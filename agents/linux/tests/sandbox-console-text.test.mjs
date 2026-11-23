import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decodeWindowsConsoleText } from '../dist/services/sandbox-console-text.js';

// Shift_JIS (CP932) のバイト列は `printf '%s' "アクセスが拒否されました。" | iconv -f UTF-8 -t SHIFT_JIS | xxd -p`
// で実際に生成・確認した実バイト列（捏造ではなく iconv の出力そのもの）。
const ACCESS_DENIED_SHIFT_JIS_HEX = '8341834e835a835882aa8b9194db82b382ea82dc82b582bd8142';
const ACCESS_DENIED_TEXT = 'アクセスが拒否されました。';

describe('sandbox-console-text: decodeWindowsConsoleText', () => {
  test('空 Buffer は空文字列', () => {
    assert.equal(decodeWindowsConsoleText(Buffer.alloc(0)), '');
  });

  test('厳格 UTF-8 として妥当なバイト列はそのまま UTF-8 として読む', () => {
    const buf = Buffer.from('icacls: Access is denied. 日本語も含む', 'utf-8');
    assert.equal(decodeWindowsConsoleText(buf), 'icacls: Access is denied. 日本語も含む');
  });

  test('UTF-8 として不正だが Shift_JIS として妥当なバイト列は CP932 として復号する（B2 対応）', () => {
    const buf = Buffer.from(ACCESS_DENIED_SHIFT_JIS_HEX, 'hex');
    // 事前条件: このバイト列は厳格 UTF-8 デコードでは例外になる（文字化けの再現条件）
    assert.throws(() => new TextDecoder('utf-8', { fatal: true }).decode(buf));
    assert.equal(decodeWindowsConsoleText(buf), ACCESS_DENIED_TEXT);
  });

  test('UTF-8 としても Shift_JIS としても不正なバイト列は例外を投げず latin1 にフォールバックする', () => {
    // 0xFF 0xFE は UTF-8 としても Shift_JIS としても不正な先頭バイト列
    const buf = Buffer.from([0xff, 0xfe, 0x00, 0x01]);
    const result = decodeWindowsConsoleText(buf);
    assert.equal(typeof result, 'string');
    assert.equal(result.length, 4); // latin1 は 1 バイト = 1 文字
  });

  test('純粋な ASCII バイト列はそのまま読める', () => {
    const buf = Buffer.from('exit code 1639', 'ascii');
    assert.equal(decodeWindowsConsoleText(buf), 'exit code 1639');
  });
});
