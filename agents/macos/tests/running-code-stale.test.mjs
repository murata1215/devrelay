// #354: runningCodeStale 判定（複数ファイル対応）の単体テスト。
// 外部 import ゼロの純粋関数（agents/linux/src/services/running-code-stale.ts）を
// コンパイル済み dist から直接 import する（claude-locator.test.mjs と同じ流儀）。
// agents/macos/tests/running-code-stale.test.mjs と byte-for-byte 同一。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideRunningCodeStale, buildRunningCodeTargets } from '../dist/services/running-code-stale.js';

const COMMIT_MS = Date.parse('2026-09-02T00:00:00.000Z');

// ---- decideRunningCodeStale ----

test('decideRunningCodeStale: 全ファイルが新しい → stale:false', () => {
  const files = [
    { path: 'index.js', mtimeMs: Date.parse('2026-09-02T01:00:00.000Z') },
    { path: 'services/ai-runner.js', mtimeMs: Date.parse('2026-09-02T02:00:00.000Z') },
  ];
  const result = decideRunningCodeStale(files, COMMIT_MS);
  assert.deepEqual(result, { stale: false, oldestPath: null, oldestMtimeMs: null });
});

test('decideRunningCodeStale: 1 つだけ古い → stale:true かつ oldestPath がそれ', () => {
  const staleMs = Date.parse('2026-09-01T11:01:03.000Z');
  const files = [
    { path: 'index.js', mtimeMs: Date.parse('2026-09-02T01:00:00.000Z') },
    { path: 'services/ai-runner.js', mtimeMs: staleMs },
  ];
  const result = decideRunningCodeStale(files, COMMIT_MS);
  assert.equal(result.stale, true);
  assert.equal(result.oldestPath, 'services/ai-runner.js');
  assert.equal(result.oldestMtimeMs, staleMs);
});

test('decideRunningCodeStale: 複数古い → 最古を返す', () => {
  const olderMs = Date.parse('2026-08-30T00:00:00.000Z');
  const lessOldMs = Date.parse('2026-09-01T00:00:00.000Z');
  const files = [
    { path: 'services/connection.js', mtimeMs: lessOldMs },
    { path: 'services/ai-runner.js', mtimeMs: olderMs },
    { path: 'services/config.js', mtimeMs: lessOldMs },
  ];
  const result = decideRunningCodeStale(files, COMMIT_MS);
  assert.equal(result.stale, true);
  assert.equal(result.oldestPath, 'services/ai-runner.js');
  assert.equal(result.oldestMtimeMs, olderMs);
});

test('decideRunningCodeStale: mtimeMs:null は無視される（全部 null → stale:false）', () => {
  const files = [
    { path: 'index.js', mtimeMs: null },
    { path: 'services/ai-runner.js', mtimeMs: null },
  ];
  const result = decideRunningCodeStale(files, COMMIT_MS);
  assert.deepEqual(result, { stale: false, oldestPath: null, oldestMtimeMs: null });
});

test('decideRunningCodeStale: 一部が null でも残りで判定する', () => {
  const staleMs = Date.parse('2026-08-01T00:00:00.000Z');
  const files = [
    { path: 'index.js', mtimeMs: null },
    { path: 'services/ai-runner.js', mtimeMs: staleMs },
  ];
  const result = decideRunningCodeStale(files, COMMIT_MS);
  assert.equal(result.stale, true);
  assert.equal(result.oldestPath, 'services/ai-runner.js');
});

test('decideRunningCodeStale: commitMs が NaN → stale:false（fail-open）', () => {
  const files = [
    { path: 'services/ai-runner.js', mtimeMs: Date.parse('2020-01-01T00:00:00.000Z') },
  ];
  const result = decideRunningCodeStale(files, NaN);
  assert.deepEqual(result, { stale: false, oldestPath: null, oldestMtimeMs: null });
});

test('decideRunningCodeStale: 空配列 → stale:false', () => {
  const result = decideRunningCodeStale([], COMMIT_MS);
  assert.deepEqual(result, { stale: false, oldestPath: null, oldestMtimeMs: null });
});

test('decideRunningCodeStale: 境界値（mtimeMs === commitMs は古くない）', () => {
  const files = [
    { path: 'index.js', mtimeMs: COMMIT_MS },
  ];
  const result = decideRunningCodeStale(files, COMMIT_MS);
  assert.deepEqual(result, { stale: false, oldestPath: null, oldestMtimeMs: null });
});

test('decideRunningCodeStale: 境界値のわずか1ms前は古いと判定される', () => {
  const files = [
    { path: 'index.js', mtimeMs: COMMIT_MS - 1 },
  ];
  const result = decideRunningCodeStale(files, COMMIT_MS);
  assert.equal(result.stale, true);
  assert.equal(result.oldestPath, 'index.js');
});

// ---- buildRunningCodeTargets ----

test('buildRunningCodeTargets: Windows パス（バックスラッシュ）で entry + services 3 本を返す', () => {
  const targets = buildRunningCodeTargets('C:\\Users\\x\\agent\\agents\\linux\\dist\\index.js');
  assert.deepEqual(targets, [
    'C:\\Users\\x\\agent\\agents\\linux\\dist\\index.js',
    'C:\\Users\\x\\agent\\agents\\linux\\dist\\services\\ai-runner.js',
    'C:\\Users\\x\\agent\\agents\\linux\\dist\\services\\connection.js',
    'C:\\Users\\x\\agent\\agents\\linux\\dist\\services\\config.js',
  ]);
});

test('buildRunningCodeTargets: POSIX パス（スラッシュ）で entry + services 3 本を返す', () => {
  const targets = buildRunningCodeTargets('/home/devrelay/.devrelay/agent/agents/linux/dist/index.js');
  assert.deepEqual(targets, [
    '/home/devrelay/.devrelay/agent/agents/linux/dist/index.js',
    '/home/devrelay/.devrelay/agent/agents/linux/dist/services/ai-runner.js',
    '/home/devrelay/.devrelay/agent/agents/linux/dist/services/connection.js',
    '/home/devrelay/.devrelay/agent/agents/linux/dist/services/config.js',
  ]);
});

test('buildRunningCodeTargets: ディレクトリ区切りが無い場合は entry のみ返す', () => {
  const targets = buildRunningCodeTargets('index.js');
  assert.deepEqual(targets, ['index.js']);
});
