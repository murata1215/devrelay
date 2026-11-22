import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { createSandboxConnectProxy } from '../dist/services/sandbox-proxy.js';

/** 127.0.0.1 上で平文 echo を返す TCP サーバー（許可された宛先の代わり） */
function createEchoServer() {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.on('data', (chunk) => socket.write(chunk));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function sendRawConnect(proxyPort, targetHostPort) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1', () => {
      socket.write(`CONNECT ${targetHostPort} HTTP/1.1\r\nHost: ${targetHostPort}\r\n\r\n`);
    });
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      if (buffer.includes('\r\n\r\n')) {
        resolve({ socket, statusLine: buffer.split('\r\n')[0] });
      }
    });
    socket.on('error', reject);
  });
}

describe('sandbox-proxy: CONNECT allow/deny', () => {
  async function startProxyOnEphemeralPort(allowlist, extra = {}) {
    // 本番は固定ポート（48711）だが、テストは並行実行・再実行時の衝突を避けるため
    // 都度ランダムな高位ポートを使う。
    const port = 40000 + Math.floor(Math.random() * 10000);
    const handle = await createSandboxConnectProxy({ port, allowlist, ...extra });
    return { handle, port };
  }

  test('許可リスト外の宛先への CONNECT は 403 を返す', async () => {
    const { handle, port } = await startProxyOnEphemeralPort([{ host: 'allowed.example', ports: [443] }]);
    try {
      const { statusLine, socket } = await sendRawConnect(port, 'not-allowed.example:443');
      assert.match(statusLine, /403/);
      socket.destroy();
    } finally {
      await handle.close();
    }
  });

  test('許可された宛先への CONNECT は 200 を返し、以降のデータを中継する', async () => {
    const { server: echoServer, port: echoPort } = await createEchoServer();
    const { handle, port } = await startProxyOnEphemeralPort([{ host: '127.0.0.1', ports: [echoPort] }]);
    try {
      const { statusLine, socket } = await sendRawConnect(port, `127.0.0.1:${echoPort}`);
      assert.match(statusLine, /200/);
      const echoed = await new Promise((resolve) => {
        socket.once('data', (chunk) => resolve(chunk.toString('utf-8')));
        socket.write('ping-through-proxy');
      });
      assert.equal(echoed, 'ping-through-proxy');
      socket.destroy();
    } finally {
      await handle.close();
      echoServer.close();
    }
  });

  test('CONNECT 以外のメソッド（GET）は 403 を返す', async () => {
    const { handle, port } = await startProxyOnEphemeralPort([{ host: 'allowed.example', ports: [443] }]);
    try {
      const status = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/', method: 'GET' }, (res) => {
          resolve(res.statusCode);
        });
        req.on('error', reject);
        req.end();
      });
      assert.equal(status, 403);
    } finally {
      await handle.close();
    }
  });

  test('拒否された宛先は onDenied コールバックに記録される', async () => {
    const denials = [];
    const { handle, port } = await startProxyOnEphemeralPort([{ host: 'allowed.example', ports: [443] }], {
      onDenied: (d) => denials.push(d),
    });
    try {
      const { socket } = await sendRawConnect(port, 'blocked.example:443');
      socket.destroy();
      assert.equal(denials.length, 1);
      assert.equal(denials[0].host, 'blocked.example');
      assert.equal(denials[0].port, 443);
    } finally {
      await handle.close();
    }
  });

  test('許可された宛先は onAllowed コールバックに記録される', async () => {
    const { server: echoServer, port: echoPort } = await createEchoServer();
    const allowed = [];
    const { handle, port } = await startProxyOnEphemeralPort([{ host: '127.0.0.1', ports: [echoPort] }], {
      onAllowed: (host, p) => allowed.push({ host, port: p }),
    });
    try {
      const { socket } = await sendRawConnect(port, `127.0.0.1:${echoPort}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(allowed.length, 1);
      assert.equal(allowed[0].host, '127.0.0.1');
      socket.destroy();
    } finally {
      await handle.close();
      echoServer.close();
    }
  });

  test('socks 上位プロキシは起動前に拒否される（fail-closed、chain できないため）', async () => {
    const port = 40000 + Math.floor(Math.random() * 10000);
    // createSandboxConnectProxy はスキーム検証を同期的に行い、その場で throw する
    // （Promise を返す前）。assert.rejects で捕まえるため async ラッパーに包む。
    await assert.rejects(
      async () => createSandboxConnectProxy({ port, allowlist: [], upstreamProxyUrl: 'socks5://127.0.0.1:1080' }),
      /socks/,
    );
  });

  test('http 上位プロキシは chain される', async () => {
    // 上位プロキシ役の簡易 CONNECT サーバー（接続先へそのまま中継する）
    const { server: echoServer, port: echoPort } = await createEchoServer();
    const upstreamProxyPort = 40000 + Math.floor(Math.random() * 10000);
    const upstreamServer = http.createServer((_req, res) => {
      res.writeHead(403);
      res.end();
    });
    upstreamServer.on('connect', (req, clientSocket) => {
      const [host, portStr] = (req.url ?? '').split(':');
      const upstream = net.connect(Number(portStr), host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
    });
    await new Promise((resolve) => upstreamServer.listen(upstreamProxyPort, '127.0.0.1', resolve));

    const { handle, port } = await startProxyOnEphemeralPort([{ host: '127.0.0.1', ports: [echoPort] }], {
      upstreamProxyUrl: `http://127.0.0.1:${upstreamProxyPort}`,
    });
    try {
      const { statusLine, socket } = await sendRawConnect(port, `127.0.0.1:${echoPort}`);
      assert.match(statusLine, /200/);
      const echoed = await new Promise((resolve) => {
        socket.once('data', (chunk) => resolve(chunk.toString('utf-8')));
        socket.write('via-upstream');
      });
      assert.equal(echoed, 'via-upstream');
      socket.destroy();
    } finally {
      await handle.close();
      echoServer.close();
      upstreamServer.close();
    }
  });

  test('close() 後は新しい接続を受け付けない', async () => {
    const { handle, port } = await startProxyOnEphemeralPort([{ host: 'allowed.example', ports: [443] }]);
    await handle.close();
    await assert.rejects(() => sendRawConnect(port, 'allowed.example:443'));
  });
});
