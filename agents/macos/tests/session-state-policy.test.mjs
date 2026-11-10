// 案C′（クロス ask のセッション継続）サイクルC1: 一時セッションの状態ポリシー
// （session-scope.ts の resolveSessionStatePolicy）の単体テスト。
// 外部 import ゼロの純粋関数をコンパイル済み dist から直接 import する
// （既存の session-scope.test.mjs / scope-dir.test.mjs と同じ流儀）。
//
// `agents/linux` と `agents/macos` と `agents/windows` で byte-for-byte 同一内容を維持すること
// （session-scope.ts 自体の規約と同じ）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSessionStatePolicy } from '../dist/services/session-scope.js';

const INTERACTIVE_POLICY = {
  scopedConversation: true,
  outputDirClear: true,
  outputFileCollect: true,
  planFile: true,
  workState: true,
  storageContext: true,
  receivedFiles: true,
  projectRescan: true,
  forcePlanTurn: false,
  outputDirInstruction: true,
};

const LEGACY_EPHEMERAL_POLICY = {
  scopedConversation: false,
  outputDirClear: false,
  outputFileCollect: true,
  planFile: false,
  workState: false,
  storageContext: true,
  receivedFiles: true,
  projectRescan: true,
  forcePlanTurn: false,
  outputDirInstruction: true,
};

const RESUMABLE_SCOPED_POLICY = {
  scopedConversation: true,
  outputDirClear: false,
  outputFileCollect: false,
  planFile: false,
  workState: false,
  storageContext: false,
  receivedFiles: false,
  projectRescan: false,
  forcePlanTurn: true,
  outputDirInstruction: false,
};

const VALID_SCOPE_ID = 'crossask-abc123_XYZ-789';
const EPHEMERAL_PREFIXES = ['crossquery_', 'teamexec_', 'askdesc_', 'raw_'];

// --- 対話セッション（interactive） ---

test('resolveSessionStatePolicy: interactive は opts 無指定で全許可（既存の !isEphemeral 分岐と完全一致）', () => {
  const policy = resolveSessionStatePolicy('normal-session-id', {});
  assert.deepEqual(policy, INTERACTIVE_POLICY);
});

test('resolveSessionStatePolicy: interactive は opts 省略（デフォルト引数）でも同じ結果', () => {
  const policy = resolveSessionStatePolicy('normal-session-id');
  assert.deepEqual(policy, INTERACTIVE_POLICY);
});

test('resolveSessionStatePolicy: interactive は statePolicy/agentScopeId を渡しても常に全許可のまま（resumable 分岐より先に短絡する）', () => {
  // interactive 判定が最優先のため、誤ってサーバーが statePolicy を送っても
  // 対話セッションが resumable の制限付きポリシーに縮退することは構造的に起き得ない。
  const policy = resolveSessionStatePolicy('normal-session-id', {
    statePolicy: 'resumable-scoped',
    agentScopeId: VALID_SCOPE_ID,
  });
  assert.deepEqual(policy, INTERACTIVE_POLICY);
});

// --- 従来の一時セッション（statePolicy 未指定、既存の isEphemeral=true 分岐と一致） ---

for (const prefix of EPHEMERAL_PREFIXES) {
  test(`resolveSessionStatePolicy: ${prefix} は statePolicy 未指定で従来の一時セッション扱い（挙動不変）`, () => {
    const policy = resolveSessionStatePolicy(`${prefix}abc123`, {});
    assert.deepEqual(policy, LEGACY_EPHEMERAL_POLICY);
  });

  test(`resolveSessionStatePolicy: ${prefix} は agentScopeId だけ渡しても statePolicy が無ければ従来扱い`, () => {
    const policy = resolveSessionStatePolicy(`${prefix}abc123`, { agentScopeId: VALID_SCOPE_ID });
    assert.deepEqual(policy, LEGACY_EPHEMERAL_POLICY);
  });
}

test('resolveSessionStatePolicy: teamExec/askDesc/raw は statePolicy+agentScopeId が揃っていても resumable にならない（crossQuery 限定）', () => {
  for (const prefix of ['teamexec_', 'askdesc_', 'raw_']) {
    const policy = resolveSessionStatePolicy(`${prefix}abc123`, {
      statePolicy: 'resumable-scoped',
      agentScopeId: VALID_SCOPE_ID,
    });
    assert.deepEqual(policy, LEGACY_EPHEMERAL_POLICY, `prefix=${prefix} が resumable に縮退してはいけない`);
  }
});

// --- resumable（第3区分）: crossQuery かつ statePolicy==='resumable-scoped' かつ agentScopeId 有効の3条件AND ---

test('resolveSessionStatePolicy: crossQuery + statePolicy=resumable-scoped + 有効な agentScopeId → resumable', () => {
  const policy = resolveSessionStatePolicy('crossquery_abc123', {
    statePolicy: 'resumable-scoped',
    agentScopeId: VALID_SCOPE_ID,
  });
  assert.deepEqual(policy, RESUMABLE_SCOPED_POLICY);
});

test('resolveSessionStatePolicy: resumable では conversation 以外が全て deny（savePlanFile/clearOutputDir/workState 等への影響を固定）', () => {
  const policy = resolveSessionStatePolicy('crossquery_abc123', {
    statePolicy: 'resumable-scoped',
    agentScopeId: VALID_SCOPE_ID,
  });
  assert.equal(policy.scopedConversation, true);
  assert.equal(policy.forcePlanTurn, true);
  assert.equal(policy.outputDirClear, false);
  assert.equal(policy.outputFileCollect, false);
  assert.equal(policy.planFile, false);
  assert.equal(policy.workState, false);
  assert.equal(policy.storageContext, false);
  assert.equal(policy.receivedFiles, false);
  assert.equal(policy.projectRescan, false);
  assert.equal(policy.outputDirInstruction, false);
});

test('resolveSessionStatePolicy: crossQuery + agentScopeId 未指定 → statePolicy=resumable-scoped でも従来扱い', () => {
  const policy = resolveSessionStatePolicy('crossquery_abc123', { statePolicy: 'resumable-scoped' });
  assert.deepEqual(policy, LEGACY_EPHEMERAL_POLICY);
});

test('resolveSessionStatePolicy: crossQuery + 不正な agentScopeId（パストラバーサル文字含む）→ 従来扱い', () => {
  for (const invalidScopeId of ['../etc/passwd', 'a/b', '', 'a.b', 'a'.repeat(129)]) {
    const policy = resolveSessionStatePolicy('crossquery_abc123', {
      statePolicy: 'resumable-scoped',
      agentScopeId: invalidScopeId,
    });
    assert.deepEqual(policy, LEGACY_EPHEMERAL_POLICY, `agentScopeId=${JSON.stringify(invalidScopeId)} は resumable にならない`);
  }
});

test('resolveSessionStatePolicy: crossQuery + 有効な agentScopeId だが statePolicy が異なる値/未指定 → 従来扱い', () => {
  for (const statePolicy of [undefined, '', 'interactive', 'resumable', 'Resumable-Scoped']) {
    const policy = resolveSessionStatePolicy('crossquery_abc123', {
      statePolicy,
      agentScopeId: VALID_SCOPE_ID,
    });
    assert.deepEqual(policy, LEGACY_EPHEMERAL_POLICY, `statePolicy=${JSON.stringify(statePolicy)} は resumable にならない`);
  }
});

test('resolveSessionStatePolicy: agentScopeId は 128 文字まで有効（境界値）', () => {
  const policy = resolveSessionStatePolicy('crossquery_abc123', {
    statePolicy: 'resumable-scoped',
    agentScopeId: 'a'.repeat(128),
  });
  assert.deepEqual(policy, RESUMABLE_SCOPED_POLICY);
});

// --- 戻り値の独立性（呼び出しごとに新しいオブジェクトを返す） ---

test('resolveSessionStatePolicy: 戻り値は呼び出しごとに新しいオブジェクト（ミューテーションが他の呼び出しに影響しない）', () => {
  const policy1 = resolveSessionStatePolicy('normal-session-id', {});
  policy1.scopedConversation = false;
  const policy2 = resolveSessionStatePolicy('normal-session-id', {});
  assert.equal(policy2.scopedConversation, true, 'policy1 への変更が policy2 に漏れてはいけない');
});
