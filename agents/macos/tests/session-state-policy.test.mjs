// 案C′（クロス ask のセッション継続）サイクルC1 + サイクルG（既存バグ修正）: 一時セッションの
// 状態ポリシー（session-scope.ts の resolveSessionStatePolicy）の単体テスト。
// 外部 import ゼロの純粋関数をコンパイル済み dist から直接 import する
// （既存の session-scope.test.mjs / scope-dir.test.mjs と同じ流儀）。
//
// `agents/linux` と `agents/macos` と `agents/windows` で byte-for-byte 同一内容を維持すること
// （session-scope.ts 自体の規約と同じ）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSessionStatePolicy, isAiToolReadOnlyEnforceable } from '../dist/services/session-scope.js';

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
  projectStateRead: true,
  approveAllState: true,
  refuseUnsafeAiTool: false,
  reportAiToolSubstitution: true,
  crossAskScope: false,
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
  projectStateRead: true,
  approveAllState: false,
  refuseUnsafeAiTool: false,
  reportAiToolSubstitution: true,
  crossAskScope: false,
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
  projectStateRead: true,
  approveAllState: false,
  // サイクルC2（A-1）: isolated と同じ true に揃えた（C1 時点の暫定値 false から変更）。
  refuseUnsafeAiTool: true,
  reportAiToolSubstitution: false,
  crossAskScope: true,
};

const ISOLATED_POLICY = {
  scopedConversation: false,
  outputDirClear: false,
  outputFileCollect: false,
  planFile: false,
  workState: false,
  storageContext: false,
  receivedFiles: false,
  projectRescan: false,
  // サイクルS2a（新発見④）: C2 時点の暫定値 false から true に変更。resumable にある
  // 「履歴に exec マーカーが混入していても plan ターンに固定する」構造的保証を isolated にも揃える。
  forcePlanTurn: true,
  outputDirInstruction: false,
  projectStateRead: false,
  approveAllState: false,
  refuseUnsafeAiTool: true,
  reportAiToolSubstitution: false,
  crossAskScope: true,
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

test('resolveSessionStatePolicy: interactive は statePolicy/agentScopeId を渡しても常に全許可のまま（resumable/isolated 分岐より先に短絡する）', () => {
  // interactive 判定が最優先のため、誤ってサーバーが statePolicy を送っても
  // 対話セッションが制限付きポリシーに縮退することは構造的に起き得ない。
  for (const statePolicy of ['resumable-scoped', 'isolated']) {
    const policy = resolveSessionStatePolicy('normal-session-id', {
      statePolicy,
      agentScopeId: VALID_SCOPE_ID,
    });
    assert.deepEqual(policy, INTERACTIVE_POLICY, `statePolicy=${statePolicy}`);
  }
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

test('resolveSessionStatePolicy: teamExec/askDesc/raw は statePolicy=isolated を送っても isolated にならない（crossQuery 限定）', () => {
  for (const prefix of ['teamexec_', 'askdesc_', 'raw_']) {
    const policy = resolveSessionStatePolicy(`${prefix}abc123`, { statePolicy: 'isolated' });
    assert.deepEqual(policy, LEGACY_EPHEMERAL_POLICY, `prefix=${prefix} が isolated に縮退してはいけない`);
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

test('resolveSessionStatePolicy: resumable では conversation 系以外が全て deny（savePlanFile/clearOutputDir/workState 等への影響を固定）', () => {
  const policy = resolveSessionStatePolicy('crossquery_abc123', {
    statePolicy: 'resumable-scoped',
    agentScopeId: VALID_SCOPE_ID,
  });
  assert.equal(policy.scopedConversation, true);
  assert.equal(policy.forcePlanTurn, true);
  assert.equal(policy.projectStateRead, true);
  assert.equal(policy.outputDirClear, false);
  assert.equal(policy.outputFileCollect, false);
  assert.equal(policy.planFile, false);
  assert.equal(policy.workState, false);
  assert.equal(policy.storageContext, false);
  assert.equal(policy.receivedFiles, false);
  assert.equal(policy.projectRescan, false);
  assert.equal(policy.outputDirInstruction, false);
  assert.equal(policy.approveAllState, false);
  // サイクルC2（A-1）: resumable も isolated と同じ true（C1 時点の false から変更）。
  assert.equal(policy.refuseUnsafeAiTool, true);
  assert.equal(policy.reportAiToolSubstitution, false);
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

// --- isolated（第4区分、サイクルG）: crossQuery かつ statePolicy==='isolated'。agentScopeId は不要 ---

test('resolveSessionStatePolicy: crossQuery + statePolicy=isolated → isolated（agentScopeId 不要）', () => {
  const policy = resolveSessionStatePolicy('crossquery_abc123', { statePolicy: 'isolated' });
  assert.deepEqual(policy, ISOLATED_POLICY);
});

test('resolveSessionStatePolicy: crossQuery + statePolicy=isolated は agentScopeId を渡しても結果が変わらない', () => {
  const policy = resolveSessionStatePolicy('crossquery_abc123', {
    statePolicy: 'isolated',
    agentScopeId: VALID_SCOPE_ID,
  });
  assert.deepEqual(policy, ISOLATED_POLICY);
});

test('resolveSessionStatePolicy: isolated では conversation も含めて全て deny、refuseUnsafeAiTool/forcePlanTurn/crossAskScope のみ true', () => {
  const policy = resolveSessionStatePolicy('crossquery_abc123', { statePolicy: 'isolated' });
  assert.equal(policy.scopedConversation, false);
  assert.equal(policy.outputDirClear, false);
  assert.equal(policy.outputFileCollect, false);
  assert.equal(policy.planFile, false);
  assert.equal(policy.workState, false);
  assert.equal(policy.storageContext, false);
  assert.equal(policy.receivedFiles, false);
  assert.equal(policy.projectRescan, false);
  assert.equal(policy.forcePlanTurn, true);
  assert.equal(policy.outputDirInstruction, false);
  assert.equal(policy.projectStateRead, false);
  assert.equal(policy.approveAllState, false);
  assert.equal(policy.reportAiToolSubstitution, false);
  assert.equal(policy.refuseUnsafeAiTool, true);
  assert.equal(policy.crossAskScope, true);
});

test('resolveSessionStatePolicy: statePolicy の大文字小文字違い・別文字列は isolated にならない', () => {
  for (const statePolicy of ['Isolated', 'ISOLATED', 'isolated-scoped', ' isolated']) {
    const policy = resolveSessionStatePolicy('crossquery_abc123', { statePolicy });
    assert.deepEqual(policy, LEGACY_EPHEMERAL_POLICY, `statePolicy=${JSON.stringify(statePolicy)} は isolated にならない`);
  }
});

// --- 戻り値の独立性（呼び出しごとに新しいオブジェクトを返す） ---

test('resolveSessionStatePolicy: 戻り値は呼び出しごとに新しいオブジェクト（ミューテーションが他の呼び出しに影響しない）', () => {
  const policy1 = resolveSessionStatePolicy('normal-session-id', {});
  policy1.scopedConversation = false;
  const policy2 = resolveSessionStatePolicy('normal-session-id', {});
  assert.equal(policy2.scopedConversation, true, 'policy1 への変更が policy2 に漏れてはいけない');
});

// --- isAiToolReadOnlyEnforceable（サイクルG, G-7 の一般化） ---

test('isAiToolReadOnlyEnforceable: claude/codex は terminalMode=false で強制可能', () => {
  assert.equal(isAiToolReadOnlyEnforceable('claude', false), true);
  assert.equal(isAiToolReadOnlyEnforceable('codex', false), true);
});

test('isAiToolReadOnlyEnforceable: claude + terminalMode=true は強制不可（PTY 経由では --permission-mode plan が適用されない）', () => {
  assert.equal(isAiToolReadOnlyEnforceable('claude', true), false);
  assert.equal(isAiToolReadOnlyEnforceable('codex', true), false);
});

test('isAiToolReadOnlyEnforceable: devin/gemini は terminalMode の値に関わらず強制不可', () => {
  for (const terminalMode of [false, true]) {
    assert.equal(isAiToolReadOnlyEnforceable('devin', terminalMode), false);
    assert.equal(isAiToolReadOnlyEnforceable('gemini', terminalMode), false);
  }
});

test('isAiToolReadOnlyEnforceable: 未知の AI ツール名は強制不可（deny-by-default）', () => {
  assert.equal(isAiToolReadOnlyEnforceable('unknown-tool', false), false);
});

// --- サイクルC2: resumable と isolated の差分を不変条件として固定 ---

test('【不変条件】resumable が isolated より緩いのは scopedConversation と projectStateRead の2項目だけ', () => {
  // サイクルS2a: isolated の forcePlanTurn を true に揃えたため、両者とも true/true で等しくなり
  // 「true かどうか」の比較から自然に除外される（POLARITY_INVERTED_KEYS の特別扱いは不要になった）。
  const keys = Object.keys(RESUMABLE_SCOPED_POLICY);
  const looserKeys = keys.filter((k) => RESUMABLE_SCOPED_POLICY[k] === true && ISOLATED_POLICY[k] === false);
  assert.deepEqual(looserKeys.sort(), ['projectStateRead', 'scopedConversation'].sort());
  // 逆方向（isolated が resumable より緩い項目）が無いことも確認する。
  const reverseLooserKeys = keys.filter((k) => ISOLATED_POLICY[k] === true && RESUMABLE_SCOPED_POLICY[k] === false);
  assert.deepEqual(reverseLooserKeys, []);
  // forcePlanTurn/crossAskScope は resumable=isolated=true（両者とも厳格側で等しい）であることを固定する。
  assert.equal(RESUMABLE_SCOPED_POLICY.forcePlanTurn, true);
  assert.equal(ISOLATED_POLICY.forcePlanTurn, true);
  assert.equal(RESUMABLE_SCOPED_POLICY.crossAskScope, true);
  assert.equal(ISOLATED_POLICY.crossAskScope, true);
});

// --- サイクルS2a: crossAskScope フィールドの固定 ---

test('【不変条件】crossAskScope が true なのは isolated/resumable-scoped の2区分だけ', () => {
  assert.equal(INTERACTIVE_POLICY.crossAskScope, false);
  assert.equal(LEGACY_EPHEMERAL_POLICY.crossAskScope, false);
  assert.equal(RESUMABLE_SCOPED_POLICY.crossAskScope, true);
  assert.equal(ISOLATED_POLICY.crossAskScope, true);
});
