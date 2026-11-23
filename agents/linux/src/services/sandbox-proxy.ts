/**
 * Sandbox 実行用の 127.0.0.1 専用 CONNECT 中継プロキシ（Agent プロセス内）。
 *
 * CONNECT メソッドのみを受け付け、許可リスト（`sandbox-allowlist.ts`）外の宛先は 403 で拒否する。
 * 上位プロキシ（`config.proxy.url`）が設定されている場合は http/https のみ chain する
 * （socks は構造的に chain できないため fail-closed で拒否する。黙って無視しない）。
 *
 * サイクル SB-1a-1。
 */

import * as http from 'node:http';
import * as net from 'node:net';
import { isAllowedSandboxConnectTarget, type SandboxAllowlistEntry } from './sandbox-allowlist.js';

export interface SandboxProxyDenial {
  host: string;
  port: number;
  at: number;
}

export interface SandboxProxyOptions {
  port: number;
  allowlist: readonly SandboxAllowlistEntry[];
  /** 上位プロキシ（`config.proxy.url`）。http/https のみ対応 */
  upstreamProxyUrl?: string;
  onDenied?: (denial: SandboxProxyDenial) => void;
  onAllowed?: (host: string, port: number) => void;
}

export interface SandboxProxyHandle {
  port: number;
  close(): Promise<void>;
}

/**
 * 許可リスト外の宛先への接続を 403 で拒否する CONNECT 専用プロキシを起動する。
 * @throws 上位プロキシのスキームが socks の場合（chain できないため起動前に拒否）
 */
export function createSandboxConnectProxy(options: SandboxProxyOptions): Promise<SandboxProxyHandle> {
  if (options.upstreamProxyUrl) {
    const scheme = options.upstreamProxyUrl.split(':')[0]?.toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') {
      throw new Error(`sandbox proxy: unsupported upstream proxy scheme（socks は未対応）: ${options.upstreamProxyUrl}`);
    }
  }

  // c 対応（SB-1a-2）: CONNECT 中継中の socket（クライアント側・上位側の両方）を追跡する。
  // `http.Server.close()` は既存の接続が自然に終わるまで callback を呼ばない。CONNECT で
  // ハイジャックした TCP パイプはクライアント側が明示的に切断するまで「接続中」のままなので、
  // 中継中に `close()` を呼ぶとプロセスが終了しない既存バグがあった（SB-1a-1.1 時点で未解決、
  // `--claude-roundtrip` が成功表示の後に戻らない症状）。`close()` 側で追跡中の socket を
  // 全て `destroy()` してから `server.close()` することで確実に終了させる。
  const activeSockets = new Set<net.Socket>();
  function track(socket: net.Socket): void {
    activeSockets.add(socket);
    socket.once('close', () => activeSockets.delete(socket));
  }

  const server = http.createServer((_req, res) => {
    // CONNECT 以外は全部 403（このプロキシは CONNECT 中継専用）
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden: this proxy only accepts CONNECT\n');
  });

  server.on('connect', (req, clientSocket, head) => {
    // Node の型定義では 'connect' イベントの socket は Duplex 型だが、実体は常に net.Socket
    // （http サーバーの TCP 接続由来のため）。CONNECT 中継では Socket 固有の API（pipe 先の
    // 再利用等）を使わないため安全にキャストする。
    const socket = clientSocket as net.Socket;
    track(socket);
    try {
      handleConnect(req, socket, head, options, track);
    } catch {
      try {
        socket.end('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      } catch {
        /* ignore */
      }
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve({
        port: options.port,
        close: () =>
          new Promise<void>((res) => {
            for (const socket of activeSockets) {
              try {
                socket.destroy();
              } catch {
                /* ignore */
              }
            }
            activeSockets.clear();
            server.close(() => res());
          }),
      });
    });
  });
}

function parseConnectTarget(url: string): { host: string; port: number } | null {
  const match = /^([^:]+):(\d+)$/.exec(url);
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: match[1], port };
}

/** 中継中の socket を `createSandboxConnectProxy()` の追跡 Set へ登録する関数の型 */
type TrackSocket = (socket: net.Socket) => void;

function handleConnect(
  req: http.IncomingMessage,
  clientSocket: net.Socket,
  head: Buffer,
  options: SandboxProxyOptions,
  track: TrackSocket,
): void {
  const target = parseConnectTarget(req.url ?? '');
  if (!target) {
    clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  if (!isAllowedSandboxConnectTarget(options.allowlist, target.host, target.port)) {
    options.onDenied?.({ host: target.host, port: target.port, at: Date.now() });
    clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }

  clientSocket.on('error', () => {
    /* クライアント切断は無視 */
  });

  if (options.upstreamProxyUrl) {
    chainThroughUpstreamProxy(options.upstreamProxyUrl, target, clientSocket, head, options, track);
  } else {
    connectDirect(target, clientSocket, head, options, track);
  }
}

function connectDirect(
  target: { host: string; port: number },
  clientSocket: net.Socket,
  head: Buffer,
  options: SandboxProxyOptions,
  track: TrackSocket,
): void {
  const upstream = net.connect(target.port, target.host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length > 0) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
    options.onAllowed?.(target.host, target.port);
  });
  track(upstream);
  upstream.on('error', () => {
    try {
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    } catch {
      /* ignore */
    }
  });
}

function chainThroughUpstreamProxy(
  upstreamProxyUrl: string,
  target: { host: string; port: number },
  clientSocket: net.Socket,
  head: Buffer,
  options: SandboxProxyOptions,
  track: TrackSocket,
): void {
  const upstream = new URL(upstreamProxyUrl);
  const socket = net.connect(Number(upstream.port) || 80, upstream.hostname, () => {
    socket.write(`CONNECT ${target.host}:${target.port} HTTP/1.1\r\nHost: ${target.host}:${target.port}\r\n\r\n`);
  });
  track(socket);
  let responded = false;
  socket.on('data', function onData(chunk: Buffer) {
    if (responded) return;
    const text = chunk.toString('utf-8');
    if (!text.includes('\r\n\r\n')) return;
    responded = true;
    if (/^HTTP\/1\.[01] 200/.test(text)) {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length > 0) socket.write(head);
      socket.pipe(clientSocket);
      clientSocket.pipe(socket);
      options.onAllowed?.(target.host, target.port);
    } else {
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      socket.end();
    }
  });
  socket.on('error', () => {
    try {
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    } catch {
      /* ignore */
    }
  });
}
