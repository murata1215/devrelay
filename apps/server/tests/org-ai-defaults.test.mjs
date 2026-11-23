// #372 + 組織プロバイダー強制サイクル: 組織 AI デフォルト設定の純粋関数
// （apps/server/src/services/org-ai-defaults.ts）の単体テスト。
// コンパイル済み dist から直接 import する（#308/#331〜#334 と同じ流儀）。
// resolveOrgAiContext / isAiSettingLocked は prisma に依存するため対象外
// （isOrgAiDefaultKey のキー判定ロジックでロック対象/対象外の分岐は検証できる）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isOrgAiDefaultKey,
  isOrgAiProviderKey,
  isValidOrgAiDefaultValue,
  isOrgProviderControlEnabled,
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

// --- isOrgAiProviderKey / isOrgAiDefaultKey（プロバイダー7キー、組織プロバイダー強制サイクル） ---

test('isOrgAiProviderKey: プロバイダー7キーすべてを true と判定する', () => {
  const keys = [
    'build_summary_provider', 'chat_ai_provider', 'dev_report_provider',
    'terminal_ai_provider', 'voice_assist_provider', 'org_summary_provider', 'reply_summary_provider',
  ];
  for (const key of keys) {
    assert.equal(isOrgAiProviderKey(key), true, `${key} は true であるべき`);
    assert.equal(isOrgAiDefaultKey(key), true, `${key} は isOrgAiDefaultKey でも true であるべき`);
  }
});

test('isOrgAiProviderKey: 似ているが一致しないキーは false', () => {
  assert.equal(isOrgAiProviderKey('foo_provider'), false);
  assert.equal(isOrgAiProviderKey('build_summary_providerX'), false);
  assert.equal(isOrgAiProviderKey('build_summary'), false);
  assert.equal(isOrgAiProviderKey('claude_model_plan'), false);
});

test('isOrgAiDefaultKey: モデルキー8種・プロバイダーキー7種の既存判定は変わらない', () => {
  assert.equal(isOrgAiDefaultKey('claude_model_plan'), true);
  assert.equal(isOrgAiDefaultKey('language'), false);
});

// --- isValidOrgAiDefaultValue ---

test('isValidOrgAiDefaultValue: プロバイダーキーは openai/anthropic/gemini/none のみ許可', () => {
  assert.equal(isValidOrgAiDefaultValue('chat_ai_provider', 'openai'), true);
  assert.equal(isValidOrgAiDefaultValue('chat_ai_provider', 'anthropic'), true);
  assert.equal(isValidOrgAiDefaultValue('chat_ai_provider', 'gemini'), true);
  assert.equal(isValidOrgAiDefaultValue('chat_ai_provider', 'none'), true);
  assert.equal(isValidOrgAiDefaultValue('chat_ai_provider', 'gpt-4o'), false);
  assert.equal(isValidOrgAiDefaultValue('chat_ai_provider', 'OpenAI'), false);
  assert.equal(isValidOrgAiDefaultValue('chat_ai_provider', ''), false);
});

test('isValidOrgAiDefaultValue: モデルキーは危険文字・空白のみ拒否（enum 制限なし）', () => {
  assert.equal(isValidOrgAiDefaultValue('claude_model_plan', 'claude-sonnet-5'), true);
  assert.equal(isValidOrgAiDefaultValue('claude_model_plan', 'sonnet; rm -rf /'), false);
  assert.equal(isValidOrgAiDefaultValue('claude_model_plan', 'has space'), false);
  assert.equal(isValidOrgAiDefaultValue('claude_model_plan', 'openai'), true);
});

test('isValidOrgAiDefaultValue: trim 前提（呼び出し側が trim 済みの値を渡す想定）', () => {
  // 末尾・先頭の空白自体が /\s/ にマッチするため、trim していない値は拒否される
  assert.equal(isValidOrgAiDefaultValue('claude_model_plan', ' sonnet '), false);
  assert.equal(isValidOrgAiDefaultValue('claude_model_plan', 'sonnet'), true);
});

// --- isOrgProviderControlEnabled（キルスイッチ） ---

test('isOrgProviderControlEnabled: 既定（undefined）は有効', () => {
  assert.equal(isOrgProviderControlEnabled(undefined), true);
});

test('isOrgProviderControlEnabled: "0" のときのみ無効', () => {
  assert.equal(isOrgProviderControlEnabled('0'), false);
});

test('isOrgProviderControlEnabled: "0" 以外の値は有効のまま', () => {
  assert.equal(isOrgProviderControlEnabled('1'), true);
  assert.equal(isOrgProviderControlEnabled(''), true);
  assert.equal(isOrgProviderControlEnabled('false'), true);
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

test('parseOrgAiDefaults: プロバイダーキーは enum 値のみ採用し、それ以外は除外する', () => {
  const raw = JSON.stringify({
    chat_ai_provider: 'anthropic',
    reply_summary_provider: 'gpt-4o', // enum 外 → 除外
    terminal_ai_provider: 'none',
  });
  assert.deepEqual(parseOrgAiDefaults(raw), { chat_ai_provider: 'anthropic', terminal_ai_provider: 'none' });
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

test('serializeOrgAiDefaults: プロバイダーキーは enum 値のみシリアライズし、enum 外は除外する', () => {
  const result = serializeOrgAiDefaults({ chat_ai_provider: 'openai', reply_summary_provider: 'gpt-4o' });
  assert.deepEqual(JSON.parse(result), { chat_ai_provider: 'openai' });
});

test('serializeOrgAiDefaults → parseOrgAiDefaults: プロバイダーキーのラウンドトリップ', () => {
  const input = { chat_ai_provider: 'anthropic', terminal_ai_provider: 'none' };
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
