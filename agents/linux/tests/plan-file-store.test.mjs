// #375: 全 AI ツール共通のプランファイル保存（plan-file-store.ts）の単体テスト。
// コンパイル済み dist から直接 import する（atomic-write.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildPlanFileName,
  selectLatestPlanFileName,
  isSavablePlanText,
  savePlanFile,
  loadLatestPlanFile,
} from '../dist/services/plan-file-store.js';

// --- buildPlanFileName ---

test('buildPlanFileName: 固定幅ゼロ埋めの YYYYMMDD-HHmmss.md を返す', () => {
  const d = new Date(2026, 8, 7, 9, 5, 3); // 2026-09-07 09:05:03（月は0始まり）
  assert.equal(buildPlanFileName(d), '20260907-090503.md');
});

test('buildPlanFileName: 名前の辞書順が生成時刻の時系列順と一致する', () => {
  const earlier = buildPlanFileName(new Date(2026, 8, 7, 9, 0, 0));
  const later = buildPlanFileName(new Date(2026, 8, 7, 9, 0, 1));
  assert.ok(earlier < later);
});

// --- selectLatestPlanFileName ---

test('selectLatestPlanFileName: 複数ファイルから辞書順最大（= 最新）を選ぶ', () => {
  const names = ['20260907-090000.md', '20260907-090503.md', '20260906-235959.md'];
  assert.equal(selectLatestPlanFileName(names), '20260907-090503.md');
});

test('selectLatestPlanFileName: .md 以外の混入ファイルを無視する', () => {
  const names = ['20260907-090503.md', '.gitkeep', 'notes.txt'];
  assert.equal(selectLatestPlanFileName(names), '20260907-090503.md');
});

test('selectLatestPlanFileName: 空配列は null を返す', () => {
  assert.equal(selectLatestPlanFileName([]), null);
});

// --- isSavablePlanText ---

test('isSavablePlanText: 空文字・空白のみは false', () => {
  assert.equal(isSavablePlanText(''), false);
  assert.equal(isSavablePlanText('   \n\t  '), false);
});

test('isSavablePlanText: 極端に短い断片は false', () => {
  assert.equal(isSavablePlanText('ok'), false);
});

test('isSavablePlanText: 通常のプラン本文は true', () => {
  assert.equal(isSavablePlanText('## Plan\n\nこの手順で実装します。'), true);
});

// --- savePlanFile / loadLatestPlanFile（実ファイルシステム） ---

test('savePlanFile → loadLatestPlanFile: 保存した内容がそのまま読み戻せる', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devrelay-375-plan-'));
  try {
    const content = '## Plan\n\nこの手順で実装します。';
    const filename = await savePlanFile(dir, content);
    assert.ok(filename && filename.endsWith('.md'));

    const loaded = await loadLatestPlanFile(dir);
    assert.ok(loaded);
    assert.equal(loaded.filename, filename);
    assert.equal(loaded.content, content);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('savePlanFile: 保存に値しない本文は保存せず null を返す', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devrelay-375-plan-'));
  try {
    const result = await savePlanFile(dir, '  ');
    assert.equal(result, null);

    const loaded = await loadLatestPlanFile(dir);
    assert.equal(loaded, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadLatestPlanFile: ディレクトリが存在しない場合は null を返す', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devrelay-375-plan-'));
  try {
    const loaded = await loadLatestPlanFile(join(dir, 'nonexistent-project'));
    assert.equal(loaded, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('savePlanFile: 上限（20件）を超えると最も古いファイルから削除される', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devrelay-375-plan-'));
  try {
    const plansDir = join(dir, '.devrelay', 'plans');
    await mkdir(plansDir, { recursive: true });
    // 過去日付（savePlanFile が今回生成する実時刻より必ず辞書順で小さくなる）のダミーファイルを
    // 25件事前に作成し、最古のもの（20260101-000000.md）が削除対象になることを検証する。
    for (let i = 0; i < 25; i++) {
      const name = `20260101-${String(i).padStart(6, '0')}.md`;
      await writeFile(join(plansDir, name), `dummy ${i}`, 'utf-8');
    }
    const before = (await readdir(plansDir)).filter((n) => n.endsWith('.md'));
    assert.equal(before.length, 25);

    // これで26件になり、上限20件を超えた6件（最古から）が削除されるはず
    const saved = await savePlanFile(dir, '## Plan\n\nこの手順で実装します。');
    assert.ok(saved);

    const after = (await readdir(plansDir)).filter((n) => n.endsWith('.md'));
    assert.equal(after.length, 20);
    // 最古のダミーファイルは削除され、直近に保存した実ファイルは残っていること
    assert.ok(!after.includes('20260101-000000.md'));
    assert.ok(after.includes(saved));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
