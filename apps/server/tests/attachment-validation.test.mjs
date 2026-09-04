import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTACHMENT_MAX_FILE_SIZE,
  ATTACHMENT_MAX_TOTAL_SIZE,
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_FILENAME_MAX_LENGTH,
  ALLOWED_ATTACHMENT_MIME_TYPES,
  sanitizeAttachmentFilename,
  decodeStrictBase64,
  detectMimeFromMagicBytes,
  validateAttachments,
} from '../dist/services/attachment-validation.js';

// 1x1 透明 PNG（実バイナリ、テストで使い回す）
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function pngBuffer() {
  return Buffer.from(PNG_1X1_BASE64, 'base64');
}

// --- sanitizeAttachmentFilename ---

test('sanitizeAttachmentFilename: 通常のファイル名はそのまま通る', () => {
  const r = sanitizeAttachmentFilename('photo.png');
  assert.equal(r.ok, true);
  assert.equal(r.filename, 'photo.png');
  assert.equal(r.changed, false);
});

test('sanitizeAttachmentFilename: パストラバーサル ../../../etc/passwd は basename 化される', () => {
  const r = sanitizeAttachmentFilename('../../../etc/passwd');
  assert.equal(r.ok, true);
  assert.equal(r.filename, 'passwd');
  assert.equal(r.changed, true);
});

test('sanitizeAttachmentFilename: Windows 区切り ..\\..\\windows\\system32\\x.png も basename 化される', () => {
  const r = sanitizeAttachmentFilename('..\\..\\windows\\system32\\x.png');
  assert.equal(r.ok, true);
  assert.equal(r.filename, 'x.png');
  assert.equal(r.changed, true);
});

test('sanitizeAttachmentFilename: ".." 単体は拒否される', () => {
  const r = sanitizeAttachmentFilename('..');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'dotOnly');
});

test('sanitizeAttachmentFilename: "." 単体は拒否される', () => {
  const r = sanitizeAttachmentFilename('.');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'dotOnly');
});

test('sanitizeAttachmentFilename: 空文字は拒否される', () => {
  const r = sanitizeAttachmentFilename('');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'empty');
});

test('sanitizeAttachmentFilename: 改行を含む名前は除去される（プロンプト行注入対策）', () => {
  const r = sanitizeAttachmentFilename('a\nb.png');
  assert.equal(r.ok, true);
  assert.equal(r.filename, 'ab.png');
  assert.equal(r.changed, true);
});

test('sanitizeAttachmentFilename: CR を含む名前も除去される', () => {
  const r = sanitizeAttachmentFilename('a\rb.png');
  assert.equal(r.ok, true);
  assert.equal(r.filename, 'ab.png');
  assert.equal(r.changed, true);
});

test('sanitizeAttachmentFilename: NUL バイトを含む名前は拒否される', () => {
  const r = sanitizeAttachmentFilename('a\u0000b.png');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'nulByte');
});

test('sanitizeAttachmentFilename: 101文字のファイル名は拒否される（切り詰めない）', () => {
  const longName = 'a'.repeat(97) + '.png'; // 101 chars
  assert.equal(longName.length, 101);
  const r = sanitizeAttachmentFilename(longName);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'tooLong');
});

test('sanitizeAttachmentFilename: ちょうど上限(100文字)は許可される', () => {
  const name = 'a'.repeat(96) + '.png'; // 100 chars
  assert.equal(name.length, ATTACHMENT_FILENAME_MAX_LENGTH);
  const r = sanitizeAttachmentFilename(name);
  assert.equal(r.ok, true);
});

test('sanitizeAttachmentFilename: 日本語ファイル名は許可される', () => {
  const r = sanitizeAttachmentFilename('写真.png');
  assert.equal(r.ok, true);
  assert.equal(r.filename, '写真.png');
  assert.equal(r.changed, false);
});

// --- decodeStrictBase64 ---

test('decodeStrictBase64: 正しい base64 はデコードできる', () => {
  const buf = decodeStrictBase64(PNG_1X1_BASE64);
  assert.ok(buf);
  assert.ok(buf.equals(pngBuffer()));
});

test('decodeStrictBase64: 改行入り base64 は空白除去後に受理される', () => {
  const withNewlines = PNG_1X1_BASE64.match(/.{1,20}/g).join('\n');
  const buf = decodeStrictBase64(withNewlines);
  assert.ok(buf);
  assert.ok(buf.equals(pngBuffer()));
});

test('decodeStrictBase64: 不正な文字集合は拒否される', () => {
  assert.equal(decodeStrictBase64('!!!!not-base64!!!!'), null);
});

test('decodeStrictBase64: 長さが4の倍数でないものは拒否される', () => {
  assert.equal(decodeStrictBase64('YQ'), null); // 'a' だが長さ2で%4!=0（パディングなし）
});

test('decodeStrictBase64: 空文字は拒否される', () => {
  assert.equal(decodeStrictBase64(''), null);
});

// --- detectMimeFromMagicBytes ---

test('detectMimeFromMagicBytes: PNG シグネチャを検出する', () => {
  assert.equal(detectMimeFromMagicBytes(pngBuffer()), 'image/png');
});

test('detectMimeFromMagicBytes: JPEG シグネチャを検出する', () => {
  const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  assert.equal(detectMimeFromMagicBytes(buf), 'image/jpeg');
});

test('detectMimeFromMagicBytes: GIF シグネチャを検出する', () => {
  const buf = Buffer.from('GIF89a', 'ascii');
  assert.equal(detectMimeFromMagicBytes(buf), 'image/gif');
});

test('detectMimeFromMagicBytes: WebP (RIFF....WEBP) シグネチャを検出する', () => {
  const buf = Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP', 'ascii'),
  ]);
  assert.equal(detectMimeFromMagicBytes(buf), 'image/webp');
});

test('detectMimeFromMagicBytes: プレーンテキストは null（画像シグネチャなし）', () => {
  assert.equal(detectMimeFromMagicBytes(Buffer.from('hello world', 'utf-8')), null);
});

// --- validateAttachments: 正常系 ---

test('validateAttachments: 有効な PNG 添付は受理される（size はデコード後の実バイト数）', () => {
  const result = validateAttachments([
    { filename: 'photo.png', mimeType: 'image/png', content: PNG_1X1_BASE64 },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].filename, 'photo.png');
  assert.equal(result.files[0].size, pngBuffer().length);
  assert.equal(result.sanitizedFilenameCount, 0);
});

test('validateAttachments: text/markdown の日本語添付は受理される', () => {
  const content = Buffer.from('# 見出し\n本文です', 'utf-8').toString('base64');
  const result = validateAttachments([
    { filename: 'note.md', mimeType: 'text/markdown', content },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.files[0].mimeType, 'text/markdown');
});

test('validateAttachments: 空配列は無添付として受理される', () => {
  const result = validateAttachments([]);
  assert.equal(result.ok, true);
  assert.equal(result.files.length, 0);
  assert.equal(result.totalBytes, 0);
});

test('validateAttachments: 同名ファイル2件は両方受理される（連番は Agent 側の責務）', () => {
  const content = Buffer.from('hello', 'utf-8').toString('base64');
  const result = validateAttachments([
    { filename: 'note.txt', mimeType: 'text/plain', content },
    { filename: 'note.txt', mimeType: 'text/plain', content },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.files.length, 2);
});

test('validateAttachments: basename 化されたファイル名は sanitizedFilenameCount に反映される', () => {
  const result = validateAttachments([
    { filename: '../../../etc/passwd', mimeType: 'image/png', content: PNG_1X1_BASE64 },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.files[0].filename, 'passwd');
  assert.equal(result.sanitizedFilenameCount, 1);
});

// --- validateAttachments: 異常系 ---

test('validateAttachments: 宣言 image/png・実体 JPEG は mimeMismatch で拒否される', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString('base64');
  const result = validateAttachments([
    { filename: 'fake.png', mimeType: 'image/png', content: jpeg },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'itemInvalid');
  assert.equal(result.failures[0].reason, 'mimeMismatch');
});

test('validateAttachments: 宣言 text/plain・実体 PNG は mimeMismatch で拒否される', () => {
  const result = validateAttachments([
    { filename: 'fake.txt', mimeType: 'text/plain', content: PNG_1X1_BASE64 },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.failures[0].reason, 'mimeMismatch');
});

test('validateAttachments: application/pdf は allowlist 外として拒否される', () => {
  const content = Buffer.from('%PDF-1.4', 'utf-8').toString('base64');
  const result = validateAttachments([
    { filename: 'doc.pdf', mimeType: 'application/pdf', content },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.failures[0].reason, 'mimeNotAllowed');
});

test('validateAttachments: application/octet-stream は allowlist 外として拒否される', () => {
  const content = Buffer.from('binary', 'utf-8').toString('base64');
  const result = validateAttachments([
    { filename: 'blob.bin', mimeType: 'application/octet-stream', content },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.failures[0].reason, 'mimeNotAllowed');
});

test('validateAttachments: 5MB を超える単体添付は fileTooLarge で拒否される', () => {
  // PNG シグネチャを先頭に付けた 5MB+1 バイトのバッファ（実 PNG である必要はない、サイズ判定が先に効く）
  const big = Buffer.concat([pngBuffer(), Buffer.alloc(ATTACHMENT_MAX_FILE_SIZE - pngBuffer().length + 1, 0x41)]);
  const result = validateAttachments([
    { filename: 'big.png', mimeType: 'image/png', content: big.toString('base64') },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.failures[0].reason, 'fileTooLarge');
});

test('validateAttachments: 合計10MB超は totalTooLarge で拒否される', () => {
  // 4MB のテキストファイルを3件（合計12MB）
  const chunk = Buffer.alloc(4 * 1024 * 1024, 0x61).toString('base64'); // 'a' で埋める
  const result = validateAttachments([
    { filename: 'a.txt', mimeType: 'text/plain', content: chunk },
    { filename: 'b.txt', mimeType: 'text/plain', content: chunk },
    { filename: 'c.txt', mimeType: 'text/plain', content: chunk },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'totalTooLarge');
  assert.ok(result.detail.totalBytes > ATTACHMENT_MAX_TOTAL_SIZE);
});

test('validateAttachments: 11件は tooManyFiles で拒否される', () => {
  const content = Buffer.from('x', 'utf-8').toString('base64');
  const items = Array.from({ length: ATTACHMENT_MAX_COUNT + 1 }, (_, i) => ({
    filename: `f${i}.txt`, mimeType: 'text/plain', content,
  }));
  const result = validateAttachments(items);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'tooManyFiles');
  assert.equal(result.detail.count, ATTACHMENT_MAX_COUNT + 1);
});

test('validateAttachments: 不正な base64 は base64Invalid で拒否される', () => {
  const result = validateAttachments([
    { filename: 'x.png', mimeType: 'image/png', content: '!!!!not-base64!!!!' },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.failures[0].reason, 'base64Invalid');
});

test('validateAttachments: パストラバーサル名の添付でも拒否ではなく basename 化のうえ受理される（サニタイズ方針の確認）', () => {
  const result = validateAttachments([
    { filename: '/etc/passwd', mimeType: 'image/png', content: PNG_1X1_BASE64 },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.files[0].filename, 'passwd');
});

test('validateAttachments: "." だけのファイル名は filenameInvalid で拒否される', () => {
  const result = validateAttachments([
    { filename: '.', mimeType: 'image/png', content: PNG_1X1_BASE64 },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.failures[0].reason, 'filenameInvalid');
});

test('validateAttachments: 不正な UTF-8 バイト列の text/plain は textInvalidUtf8 で拒否される', () => {
  const invalidUtf8 = Buffer.from([0xff, 0xfe, 0xfd]).toString('base64');
  const result = validateAttachments([
    { filename: 'bad.txt', mimeType: 'text/plain', content: invalidUtf8 },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.failures[0].reason, 'textInvalidUtf8');
});

test('validateAttachments: allowlist の一覧に想定6種が含まれる', () => {
  assert.deepEqual(
    [...ALLOWED_ATTACHMENT_MIME_TYPES].sort(),
    ['image/gif', 'image/jpeg', 'image/png', 'image/webp', 'text/markdown', 'text/plain'].sort()
  );
});
