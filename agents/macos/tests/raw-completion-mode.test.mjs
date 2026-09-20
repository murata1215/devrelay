// raw-completion（ゲーム席用の素の completion API）の Agent 側モード定義の単体テスト。
// 外部 import ゼロの純粋関数（agents/linux/src/services/raw-completion-mode.ts）を
// コンパイル済み dist から直接 import する（session-scope.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RAW_MAX_TURNS,
  RAW_DISALLOWED_TOOLS,
  RAW_ENV_OVERRIDES,
  RAW_AUTO_MEMORY_DIR,
  composeRawPrompt,
  buildRawSdkOverrides,
  buildRawEnv,
  isRawToolDenied,
  buildRawDenyMessage,
  resolveRawCompletionResult,
  resolveRawUsedModel,
} from '../dist/services/raw-completion-mode.js';
import * as rawCompletionMode from '../dist/services/raw-completion-mode.js';

// ---- 定数 ----

test('RAW_MAX_TURNS: 1 ではなく 2（off-by-one 対策）', () => {
  assert.equal(RAW_MAX_TURNS, 2);
});

test('RAW_DISALLOWED_TOOLS: 主要な編集・実行系ツールを含む', () => {
  for (const tool of ['Bash', 'Read', 'Write', 'Edit', 'WebFetch', 'Task', 'AskUserQuestion', 'ExitPlanMode']) {
    assert.ok(RAW_DISALLOWED_TOOLS.includes(tool), `${tool} が含まれていない`);
  }
});

// ---- composeRawPrompt ----

test('composeRawPrompt: 恒等関数（DevRelay の前置きを一切付けない契約）', () => {
  assert.equal(composeRawPrompt('自分の役割は？'), '自分の役割は？');
  assert.equal(composeRawPrompt(''), '');
  const multiline = 'line1\nline2\n---\nline3';
  assert.equal(composeRawPrompt(multiline), multiline);
});

// ---- buildRawSdkOverrides ----

test('buildRawSdkOverrides: systemPrompt を完全置換する', () => {
  const overrides = buildRawSdkOverrides('あなたは談合カードのプレイヤーP05である');
  assert.equal(overrides.systemPrompt, 'あなたは談合カードのプレイヤーP05である');
});

test('buildRawSdkOverrides: tools/settingSources を空配列にする（D1 第1層・第4層前提）', () => {
  const overrides = buildRawSdkOverrides('sys');
  assert.deepEqual(overrides.tools, []);
  assert.deepEqual(overrides.settingSources, []);
});

test('buildRawSdkOverrides: disallowedTools は RAW_DISALLOWED_TOOLS そのもの（D1 第2層）', () => {
  const overrides = buildRawSdkOverrides('sys');
  assert.equal(overrides.disallowedTools, RAW_DISALLOWED_TOOLS);
});

test('buildRawSdkOverrides: permissionMode は default 固定（Phase 1.2: plan は SDK が plan-mode reminder を注入するため不可）', () => {
  const overrides = buildRawSdkOverrides('sys');
  assert.equal(overrides.permissionMode, 'default');
  assert.notEqual(overrides.permissionMode, 'plan'); // 回帰防止: 'plan' へ戻すと Phase 1.2 の不具合が再発する
});

test('buildRawSdkOverrides: mcpServers は空オブジェクト + strictMcpConfig true（MCP 経由の再導入を塞ぐ）', () => {
  const overrides = buildRawSdkOverrides('sys');
  assert.deepEqual(overrides.mcpServers, {});
  assert.equal(overrides.strictMcpConfig, true);
});

test('buildRawSdkOverrides: maxTurns は RAW_MAX_TURNS と一致する', () => {
  const overrides = buildRawSdkOverrides('sys');
  assert.equal(overrides.maxTurns, RAW_MAX_TURNS);
});

test('buildRawSdkOverrides: settings.autoMemoryEnabled は false（auto-memory 注入を settings 層で塞ぐ、Phase 1.3 第2層）', () => {
  const overrides = buildRawSdkOverrides('sys');
  assert.equal(overrides.settings.autoMemoryEnabled, false);
});

test('buildRawSdkOverrides: settings.autoMemoryDirectory は raw 専用ディレクトリ（Phase 1.3 第3層。~/ 展開に依存）', () => {
  const overrides = buildRawSdkOverrides('sys');
  assert.equal(overrides.settings.autoMemoryDirectory, RAW_AUTO_MEMORY_DIR);
  assert.match(RAW_AUTO_MEMORY_DIR, /^~\//);
});

test('buildRawSdkOverrides: settings と settingSources:[] は併存する（flagSettings は setting-sources に依らず常にマージされる）', () => {
  const overrides = buildRawSdkOverrides('sys');
  assert.ok(overrides.settings, 'settings が存在しない');
  assert.deepEqual(overrides.settingSources, []);
});

test('buildRawSdkOverrides: env を返さない（呼び出し元の env 全体を破壊しない契約）', () => {
  const overrides = buildRawSdkOverrides('sys');
  assert.equal('env' in overrides, false);
});

test('buildRawSdkOverrides: Phase 1.2 までの既存キーが settings 追加後も不変（回帰防止）', () => {
  const overrides = buildRawSdkOverrides('sys');
  assert.equal(overrides.systemPrompt, 'sys');
  assert.deepEqual(overrides.tools, []);
  assert.deepEqual(overrides.settingSources, []);
  assert.equal(overrides.disallowedTools, RAW_DISALLOWED_TOOLS);
  assert.equal(overrides.permissionMode, 'default');
  assert.deepEqual(overrides.mcpServers, {});
  assert.equal(overrides.strictMcpConfig, true);
  assert.equal(overrides.maxTurns, RAW_MAX_TURNS);
  assert.equal(Object.keys(overrides).length, 10); // キーの黙った追加を検出（Phase 1.4: persistSession 追加で 9→10）
});

test('buildRawSdkOverrides: persistSession は false（Phase 1.4、トランスクリプトを書かない）', () => {
  const overrides = buildRawSdkOverrides('sys');
  assert.equal(overrides.persistSession, false);
});

// ---- buildRawEnv / RAW_ENV_OVERRIDES（auto-memory 遮断・第1層 + Phase 1.4 追加分） ----

test('RAW_ENV_OVERRIDES: Phase 1.4 で追加した3キーを含む', () => {
  assert.deepEqual(RAW_ENV_OVERRIDES, {
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
    CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1',
  });
});

test('buildRawEnv: ベース env（PATH/HOME/proxy/DEVRELAY_*）を保持する', () => {
  const base = {
    PATH: '/usr/bin',
    HOME: '/home/devrelay',
    HTTPS_PROXY: 'http://proxy:8080',
    DEVRELAY: '1',
    DEVRELAY_SESSION_ID: 'raw_abc123',
    DEVRELAY_PROJECT: '/opt/devrelay',
  };
  const result = buildRawEnv(base);
  for (const key of Object.keys(base)) {
    assert.equal(result[key], base[key], `${key} が保持されていない`);
  }
  assert.equal(result.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
  assert.equal(result.CLAUDE_CODE_DISABLE_TERMINAL_TITLE, '1');
  assert.equal(result.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS, '1');
});

test('buildRawEnv: agent 側が 0 で起動していても 1 に倒す（override が後勝ち）', () => {
  const result = buildRawEnv({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' });
  assert.equal(result.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
});

test('buildRawEnv: 入力オブジェクトを破壊しない', () => {
  const base = { PATH: '/usr/bin' };
  const result = buildRawEnv(base);
  assert.equal('CLAUDE_CODE_DISABLE_AUTO_MEMORY' in base, false);
  assert.notEqual(result, base);
});

test('buildRawEnv: 空 env でも例外を投げず override のみを返す', () => {
  assert.deepEqual(buildRawEnv({}), RAW_ENV_OVERRIDES);
});

test('buildRawEnv: 値が undefined のキーを落とさない（process.env は undefined を含みうる）', () => {
  const result = buildRawEnv({ FOO: undefined });
  assert.ok('FOO' in result);
  assert.equal(result.FOO, undefined);
});

test('buildRawEnv: 二重適用が冪等', () => {
  const base = { PATH: '/usr/bin' };
  assert.deepEqual(buildRawEnv(buildRawEnv(base)), buildRawEnv(base));
});

// ---- isRawToolDenied / buildRawDenyMessage ----

test('isRawToolDenied: 常に true（D1 第3層・無条件 deny）', () => {
  assert.equal(isRawToolDenied(), true);
});

test('buildRawDenyMessage: ツール名を含む拒否メッセージを返す', () => {
  const msg = buildRawDenyMessage('Bash');
  assert.match(msg, /Bash/);
  assert.match(msg, /denied/);
});

// ---- resolveRawCompletionResult（本文の配線。Phase 1.1 空レスポンス根治の核心） ----

test('resolveRawCompletionResult: 連結済み本文（rawOutput）が最終コールバックの空文字より優先される（空レスポンス根治の核心）', () => {
  const result = resolveRawCompletionResult({
    rawOutput: 'こんにちは、P05です。',
    completionText: '',
    completionSeen: true,
    stopReason: 'success',
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'こんにちは、P05です。');
});

test('resolveRawCompletionResult: rawOutput が空文字でも success なら ok:true・text は空文字（例外を投げない）', () => {
  const result = resolveRawCompletionResult({
    rawOutput: '',
    completionText: '(No response from AI)',
    completionSeen: true,
    stopReason: 'success',
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, '');
});

test('resolveRawCompletionResult: 最終コールバックの (No response from AI) を本文として採用しない', () => {
  const result = resolveRawCompletionResult({
    rawOutput: '実際の回答テキスト',
    completionText: '(No response from AI)',
    completionSeen: true,
    stopReason: 'success',
  });
  assert.equal(result.text, '実際の回答テキスト');
  assert.notEqual(result.text, '(No response from AI)');
});

test('resolveRawCompletionResult: stopReason 未指定（rawOutput あり＝自然終了フォールバック）は success に正規化する', () => {
  const result = resolveRawCompletionResult({
    rawOutput: '応答本文',
    completionText: '',
    completionSeen: true,
    stopReason: undefined,
  });
  assert.equal(result.ok, true);
  assert.equal(result.stopReason, 'success');
});

// ---- stopReason / エラー伝播 ----

test('resolveRawCompletionResult: stopReason=max_turns は ok:true のまま部分出力と stopReason を返す（切り詰めを隠さない）', () => {
  const result = resolveRawCompletionResult({
    rawOutput: '途中まで書いた応答',
    completionText: '',
    completionSeen: true,
    stopReason: 'max_turns',
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, '途中まで書いた応答');
  assert.equal(result.stopReason, 'max_turns');
});

test('resolveRawCompletionResult: stopReason=error は ok:false・errorMessage に本文を載せる', () => {
  const result = resolveRawCompletionResult({
    rawOutput: 'エラー時の部分出力',
    completionText: '',
    completionSeen: true,
    stopReason: 'error',
  });
  assert.equal(result.ok, false);
  assert.equal(result.stopReason, 'error');
  assert.equal(result.errorMessage, 'エラー時の部分出力');
});

test('resolveRawCompletionResult: rawOutput 未設定（エラー分岐の早期 return）は完了テキストを errorMessage へ回し text は空にする', () => {
  const result = resolveRawCompletionResult({
    rawOutput: undefined,
    completionText: '⚠️ プロンプトが長すぎます。',
    completionSeen: true,
    stopReason: undefined,
  });
  assert.equal(result.ok, false);
  assert.equal(result.text, '');
  assert.equal(result.errorMessage, '⚠️ プロンプトが長すぎます。');
});

test('resolveRawCompletionResult: rawOutput 未設定 + stopReason 未指定は error として扱う（無言の success にしない）', () => {
  const result = resolveRawCompletionResult({
    rawOutput: undefined,
    completionText: 'なんらかのエラー文言',
    completionSeen: true,
    stopReason: undefined,
  });
  assert.equal(result.ok, false);
  assert.equal(result.stopReason, 'error');
});

test('resolveRawCompletionResult: rawOutput 未設定 + stopReason=aborted（loop-guard）は aborted を保ったまま ok:false', () => {
  const result = resolveRawCompletionResult({
    rawOutput: undefined,
    completionText: 'ループガードにより打ち切りました',
    completionSeen: true,
    stopReason: 'aborted',
  });
  assert.equal(result.ok, false);
  assert.equal(result.stopReason, 'aborted');
});

test('resolveRawCompletionResult: 完了シグナル自体が来なければ ok:false・errorMessage を明示する', () => {
  const result = resolveRawCompletionResult({
    rawOutput: undefined,
    completionText: '',
    completionSeen: false,
    stopReason: undefined,
  });
  assert.equal(result.ok, false);
  assert.equal(result.stopReason, 'error');
  assert.match(result.errorMessage, /completion signal/);
});

test('resolveRawCompletionResult: 完了テキストが空白のみなら既定のエラー文言にフォールバックする', () => {
  const result = resolveRawCompletionResult({
    rawOutput: undefined,
    completionText: '   ',
    completionSeen: true,
    stopReason: undefined,
  });
  assert.equal(result.ok, false);
  assert.match(result.errorMessage, /without output/);
});

// ---- deniedTools ----

test('resolveRawCompletionResult: deniedTools は重複を除去し入力順を保つ', () => {
  const result = resolveRawCompletionResult({
    rawOutput: 'ok',
    completionText: '',
    completionSeen: true,
    stopReason: 'success',
    deniedTools: ['Bash', 'Read', 'Bash', 'Write', 'Read'],
  });
  assert.deepEqual(result.deniedTools, ['Bash', 'Read', 'Write']);
});

test('resolveRawCompletionResult: deniedTools 未指定なら空配列を返す（undefined を返さない）', () => {
  const result = resolveRawCompletionResult({
    rawOutput: 'ok',
    completionText: '',
    completionSeen: true,
    stopReason: 'success',
  });
  assert.deepEqual(result.deniedTools, []);
});

test('resolveRawCompletionResult: 入力の deniedTools 配列と戻り値の配列が同一参照でない（呼び出し元の破壊を防ぐ）', () => {
  const input = ['Bash'];
  const result = resolveRawCompletionResult({
    rawOutput: 'ok',
    completionText: '',
    completionSeen: true,
    stopReason: 'success',
    deniedTools: input,
  });
  assert.notEqual(result.deniedTools, input);
});

// ---- resolveRawUsedModel（Phase 1.4: model 誤判定の根治） ----

test('resolveRawUsedModel: (a) 通常ケース — assistant model が最優先（modelUsage の先頭が Haiku でも無視）', () => {
  const model = resolveRawUsedModel({
    lastAssistantModel: 'claude-opus-5',
    requestedModel: 'claude-opus-5',
    modelUsage: {
      'claude-haiku-4-5-20251001': { outputTokens: 15 },
      'claude-opus-5': { outputTokens: 675 },
    },
  });
  assert.equal(model, 'claude-opus-5');
});

test('resolveRawUsedModel: (b) 応答が数トークンで Haiku 内部呼び出しの output の方が多いケース（必須ケース）', () => {
  // assistant model が取れず、Haiku(out=20) > 本体(out=12) でも requestedModel 一致を優先する
  const model = resolveRawUsedModel({
    lastAssistantModel: undefined,
    requestedModel: 'claude-fable-5-1',
    modelUsage: {
      'claude-fable-5-1': { outputTokens: 12 },
      'claude-haiku-4-5-20251001': { outputTokens: 20 },
    },
  });
  assert.equal(model, 'claude-fable-5-1');
});

test('resolveRawUsedModel: (c) assistant model 取れず、requested の前方一致で解決する', () => {
  const model = resolveRawUsedModel({
    lastAssistantModel: undefined,
    requestedModel: 'claude-opus-5',
    modelUsage: {
      'claude-opus-5-20260301': { outputTokens: 100 },
      'claude-haiku-4-5-20251001': { outputTokens: 500 },
    },
  });
  assert.equal(model, 'claude-opus-5-20260301');
});

test('resolveRawUsedModel: (d) 全部取れず最終手段（outputTokens 最大）に落ちる', () => {
  const model = resolveRawUsedModel({
    lastAssistantModel: undefined,
    requestedModel: undefined,
    modelUsage: {
      'claude-haiku-4-5-20251001': { outputTokens: 15 },
      'claude-opus-5': { outputTokens: 675 },
    },
  });
  assert.equal(model, 'claude-opus-5');
});

test('resolveRawUsedModel: lastAssistantModel が "<synthetic>" 等の無効値なら次の優先度へ落ちる', () => {
  const model = resolveRawUsedModel({
    lastAssistantModel: '<synthetic>',
    requestedModel: 'claude-opus-5',
    modelUsage: { 'claude-opus-5': { outputTokens: 10 } },
  });
  assert.equal(model, 'claude-opus-5');
});

test('resolveRawUsedModel: lastAssistantModel が空文字なら次の優先度へ落ちる', () => {
  const model = resolveRawUsedModel({
    lastAssistantModel: '',
    requestedModel: undefined,
    modelUsage: { 'claude-opus-5': { outputTokens: 10 } },
  });
  assert.equal(model, 'claude-opus-5');
});

test('resolveRawUsedModel: modelUsage が空オブジェクトなら undefined（例外を投げない）', () => {
  assert.equal(resolveRawUsedModel({ modelUsage: {} }), undefined);
});

test('resolveRawUsedModel: すべて欠落していれば undefined（例外を投げない）', () => {
  assert.equal(resolveRawUsedModel({}), undefined);
});

test('resolveRawUsedModel: modelUsage 未指定でも例外を投げない', () => {
  assert.equal(resolveRawUsedModel({ lastAssistantModel: undefined, requestedModel: 'claude-opus-5' }), undefined);
});

test('resolveRawUsedModel: outputTokens が欠落・非数値のエントリは 0 扱い（例外を投げない）', () => {
  const model = resolveRawUsedModel({
    modelUsage: {
      'model-a': {},
      'model-b': { outputTokens: 'not-a-number' },
      'model-c': { outputTokens: 5 },
    },
  });
  assert.equal(model, 'model-c');
});

// ---- mapRawUsage の削除確認（要件3の end state を表明: 死コードの復活防止） ----

test('mapRawUsage: 削除済み（raw-completion-mode.js から export されていない）', () => {
  assert.equal(rawCompletionMode.mapRawUsage, undefined);
});
