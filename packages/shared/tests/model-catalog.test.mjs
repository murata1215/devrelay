// #353: packages/shared/src/constants.ts の AI_MODEL_CATALOG / UTILITY_MODEL_ANTHROPIC のテスト
// （コンパイル済み dist を直接 import、node:test）。
// Claude Fable 5.1 追加時の回帰防止 + 「ID 重複」「危険文字混入」「内部ユーティリティモデルの
// 意図しない書き換え」を仕組みで検出する。

import test from 'node:test';
import assert from 'node:assert/strict';
import { AI_MODEL_CATALOG, UTILITY_MODEL_ANTHROPIC, isUnsafeModelId } from '../dist/constants.js';

test('claude カタログに claude-fable-5-1 が存在する', () => {
  const ids = AI_MODEL_CATALOG.claude.map((m) => m.id);
  assert.ok(ids.includes('claude-fable-5-1'), `claude-fable-5-1 が見つからない: ${JSON.stringify(ids)}`);
});

test('claude カタログから既存モデルが削除されていない（#353 時点で削除対象は0件）', () => {
  const ids = AI_MODEL_CATALOG.claude.map((m) => m.id);
  const expectedRetained = [
    'claude-fable-5',
    'claude-opus-5',
    'claude-opus-4-8',
    'claude-sonnet-5',
    'claude-haiku-4-5',
    'opus',
    'sonnet',
    'haiku',
  ];
  for (const id of expectedRetained) {
    assert.ok(ids.includes(id), `既存モデル ${id} が削除されている`);
  }
});

test('全ツールの全モデル ID が isUnsafeModelId() を通過する（危険文字を含まない）', () => {
  const offenders = [];
  for (const [tool, models] of Object.entries(AI_MODEL_CATALOG)) {
    for (const m of models) {
      if (isUnsafeModelId(m.id)) {
        offenders.push(`${tool}:${m.id}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `危険文字を含む ID: ${JSON.stringify(offenders)}`);
});

test('各ツール内でモデル ID が重複していない', () => {
  const dupes = [];
  for (const [tool, models] of Object.entries(AI_MODEL_CATALOG)) {
    const ids = models.map((m) => m.id);
    const seen = new Set();
    for (const id of ids) {
      if (seen.has(id)) dupes.push(`${tool}:${id}`);
      seen.add(id);
    }
  }
  assert.deepEqual(dupes, [], `重複 ID: ${JSON.stringify(dupes)}`);
});

test('UTILITY_MODEL_ANTHROPIC は #353 時点の値から変更されていない（値の意図しない変更を検出）', () => {
  // #353: 7箇所のハードコードをこの定数に集約したのみで、モデル自体の差し替えは別サイクル。
  // 値が変わった場合は、集約元7箇所すべてが temperature を渡している点を再確認すること
  // （temperature は Claude Opus 4.7 以降で 400 エラーになる）。
  assert.equal(UTILITY_MODEL_ANTHROPIC, 'claude-haiku-4-5-20251001');
});

test('UTILITY_MODEL_ANTHROPIC はユーザー選択可能な AI_MODEL_CATALOG.claude と独立している', () => {
  // ユーザー向けカタログに含まれていても含まれていなくても構わない（別軸の定数であることの確認）。
  assert.equal(typeof UTILITY_MODEL_ANTHROPIC, 'string');
  assert.ok(UTILITY_MODEL_ANTHROPIC.length > 0);
});
