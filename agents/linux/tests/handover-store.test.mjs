// スレッド引継ぎ（`n` コマンド）: handover-store.ts の単体テスト。
// コンパイル済み dist から直接 import する（atomic-write.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyHandover,
  loadActiveHandover,
  markHandoverInjected,
  formatHandoverForPrompt,
  unusedHandoverStamp,
  handoverFileName,
} from '../dist/services/handover-store.js';

const SRC = 'cmh1a2b3c4d5e6f7g8h9i0j1k';
const SRC2 = 'cmh2b2b3c4d5e6f7g8h9i0j1k';
const TGT = 'cmh9z8y7x6w5v4u3t2s1r0q9p';
const TGT2 = 'cmh8z8y7x6w5v4u3t2s1r0q9p';

async function withProject(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'devrelay-handover-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const listHandover = async (project) => (await readdir(join(project, 'doc', 'handover'))).filter((n) => !n.startsWith('.')).sort();

test('unusedHandoverStamp: 未使用名だけを判定する', () => {
  assert.equal(unusedHandoverStamp(`20261031_105130_${SRC}.md`, SRC), '20261031_105130');
  assert.equal(unusedHandoverStamp(`20261031_105130_${SRC}_${TGT}.md`, SRC), null);
  assert.equal(unusedHandoverStamp(`20261031_105130_${SRC2}.md`, SRC), null);
  assert.equal(unusedHandoverStamp(`x0261031_105130_${SRC}.md`, SRC), null);
});

test('applyHandover: doc/handover に使用中ファイルを作り、scope dir にポインタを書く', async () => {
  await withProject(async (project) => {
    const { fileName } = await applyHandover({
      projectPath: project, sourceSessionId: SRC, targetSessionId: TGT, targetAgentScopeId: TGT,
      stamp: '20261031_105130', content: '# T\n本文\n',
    });
    assert.equal(fileName, `20261031_105130_${SRC}_${TGT}.md`);
    assert.deepEqual(await listHandover(project), [fileName]);
    assert.equal(await readFile(join(project, 'doc', 'handover', fileName), 'utf-8'), '# T\n本文\n');

    const active = await loadActiveHandover(project, TGT);
    assert.equal(active.sourceSessionId, SRC);
    assert.equal(active.fileName, fileName);
    assert.equal(active.pending, true);
    assert.equal(active.replaced, false);

    // 冪等: 同じ指示をもう一度受けても同じ結果
    await applyHandover({
      projectPath: project, sourceSessionId: SRC, targetSessionId: TGT, targetAgentScopeId: TGT,
      stamp: '20261031_105130', content: '# T\n本文\n',
    });
    assert.deepEqual(await listHandover(project), [fileName]);
    assert.equal((await loadActiveHandover(project, TGT)).replaced, false);
  });
});

test('applyHandover: 未使用ファイルがあれば使用中名にリネームする', async () => {
  await withProject(async (project) => {
    const dir = join(project, 'doc', 'handover');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, handoverFileName('20261031_105130', SRC)), 'old');
    await applyHandover({
      projectPath: project, sourceSessionId: SRC, targetSessionId: TGT, targetAgentScopeId: TGT,
      stamp: '20261031_105130', content: 'new',
    });
    assert.deepEqual(await listHandover(project), [`20261031_105130_${SRC}_${TGT}.md`]);
  });
});

test('applyHandover: 差し替えると旧ファイルは未使用名に戻り、replaced が立つ', async () => {
  await withProject(async (project) => {
    await applyHandover({ projectPath: project, sourceSessionId: SRC, targetSessionId: TGT, targetAgentScopeId: TGT, stamp: '20261031_105130', content: 'A' });
    await markHandoverInjected(project, TGT);
    assert.equal((await loadActiveHandover(project, TGT)).pending, false);

    await applyHandover({
      projectPath: project, sourceSessionId: SRC2, targetSessionId: TGT, targetAgentScopeId: TGT,
      stamp: '20261031_110000', content: 'B', previous: { sourceSessionId: SRC, stamp: '20261031_105130' },
    });
    assert.deepEqual(await listHandover(project), [`20261031_105130_${SRC}.md`, `20261031_110000_${SRC2}_${TGT}.md`].sort());
    const active = await loadActiveHandover(project, TGT);
    assert.equal(active.content, 'B');
    assert.equal(active.pending, true);
    assert.equal(active.replaced, true);
    assert.match(formatHandoverForPrompt(active), /以前の引継ぎは破棄/);

    await markHandoverInjected(project, TGT);
    const after = await loadActiveHandover(project, TGT);
    assert.equal(after.pending, false);
    assert.equal(after.replaced, false);
  });
});

test('applyHandover: 他スレッドで使用中のコピーが残っていれば、外したファイルは削除する', async () => {
  await withProject(async (project) => {
    // SRC の引継ぎ書を TGT と TGT2 の両方で使う（2 つ目はコピー相当）
    await applyHandover({ projectPath: project, sourceSessionId: SRC, targetSessionId: TGT, targetAgentScopeId: TGT, stamp: '20261031_105130', content: 'A' });
    await applyHandover({ projectPath: project, sourceSessionId: SRC, targetSessionId: TGT2, targetAgentScopeId: TGT2, stamp: '20261031_105130', content: 'A' });
    // TGT を SRC2 に差し替え → TGT の旧ファイルは TGT2 のコピーが残っているので削除
    await applyHandover({
      projectPath: project, sourceSessionId: SRC2, targetSessionId: TGT, targetAgentScopeId: TGT,
      stamp: '20261031_120000', content: 'B', previous: { sourceSessionId: SRC, stamp: '20261031_105130' },
    });
    assert.deepEqual(await listHandover(project), [
      `20261031_105130_${SRC}_${TGT2}.md`,
      `20261031_120000_${SRC2}_${TGT}.md`,
    ].sort());
  });
});

test('applyHandover: 同じ元スレッドの古い未使用ファイルを消す', async () => {
  await withProject(async (project) => {
    const dir = join(project, 'doc', 'handover');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, handoverFileName('20261030_090000', SRC)), 'older');
    await applyHandover({ projectPath: project, sourceSessionId: SRC, targetSessionId: TGT, targetAgentScopeId: TGT, stamp: '20261031_105130', content: 'A' });
    assert.deepEqual(await listHandover(project), [`20261031_105130_${SRC}_${TGT}.md`]);
  });
});

test('applyHandover（n make）: 未使用ファイルを書き、古い未使用を消し、ポインタは書かない', async () => {
  await withProject(async (project) => {
    const first = await applyHandover({ projectPath: project, sourceSessionId: SRC, stamp: '20261031_105130', content: 'v1' });
    assert.equal(first.fileName, `20261031_105130_${SRC}.md`);
    const second = await applyHandover({ projectPath: project, sourceSessionId: SRC, stamp: '20261031_130000', content: 'v2' });
    assert.equal(second.fileName, `20261031_130000_${SRC}.md`);
    assert.deepEqual(await listHandover(project), [`20261031_130000_${SRC}.md`]);
    assert.equal(await readFile(join(project, 'doc', 'handover', second.fileName), 'utf-8'), 'v2');
    assert.equal(await loadActiveHandover(project, SRC), null);

    // その後 n 1 で使うと、未使用ファイルが使用中名にリネームされる
    await applyHandover({ projectPath: project, sourceSessionId: SRC, targetSessionId: TGT, targetAgentScopeId: TGT, stamp: '20261031_130000', content: 'v2' });
    assert.deepEqual(await listHandover(project), [`20261031_130000_${SRC}_${TGT}.md`]);
  });
});

test('applyHandover: 旧スレッド（agentScopeId 無し）は .devrelay/ 直下にポインタを書く', async () => {
  await withProject(async (project) => {
    await applyHandover({ projectPath: project, sourceSessionId: SRC, targetSessionId: TGT, stamp: '20261031_105130', content: 'A' });
    const raw = JSON.parse(await readFile(join(project, '.devrelay', 'handover.json'), 'utf-8'));
    assert.equal(raw.sourceSessionId, SRC);
  });
});

test('applyHandover: 不正な ID・スタンプは拒否する', async () => {
  await withProject(async (project) => {
    await assert.rejects(applyHandover({ projectPath: project, sourceSessionId: '../x', targetSessionId: TGT, stamp: '20261031_105130', content: 'A' }));
    await assert.rejects(applyHandover({ projectPath: project, sourceSessionId: SRC, targetSessionId: TGT, stamp: '2026', content: 'A' }));
  });
});

test('formatHandoverForPrompt: ファイルの場所と本文を含む（英語版も）', () => {
  const h = { sourceSessionId: SRC, stamp: '20261031_105130', fileName: 'f.md', content: '# T\nbody', pending: true, replaced: false, updatedAt: '' };
  const ja = formatHandoverForPrompt(h);
  assert.match(ja, /【前スレッドからの引継ぎ】/);
  assert.match(ja, /doc\/handover\/f\.md/);
  assert.match(ja, /# T\nbody/);
  assert.match(formatHandoverForPrompt(h, 'en'), /Handover from the previous thread/);
});
