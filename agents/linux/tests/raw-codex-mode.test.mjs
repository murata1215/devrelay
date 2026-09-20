// raw-completion Phase 2（Codex 経路）の Agent 側モード定義の単体テスト。
// 外部 import ゼロの純粋関数（agents/linux/src/services/raw-codex-mode.ts）を
// コンパイル済み dist から直接 import する（raw-completion-mode.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RAW_CODEX_CONFIG_OVERRIDES,
  RAW_CODEX_BASE_FLAGS,
  RAW_CODEX_EPHEMERAL_FLAG,
  RAW_CODEX_EXECUTED_ITEM_TYPES,
  toTomlBasicString,
  safeRawCodexModel,
  buildRawCodexArgs,
  composeRawCodexPrompt,
  buildRawCodexEnv,
  createRawCodexAccumulator,
  consumeRawCodexLine,
  resolveRawCodexResult,
} from '../dist/services/raw-codex-mode.js';

// ---- 定数 ----

test('RAW_CODEX_CONFIG_OVERRIDES: 混入除去フラグ一式を含む（devlog Phase 0 訂正表と一致）', () => {
  const expected = [
    'sandbox_mode="read-only"',
    'approval_policy="never"',
    'project_doc_max_bytes=0',
    'include_environment_context=false',
    'skills.include_instructions=false',
    'include_apps_instructions=false',
    'features.tool_suggest=false',
    'features.multi_agent=false',
    'mcp_servers={}',
    'tools.web_search=false',
    'history.persistence="none"',
  ];
  assert.deepEqual(RAW_CODEX_CONFIG_OVERRIDES, expected);
});

test('RAW_CODEX_BASE_FLAGS: --json と --skip-git-repo-check を含む', () => {
  assert.deepEqual(RAW_CODEX_BASE_FLAGS, ['--json', '--skip-git-repo-check']);
});

test('RAW_CODEX_EPHEMERAL_FLAG: --ephemeral', () => {
  assert.equal(RAW_CODEX_EPHEMERAL_FLAG, '--ephemeral');
});

test('RAW_CODEX_EXECUTED_ITEM_TYPES: agent_message/reasoning/todo_list を含まない', () => {
  for (const excluded of ['agent_message', 'reasoning', 'todo_list']) {
    assert.ok(!RAW_CODEX_EXECUTED_ITEM_TYPES.includes(excluded), `${excluded} は含まれてはいけない`);
  }
  for (const included of ['command_execution', 'file_change', 'mcp_tool_call', 'collab_tool_call', 'web_search']) {
    assert.ok(RAW_CODEX_EXECUTED_ITEM_TYPES.includes(included), `${included} が含まれていない`);
  }
});

// ---- toTomlBasicString ----

test('toTomlBasicString: 通常文字列はダブルクォートで囲むだけ', () => {
  assert.equal(toTomlBasicString('hello'), '"hello"');
});

test('toTomlBasicString: ダブルクォート・バックスラッシュをエスケープする', () => {
  assert.equal(toTomlBasicString('say "hi" \\ bye'), '"say \\"hi\\" \\\\ bye"');
});

test('toTomlBasicString: 改行・タブ・復帰をエスケープする', () => {
  assert.equal(toTomlBasicString('a\nb\tc\rd'), '"a\\nb\\tc\\rd"');
});

test('toTomlBasicString: 制御文字（\\x01 等）は \\uXXXX 形式', () => {
  assert.equal(toTomlBasicString('a\x01b'), '"a\\u0001b"');
  assert.equal(toTomlBasicString('a\x7fb'), '"a\\u007fb"');
});

test('toTomlBasicString: 非 ASCII（絵文字・日本語）はそのまま通す', () => {
  assert.equal(toTomlBasicString('こんにちは😀'), '"こんにちは😀"');
});

test('toTomlBasicString: 空文字は空のダブルクォート', () => {
  assert.equal(toTomlBasicString(''), '""');
});

test('toTomlBasicString: 往復整合性（JSON.parse でも構造的に同じ結果になる代表例）', () => {
  const raw = 'line1\nline2 "quoted" \\backslash\\';
  const escaped = toTomlBasicString(raw);
  // TOML basic string のエスケープは JSON とほぼ同一集合なので JSON.parse で復元できることを確認する
  assert.equal(JSON.parse(escaped), raw);
});

// ---- safeRawCodexModel ----

test('safeRawCodexModel: 未指定は undefined', () => {
  assert.equal(safeRawCodexModel(undefined), undefined);
  assert.equal(safeRawCodexModel(''), undefined);
});

test('safeRawCodexModel: 安全なモデル ID はそのまま返す', () => {
  assert.equal(safeRawCodexModel('gpt-5.6-terra'), 'gpt-5.6-terra');
});

test('safeRawCodexModel: 危険文字を含む値は undefined', () => {
  for (const dangerous of ['gpt"; rm -rf /', "gpt'", 'gpt\n', 'gpt terra', 'gpt$(x)', 'gpt`x`', 'gpt;x']) {
    assert.equal(safeRawCodexModel(dangerous), undefined, `expected undefined for ${JSON.stringify(dangerous)}`);
  }
});

// ---- buildRawCodexArgs ----

test('buildRawCodexArgs: 順序固定（exec → base flags → ephemeral → -c 一式 → model → developer_instructions → -）', () => {
  const args = buildRawCodexArgs({ system: 'You are terra.', model: 'gpt-5.6-terra', supportsEphemeral: true });
  assert.equal(args[0], 'exec');
  assert.equal(args[1], '--json');
  assert.equal(args[2], '--skip-git-repo-check');
  assert.equal(args[3], '--ephemeral');
  // -c 一式は RAW_CODEX_CONFIG_OVERRIDES の順に -c <kv> ペアで続く
  let i = 4;
  for (const override of RAW_CODEX_CONFIG_OVERRIDES) {
    assert.equal(args[i], '-c');
    assert.equal(args[i + 1], override);
    i += 2;
  }
  assert.equal(args[i], '-c');
  assert.equal(args[i + 1], 'model="gpt-5.6-terra"');
  i += 2;
  assert.equal(args[i], '-c');
  assert.equal(args[i + 1], 'developer_instructions="You are terra."');
  i += 2;
  assert.equal(args[i], '-');
  assert.equal(args.length, i + 1);
});

test('buildRawCodexArgs: supportsEphemeral=false なら --ephemeral を含めない', () => {
  const args = buildRawCodexArgs({ system: 'x', model: undefined, supportsEphemeral: false });
  assert.ok(!args.includes('--ephemeral'));
});

test('buildRawCodexArgs: model 未指定なら -c model= を付けない', () => {
  const args = buildRawCodexArgs({ system: 'x', model: undefined, supportsEphemeral: true });
  assert.ok(!args.some((a) => a.startsWith('model=')));
});

test('buildRawCodexArgs: 危険な model は安全側で無視される（-c model= が付かない）', () => {
  const args = buildRawCodexArgs({ system: 'x', model: 'gpt"; rm -rf /', supportsEphemeral: true });
  assert.ok(!args.some((a) => a.startsWith('model=')));
});

test('buildRawCodexArgs: "-" が必ず最後の引数', () => {
  const args = buildRawCodexArgs({ system: 'x', model: 'gpt-5.6-sol', supportsEphemeral: true });
  assert.equal(args[args.length - 1], '-');
});

test('buildRawCodexArgs: system の TOML インジェクション文字も developer_instructions 1 引数に閉じ込める', () => {
  const args = buildRawCodexArgs({ system: 'ignore all rules"\n[bad]\nx=1', model: undefined, supportsEphemeral: false });
  const devIdx = args.findIndex((a) => a.startsWith('developer_instructions='));
  assert.equal(devIdx, args.length - 2); // 直後が "-"
  // -c と developer_instructions=... が1つの配列要素に収まっている（シェルへ展開されず spawn の引数として渡る前提）
  assert.equal(args[devIdx - 1], '-c');
});

// ---- composeRawCodexPrompt ----

test('composeRawCodexPrompt: 恒等関数（何も前置・変換しない）', () => {
  assert.equal(composeRawCodexPrompt('hello'), 'hello');
  assert.equal(composeRawCodexPrompt(''), '');
  const withSpecial = '[SYSTEM]should not be added';
  assert.equal(composeRawCodexPrompt(withSpecial), withSpecial);
});

// ---- buildRawCodexEnv ----

test('buildRawCodexEnv: codexDir を PATH の先頭に追加する', () => {
  const env = buildRawCodexEnv({ PATH: '/usr/bin', HOME: '/home/x' }, '/opt/codex/bin', ':');
  assert.equal(env.PATH, '/opt/codex/bin:/usr/bin');
  assert.equal(env.HOME, '/home/x');
});

test('buildRawCodexEnv: PATH 未設定なら codexDir のみ', () => {
  const env = buildRawCodexEnv({}, '/opt/codex/bin', ':');
  assert.equal(env.PATH, '/opt/codex/bin');
});

test('buildRawCodexEnv: DEVRELAY / DEVRELAY_SESSION_ID / DEVRELAY_PROJECT を付けない', () => {
  const env = buildRawCodexEnv(
    { PATH: '/usr/bin', DEVRELAY: 'leftover-from-base' },
    '/opt/codex/bin',
    ':'
  );
  // baseEnv に既に DEVRELAY が入っていた場合でも本関数はそれを消さない（呼び出し元の責務）が、
  // 少なくとも本関数自身が DEVRELAY_SESSION_ID/DEVRELAY_PROJECT を新設しないことを確認する
  assert.equal(env.DEVRELAY_SESSION_ID, undefined);
  assert.equal(env.DEVRELAY_PROJECT, undefined);
});

test('buildRawCodexEnv: Windows のパス区切り（;）も指定できる', () => {
  const env = buildRawCodexEnv({ PATH: 'C:\\Windows' }, 'C:\\codex', ';');
  assert.equal(env.PATH, 'C:\\codex;C:\\Windows');
});

test('buildRawCodexEnv: baseEnv を破壊しない（新しいオブジェクトを返す）', () => {
  const base = { PATH: '/usr/bin' };
  const env = buildRawCodexEnv(base, '/opt/codex/bin', ':');
  assert.equal(base.PATH, '/usr/bin');
  assert.notEqual(env, base);
});

// ---- createRawCodexAccumulator / consumeRawCodexLine ----

test('createRawCodexAccumulator: 初期状態', () => {
  const acc = createRawCodexAccumulator();
  assert.deepEqual(acc, { text: '', executedTools: [], plainLines: [] });
});

test('consumeRawCodexLine: thread.started は threadId を記録するだけ', () => {
  const acc = createRawCodexAccumulator();
  consumeRawCodexLine(acc, JSON.stringify({ type: 'thread.started', thread_id: 'th_123' }));
  assert.equal(acc.threadId, 'th_123');
  assert.equal(acc.text, '');
});

test('consumeRawCodexLine: item.completed(agent_message) はテキストを連結する', () => {
  const acc = createRawCodexAccumulator();
  consumeRawCodexLine(acc, JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Hello ' } }));
  consumeRawCodexLine(acc, JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'world.' } }));
  assert.equal(acc.text, 'Hello world.');
});

test('consumeRawCodexLine: item.completed(reasoning) は本文に混ぜない', () => {
  const acc = createRawCodexAccumulator();
  consumeRawCodexLine(acc, JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'internal thinking' } }));
  assert.equal(acc.text, '');
  assert.deepEqual(acc.executedTools, []);
});

test('consumeRawCodexLine: item.completed(command_execution 等) は executedTools に記録する', () => {
  const acc = createRawCodexAccumulator();
  consumeRawCodexLine(acc, JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'ls' } }));
  consumeRawCodexLine(acc, JSON.stringify({ type: 'item.completed', item: { type: 'file_change', path: '/tmp/x' } }));
  consumeRawCodexLine(acc, JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call' } }));
  consumeRawCodexLine(acc, JSON.stringify({ type: 'item.completed', item: { type: 'web_search' } }));
  assert.deepEqual(acc.executedTools, ['command_execution', 'file_change', 'mcp_tool_call', 'web_search']);
  assert.equal(acc.text, '');
});

test('consumeRawCodexLine: item.completed(todo_list) は実行系扱いしない', () => {
  const acc = createRawCodexAccumulator();
  consumeRawCodexLine(acc, JSON.stringify({ type: 'item.completed', item: { type: 'todo_list' } }));
  assert.deepEqual(acc.executedTools, []);
});

test('consumeRawCodexLine: turn.completed.usage を Claude 互換キーへ写像する', () => {
  const acc = createRawCodexAccumulator();
  consumeRawCodexLine(acc, JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 30, cache_write_input_tokens: 5 },
  }));
  assert.deepEqual(acc.usage, {
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 30,
    cache_creation_input_tokens: 5,
  });
});

test('consumeRawCodexLine: turn.completed.usage の欠落フィールドは0扱い', () => {
  const acc = createRawCodexAccumulator();
  consumeRawCodexLine(acc, JSON.stringify({ type: 'turn.completed', usage: {} }));
  assert.deepEqual(acc.usage, {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });
});

test('consumeRawCodexLine: turn.completed に usage が無ければ acc.usage は据え置き', () => {
  const acc = createRawCodexAccumulator();
  consumeRawCodexLine(acc, JSON.stringify({ type: 'turn.completed' }));
  assert.equal(acc.usage, undefined);
});

test('consumeRawCodexLine: turn.failed はエラーメッセージを記録する（最初の1件のみ保持）', () => {
  const acc = createRawCodexAccumulator();
  consumeRawCodexLine(acc, JSON.stringify({ type: 'turn.failed', error: { message: 'boom' } }));
  consumeRawCodexLine(acc, JSON.stringify({ type: 'turn.failed', error: { message: 'second boom' } }));
  assert.equal(acc.failedMessage, 'boom');
});

test('consumeRawCodexLine: error イベントもエラーメッセージを記録する', () => {
  const acc = createRawCodexAccumulator();
  consumeRawCodexLine(acc, JSON.stringify({ type: 'error', message: 'fatal' }));
  assert.equal(acc.failedMessage, 'fatal');
});

test('consumeRawCodexLine: 非 JSON 行は plainLines に退避し本文には混ぜない', () => {
  const acc = createRawCodexAccumulator();
  consumeRawCodexLine(acc, 'not valid json {{{');
  assert.deepEqual(acc.plainLines, ['not valid json {{{']);
  assert.equal(acc.text, '');
});

test('consumeRawCodexLine: 未知の type は無視する（例外を投げない）', () => {
  const acc = createRawCodexAccumulator();
  assert.doesNotThrow(() => consumeRawCodexLine(acc, JSON.stringify({ type: 'turn.started' })));
  assert.doesNotThrow(() => consumeRawCodexLine(acc, JSON.stringify({ type: 'unknown.event.xyz' })));
});

test('consumeRawCodexLine: item が欠落・型不正でも例外を投げない', () => {
  const acc = createRawCodexAccumulator();
  assert.doesNotThrow(() => consumeRawCodexLine(acc, JSON.stringify({ type: 'item.completed' })));
  assert.doesNotThrow(() => consumeRawCodexLine(acc, JSON.stringify({ type: 'item.completed', item: null })));
  assert.doesNotThrow(() => consumeRawCodexLine(acc, JSON.stringify({ type: 'item.completed', item: {} })));
});

// ---- resolveRawCodexResult ----

function baseResolveInput(overrides = {}) {
  const acc = overrides.acc ?? createRawCodexAccumulator();
  return {
    acc,
    exitCode: 0,
    signal: null,
    timedOut: false,
    stderrTail: '',
    requestedModel: 'gpt-5.6-terra',
    ...overrides,
  };
}

test('resolveRawCodexResult: timedOut が最優先で ok:false/stopReason:timeout', () => {
  const acc = createRawCodexAccumulator();
  acc.text = 'partial';
  const result = resolveRawCodexResult(baseResolveInput({ acc, timedOut: true }));
  assert.equal(result.ok, false);
  assert.equal(result.stopReason, 'timeout');
});

test('resolveRawCodexResult: executedTools 非空なら ok:false・本文は返さない', () => {
  const acc = createRawCodexAccumulator();
  acc.text = 'should not leak';
  acc.executedTools = ['command_execution'];
  const result = resolveRawCodexResult(baseResolveInput({ acc }));
  assert.equal(result.ok, false);
  assert.equal(result.text, '');
  assert.match(result.errorMessage, /executed a tool/);
  assert.deepEqual(result.deniedTools, ['codex:command_execution']);
});

test('resolveRawCodexResult: executedTools は重複除去してエラーメッセージに列挙する', () => {
  const acc = createRawCodexAccumulator();
  acc.executedTools = ['command_execution', 'command_execution', 'file_change'];
  const result = resolveRawCodexResult(baseResolveInput({ acc }));
  assert.match(result.errorMessage, /command_execution, file_change/);
  assert.deepEqual(result.deniedTools, ['codex:command_execution', 'codex:command_execution', 'codex:file_change']);
});

test('resolveRawCodexResult: failedMessage があれば ok:false', () => {
  const acc = createRawCodexAccumulator();
  acc.failedMessage = 'turn failed for reasons';
  const result = resolveRawCodexResult(baseResolveInput({ acc }));
  assert.equal(result.ok, false);
  assert.equal(result.errorMessage, 'turn failed for reasons');
});

test('resolveRawCodexResult: exitCode非ゼロ + usage未受信は ok:false（stderr末尾を含める）', () => {
  const acc = createRawCodexAccumulator();
  const result = resolveRawCodexResult(baseResolveInput({ acc, exitCode: 1, stderrTail: 'auth error: not logged in' }));
  assert.equal(result.ok, false);
  assert.match(result.errorMessage, /exited with code 1/);
  assert.match(result.errorMessage, /auth error/);
});

test('resolveRawCodexResult: exitCode非ゼロでも usage 受信済みなら成功扱い（turn.completed後のexit code誤差を許容）', () => {
  const acc = createRawCodexAccumulator();
  acc.text = 'done';
  acc.usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const result = resolveRawCodexResult(baseResolveInput({ acc, exitCode: 1 }));
  assert.equal(result.ok, true);
  assert.equal(result.text, 'done');
});

test('resolveRawCodexResult: 正常系は ok:true・stopReason:success・usageData を Claude 互換形に整形', () => {
  const acc = createRawCodexAccumulator();
  acc.text = 'Hello, seat.';
  acc.usage = { input_tokens: 500, output_tokens: 50, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 };
  const result = resolveRawCodexResult(baseResolveInput({ acc, requestedModel: 'gpt-5.6-terra' }));
  assert.equal(result.ok, true);
  assert.equal(result.text, 'Hello, seat.');
  assert.equal(result.stopReason, 'success');
  assert.deepEqual(result.deniedTools, []);
  assert.deepEqual(result.usageData, {
    usage: acc.usage,
    modelUsage: { 'gpt-5.6-terra': acc.usage },
    model: 'gpt-5.6-terra',
  });
});

test('resolveRawCodexResult: usage が全く無ければ usageData は undefined（0埋めで捏造しない）', () => {
  const acc = createRawCodexAccumulator();
  acc.text = 'hi';
  const result = resolveRawCodexResult(baseResolveInput({ acc }));
  assert.equal(result.ok, true);
  assert.equal(result.usageData, undefined);
});

test('resolveRawCodexResult: requestedModel 未指定でも usageData.model は undefined のまま（捏造しない）', () => {
  const acc = createRawCodexAccumulator();
  acc.text = 'hi';
  acc.usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const result = resolveRawCodexResult(baseResolveInput({ acc, requestedModel: undefined }));
  assert.equal(result.usageData.model, undefined);
  assert.deepEqual(Object.keys(result.usageData.modelUsage), ['codex']);
});

test('resolveRawCodexResult: cacheWrite（cache_creation_input_tokens）はマッピング元が無ければ常に0', () => {
  const acc = createRawCodexAccumulator();
  consumeRawCodexLine(acc, JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }));
  const result = resolveRawCodexResult(baseResolveInput({ acc }));
  assert.equal(result.usageData.usage.cache_creation_input_tokens, 0);
});

test('resolveRawCodexResult: 判定順は timedOut > executedTools > failedMessage > exitCode（同時発生時）', () => {
  const acc = createRawCodexAccumulator();
  acc.executedTools = ['command_execution'];
  acc.failedMessage = 'also failed';
  const result = resolveRawCodexResult(baseResolveInput({ acc, exitCode: 1, timedOut: true }));
  assert.equal(result.stopReason, 'timeout');
});
