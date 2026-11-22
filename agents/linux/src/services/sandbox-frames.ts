/**
 * Sandbox Host と Agent 間のフレーム符号化・復号（外部 import ゼロ、純関数）。
 *
 * ワイヤーフォーマット: `[1 byte type][4 bytes length (big-endian)][payload...]`。
 * 複数フレームが同じ TCP/パイプストリームに連結して届く（分割・結合どちらも起きる）前提で、
 * `createSandboxFrameDecoder()` は到着したバイト列を逐次 push し、確定したフレームのみ返す。
 *
 * サイクル SB-1a-1。
 */

import { SANDBOX_MAX_FRAME_BYTES } from './sandbox-protocol.js';

const HEADER_BYTES = 5; // 1 (type) + 4 (length, big-endian)

export interface SandboxFrame {
  type: number;
  payload: Buffer;
}

/**
 * フレームを符号化する。
 * @throws payload が `SANDBOX_MAX_FRAME_BYTES` を超える場合
 */
export function encodeSandboxFrame(type: number, payload: Buffer): Buffer {
  if (!Number.isInteger(type) || type < 0 || type > 0xff) {
    throw new Error(`sandbox frame: type must be a byte (0-255): ${type}`);
  }
  if (payload.length > SANDBOX_MAX_FRAME_BYTES) {
    throw new Error(`sandbox frame: payload too large (${payload.length} bytes, max ${SANDBOX_MAX_FRAME_BYTES})`);
  }
  const header = Buffer.allocUnsafe(HEADER_BYTES);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

export interface SandboxFrameDecoder {
  /**
   * 受信した生バイト列を追加し、確定したフレームを返す（0 件のこともある）。
   * @throws 宣言長が上限超過、または未知のフレーム種別を検出した場合（致命エラー＝呼び出し側は接続を切る）
   */
  push(chunk: Buffer): SandboxFrame[];
  /** 接続が切れた時点で未完成のバイト列が残っているか（途中切断の検知に使う） */
  hasPendingBytes(): boolean;
}

/**
 * 逐次デコーダを作る。
 * @param validTypes 許容するフレーム種別の集合。これ以外の種別を検出したら例外を投げる
 *   （未知フレームを無視して先に進めると、プロトコル不一致の Sandbox Host を無言で信用してしまうため）
 */
export function createSandboxFrameDecoder(validTypes: ReadonlySet<number>): SandboxFrameDecoder {
  let buffer = Buffer.alloc(0);

  function push(chunk: Buffer): SandboxFrame[] {
    buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
    const frames: SandboxFrame[] = [];
    for (;;) {
      if (buffer.length < HEADER_BYTES) break;
      const type = buffer.readUInt8(0);
      const length = buffer.readUInt32BE(1);
      if (length > SANDBOX_MAX_FRAME_BYTES) {
        throw new Error(`sandbox frame: declared length ${length} exceeds max ${SANDBOX_MAX_FRAME_BYTES} (type=${type})`);
      }
      const totalLength = HEADER_BYTES + length;
      if (buffer.length < totalLength) break; // まだ全体が届いていない
      if (!validTypes.has(type)) {
        throw new Error(`sandbox frame: unknown frame type ${type}`);
      }
      const payload = Buffer.from(buffer.subarray(HEADER_BYTES, totalLength));
      frames.push({ type, payload });
      buffer = Buffer.from(buffer.subarray(totalLength));
    }
    return frames;
  }

  function hasPendingBytes(): boolean {
    return buffer.length > 0;
  }

  return { push, hasPendingBytes };
}
