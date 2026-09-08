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
  endedWithoutAnswer,
  extractRejectionEvidence,
  extractBlockedCommands,
  sliceStepsFromOffset,
  formatStepTitle,
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

test('summarizeAtifEntry: arguments.command は80文字+「…」に切り詰められる（#374）', () => {
  const longCommand = 'x'.repeat(100);
  const s = summarizeAtifEntry({
    source: 'agent',
    tool_calls: [{ function_name: 'str_replace_editor', arguments: { command: longCommand } }],
  });
  assert.equal(s.tool, 'str_replace_editor');
  assert.equal(s.title, `${longCommand.slice(0, 80)}…`);
  assert.equal(s.title.length, 81);
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

// --- formatStepTitle（#374） ---

test('formatStepTitle: maxLength ちょうどの長さでは「…」を付けない', () => {
  const exact = 'y'.repeat(80);
  assert.equal(formatStepTitle(exact, 80), exact);
  assert.equal(formatStepTitle(exact, 80).length, 80);
});

test('formatStepTitle: maxLength を1文字でも超えたら末尾に「…」を付けて切り詰める', () => {
  const over = 'y'.repeat(81);
  const result = formatStepTitle(over, 80);
  assert.equal(result, `${'y'.repeat(80)}…`);
  assert.equal(result.length, 81);
});

test('formatStepTitle: 改行/タブ等の空白文字を半角スペース1個へ畳む（複数行テキストが1行の🧭表示に混ざらないように）', () => {
  assert.equal(formatStepTitle('line1\nline2\r\nline3\ttab', 100), 'line1 line2 line3 tab');
});

test('formatStepTitle: 前後の空白はトリムされる', () => {
  assert.equal(formatStepTitle('  padded  ', 100), 'padded');
});

test('formatStepTitle: サロゲートペアを分断しない（絵文字の途中で切らない）', () => {
  // U+1F600 (😀) はサロゲートペア（\uD83D\uDE00）。ペア境界のちょうど手前で切れるケースを作る。
  const emoji = '\uD83D\uDE00'; // 😀
  const text = 'x'.repeat(79) + emoji; // 79 文字目までが 'x'、80文字目(コードユニット)が上位サロゲート
  const result = formatStepTitle(text, 80);
  // 80文字目で切ると上位サロゲートだけが残ってしまうため、79文字まで戻してから「…」を付ける
  assert.equal(result, `${'x'.repeat(79)}…`);
  // 孤立サロゲート（壊れた UTF-16）が含まれていないことを確認
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(result), false);
});

test('formatStepTitle: 空文字はそのまま空文字', () => {
  assert.equal(formatStepTitle('', 80), '');
});

// --- endedWithoutAnswer 非退行テスト（#374でai-runner.ts側にtool===nullフィルタを追加したが、
//     devin-atif.ts のパース結果・endedWithoutAnswer() 自体は一切変更していないことを確認する） ---

test('endedWithoutAnswer: #374 のフィルタは表示層のみであり、summarizeAtifEntry は引き続き tool:null のテキスト応答ステップを返す', () => {
  const s = summarizeAtifEntry({ source: 'agent', message: 'Final answer text.' });
  assert.deepEqual(s, { tool: null, title: 'Final answer text.' });
});

test('endedWithoutAnswer: 最後がテキスト応答（tool:null）なら false のまま（回帰なし）', () => {
  const steps = [
    { tool: 'bash', title: 'ls' },
    { tool: null, title: 'Done.' },
  ];
  assert.equal(endedWithoutAnswer(steps), false);
});

test('endedWithoutAnswer: 最後がツール呼び出し（tool!=null）のままなら true（プランモード無言終了検知の回帰なし）', () => {
  const steps = [
    { tool: null, title: 'Thinking...' },
    { tool: 'bash', title: 'rm -rf /tmp/x' },
  ];
  assert.equal(endedWithoutAnswer(steps), true);
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
      { extra: { generation_model: 'should-be-used' } },
    ],
  };
  const { modelName, modelId } = extractAtifModel(parsed);
  assert.equal(modelName, 'Claude Fable 5.1');
  // #365: 逆順走査のため最後に見つかったもの（配列末尾に近い方）が採用される
  assert.equal(modelId, 'should-be-used');
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

// --- endedWithoutAnswer（欠陥1対策: プランモードの「無言で途中終了」検知） ---

test('endedWithoutAnswer: steps が空なら false', () => {
  assert.equal(endedWithoutAnswer([]), false);
});

test('endedWithoutAnswer: 最後がツール呼び出しで終わっていれば true（実測パターン: grep → exec で終了）', () => {
  const steps = [
    { tool: null, title: '現在プランモードです' },
    { tool: 'grep', title: 'grep を実行中' },
    { tool: 'exec', title: 'bash "...\\scripts\\list.sh"' },
  ];
  assert.equal(endedWithoutAnswer(steps), true);
});

test('endedWithoutAnswer: 最後がテキスト応答（tool: null）で終わっていれば false', () => {
  const steps = [
    { tool: 'grep', title: 'grep を実行中' },
    { tool: null, title: '調査結果はこちらです。' },
  ];
  assert.equal(endedWithoutAnswer(steps), false);
});

test('endedWithoutAnswer: ツール → テキスト → ツール で終わる場合は true', () => {
  const steps = [
    { tool: 'bash', title: 'ls -la' },
    { tool: null, title: '結果を確認しています。' },
    { tool: 'exec', title: 'bash "...\\scripts\\list.sh"' },
  ];
  assert.equal(endedWithoutAnswer(steps), true);
});

test('endedWithoutAnswer: テキスト応答のみの場合は false', () => {
  const steps = [
    { tool: null, title: '最初の応答です。' },
    { tool: null, title: '最終的な回答です。' },
  ];
  assert.equal(endedWithoutAnswer(steps), false);
});

// --- extractRejectionEvidence（#364 Phase1: 失敗ターン限定で observation を300文字抜粋） ---

test('extractRejectionEvidence: 失敗ターン（最後がツール呼び出しで終わる）は observation.results[0].content を返す', () => {
  const content = JSON.stringify({
    steps: [
      { source: 'agent', message: '調査中です。' },
      {
        source: 'agent',
        tool_calls: [{ function_name: 'exec', arguments: { command: 'bash "C:\\Users\\lfuser\\.claude\\skills\\devrelay-list-inventory\\scripts\\list.sh"' } }],
        observation: { results: [{ content: 'Tool execution was rejected by the user' }] },
      },
    ],
  });
  assert.equal(extractRejectionEvidence(content), 'Tool execution was rejected by the user');
});

test('extractRejectionEvidence: テキスト応答で終わるターン（成功）は null', () => {
  const content = JSON.stringify({
    steps: [
      { source: 'agent', tool_calls: [{ function_name: 'bash', arguments: { command: 'ls -la' } }], observation: { results: [{ content: 'total 0' }] } },
      { source: 'agent', message: 'こちらが結果です。' },
    ],
  });
  assert.equal(extractRejectionEvidence(content), null);
});

test('extractRejectionEvidence: 300文字で切り詰められる', () => {
  const longContent = 'x'.repeat(400);
  const content = JSON.stringify({
    steps: [
      { source: 'agent', tool_calls: [{ function_name: 'exec', arguments: { command: 'bash script.sh' } }], observation: { results: [{ content: longContent }] } },
    ],
  });
  const evidence = extractRejectionEvidence(content);
  assert.equal(evidence.length, 300);
  assert.equal(evidence, longContent.slice(0, 300));
});

test('extractRejectionEvidence: JSONL（複数トップレベル値）は単一 JSON として parse できないため null', () => {
  const content = ['{"a":1}', '{"b":2}'].join('\n');
  assert.equal(extractRejectionEvidence(content), null);
});

test('extractRejectionEvidence: steps が空、observation 無し、不正 JSON はいずれも null（例外を投げない）', () => {
  assert.equal(extractRejectionEvidence('{}'), null);
  assert.equal(extractRejectionEvidence('not json at all'), null);
  const noObservation = JSON.stringify({
    steps: [{ source: 'agent', tool_calls: [{ function_name: 'exec', arguments: { command: 'ls' } }] }],
  });
  assert.equal(extractRejectionEvidence(noObservation), null);
});

// --- extractRejectionEvidence（#368 Phase1-2: isRejection 述語による末尾からの逆順走査） ---

test('extractRejectionEvidence: isRejection 述語指定時、最後のエントリではなく一致する最初の（末尾から見て）エントリを返す', () => {
  const content = JSON.stringify({
    steps: [
      { source: 'agent', message: '調査開始します。' },
      {
        source: 'agent',
        tool_calls: [{ function_name: 'exec', arguments: { command: 'bash script-a.sh' } }],
        observation: { results: [{ content: 'warning: rejected a tool call that requires confirmation.' }] },
      },
      {
        source: 'agent',
        tool_calls: [{ function_name: 'exec', arguments: { command: 'bash script-b.sh' } }],
        observation: { results: [{ content: 'unrelated informational output, not a rejection' }] },
      },
    ],
  });
  const isRejection = (t) => /rejected a tool call/i.test(t);
  assert.equal(extractRejectionEvidence(content, isRejection), 'warning: rejected a tool call that requires confirmation.');
});

test('extractRejectionEvidence: isRejection 述語が一切一致しない場合は従来どおり最後のエントリにフォールバックする', () => {
  const content = JSON.stringify({
    steps: [
      {
        source: 'agent',
        tool_calls: [{ function_name: 'exec', arguments: { command: 'bash script-a.sh' } }],
        observation: { results: [{ content: 'first observation, not a match' }] },
      },
      {
        source: 'agent',
        tool_calls: [{ function_name: 'exec', arguments: { command: 'bash script-b.sh' } }],
        observation: { results: [{ content: 'last observation, also not a match' }] },
      },
    ],
  });
  const isRejection = (t) => /never matches anything/i.test(t);
  assert.equal(extractRejectionEvidence(content, isRejection), 'last observation, also not a match');
});

test('extractRejectionEvidence: isRejection 未指定時は従来どおり最後のエントリのみを見る（後方互換）', () => {
  const content = JSON.stringify({
    steps: [
      {
        source: 'agent',
        tool_calls: [{ function_name: 'exec', arguments: { command: 'bash script-a.sh' } }],
        observation: { results: [{ content: 'rejected a tool call that requires confirmation.' }] },
      },
      {
        source: 'agent',
        tool_calls: [{ function_name: 'exec', arguments: { command: 'bash script-b.sh' } }],
        observation: { results: [{ content: 'unrelated last observation' }] },
      },
    ],
  });
  assert.equal(extractRejectionEvidence(content), 'unrelated last observation');
});

test('extractRejectionEvidence: isRejection 一致時も300文字で切り詰められる', () => {
  const longContent = 'y'.repeat(400);
  const content = JSON.stringify({
    steps: [
      { source: 'agent', tool_calls: [{ function_name: 'exec', arguments: { command: 'bash script.sh' } }], observation: { results: [{ content: longContent }] } },
    ],
  });
  const isRejection = (t) => t.startsWith('y');
  const evidence = extractRejectionEvidence(content, isRejection);
  assert.equal(evidence.length, 300);
  assert.equal(evidence, longContent.slice(0, 300));
});

// --- extractBlockedCommands（#368 Phase1-3: 拒否されたコマンドの抽出） ---

test('extractBlockedCommands: reason:"Blocked" マーカーを持つエントリから tool_calls[0].arguments.command を抽出する', () => {
  const entries = [
    { source: 'agent', message: '調査開始します。' },
    {
      source: 'agent',
      tool_calls: [{ function_name: 'exec', arguments: { command: 'bash script-a.sh' } }],
      'chisel/tool_failure': { reason: 'Blocked' },
      observation: { results: [{ content: LEAK_MARKER }] },
    },
  ];
  assert.deepEqual(extractBlockedCommands(entries), ['bash script-a.sh']);
});

test('extractBlockedCommands: reason:"Blocked" が入れ子構造でも再帰的に検出する', () => {
  const entries = [
    {
      source: 'agent',
      tool_calls: [{ function_name: 'exec', arguments: { command: 'bash nested.sh' } }],
      extra: { failure: { detail: { reason: 'Blocked' } } },
    },
  ];
  assert.deepEqual(extractBlockedCommands(entries), ['bash nested.sh']);
});

test('extractBlockedCommands: reason が "Blocked" 以外（例: "Approved"）なら対象外', () => {
  const entries = [
    {
      source: 'agent',
      tool_calls: [{ function_name: 'exec', arguments: { command: 'bash script.sh' } }],
      'chisel/tool_failure': { reason: 'Approved' },
    },
  ];
  assert.deepEqual(extractBlockedCommands(entries), []);
});

test('extractBlockedCommands: ブロックマーカーが無いエントリは対象外（空配列）', () => {
  const entries = [
    { source: 'agent', tool_calls: [{ function_name: 'exec', arguments: { command: 'bash script.sh' } }], observation: { results: [{ content: 'ok' }] } },
    { source: 'agent', message: 'こちらが結果です。' },
  ];
  assert.deepEqual(extractBlockedCommands(entries), []);
});

test('extractBlockedCommands: tool_calls が無いレガシー形式は e.command 文字列にフォールバックする', () => {
  const entries = [
    {
      source: 'agent',
      command: 'bash legacy.sh',
      'chisel/tool_failure': { reason: 'Blocked' },
    },
  ];
  assert.deepEqual(extractBlockedCommands(entries), ['bash legacy.sh']);
});

test('extractBlockedCommands: 複数のブロック済みエントリはすべて出現順に返す', () => {
  const entries = [
    {
      tool_calls: [{ function_name: 'exec', arguments: { command: 'bash first.sh' } }],
      'chisel/tool_failure': { reason: 'Blocked' },
    },
    { source: 'agent', message: '中間のテキスト応答。' },
    {
      tool_calls: [{ function_name: 'exec', arguments: { command: 'bash second.sh' } }],
      'chisel/tool_failure': { reason: 'Blocked' },
    },
  ];
  assert.deepEqual(extractBlockedCommands(entries), ['bash first.sh', 'bash second.sh']);
});

test('extractBlockedCommands: observation 配下の reason:"Blocked" はマーカー検出対象から除外される（#361 漏洩ガード）', () => {
  const entries = [
    {
      tool_calls: [{ function_name: 'exec', arguments: { command: 'bash should-not-match.sh' } }],
      observation: { results: [{ content: LEAK_MARKER, reason: 'Blocked' }] },
    },
  ];
  assert.deepEqual(extractBlockedCommands(entries), []);
});

test('extractBlockedCommands: 配列以外の入力・空配列は例外を投げず空配列を返す', () => {
  assert.deepEqual(extractBlockedCommands([]), []);
  assert.deepEqual(extractBlockedCommands(null), []);
  assert.deepEqual(extractBlockedCommands(undefined), []);
  assert.deepEqual(extractBlockedCommands('not an array'), []);
});

test('extractBlockedCommands: tool_calls[0].arguments.command が無い場合はコマンド抽出できず対象外', () => {
  const entries = [
    {
      tool_calls: [{ function_name: 'exec', arguments: {} }],
      'chisel/tool_failure': { reason: 'Blocked' },
    },
  ];
  assert.deepEqual(extractBlockedCommands(entries), []);
});

// --- sliceStepsFromOffset（#365） ---

test('sliceStepsFromOffset: 正常な差分（offset が範囲内）は offset 以降だけを返す', () => {
  const steps = [{ tool: 'a', title: null }, { tool: 'b', title: null }, { tool: 'c', title: null }, { tool: 'd', title: null }];
  const { steps: sliced, omitted } = sliceStepsFromOffset(steps, 2);
  assert.deepEqual(sliced, [{ tool: 'c', title: null }, { tool: 'd', title: null }]);
  assert.equal(omitted, 2);
});

test('sliceStepsFromOffset: offset=0 は全件を返す（フォールバックではなく素通し）', () => {
  const steps = [{ tool: 'a', title: null }, { tool: 'b', title: null }];
  const { steps: sliced, omitted } = sliceStepsFromOffset(steps, 0);
  assert.deepEqual(sliced, steps);
  assert.equal(omitted, 0);
});

test('sliceStepsFromOffset: offset===steps.length（前ターンから増えていない）は全件返しにフォールバック', () => {
  const steps = [{ tool: 'a', title: null }, { tool: 'b', title: null }];
  const { steps: sliced, omitted } = sliceStepsFromOffset(steps, 2);
  assert.deepEqual(sliced, steps);
  assert.equal(omitted, 0);
});

test('sliceStepsFromOffset: offset>steps.length（devin 側で圧縮・再採番された等の異常値）は全件返しにフォールバック', () => {
  const steps = [{ tool: 'a', title: null }];
  const { steps: sliced, omitted } = sliceStepsFromOffset(steps, 99);
  assert.deepEqual(sliced, steps);
  assert.equal(omitted, 0);
});

test('sliceStepsFromOffset: 負の offset は全件返しにフォールバック（例外を投げない）', () => {
  const steps = [{ tool: 'a', title: null }, { tool: 'b', title: null }];
  const { steps: sliced, omitted } = sliceStepsFromOffset(steps, -3);
  assert.deepEqual(sliced, steps);
  assert.equal(omitted, 0);
});

test('sliceStepsFromOffset: steps が配列でない場合も例外を投げず空配列を返す', () => {
  assert.deepEqual(sliceStepsFromOffset(null, 1), { steps: [], omitted: 0 });
  assert.deepEqual(sliceStepsFromOffset(undefined, 1), { steps: [], omitted: 0 });
});

// --- extractAtifModel: 逆順走査の回帰テスト（#365） ---

test('extractAtifModel: 複数ステップで generation_model が異なるとき最後の値を返す（今回のバグの回帰テスト）', () => {
  // 実際に発生したケースの再現: 1件目が診断用の別モデル呼び出し（--model sonnet）、
  // 最後のステップが今回実際に使われたモデル。旧実装（先頭から break）は 1 件目の値を誤って返していた。
  const parsed = {
    steps: [
      { extra: { generation_model: 'sonnet' } },
      { extra: { generation_model: 'swe-1-7-medium' } },
      { extra: { generation_model: 'swe-1-7-medium' } },
    ],
  };
  const { modelId } = extractAtifModel(parsed);
  assert.equal(modelId, 'swe-1-7-medium');
});
