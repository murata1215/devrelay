import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { encodeSandboxFrame, createSandboxFrameDecoder } from '../dist/services/sandbox-frames.js';

const VALID_TYPES = new Set([1, 2, 3, 4, 5]);

describe('sandbox-frames', () => {
  test('encode → decode の往復で元のペイロードが復元される', () => {
    const payload = Buffer.from('hello sandbox', 'utf-8');
    const encoded = encodeSandboxFrame(3, payload);
    const decoder = createSandboxFrameDecoder(VALID_TYPES);
    const frames = decoder.push(encoded);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].type, 3);
    assert.equal(frames[0].payload.toString('utf-8'), 'hello sandbox');
    assert.equal(decoder.hasPendingBytes(), false);
  });

  test('空ペイロードのフレームも正しく符号化・復号できる', () => {
    const encoded = encodeSandboxFrame(5, Buffer.alloc(0));
    const decoder = createSandboxFrameDecoder(VALID_TYPES);
    const [frame] = decoder.push(encoded);
    assert.equal(frame.type, 5);
    assert.equal(frame.payload.length, 0);
  });

  test('複数フレームが連結して届いても分離して復号できる', () => {
    const a = encodeSandboxFrame(1, Buffer.from('a'));
    const b = encodeSandboxFrame(2, Buffer.from('bb'));
    const c = encodeSandboxFrame(3, Buffer.from('ccc'));
    const decoder = createSandboxFrameDecoder(VALID_TYPES);
    const frames = decoder.push(Buffer.concat([a, b, c]));
    assert.equal(frames.length, 3);
    assert.deepEqual(frames.map((f) => f.type), [1, 2, 3]);
    assert.deepEqual(frames.map((f) => f.payload.toString('utf-8')), ['a', 'bb', 'ccc']);
  });

  test('1 フレームが複数チャンクに分割されて届いても結合して復号できる', () => {
    const encoded = encodeSandboxFrame(4, Buffer.from('split-payload'));
    const decoder = createSandboxFrameDecoder(VALID_TYPES);
    const first = decoder.push(encoded.subarray(0, 3));
    assert.equal(first.length, 0);
    assert.equal(decoder.hasPendingBytes(), true);
    const second = decoder.push(encoded.subarray(3, 6));
    assert.equal(second.length, 0);
    const third = decoder.push(encoded.subarray(6));
    assert.equal(third.length, 1);
    assert.equal(third[0].payload.toString('utf-8'), 'split-payload');
    assert.equal(decoder.hasPendingBytes(), false);
  });

  test('宣言長が上限を超えるフレームは例外を投げる（致命エラー）', () => {
    const decoder = createSandboxFrameDecoder(VALID_TYPES);
    const header = Buffer.allocUnsafe(5);
    header.writeUInt8(1, 0);
    header.writeUInt32BE(0xffffffff, 1); // 16MiB 上限を大きく超える宣言
    assert.throws(() => decoder.push(header), /exceeds max/);
  });

  test('未知のフレーム種別は例外を投げる（致命エラー）', () => {
    const encoded = encodeSandboxFrame(99, Buffer.from('x'));
    const decoder = createSandboxFrameDecoder(VALID_TYPES);
    assert.throws(() => decoder.push(encoded), /unknown frame type/);
  });

  test('途中切断（ヘッダのみ届いてペイロードが来ない）は hasPendingBytes() で検知できる', () => {
    const decoder = createSandboxFrameDecoder(VALID_TYPES);
    const header = Buffer.allocUnsafe(5);
    header.writeUInt8(1, 0);
    header.writeUInt32BE(100, 1); // ペイロード 100 バイトを宣言するが実際には届かない
    const frames = decoder.push(header);
    assert.equal(frames.length, 0);
    assert.equal(decoder.hasPendingBytes(), true);
  });

  test('payload が最大長を超える場合、encodeSandboxFrame 自体が例外を投げる', () => {
    const huge = Buffer.alloc(16 * 1024 * 1024 + 1);
    assert.throws(() => encodeSandboxFrame(1, huge), /too large/);
  });

  test('type がバイト範囲外の場合、encodeSandboxFrame が例外を投げる', () => {
    assert.throws(() => encodeSandboxFrame(256, Buffer.alloc(0)), /must be a byte/);
    assert.throws(() => encodeSandboxFrame(-1, Buffer.alloc(0)), /must be a byte/);
  });
});
