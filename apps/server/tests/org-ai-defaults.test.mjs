// #372: 組織 AI デフォルト設定の純粋関数（apps/server/src/services/org-ai-defaults.ts）の単体テスト。
// コンパイル済み dist から直接 import する（#308/#331〜#334 と同じ流儀）。
// resolveOrgAiContext / isModelSettingLocked は prisma に依存するため対象外
// （isOrgAiDefaultKey のキー判定ロジックでロック対象/対象外の分岐は検証できる）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isOrgAiDefaultKey,
  parseOrgAiDefaults,
  serializeOrgAiDefaults,
  decideEffectiveModel,
} from '../dist/services/org-ai-defaults.js';

// --- isOrgAiDefaultKey ---

test('isOrgAiDefaultKey: 8キーすべてを true と判定する', () => {
  const keys = [
    'claude_model_plan', 'claude_model_exec',
    'codex_model_plan', 'codex_model_exec',
    'gemini_model_plan', 'gemini_model_exec',
    'devin_model_plan', 'devin_model_exec',
  ];
  for (const key of keys) {
    assert.equal(isOrgAiDefaultKey(key), true, `${key} は true であるべき`);
  }
});

test('isOrgAiDefaultKey: モデル設定キー以外は false', () => {
  assert.equal(isOrgAiDefaultKey('language'), false);
  assert.equal(isOrgAiDefaultKey('theme'), false);
  assert.equal(isOrgAiDefaultKey('claude_model_planX'), false);
  assert.equal(isOrgAiDefaultKey('aider_model_plan'), false);
});

// --- parseOrgAiDefaults ---

test('parseOrgAiDefaults: null/undefined/空文字は空オブジェクト', () => {
  assert.deepEqual(parseOrgAiDefaults(null), {});
  assert.deepEqual(parseOrgAiDefaults(undefined), {});
  assert.deepEqual(parseOrgAiDefaults(''), {});
});

test('parseOrgAiDefaults: 不正な JSON は fail-open で空オブジェクト', () => {
  assert.deepEqual(parseOrgAiDefaults('{not json'), {});
});

test('parseOrgAiDefaults: 配列は空オブジェクト', () => {
  assert.deepEqual(parseOrgAiDefaults('["a", "b"]'), {});
});

test('parseOrgAiDefaults: 正常な JSON をそのままパースする', () => {
  const raw = JSON.stringify({ claude_model_plan: 'sonnet', devin_model_exec: 'opus' });
  assert.deepEqual(parseOrgAiDefaults(raw), { claude_model_plan: 'sonnet', devin_model_exec: 'opus' });
});

test('parseOrgAiDefaults: モデル設定キー以外は除外する', () => {
  const raw = JSON.stringify({ claude_model_plan: 'sonnet', language: 'ja' });
  assert.deepEqual(parseOrgAiDefaults(raw), { claude_model_plan: 'sonnet' });
});

test('parseOrgAiDefaults: 危険文字を含む値・空白を含む値は除外する', () => {
  const raw = JSON.stringify({
    claude_model_plan: 'sonnet; rm -rf /',
    codex_model_plan: 'has space',
    gemini_model_plan: 'ok-value',
  });
  assert.deepEqual(parseOrgAiDefaults(raw), { gemini_model_plan: 'ok-value' });
});

test('parseOrgAiDefaults: 非文字列の値・空文字列の値は除外する', () => {
  const raw = JSON.stringify({ claude_model_plan: 123, codex_model_plan: '', gemini_model_plan: 'ok' });
  assert.deepEqual(parseOrgAiDefaults(raw), { gemini_model_plan: 'ok' });
});

// --- serializeOrgAiDefaults ---

test('serializeOrgAiDefaults: 空オブジェクトは null', () => {
  assert.equal(serializeOrgAiDefaults({}), null);
});

test('serializeOrgAiDefaults: 空文字列のみのマップは null', () => {
  assert.equal(serializeOrgAiDefaults({ claude_model_plan: '' }), null);
});

test('serializeOrgAiDefaults: モデル設定キー以外は除外してシリアライズする', () => {
  const result = serializeOrgAiDefaults({ claude_model_plan: 'sonnet', language: 'ja' });
  assert.deepEqual(JSON.parse(result), { claude_model_plan: 'sonnet' });
});

test('serializeOrgAiDefaults → parseOrgAiDefaults: ラウンドトリップで一致する', () => {
  const input = { claude_model_plan: 'sonnet', devin_model_exec: 'opus' };
  const serialized = serializeOrgAiDefaults(input);
  assert.deepEqual(parseOrgAiDefaults(serialized), input);
});

// --- decideEffectiveModel ---

test('decideEffectiveModel: canOverride=true, userValue あり → user が最優先', () => {
  const result = decideEffectiveModel({ userValue: 'sonnet', orgDefault: 'opus', canOverride: true });
  assert.deepEqual(result, { value: 'sonnet', source: 'user' });
});

test('decideEffectiveModel: canOverride=true, userValue なし, orgDefault あり → org', () => {
  const result = decideEffectiveModel({ userValue: undefined, orgDefault: 'opus', canOverride: true });
  assert.deepEqual(result, { value: 'opus', source: 'org' });
});

test('decideEffectiveModel: canOverride=true, 両方なし → default(undefined)', () => {
  const result = decideEffectiveModel({ userValue: undefined, orgDefault: undefined, canOverride: true });
  assert.deepEqual(result, { value: undefined, source: 'default' });
});

test('decideEffectiveModel: canOverride=false, orgDefault あり → org（個人設定は無視・ロック）', () => {
  const result = decideEffectiveModel({ userValue: 'sonnet', orgDefault: 'opus', canOverride: false });
  assert.deepEqual(result, { value: 'opus', source: 'org' });
});

test('decideEffectiveModel: canOverride=false, orgDefault なし, userValue あり → user（後方互換フォールバック）', () => {
  const result = decideEffectiveModel({ userValue: 'sonnet', orgDefault: undefined, canOverride: false });
  assert.deepEqual(result, { value: 'sonnet', source: 'user' });
});

test('decideEffectiveModel: canOverride=false, 両方なし → default(undefined)', () => {
  const result = decideEffectiveModel({ userValue: undefined, orgDefault: undefined, canOverride: false });
  assert.deepEqual(result, { value: undefined, source: 'default' });
});
