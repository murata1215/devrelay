// SandboxSpawnedProcess / performSandboxHandshake の結合テスト。
// Windows の名前付きパイプと unix domain socket は同じ `net` API で扱えるため、
// ここでは unix domain socket で偽の Sandbox Host を立てて `SpawnedProcess` 契約を検証する
// （前例: tests/reconnect-connect-timeout.test.mjs）。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import {
  connectToSandboxHost,
  performSandboxHandshake,
  SandboxSpawnedProcess,
} from '../dist/services/sandbox-launcher.js';
import { encodeSandboxFrame, createSandboxFrameDecoder } from '../dist/services/sandbox-frames.js';
import { SandboxFrameType, SANDBOX_KNOWN_FRAME_TYPES } from '../dist/services/sandbox-protocol.js';
import { buildSandboxAttestationMessage, signSandboxAttestationMessage } from '../dist/services/sandbox-attest.js';

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PUBLIC_KEY_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const PRIVATE_KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

function tmpSocketPath() {
  return path.join(os.tmpdir(), `devrelay-sandbox-test-${process.pid}-${Math.random().toString(36).slice(2)}.sock`);
}

/** 偽ホスト: ハンドシェイクのみ応答する最小サーバー */
function createFakeHandshakeHost(socketPath, respond) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      const decoder = createSandboxFrameDecoder(SANDBOX_KNOWN_FRAME_TYPES);
      socket.on('data', (chunk) => {
        const frames = decoder.push(chunk);
        for (const frame of frames) {
          if (frame.type === SandboxFrameType.HANDSHAKE_REQUEST) {
            const request = JSON.parse(frame.payload.toString('utf-8'));
            respond(socket, request);
          }
        }
      });
    });
    server.listen(socketPath, () => resolve(server));
  });
}

function validSignedResponseFields(request, overrides = {}) {
  const fields = {
    nonce: request.nonce,
    serviceName: 'NT SERVICE\\devrelay-sandbox',
    sid: 'S-1-5-80-111-222-333-4444',
    protocolVersion: 1,
    claudeExecutablePath: request.claudeExecutablePath,
    projectPath: request.projectPath,
    positiveControlBlocked: true,
    loopbackReachable: true,
    claudeExecutableReadable: true,
    projectFolderWritable: true,
    ...overrides,
  };
  const message = buildSandboxAttestationMessage(fields);
  const signature = signSandboxAttestationMessage(PRIVATE_KEY_PEM, message);
  return { ...fields, signature };
}

describe('sandbox-launcher: performSandboxHandshake', () => {
  test('正しい署名の応答は signatureValid=true で全フィールドを返す', async () => {
    const socketPath = tmpSocketPath();
    const server = await createFakeHandshakeHost(socketPath, (socket, request) => {
      const response = validSignedResponseFields(request);
      socket.write(encodeSandboxFrame(SandboxFrameType.HANDSHAKE_RESPONSE, Buffer.from(JSON.stringify(response), 'utf-8')));
    });
    try {
      const socket = await connectToSandboxHost(socketPath, 2000);
      const result = await performSandboxHandshake(
        socket,
        { nonce: 'test-nonce', claudeExecutablePath: 'C:\\dev\\claude.exe', projectPath: 'C:\\dev\\repo' },
        PUBLIC_KEY_PEM,
        2000,
      );
      assert.equal(result.signatureValid, true);
      assert.equal(result.serviceName, 'NT SERVICE\\devrelay-sandbox');
      assert.equal(result.sid, 'S-1-5-80-111-222-333-4444');
      assert.equal(result.positiveControlBlocked, true);
      assert.equal(result.loopbackReachable, true);
      assert.equal(result.claudeExecutableReadable, true);
      assert.equal(result.projectFolderWritable, true);
      socket.destroy();
    } finally {
      server.close();
      fs.rmSync(socketPath, { force: true });
    }
  });

  test('改竄された署名は signatureValid=false になる（身元・プローブ結果は証拠にならない）', async () => {
    const socketPath = tmpSocketPath();
    const server = await createFakeHandshakeHost(socketPath, (socket, request) => {
      const response = validSignedResponseFields(request);
      response.signature = response.signature.slice(0, -4) + 'AAAA'; // 署名を破壊
      socket.write(encodeSandboxFrame(SandboxFrameType.HANDSHAKE_RESPONSE, Buffer.from(JSON.stringify(response), 'utf-8')));
    });
    try {
      const socket = await connectToSandboxHost(socketPath, 2000);
      const result = await performSandboxHandshake(
        socket,
        { nonce: 'test-nonce', claudeExecutablePath: 'C:\\dev\\claude.exe', projectPath: 'C:\\dev\\repo' },
        PUBLIC_KEY_PEM,
        2000,
      );
      assert.equal(result.signatureValid, false);
      socket.destroy();
    } finally {
      server.close();
      fs.rmSync(socketPath, { force: true });
    }
  });

  test('別パス向けの署名済み応答を別のリクエストに流用しても signatureValid=false（リプレイ防止）', async () => {
    const socketPath = tmpSocketPath();
    const server = await createFakeHandshakeHost(socketPath, (socket, request) => {
      // request.projectPath を無視し、別のプロジェクトパス向けに署名した応答を返す（偽ホストの不正行為を模擬）
      const response = validSignedResponseFields({ ...request, projectPath: 'C:\\dev\\OTHER-PROJECT' });
      socket.write(encodeSandboxFrame(SandboxFrameType.HANDSHAKE_RESPONSE, Buffer.from(JSON.stringify(response), 'utf-8')));
    });
    try {
      const socket = await connectToSandboxHost(socketPath, 2000);
      const result = await performSandboxHandshake(
        socket,
        { nonce: 'test-nonce', claudeExecutablePath: 'C:\\dev\\claude.exe', projectPath: 'C:\\dev\\repo' },
        PUBLIC_KEY_PEM,
        2000,
      );
      assert.equal(result.signatureValid, false);
      socket.destroy();
    } finally {
      server.close();
      fs.rmSync(socketPath, { force: true });
    }
  });

  test('応答が来ない場合はタイムアウトで reject される', async () => {
    const socketPath = tmpSocketPath();
    const server = await createFakeHandshakeHost(socketPath, () => {
      // 応答しない
    });
    try {
      const socket = await connectToSandboxHost(socketPath, 2000);
      await assert.rejects(
        () => performSandboxHandshake(socket, { nonce: 'n', claudeExecutablePath: 'c', projectPath: 'p' }, PUBLIC_KEY_PEM, 300),
        /タイムアウト/,
      );
      socket.destroy();
    } finally {
      server.close();
      fs.rmSync(socketPath, { force: true });
    }
  });

  test('接続自体が失敗する場合（ホスト未起動）は reject される', async () => {
    const socketPath = tmpSocketPath(); // listen していないパス
    await assert.rejects(() => connectToSandboxHost(socketPath, 300));
  });
});

/** 偽ホスト: SPAWN_REQUEST を受けたら STDIN をそのまま STDOUT にエコー、STDIN_EOF で EXIT(0) を返す。
 *  KILL を受けたら EXIT(null, SIGTERM) を返す。 */
function createFakeSpawnHost(socketPath) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      const decoder = createSandboxFrameDecoder(SANDBOX_KNOWN_FRAME_TYPES);
      socket.on('data', (chunk) => {
        const frames = decoder.push(chunk);
        for (const frame of frames) {
          switch (frame.type) {
            case SandboxFrameType.SPAWN_REQUEST:
              break; // 受理のみ（レスポンスフレームは本テストでは使わない）
            case SandboxFrameType.STDIN_DATA:
              socket.write(encodeSandboxFrame(SandboxFrameType.STDOUT_DATA, frame.payload));
              break;
            case SandboxFrameType.STDIN_EOF:
              socket.write(encodeSandboxFrame(SandboxFrameType.EXIT, Buffer.from(JSON.stringify({ code: 0, signal: null }))));
              break;
            case SandboxFrameType.KILL:
              socket.write(encodeSandboxFrame(SandboxFrameType.EXIT, Buffer.from(JSON.stringify({ code: null, signal: 'SIGTERM' }))));
              break;
            default:
              break;
          }
        }
      });
    });
    server.listen(socketPath, () => resolve(server));
  });
}

describe('sandbox-launcher: SandboxSpawnedProcess（SpawnedProcess 契約）', () => {
  test('stdin へ書いた内容が stdout に中継される（エコー）', async () => {
    const socketPath = tmpSocketPath();
    const server = await createFakeSpawnHost(socketPath);
    try {
      const socket = await connectToSandboxHost(socketPath, 2000);
      const proc = new SandboxSpawnedProcess(socket, { command: 'cmd.exe', args: [], cwd: 'C:\\dev', env: {} });

      const received = new Promise((resolve) => {
        proc.stdout.once('data', (chunk) => resolve(chunk.toString('utf-8')));
      });
      proc.stdin.write('hello-sandbox');
      assert.equal(await received, 'hello-sandbox');
      socket.destroy();
    } finally {
      server.close();
      fs.rmSync(socketPath, { force: true });
    }
  });

  test('stdin.end()（EOF）は kill ではなく正常終了として扱われ、exit イベントで code=0 が通知される', async () => {
    const socketPath = tmpSocketPath();
    const server = await createFakeSpawnHost(socketPath);
    try {
      const socket = await connectToSandboxHost(socketPath, 2000);
      const proc = new SandboxSpawnedProcess(socket, { command: 'cmd.exe', args: [], cwd: 'C:\\dev', env: {} });

      const exitInfo = await new Promise((resolve) => {
        proc.once('exit', (code, signal) => resolve({ code, signal }));
        proc.stdin.end();
      });
      assert.equal(exitInfo.code, 0);
      assert.equal(exitInfo.signal, null);
      assert.equal(proc.killed, false, 'stdin.end() は kill とみなさない');
      assert.equal(proc.exitCode, 0);
      socket.destroy();
    } finally {
      server.close();
      fs.rmSync(socketPath, { force: true });
    }
  });

  test('kill() は KILL フレームを送り、ホストからの EXIT(null, SIGTERM) で反映される', async () => {
    const socketPath = tmpSocketPath();
    const server = await createFakeSpawnHost(socketPath);
    try {
      const socket = await connectToSandboxHost(socketPath, 2000);
      const proc = new SandboxSpawnedProcess(socket, { command: 'cmd.exe', args: [], cwd: 'C:\\dev', env: {} });

      const exitInfo = await new Promise((resolve) => {
        proc.once('exit', (code, signal) => resolve({ code, signal }));
        const killed = proc.kill('SIGTERM');
        assert.equal(killed, true);
      });
      assert.equal(exitInfo.code, null);
      assert.equal(exitInfo.signal, 'SIGTERM');
      assert.equal(proc.killed, true);

      // 2 回目の kill() は false を返す（既に killed）
      assert.equal(proc.kill('SIGTERM'), false);
      socket.destroy();
    } finally {
      server.close();
      fs.rmSync(socketPath, { force: true });
    }
  });

  test('未知のフレーム種別を受信すると error イベントが発火する', async () => {
    const socketPath = tmpSocketPath();
    const server = net.createServer((socket) => {
      // SPAWN_REQUEST を待たず、未知のフレーム種別（99）を即座に送る
      const header = Buffer.allocUnsafe(5);
      header.writeUInt8(99, 0);
      header.writeUInt32BE(0, 1);
      socket.write(header);
    });
    await new Promise((resolve) => server.listen(socketPath, resolve));
    try {
      const socket = await connectToSandboxHost(socketPath, 2000);
      const proc = new SandboxSpawnedProcess(socket, { command: 'cmd.exe', args: [], cwd: 'C:\\dev', env: {} });
      const error = await new Promise((resolve) => {
        proc.once('error', (err) => resolve(err));
      });
      assert.ok(error instanceof Error);
      assert.match(error.message, /unknown frame type/);
      socket.destroy();
    } finally {
      server.close();
      fs.rmSync(socketPath, { force: true });
    }
  });

  test('EXIT を受け取る前に接続が切断されると error イベントが発火する（孤児化の検知）', async () => {
    const socketPath = tmpSocketPath();
    const server = net.createServer((socket) => {
      socket.on('data', () => {
        socket.destroy(); // SPAWN_REQUEST を受けたら何も返さず即座に切断
      });
    });
    await new Promise((resolve) => server.listen(socketPath, resolve));
    try {
      const socket = await connectToSandboxHost(socketPath, 2000);
      const proc = new SandboxSpawnedProcess(socket, { command: 'cmd.exe', args: [], cwd: 'C:\\dev', env: {} });
      const error = await new Promise((resolve) => {
        proc.once('error', (err) => resolve(err));
      });
      assert.ok(error instanceof Error);
      assert.match(error.message, /予期せず切断/);
    } finally {
      server.close();
      fs.rmSync(socketPath, { force: true });
    }
  });

  test('on/off でリスナーを登録・解除できる', async () => {
    const socketPath = tmpSocketPath();
    const server = await createFakeSpawnHost(socketPath);
    try {
      const socket = await connectToSandboxHost(socketPath, 2000);
      const proc = new SandboxSpawnedProcess(socket, { command: 'cmd.exe', args: [], cwd: 'C:\\dev', env: {} });

      let calls = 0;
      const listener = () => { calls++; };
      proc.on('exit', listener);
      proc.off('exit', listener);
      await new Promise((resolve) => {
        proc.once('exit', resolve);
        proc.stdin.end();
      });
      assert.equal(calls, 0, 'off() 後は呼ばれない');
      socket.destroy();
    } finally {
      server.close();
      fs.rmSync(socketPath, { force: true });
    }
  });
});
