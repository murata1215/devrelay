// #添付対応 Part B: Agent 側ファイル保存の多重防御（sanitizeSavedFilename / saveReceivedFiles）の単体テスト。
// コンパイル済み dist から直接 import する（atomic-write.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitizeSavedFilename, saveReceivedFiles, buildPromptWithFiles } from '../dist/services/file-handler.js';

// --- sanitizeSavedFilename ---

test('sanitizeSavedFilename: 通常のファイル名はそのまま返す', () => {
  assert.equal(sanitizeSavedFilename('photo.png'), 'photo.png');
});

test('sanitizeSavedFilename: 日本語ファイル名はそのまま許可する', () => {
  assert.equal(sanitizeSavedFilename('スクリーンショット.png'), 'スクリーンショット.png');
});

test('sanitizeSavedFilename: パストラバーサル（/区切り）は basename 化される', () => {
  assert.equal(sanitizeSavedFilename('../../../etc/passwd'), 'passwd');
});

test('sanitizeSavedFilename: パストラバーサル（\\区切り、win32形式）は basename 化される', () => {
  assert.equal(sanitizeSavedFilename('..\\..\\windows\\system32\\x.png'), 'x.png');
});

test('sanitizeSavedFilename: "." のみは attachment にフォールバックする', () => {
  assert.equal(sanitizeSavedFilename('.'), 'attachment');
});

test('sanitizeSavedFilename: ".." のみは attachment にフォールバックする', () => {
  assert.equal(sanitizeSavedFilename('..'), 'attachment');
});

test('sanitizeSavedFilename: 空文字は attachment にフォールバックする', () => {
  assert.equal(sanitizeSavedFilename(''), 'attachment');
});

test('sanitizeSavedFilename: basename 化した結果が空になる場合も attachment にフォールバックする', () => {
  assert.equal(sanitizeSavedFilename('foo/'), 'attachment');
});

test('sanitizeSavedFilename: 改行を含むファイル名は制御文字が除去される', () => {
  assert.equal(sanitizeSavedFilename('a\nb.png'), 'ab.png');
});

test('sanitizeSavedFilename: CRを含むファイル名は制御文字が除去される', () => {
  assert.equal(sanitizeSavedFilename('a\rb.png'), 'ab.png');
});

test('sanitizeSavedFilename: NUL文字を含むファイル名は除去される（拒否ではなく正規化）', () => {
  assert.equal(sanitizeSavedFilename('a\u0000b.png'), 'ab.png');
});

test('sanitizeSavedFilename: 121文字のファイル名は120文字に切り詰められる', () => {
  const raw = 'a'.repeat(121) + '.png';
  const result = sanitizeSavedFilename(raw);
  assert.equal(result.length, 120);
  assert.equal(result, raw.slice(0, 120));
});

test('sanitizeSavedFilename: 120文字ちょうどのファイル名は切り詰められない', () => {
  const raw = 'a'.repeat(120);
  assert.equal(sanitizeSavedFilename(raw), raw);
});

// --- saveReceivedFiles ---

test('saveReceivedFiles: 画像添付が .devrelay-files/ に正しいバイト列で書き出される', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devrelay-attach-'));
  try {
    // 1x1 PNG（実バイナリ）
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const paths = await saveReceivedFiles(dir, [
      { filename: 'photo.png', mimeType: 'image/png', content: pngBase64, size: 0 },
    ]);
    assert.equal(paths.length, 1);
    const written = await readFile(paths[0]);
    const expected = Buffer.from(pngBase64, 'base64');
    assert.ok(written.equals(expected), 'written bytes must match original PNG bytes exactly');
    assert.ok(paths[0].includes('.devrelay-files'));
    assert.ok(paths[0].endsWith('_photo.png'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('saveReceivedFiles: トラバーサル名を渡しても filesDir の外に書き込まれない', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devrelay-attach-'));
  try {
    const paths = await saveReceivedFiles(dir, [
      { filename: '../../../etc/passwd', mimeType: 'text/plain', content: Buffer.from('pwned').toString('base64'), size: 0 },
    ]);
    assert.equal(paths.length, 1);
    // サニタイズ後は basename 化されるため .devrelay-files 配下に収まるはず
    assert.ok(paths[0].startsWith(join(dir, '.devrelay-files')));
    assert.ok(paths[0].endsWith('_passwd'));
    // 実際に外側にファイルが作られていないことも確認する
    const escaped = join(dir, '..', 'etc-passwd-should-not-exist');
    await assert.rejects(readFile(escaped));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('saveReceivedFiles: 同名ファイル2件は連番が付与される（既存挙動の非退行）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devrelay-attach-'));
  try {
    const content = Buffer.from('hello').toString('base64');
    const paths = await saveReceivedFiles(dir, [
      { filename: 'note.txt', mimeType: 'text/plain', content, size: 0 },
      { filename: 'note.txt', mimeType: 'text/plain', content, size: 0 },
    ]);
    assert.equal(paths.length, 2);
    assert.ok(paths[0].endsWith('_note.txt'));
    assert.ok(paths[1].endsWith('_note_2.txt'));
    const entries = await readdir(join(dir, '.devrelay-files'));
    assert.equal(entries.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('saveReceivedFiles: 空配列を渡すと何も保存されない', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devrelay-attach-'));
  try {
    const paths = await saveReceivedFiles(dir, []);
    assert.deepEqual(paths, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- buildPromptWithFiles（既存挙動の非退行確認） ---

test('buildPromptWithFiles: ファイルなしの場合はプロンプトをそのまま返す', () => {
  assert.equal(buildPromptWithFiles('hello', []), 'hello');
});

test('buildPromptWithFiles: ファイルありの場合は絶対パス一覧を前置する', () => {
  const result = buildPromptWithFiles('hello', ['/tmp/a.png', '/tmp/b.png']);
  assert.ok(result.includes('/tmp/a.png'));
  assert.ok(result.includes('/tmp/b.png'));
  assert.ok(result.endsWith('hello'));
});
