// ターン単位の出力フォルダ（output-collector.ts の beginOutputTurn / collectTurnOutputFiles）の単体テスト。
// 同じプロジェクトで 2 スレッドが並行して動いたとき、互いの成果物が混ざらないことを確認する。
// 2026-11-22: サブフォルダ再帰収集・上限超過時のスキップ通知を追加した際にテストも拡張。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir, utimes, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  beginOutputTurn,
  collectTurnOutputFiles,
  makeTurnDirName,
  buildOutputDirInstruction,
  buildSkippedOutputNotice,
} from '../dist/services/output-collector.js';

const names = (attachments) => attachments.map((f) => f.filename).sort();

test('makeTurnDirName: パス区切りやドットを除去し turn_ を付ける', () => {
  assert.equal(makeTurnDirName('abc-123_X'), 'turn_abc-123_X');
  assert.equal(makeTurnDirName('../../etc'), 'turn_etc');
  assert.ok(makeTurnDirName('').startsWith('turn_'));
  assert.ok(makeTurnDirName('a'.repeat(100)).length <= 'turn_'.length + 40);
});

test('並行する 2 ターンは自分のフォルダのファイルだけを集める', async () => {
  const proj = await mkdtemp(join(tmpdir(), 'devrelay-output-turn-'));
  const a = await beginOutputTurn(proj, 'turnA');
  const b = await beginOutputTurn(proj, 'turnB');
  await writeFile(join(proj, a.relDir, 'a.html'), 'A');
  await writeFile(join(proj, b.relDir, 'b.html'), 'B');
  assert.deepEqual(names((await collectTurnOutputFiles(a)).attachments), ['a.html']);
  assert.deepEqual(names((await collectTurnOutputFiles(b)).attachments), ['b.html']);
});

test('B の開始で A の作りかけファイルが消えない', async () => {
  const proj = await mkdtemp(join(tmpdir(), 'devrelay-output-turn-'));
  const a = await beginOutputTurn(proj, 'turnA');
  await writeFile(join(proj, a.relDir, 'a.pdf'), 'A');
  await writeFile(join(proj, '.devrelay-output', 'root-a.txt'), 'A');
  await beginOutputTurn(proj, 'turnB');
  assert.deepEqual(await readdir(join(proj, a.relDir)), ['a.pdf']);
  assert.ok((await readdir(join(proj, '.devrelay-output'))).includes('root-a.txt'));
});

test('直下: ターン開始前からあるファイルは送らず、新規・更新分だけ送る', async () => {
  const proj = await mkdtemp(join(tmpdir(), 'devrelay-output-turn-'));
  const out = join(proj, '.devrelay-output');
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'old.txt'), 'old');
  await writeFile(join(out, 'edit.txt'), 'v1');
  const t = await beginOutputTurn(proj, 'turnC');
  await writeFile(join(out, 'new.txt'), 'new');
  await writeFile(join(out, 'edit.txt'), 'v2-longer');
  assert.deepEqual(names((await collectTurnOutputFiles(t)).attachments), ['edit.txt', 'new.txt']);
});

test('24 時間以上前の直下ファイルと turn_ フォルダは履歴に退避して片付ける', async () => {
  const proj = await mkdtemp(join(tmpdir(), 'devrelay-output-turn-'));
  const old = await beginOutputTurn(proj, 'old');
  await writeFile(join(proj, old.relDir, 'x.txt'), 'x');
  const stale = new Date(Date.now() - 48 * 3600 * 1000);
  await utimes(join(proj, old.relDir), stale, stale);
  await writeFile(join(proj, '.devrelay-output', 'stale.txt'), 's');
  await utimes(join(proj, '.devrelay-output', 'stale.txt'), stale, stale);
  await mkdir(join(proj, '.devrelay-output', 'user-dir'));
  await utimes(join(proj, '.devrelay-output', 'user-dir'), stale, stale);

  await beginOutputTurn(proj, 'fresh');
  const left = (await readdir(join(proj, '.devrelay-output'))).sort();
  assert.deepEqual(left, ['turn_fresh', 'user-dir']);
  const hist = await readdir(join(proj, '.devrelay-output-history'));
  assert.ok(hist.some((n) => n.endsWith('_stale.txt')));
  assert.ok(hist.some((n) => n.endsWith('_turn_old_x.txt')));
});

test('prune: false では古いものも片付けない', async () => {
  const proj = await mkdtemp(join(tmpdir(), 'devrelay-output-turn-'));
  await mkdir(join(proj, '.devrelay-output'), { recursive: true });
  await writeFile(join(proj, '.devrelay-output', 'stale.txt'), 's');
  const stale = new Date(Date.now() - 48 * 3600 * 1000);
  await utimes(join(proj, '.devrelay-output', 'stale.txt'), stale, stale);
  await beginOutputTurn(proj, 'eph', { prune: false });
  assert.ok((await readdir(join(proj, '.devrelay-output'))).includes('stale.txt'));
});

test('指示文はターン専用フォルダを案内する', async () => {
  const proj = await mkdtemp(join(tmpdir(), 'devrelay-output-turn-'));
  const t = await beginOutputTurn(proj, 'turnD');
  assert.ok(buildOutputDirInstruction(t).includes('.devrelay-output/turn_turnD/'));
});

// --- 2026-11-22: サブフォルダ再帰収集 ---

test('サブフォルダ内のファイルも相対パス（/区切り）で集まる', async () => {
  const proj = await mkdtemp(join(tmpdir(), 'devrelay-output-turn-'));
  const t = await beginOutputTurn(proj, 'turnSub');
  await mkdir(join(proj, t.relDir, 'sub', 'deep'), { recursive: true });
  await writeFile(join(proj, t.relDir, 'top.txt'), 'top');
  await writeFile(join(proj, t.relDir, 'sub', 'a.png'), 'a');
  await writeFile(join(proj, t.relDir, 'sub', 'deep', 'b.txt'), 'b');
  const { attachments, skipped } = await collectTurnOutputFiles(t);
  assert.deepEqual(names(attachments), ['sub/a.png', 'sub/deep/b.txt', 'top.txt']);
  assert.deepEqual(skipped, []);
  const png = attachments.find((f) => f.filename === 'sub/a.png');
  assert.equal(png.mimeType, 'image/png');
});

test('.devrelay-output/ 直下のサブフォルダは集めない（turn_ 混線の回帰防止）', async () => {
  const proj = await mkdtemp(join(tmpdir(), 'devrelay-output-turn-'));
  const out = join(proj, '.devrelay-output');
  await mkdir(join(out, 'other-thread-dir'), { recursive: true });
  await writeFile(join(out, 'other-thread-dir', 'hidden.txt'), 'x');
  const t = await beginOutputTurn(proj, 'turnE');
  const { attachments } = await collectTurnOutputFiles(t);
  assert.deepEqual(names(attachments), []);
});

test('シンボリックリンクのフォルダ・ファイルは辿らない', async () => {
  const proj = await mkdtemp(join(tmpdir(), 'devrelay-output-turn-'));
  const outsideDir = await mkdtemp(join(tmpdir(), 'devrelay-outside-'));
  await writeFile(join(outsideDir, 'secret.txt'), 'secret');
  const t = await beginOutputTurn(proj, 'turnLink');
  await symlink(outsideDir, join(proj, t.relDir, 'escape-dir'));
  await writeFile(join(proj, t.relDir, 'real.txt'), 'real');
  await symlink(join(proj, t.relDir, 'real.txt'), join(proj, t.relDir, 'real-link.txt'));
  const { attachments } = await collectTurnOutputFiles(t);
  assert.deepEqual(names(attachments), ['real.txt']);
});

test('MAX_FILE_SIZE 超のファイルは skipped に too-large として記録される', async () => {
  const proj = await mkdtemp(join(tmpdir(), 'devrelay-output-turn-'));
  const t = await beginOutputTurn(proj, 'turnBig');
  // 25MB 上限を超える 26MB のダミーファイル
  await writeFile(join(proj, t.relDir, 'big.bin'), Buffer.alloc(26 * 1024 * 1024));
  const { attachments, skipped } = await collectTurnOutputFiles(t);
  assert.deepEqual(attachments, []);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].path, 'big.bin');
  assert.equal(skipped[0].reason, 'too-large');
  assert.ok(skipped[0].absPath.endsWith('big.bin'));
});

test('合計サイズ上限を超えると以降が total-limit で skip される', async () => {
  const proj = await mkdtemp(join(tmpdir(), 'devrelay-output-turn-'));
  const t = await beginOutputTurn(proj, 'turnTotal');
  // 1ファイル上限(25MB)未満だが、3つ合計で40MBの上限を超える15MB x 3
  await writeFile(join(proj, t.relDir, 'a.bin'), Buffer.alloc(15 * 1024 * 1024));
  await writeFile(join(proj, t.relDir, 'b.bin'), Buffer.alloc(15 * 1024 * 1024));
  await writeFile(join(proj, t.relDir, 'c.bin'), Buffer.alloc(15 * 1024 * 1024));
  const { attachments, skipped } = await collectTurnOutputFiles(t);
  assert.equal(attachments.length, 2); // a, b は収まるが c は合計40MB超で skip
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].path, 'c.bin');
  assert.equal(skipped[0].reason, 'total-limit');
});

test('buildSkippedOutputNotice: スキップが無ければ空文字', () => {
  assert.equal(buildSkippedOutputNotice([]), '');
});

test('buildSkippedOutputNotice: ファイル名・理由・絶対パスを含む', () => {
  const notice = buildSkippedOutputNotice([
    { path: 'report/best.mp4', absPath: '/proj/.devrelay-output/turn_x/report/best.mp4', size: 58 * 1024 * 1024, reason: 'too-large' },
  ]);
  assert.ok(notice.includes('report/best.mp4'));
  assert.ok(notice.includes('/proj/.devrelay-output/turn_x/report/best.mp4'));
  assert.ok(notice.includes('58.0MB'));
});
