/**
 * Sandbox Host への名前付きパイプ接続・ハンドシェイク・spawn 要求を行うクライアント。
 *
 * `agents/sandbox-host/SandboxHost.cs` とペアになる Agent 側の実装。Claude Agent SDK の
 * `spawnClaudeCodeProcess` が要求する `SpawnedProcess` 契約（stdin/stdout/killed/exitCode/
 * kill()/on('exit'|'error')）を満たすラッパーを提供する（SB-1a-1 では未配線。
 * SDK への接続は SB-1a-2 で行う）。
 *
 * サイクル SB-1a-1。named pipe と unix domain socket は同じ `net` API で扱えるため、
 * テストでは unix domain socket で偽ホストを立てて検証できる
 * （前例: `tests/reconnect-connect-timeout.test.mjs:11-23`）。
 */

import * as net from 'node:net';
import { Readable, Writable } from 'node:stream';
import { SandboxFrameType, SANDBOX_KNOWN_FRAME_TYPES, SANDBOX_HANDSHAKE_TIMEOUT_MS } from './sandbox-protocol.js';
import { encodeSandboxFrame, createSandboxFrameDecoder, type SandboxFrame } from './sandbox-frames.js';
import {
  buildSandboxAttestationMessage,
  verifySandboxAttestationSignature,
  fingerprintSandboxPublicKey,
} from './sandbox-attest.js';

export interface SandboxHandshakeResult {
  protocolVersion: number;
  serviceName: string;
  sid: string;
  publicKeyFingerprint: string;
  /** 署名が公開鍵で検証できたか。false の間は serviceName/sid/probe 系の値は自己申告に過ぎない */
  signatureValid: boolean;
  positiveControlBlocked: boolean;
  loopbackReachable: boolean;
  claudeExecutableReadable: boolean;
  projectFolderWritable: boolean;
}

/** 名前付きパイプ（またはテスト用 unix socket）へ接続する */
export function connectToSandboxHost(pipePath: string, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipePath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`sandbox host への接続がタイムアウトしました: ${pipePath}`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

interface RawHandshakeResponse {
  protocolVersion: number;
  serviceName: string;
  sid: string;
  positiveControlBlocked: boolean;
  loopbackReachable: boolean;
  claudeExecutableReadable: boolean;
  projectFolderWritable: boolean;
  signature: string;
}

export interface SandboxHandshakeRequestInput {
  nonce: string;
  /** ホストに「この claude 実行ファイルを open できるか」を確認させるパス */
  claudeExecutablePath: string;
  /** ホストに「このプロジェクトフォルダに書き込めるか」を確認させるパス */
  projectPath: string;
}

/**
 * ハンドシェイク（+プローブ）を行い、署名検証済みの結果を返す。
 * ホストの自己申告（身元・プローブ結果）は、ここで署名を検証できた場合にのみ証拠として扱える
 * （`decideSandboxPreflight()` の `signatureValid` → `identity*` の順序に対応させること）。
 * `claudeExecutablePath`/`projectPath` は署名にバインドされるため、ホストが別パスの結果を
 * 流用して回答することはできない。
 */
export async function performSandboxHandshake(
  socket: net.Socket,
  request: SandboxHandshakeRequestInput,
  publicKeyPem: string,
  timeoutMs: number = SANDBOX_HANDSHAKE_TIMEOUT_MS,
): Promise<SandboxHandshakeResult> {
  const decoder = createSandboxFrameDecoder(SANDBOX_KNOWN_FRAME_TYPES);
  const requestPayload = Buffer.from(JSON.stringify(request), 'utf-8');
  socket.write(encodeSandboxFrame(SandboxFrameType.HANDSHAKE_REQUEST, requestPayload));

  const frame = await readOneFrame(socket, decoder, SandboxFrameType.HANDSHAKE_RESPONSE, timeoutMs);
  const parsed = JSON.parse(frame.payload.toString('utf-8')) as RawHandshakeResponse;

  const message = buildSandboxAttestationMessage({
    nonce: request.nonce,
    serviceName: parsed.serviceName,
    sid: parsed.sid,
    protocolVersion: parsed.protocolVersion,
    claudeExecutablePath: request.claudeExecutablePath,
    projectPath: request.projectPath,
    positiveControlBlocked: parsed.positiveControlBlocked,
    loopbackReachable: parsed.loopbackReachable,
    claudeExecutableReadable: parsed.claudeExecutableReadable,
    projectFolderWritable: parsed.projectFolderWritable,
  });
  const signatureValid = verifySandboxAttestationSignature(publicKeyPem, message, parsed.signature);

  return {
    protocolVersion: parsed.protocolVersion,
    serviceName: parsed.serviceName,
    sid: parsed.sid,
    publicKeyFingerprint: fingerprintSandboxPublicKey(publicKeyPem),
    signatureValid,
    positiveControlBlocked: parsed.positiveControlBlocked,
    loopbackReachable: parsed.loopbackReachable,
    claudeExecutableReadable: parsed.claudeExecutableReadable,
    projectFolderWritable: parsed.projectFolderWritable,
  };
}

function readOneFrame(
  socket: net.Socket,
  decoder: ReturnType<typeof createSandboxFrameDecoder>,
  expectedType: number,
  timeoutMs: number,
): Promise<SandboxFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`sandbox host からの応答がタイムアウトしました（expected type=${expectedType}）`));
    }, timeoutMs);

    function onData(chunk: Buffer) {
      let frames: SandboxFrame[];
      try {
        frames = decoder.push(chunk);
      } catch (err) {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      for (const f of frames) {
        if (f.type === expectedType) {
          cleanup();
          resolve(f);
          return;
        }
        if (f.type === SandboxFrameType.ERROR) {
          cleanup();
          reject(new Error(`sandbox host がエラーを返しました: ${f.payload.toString('utf-8')}`));
          return;
        }
      }
    }
    function onClose() {
      cleanup();
      reject(new Error('sandbox host との接続が切断されました'));
    }
    function cleanup() {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('close', onClose);
    }
    socket.on('data', onData);
    socket.on('close', onClose);
  });
}

// -----------------------------------------------------------------------------
// SpawnedProcess 契約（Claude Agent SDK `spawnClaudeCodeProcess` が要求する形）
// -----------------------------------------------------------------------------

export interface SandboxSpawnRequest {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
}

type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;
type ErrorListener = (error: Error) => void;

/**
 * SDK の `SpawnedProcess` 契約を満たすラッパー。stdin への書き込みは `STDIN_DATA` フレーム、
 * `stdin.end()` は `STDIN_EOF` フレームとして送る（**kill と混同しない**。改訂版 Plan の
 * レビュー指摘 B-4 対応: stdin EOF は「子に正常終了の機会を与える」ための signal であり、
 * 強制終了ではない）。`stderr` は SDK 契約には無いが、診断用に別途公開する
 * （レビュー指摘 B-3: custom spawner では SDK が stderr tail を合成できないため）。
 */
export class SandboxSpawnedProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;

  private _killed = false;
  private _exitCode: number | null = null;
  private _signalCode: NodeJS.Signals | null = null;
  private exitListeners: ExitListener[] = [];
  private errorListeners: ErrorListener[] = [];
  private readonly decoder = createSandboxFrameDecoder(SANDBOX_KNOWN_FRAME_TYPES);
  private readonly socket: net.Socket;

  constructor(socket: net.Socket, request: SandboxSpawnRequest) {
    this.socket = socket;
    this.stdout = new Readable({ read() {} });
    this.stderr = new Readable({ read() {} });

    const self = this;
    this.stdin = new Writable({
      write(chunk, _enc, callback) {
        try {
          self.socket.write(encodeSandboxFrame(SandboxFrameType.STDIN_DATA, Buffer.from(chunk)));
          callback();
        } catch (err) {
          callback(err instanceof Error ? err : new Error(String(err)));
        }
      },
      final(callback) {
        try {
          self.socket.write(encodeSandboxFrame(SandboxFrameType.STDIN_EOF, Buffer.alloc(0)));
          callback();
        } catch (err) {
          callback(err instanceof Error ? err : new Error(String(err)));
        }
      },
    });

    socket.on('data', (chunk: Buffer) => this.handleData(chunk));
    socket.on('close', () => this.handleClose());
    socket.on('error', (err: Error) => this.emitError(err));

    const payload = Buffer.from(JSON.stringify(request), 'utf-8');
    socket.write(encodeSandboxFrame(SandboxFrameType.SPAWN_REQUEST, payload));
  }

  get killed(): boolean {
    return this._killed;
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  get signalCode(): NodeJS.Signals | null | undefined {
    return this._signalCode;
  }

  /** `KILL` フレームを送る。ホストはプロセスツリー全体（Job Object）を落とす責務を持つ */
  kill(_signal: NodeJS.Signals): boolean {
    if (this._killed) return false;
    this._killed = true;
    try {
      this.socket.write(encodeSandboxFrame(SandboxFrameType.KILL, Buffer.alloc(0)));
      return true;
    } catch {
      return false;
    }
  }

  on(event: 'exit', listener: ExitListener): void;
  on(event: 'error', listener: ErrorListener): void;
  on(event: 'exit' | 'error', listener: ExitListener | ErrorListener): void {
    if (event === 'exit') this.exitListeners.push(listener as ExitListener);
    else this.errorListeners.push(listener as ErrorListener);
  }

  once(event: 'exit', listener: ExitListener): void;
  once(event: 'error', listener: ErrorListener): void;
  once(event: 'exit' | 'error', listener: ExitListener | ErrorListener): void {
    if (event === 'exit') {
      const wrapped: ExitListener = (code, signal) => {
        this.off('exit', wrapped);
        (listener as ExitListener)(code, signal);
      };
      this.on('exit', wrapped);
    } else {
      const wrapped: ErrorListener = (error) => {
        this.off('error', wrapped);
        (listener as ErrorListener)(error);
      };
      this.on('error', wrapped);
    }
  }

  off(event: 'exit', listener: ExitListener): void;
  off(event: 'error', listener: ErrorListener): void;
  off(event: 'exit' | 'error', listener: ExitListener | ErrorListener): void {
    if (event === 'exit') this.exitListeners = this.exitListeners.filter((l) => l !== listener);
    else this.errorListeners = this.errorListeners.filter((l) => l !== listener);
  }

  private handleData(chunk: Buffer): void {
    let frames: SandboxFrame[];
    try {
      frames = this.decoder.push(chunk);
    } catch (err) {
      this.emitError(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    for (const frame of frames) {
      switch (frame.type) {
        case SandboxFrameType.STDOUT_DATA:
          this.stdout.push(frame.payload);
          break;
        case SandboxFrameType.STDERR_DATA:
          this.stderr.push(frame.payload);
          break;
        case SandboxFrameType.EXIT: {
          const info = JSON.parse(frame.payload.toString('utf-8')) as {
            code: number | null;
            signal: NodeJS.Signals | null;
          };
          this._exitCode = info.code;
          this._signalCode = info.signal;
          this.stdout.push(null);
          this.stderr.push(null);
          for (const l of [...this.exitListeners]) l(info.code, info.signal);
          break;
        }
        case SandboxFrameType.ERROR:
          this.emitError(new Error(frame.payload.toString('utf-8')));
          break;
        default:
          this.emitError(new Error(`sandbox host から未知のフレーム種別を受信しました: ${frame.type}`));
          break;
      }
    }
  }

  private handleClose(): void {
    if (this._exitCode === null && !this._killed) {
      this.emitError(new Error('sandbox host との接続が予期せず切断されました'));
    }
  }

  private emitError(error: Error): void {
    for (const l of [...this.errorListeners]) l(error);
  }
}
