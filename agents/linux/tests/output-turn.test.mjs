// ターン単位の出力フォルダ（output-collector.ts の beginOutputTurn / collectTurnOutputFiles）の単体テスト。
// 同じプロジェクトで 2 スレッドが並行して動いたとき、互いの成果物が混ざらないことを確認する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir, utimes, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  beginOutputTurn,
  collectTurnOutputFiles,
  makeTurnDirName,
  buildOutputDirInstruction,
} from '../dist/services/output-collector.js';

const names = (files) => files.map((f) => f.filename).sort();

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
  assert.deepEqual(names(await collectTurnOutputFiles(a)), ['a.html']);
  assert.deepEqual(names(await collectTurnOutputFiles(b)), ['b.html']);
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
  assert.deepEqual(names(await collectTurnOutputFiles(t)), ['edit.txt', 'new.txt']);
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
