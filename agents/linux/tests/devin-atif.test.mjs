// Devin モデル選択サイクル・サイクル B（変更4/変更5）: ATIF（`devin --export`）を読み解く
// 純関数群（devin-atif.ts）の単体テスト。
// 外部 import ゼロの純粋関数をコンパイル済み dist から直接 import する（session-scope.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractAtifEntries,
  summarizeAtifEntry,
  extractAtifModel,
  extractAtifUsage,
  buildAtifDigest,
} from '../dist/services/devin-atif.js';

// observation.results[].content に埋め込む漏洩検出用マーカー（このマーカーが返り値に一切現れないことを担保する）
const LEAK_MARKER = 'SECRET_OBSERVATION_CONTENT_MUST_NOT_LEAK';

// ATIF-v1.7 実構造（判明11-16）を模したフィクスチャ。8 要素（steps）で構成し、
// 実際に summarizeAtifEntry() が非 null を返すのは 6 件のみ（system/user の2件は skip）。
const FIXTURE_V17 = JSON.stringify({
  schema_version: '1.7',
  agent: {
    model_name: 'Claude Fable 5.1',
    extra: { permission_mode: 'plan' },
  },
  steps: [
    { source: 'system', content: 'You are Devin, an autonomous software engineer.' },
    { source: 'user', message: 'Please investigate the failing test.' },
    {
      source: 'agent',
      tool_calls: [{ function_name: 'bash', arguments: { command: 'ls -la /tmp' } }],
      extra: { generation_model: 'claude-fable-5-1' },
    },
    {
      source: 'agent',
      tool_calls: [{ function_name: 'str_replace_editor', arguments: { command: 'x'.repeat(100) } }],
    },
    { source: 'agent', message: 'Here is my plan for implementing the feature.' },
    { tool_name: 'grep', command: 'grep -r foo .' },
    { title: 'Some titled entry' },
    { type: 'observation', observation: { results: [{ content: LEAK_MARKER }] } },
  ],
  final_metrics: {
    total_input_tokens: 1000,
    total_output_tokens: 200,
    total_cache_read_tokens: 50,
    total_cache_creation_tokens: 10,
  },
}, null, 2);

// 旧形式（messages キー）の後方互換フィクスチャ
const FIXTURE_LEGACY_MESSAGES = JSON.stringify({
  messages: [
    { tool_name: 'read_file', title: 'Reading config.yaml' },
    { source: 'system', content: 'system prompt' },
    { tool: 'bash', command: 'echo hello' },
  ],
});

// steps と messages が両方存在する場合は steps が優先されることを確認するためのフィクスチャ
const FIXTURE_BOTH_KEYS = {
  steps: [{ tool_name: 'a' }, { tool_name: 'b' }],
  messages: [{ tool_name: 'x' }],
};

// JSONL フォールバック（旧形式互換）+ pretty-print スカラー行の誤カウント再現フィクスチャ。
// 単一 JSON としては invalid（複数のトップレベル値）なため JSONL パスへフォールバックする。
// "pattern" / 123 は単独で valid JSON となるため entries には積まれるが、
// summarizeAtifEntry() は非オブジェクトを弾くため steps には含まれない（誤カウント是正の構造的ガード）。
const FIXTURE_PRETTY_GARBAGE = [
  '{"source":"agent","tool_calls":[{"function_name":"bash","arguments":{"command":"ls -la"}}]}',
  '    "pattern"',
  '    123',
  '{"source":"agent","tool_calls":[{"function_name":"grep","arguments":{"command":"grep -r foo ."}}]}',
].join('\n');

// --- extractAtifEntries ---

test('extractAtifEntries: steps キーが最優先で抽出される', () => {
  const entries = extractAtifEntries(FIXTURE_BOTH_KEYS);
  assert.deepEqual(entries, FIXTURE_BOTH_KEYS.steps);
});

test('extractAtifEntries: steps が無ければ messages（旧形式）にフォールバック', () => {
  const parsed = JSON.parse(FIXTURE_LEGACY_MESSAGES);
  const entries = extractAtifEntries(parsed);
  assert.equal(entries.length, 3);
});

test('extractAtifEntries: parsed 自体が配列ならそのまま返す', () => {
  const arr = [{ a: 1 }, { b: 2 }];
  assert.deepEqual(extractAtifEntries(arr), arr);
});

test('extractAtifEntries: steps も messages も配列も無ければ [parsed] を返す（例外を投げない）', () => {
  assert.deepEqual(extractAtifEntries({ foo: 'bar' }), [{ foo: 'bar' }]);
  assert.deepEqual(extractAtifEntries(null), [null]);
  assert.deepEqual(extractAtifEntries('scalar'), ['scalar']);
  assert.deepEqual(extractAtifEntries(123), [123]);
});

// --- summarizeAtifEntry ---

test('summarizeAtifEntry: source=system は null（skip）', () => {
  assert.equal(summarizeAtifEntry({ source: 'system', content: 'x' }), null);
});

test('summarizeAtifEntry: source=user は null（skip）', () => {
  assert.equal(summarizeAtifEntry({ source: 'user', message: 'x' }), null);
});

test('summarizeAtifEntry: tool_calls[0].function_name + arguments.command を正しく拾う', () => {
  const s = summarizeAtifEntry({
    source: 'agent',
    tool_calls: [{ function_name: 'bash', arguments: { command: 'ls -la /tmp' } }],
  });
  assert.deepEqual(s, { tool: 'bash', title: 'ls -la /tmp' });
});

test('summarizeAtifEntry: arguments.command は80文字にスライスされる', () => {
  const longCommand = 'x'.repeat(100);
  const s = summarizeAtifEntry({
    source: 'agent',
    tool_calls: [{ function_name: 'str_replace_editor', arguments: { command: longCommand } }],
  });
  assert.equal(s.tool, 'str_replace_editor');
  assert.equal(s.title, longCommand.slice(0, 80));
  assert.equal(s.title.length, 80);
});

test('summarizeAtifEntry: tool_calls はあるが arguments.command が無ければ title は null', () => {
  const s = summarizeAtifEntry({
    source: 'agent',
    tool_calls: [{ function_name: 'noop', arguments: {} }],
  });
  assert.deepEqual(s, { tool: 'noop', title: null });
});

test('summarizeAtifEntry: レガシー形式（tool_name/command）を拾う', () => {
  const s = summarizeAtifEntry({ tool_name: 'grep', command: 'grep -r foo .' });
  assert.deepEqual(s, { tool: 'grep', title: 'grep -r foo .' });
});

test('summarizeAtifEntry: レガシー形式（tool/action）を拾う', () => {
  const s = summarizeAtifEntry({ tool: 'bash', action: 'echo hi' });
  assert.deepEqual(s, { tool: 'bash', title: 'echo hi' });
});

test('summarizeAtifEntry: レガシー形式（name/title）を拾う', () => {
  const s = summarizeAtifEntry({ name: 'read_file', title: 'Reading config.yaml' });
  assert.deepEqual(s, { tool: 'read_file', title: 'Reading config.yaml' });
});

test('summarizeAtifEntry: source=agent かつ tool_calls 無しはメッセージテキストを使う', () => {
  const s = summarizeAtifEntry({ source: 'agent', message: 'Here is my plan.' });
  assert.deepEqual(s, { tool: null, title: 'Here is my plan.' });
});

test('summarizeAtifEntry: title のみのエントリは title を使う（100文字スライス）', () => {
  const s = summarizeAtifEntry({ title: 'Some titled entry' });
  assert.deepEqual(s, { tool: null, title: 'Some titled entry' });
});

test('summarizeAtifEntry: type のみのエントリは [type] 形式', () => {
  const s = summarizeAtifEntry({ type: 'observation' });
  assert.deepEqual(s, { tool: null, title: '[observation]' });
});

test('summarizeAtifEntry: 非オブジェクト（pretty-print スカラー行）は null', () => {
  assert.equal(summarizeAtifEntry(JSON.parse('"pattern"')), null);
  assert.equal(summarizeAtifEntry(JSON.parse('123')), null);
  assert.equal(summarizeAtifEntry('pattern'), null);
  assert.equal(summarizeAtifEntry(123), null);
});

test('summarizeAtifEntry: null / undefined / 配列 / どの分岐にも該当しないオブジェクトは null（例外を投げない）', () => {
  assert.equal(summarizeAtifEntry(null), null);
  assert.equal(summarizeAtifEntry(undefined), null);
  assert.equal(summarizeAtifEntry([1, 2, 3]), null);
  assert.equal(summarizeAtifEntry({}), null);
});

test('summarizeAtifEntry: observation.results[].content は一切参照しない（漏洩ガード）', () => {
  const s = summarizeAtifEntry({
    type: 'observation',
    observation: { results: [{ content: LEAK_MARKER }] },
  });
  assert.equal(JSON.stringify(s).includes(LEAK_MARKER), false);
});

// --- extractAtifModel ---

test('extractAtifModel: agent.model_name（人間可読）を拾う', () => {
  const { modelName } = extractAtifModel({ agent: { model_name: 'Claude Fable 5.1' } });
  assert.equal(modelName, 'Claude Fable 5.1');
});

test('extractAtifModel: steps[].extra.generation_model（機械可読）をステップレベルで優先して拾う', () => {
  const parsed = {
    agent: { model_name: 'Claude Fable 5.1' },
    steps: [
      { extra: {} },
      { extra: { generation_model: 'claude-fable-5-1' } },
      { extra: { generation_model: 'should-not-be-used' } },
    ],
  };
  const { modelName, modelId } = extractAtifModel(parsed);
  assert.equal(modelName, 'Claude Fable 5.1');
  assert.equal(modelId, 'claude-fable-5-1'); // 最初に見つかったもの
});

test('extractAtifModel: 両方見つからなければ両方 null', () => {
  const { modelName, modelId } = extractAtifModel({});
  assert.equal(modelName, null);
  assert.equal(modelId, null);
});

test('extractAtifModel: 非オブジェクト・null でも例外を投げない', () => {
  assert.deepEqual(extractAtifModel(null), { modelName: null, modelId: null });
  assert.deepEqual(extractAtifModel('scalar'), { modelName: null, modelId: null });
});

// --- extractAtifUsage ---

test('extractAtifUsage: final_metrics を Claude 互換キーへマップする', () => {
  const usage = extractAtifUsage({
    final_metrics: {
      total_input_tokens: 1000,
      total_output_tokens: 200,
      total_cache_read_tokens: 50,
      total_cache_creation_tokens: 10,
    },
  });
  assert.deepEqual(usage, {
    input_tokens: 1000,
    output_tokens: 200,
    cache_read_input_tokens: 50,
    cache_creation_input_tokens: 10,
  });
});

test('extractAtifUsage: 欠落フィールドは0埋め', () => {
  const usage = extractAtifUsage({ final_metrics: { total_input_tokens: 500 } });
  assert.deepEqual(usage, {
    input_tokens: 500,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });
});

test('extractAtifUsage: final_metrics 自体が無ければ null', () => {
  assert.equal(extractAtifUsage({}), null);
});

test('extractAtifUsage: 非オブジェクト・null でも例外を投げない（null を返す）', () => {
  assert.equal(extractAtifUsage(null), null);
  assert.equal(extractAtifUsage('scalar'), null);
  assert.equal(extractAtifUsage(123), null);
});

// --- buildAtifDigest ---

test('buildAtifDigest: ATIF-v1.7 実構造からステップ・モデル・使用量・permissionMode をすべて読み取る', () => {
  const digest = buildAtifDigest(FIXTURE_V17);
  assert.ok(digest);
  assert.equal(digest.schemaVersion, '1.7');
  // 本サイクルの中核回帰テスト: 8 要素の ATIF が totalSteps===8 になること（38 に誤カウントされないこと）
  assert.equal(digest.totalSteps, 8);
  // summarizeAtifEntry が非 null を返すのは system/user を除いた6件のみ
  assert.equal(digest.steps.length, 6);
  assert.equal(digest.modelName, 'Claude Fable 5.1');
  assert.equal(digest.modelId, 'claude-fable-5-1'); // ステップレベルの値が優先される
  assert.deepEqual(digest.usage, {
    input_tokens: 1000,
    output_tokens: 200,
    cache_read_input_tokens: 50,
    cache_creation_input_tokens: 10,
  });
  assert.equal(digest.permissionMode, 'plan');
});

test('buildAtifDigest: observation.results[].content のマーカー文字列が返り値のどこにも現れない（漏洩ガード）', () => {
  const digest = buildAtifDigest(FIXTURE_V17);
  assert.equal(JSON.stringify(digest).includes(LEAK_MARKER), false);
});

test('buildAtifDigest: tool_calls の内容がステップ要約に正しく反映される', () => {
  const digest = buildAtifDigest(FIXTURE_V17);
  const bashStep = digest.steps.find((s) => s.tool === 'bash');
  assert.ok(bashStep);
  assert.equal(bashStep.title, 'ls -la /tmp');
});

test('buildAtifDigest: 旧形式（messages キー）でも読み取れる', () => {
  const digest = buildAtifDigest(FIXTURE_LEGACY_MESSAGES);
  assert.ok(digest);
  assert.equal(digest.totalSteps, 3);
  // system エントリ1件は skip されるため steps は2件
  assert.equal(digest.steps.length, 2);
});

test('buildAtifDigest: JSONL フォールバック + pretty-print スカラー行は totalSteps に含まれるが steps には含まれない', () => {
  const digest = buildAtifDigest(FIXTURE_PRETTY_GARBAGE);
  assert.ok(digest);
  // "pattern" / 123 も単独で valid JSON のため entries には積まれる（totalSteps=4）
  assert.equal(digest.totalSteps, 4);
  // だが summarizeAtifEntry が非オブジェクトを弾くため実際のステップは2件のみ
  assert.equal(digest.steps.length, 2);
});

test('buildAtifDigest: 不正 JSON（壊れた行のみ）は例外を投げず、読み取れる部分だけ返す', () => {
  const content = [
    'not valid json at all {{{',
    '{"tool_name":"bash","command":"echo ok"}',
  ].join('\n');
  const digest = buildAtifDigest(content);
  assert.ok(digest);
  assert.equal(digest.totalSteps, 1);
  assert.equal(digest.steps.length, 1);
});

test('buildAtifDigest: 空文字・null・undefined では null を返す（例外を投げない）', () => {
  assert.equal(buildAtifDigest(''), null);
  assert.equal(buildAtifDigest(null), null);
  assert.equal(buildAtifDigest(undefined), null);
});

test('buildAtifDigest: 完全に無意味な内容（ステップもモデルも使用量も取得不能）は null', () => {
  assert.equal(buildAtifDigest('"just a scalar string"'), null);
  assert.equal(buildAtifDigest('{}'), null);
});
