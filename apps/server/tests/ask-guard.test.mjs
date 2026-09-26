// MCP ask サイクル: apps/server/src/services/ask-guard.ts の単体テスト。
// 外部 import ゼロの純関数をコンパイル済み dist から直接 import する
// （submission-guard.test.mjs / cross-query-guard.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_KIND_QUESTION,
  ASK_QUESTION_MAX_LENGTH,
  ASK_PROJECT_LIMIT,
  ASK_USER_LIMIT,
  ASK_ANSWER_TIMEOUT_MS,
  ENFORCED_READONLY_AI_TOOLS,
  decideAskReadOnlyEnforcement,
  ASK_MODE_PROHIBITION_TEXT,
  buildAskPromptPrefix,
  pickInflightAskSession,
  decideAskRateLimit,
  deriveAskState,
  decideCancel,
  buildCancelClaimWhere,
  isMcpAskEnabled,
} from '../dist/services/ask-guard.js';

// --- 定数 ---

test('SESSION_KIND_QUESTION は "question"', () => {
  assert.equal(SESSION_KIND_QUESTION, 'question');
});

test('回帰ガード: ENFORCED_READONLY_AI_TOOLS は claude/codex のみ（devin/gemini を含めない）', () => {
  assert.deepEqual([...ENFORCED_READONLY_AI_TOOLS].sort(), ['claude', 'codex']);
  assert.ok(!ENFORCED_READONLY_AI_TOOLS.includes('devin'));
  assert.ok(!ENFORCED_READONLY_AI_TOOLS.includes('gemini'));
});

// --- decideAskReadOnlyEnforcement ---

test('decideAskReadOnlyEnforcement: claude + terminalMode=false → enforced', () => {
  assert.deepEqual(decideAskReadOnlyEnforcement({ aiTool: 'claude', terminalMode: false }), { readOnlyEnforced: true });
});

test('decideAskReadOnlyEnforcement: codex + terminalMode=false → enforced', () => {
  assert.deepEqual(decideAskReadOnlyEnforcement({ aiTool: 'codex', terminalMode: false }), { readOnlyEnforced: true });
});

test('decideAskReadOnlyEnforcement: claude + terminalMode=true → not enforced（PTY 経路のため）', () => {
  assert.deepEqual(decideAskReadOnlyEnforcement({ aiTool: 'claude', terminalMode: true }), { readOnlyEnforced: false });
});

test('decideAskReadOnlyEnforcement: devin → not enforced（terminalMode に関係なく常に false）', () => {
  assert.deepEqual(decideAskReadOnlyEnforcement({ aiTool: 'devin', terminalMode: false }), { readOnlyEnforced: false });
  assert.deepEqual(decideAskReadOnlyEnforcement({ aiTool: 'devin', terminalMode: true }), { readOnlyEnforced: false });
});

test('decideAskReadOnlyEnforcement: gemini → not enforced', () => {
  assert.deepEqual(decideAskReadOnlyEnforcement({ aiTool: 'gemini', terminalMode: false }), { readOnlyEnforced: false });
});

// --- buildAskPromptPrefix ---

test('buildAskPromptPrefix: readOnlyEnforced=true のときは禁止文を含まない', () => {
  const prefix = buildAskPromptPrefix(true);
  assert.ok(!prefix.includes(ASK_MODE_PROHIBITION_TEXT));
});

test('buildAskPromptPrefix: readOnlyEnforced=false のときは禁止文を含む', () => {
  const prefix = buildAskPromptPrefix(false);
  assert.ok(prefix.includes(ASK_MODE_PROHIBITION_TEXT));
});

test('buildAskPromptPrefix: readOnlyEnforced の値にかかわらず質問モードの説明を含む', () => {
  assert.ok(buildAskPromptPrefix(true).includes('質問モード'));
  assert.ok(buildAskPromptPrefix(false).includes('質問モード'));
});

// --- pickInflightAskSession ---

test('pickInflightAskSession: 回答済み（hasAnswer=true）の行は実行中とみなさない', () => {
  const now = 1_000_000;
  const rows = [{ id: 's1', startedAt: new Date(now - 1000), hasAnswer: true }];
  assert.equal(pickInflightAskSession(rows, now, ASK_ANSWER_TIMEOUT_MS), null);
});

test('pickInflightAskSession: 窓内かつ未回答の行を返す', () => {
  const now = 1_000_000;
  const rows = [{ id: 's1', startedAt: new Date(now - 1000), hasAnswer: false }];
  assert.equal(pickInflightAskSession(rows, now, ASK_ANSWER_TIMEOUT_MS), 's1');
});

test('pickInflightAskSession: 窓外の行は無視する', () => {
  const now = 1_000_000;
  const rows = [{ id: 's1', startedAt: new Date(now - ASK_ANSWER_TIMEOUT_MS - 1000), hasAnswer: false }];
  assert.equal(pickInflightAskSession(rows, now, ASK_ANSWER_TIMEOUT_MS), null);
});

test('pickInflightAskSession: 複数件ある場合は最新（startedAt が最大）を返す', () => {
  const now = 1_000_000;
  const rows = [
    { id: 'older', startedAt: new Date(now - 5000), hasAnswer: false },
    { id: 'newer', startedAt: new Date(now - 1000), hasAnswer: false },
  ];
  assert.equal(pickInflightAskSession(rows, now, ASK_ANSWER_TIMEOUT_MS), 'newer');
});

test('pickInflightAskSession: 行が無ければ null', () => {
  assert.equal(pickInflightAskSession([], 1_000_000, ASK_ANSWER_TIMEOUT_MS), null);
});

// --- decideAskRateLimit ---

test('decideAskRateLimit: 境界未満はすべて許可', () => {
  const result = decideAskRateLimit({ projectRecentCount: ASK_PROJECT_LIMIT - 1, userRecentCount: ASK_USER_LIMIT - 1 });
  assert.deepEqual(result, { allowed: true });
});

test('decideAskRateLimit: projectRecentCount が上限ちょうどで拒否（projectRate）', () => {
  const result = decideAskRateLimit({ projectRecentCount: ASK_PROJECT_LIMIT, userRecentCount: 0 });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'projectRate');
  assert.equal(result.count, ASK_PROJECT_LIMIT);
  assert.equal(result.limit, ASK_PROJECT_LIMIT);
});

test('decideAskRateLimit: userRecentCount が上限ちょうどで拒否（userRate）', () => {
  const result = decideAskRateLimit({ projectRecentCount: 0, userRecentCount: ASK_USER_LIMIT });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'userRate');
});

test('decideAskRateLimit: projectBusy はレート制限より優先される', () => {
  const result = decideAskRateLimit({
    projectRecentCount: ASK_PROJECT_LIMIT,
    userRecentCount: ASK_USER_LIMIT,
    inflightAskSessionId: 'inflight-1',
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'projectBusy');
  assert.equal(result.inflightSessionId, 'inflight-1');
});

test('decideAskRateLimit: inflightAskSessionId が null/undefined なら projectBusy にならない', () => {
  const result1 = decideAskRateLimit({ projectRecentCount: 0, userRecentCount: 0, inflightAskSessionId: null });
  const result2 = decideAskRateLimit({ projectRecentCount: 0, userRecentCount: 0 });
  assert.deepEqual(result1, { allowed: true });
  assert.deepEqual(result2, { allowed: true });
});

// --- deriveAskState ---

test('deriveAskState: 優先順位 cancelled が最優先', () => {
  const { state } = deriveAskState({
    cancelledAt: new Date(), hasAiMessage: true, hasActiveProgress: true,
    startedAtMs: 0, nowMs: 1000, timeoutMs: ASK_ANSWER_TIMEOUT_MS,
  });
  assert.equal(state, 'cancelled');
});

test('deriveAskState: cancelledAt が無ければ hasAiMessage=true で answered', () => {
  const { state } = deriveAskState({
    cancelledAt: null, hasAiMessage: true, hasActiveProgress: true,
    startedAtMs: 0, nowMs: 1000, timeoutMs: ASK_ANSWER_TIMEOUT_MS,
  });
  assert.equal(state, 'answered');
});

test('deriveAskState: answered でなく hasActiveProgress=true なら running（部分テキストは完了扱いにしない）', () => {
  const { state } = deriveAskState({
    cancelledAt: null, hasAiMessage: false, hasActiveProgress: true,
    startedAtMs: 0, nowMs: 1000, timeoutMs: ASK_ANSWER_TIMEOUT_MS,
  });
  assert.equal(state, 'running');
});

test('deriveAskState: running でもなくタイムアウト超過なら failed', () => {
  const { state } = deriveAskState({
    cancelledAt: null, hasAiMessage: false, hasActiveProgress: false,
    startedAtMs: 0, nowMs: ASK_ANSWER_TIMEOUT_MS + 1, timeoutMs: ASK_ANSWER_TIMEOUT_MS,
  });
  assert.equal(state, 'failed');
});

test('deriveAskState: タイムアウト境界未満は queued', () => {
  const { state } = deriveAskState({
    cancelledAt: null, hasAiMessage: false, hasActiveProgress: false,
    startedAtMs: 0, nowMs: ASK_ANSWER_TIMEOUT_MS - 1, timeoutMs: ASK_ANSWER_TIMEOUT_MS,
  });
  assert.equal(state, 'queued');
});

test('deriveAskState: elapsedSeconds は経過時間から算出される', () => {
  const { elapsedSeconds } = deriveAskState({
    cancelledAt: null, hasAiMessage: false, hasActiveProgress: true,
    startedAtMs: 0, nowMs: 5000, timeoutMs: ASK_ANSWER_TIMEOUT_MS,
  });
  assert.equal(elapsedSeconds, 5);
});

// --- decideCancel ---

test('decideCancel: notFound（session が null）', () => {
  const result = decideCancel({ session: null, requestedUserId: 'user-1' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'notFound');
});

test('decideCancel: userMismatch', () => {
  const result = decideCancel({
    session: { userId: 'user-2', projectId: 'proj-1', approvedAt: null, cancelledAt: null },
    requestedUserId: 'user-1',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'userMismatch');
});

test('decideCancel: projectMismatch（requestedProjectId 指定時のみ検証）', () => {
  const result = decideCancel({
    session: { userId: 'user-1', projectId: 'proj-1', approvedAt: null, cancelledAt: null },
    requestedUserId: 'user-1',
    requestedProjectId: 'proj-2',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'projectMismatch');
});

test('decideCancel: requestedProjectId 未指定なら projectId は検証しない', () => {
  const result = decideCancel({
    session: { userId: 'user-1', projectId: 'proj-1', approvedAt: null, cancelledAt: null },
    requestedUserId: 'user-1',
  });
  assert.equal(result.ok, true);
});

test('decideCancel: alreadyCancelled', () => {
  const result = decideCancel({
    session: { userId: 'user-1', projectId: 'proj-1', approvedAt: null, cancelledAt: new Date() },
    requestedUserId: 'user-1',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'alreadyCancelled');
});

test('decideCancel: alreadyApproved（2026-09-26 承認サイクルの人間判断: exec 実行中は拒否固定）', () => {
  const result = decideCancel({
    session: { userId: 'user-1', projectId: 'proj-1', approvedAt: new Date(), cancelledAt: null },
    requestedUserId: 'user-1',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'alreadyApproved');
});

test('decideCancel: 未承認・未取消なら ok', () => {
  const result = decideCancel({
    session: { userId: 'user-1', projectId: 'proj-1', approvedAt: null, cancelledAt: null },
    requestedUserId: 'user-1',
    requestedProjectId: 'proj-1',
  });
  assert.deepEqual(result, { ok: true });
});

// --- buildCancelClaimWhere ---

test('buildCancelClaimWhere: approvedAt と cancelledAt の両方を null 条件に含む（approve/cancel の相互排他の要）', () => {
  const where = buildCancelClaimWhere('sub-1');
  assert.deepEqual(where, { id: 'sub-1', approvedAt: null, cancelledAt: null });
});

// --- isMcpAskEnabled ---

test('isMcpAskEnabled: undefined は既定 ON', () => {
  assert.equal(isMcpAskEnabled(undefined), true);
});

test('isMcpAskEnabled: "1" は ON', () => {
  assert.equal(isMcpAskEnabled('1'), true);
});

test('isMcpAskEnabled: "0" のときのみ OFF', () => {
  assert.equal(isMcpAskEnabled('0'), false);
});

test('isMcpAskEnabled: 未知の値は ON（fail-open ではなく既定側に倒す）', () => {
  assert.equal(isMcpAskEnabled('yes'), true);
});

// --- 長さ上限の値そのものの回帰ガード ---

test('ASK_QUESTION_MAX_LENGTH は 4000', () => {
  assert.equal(ASK_QUESTION_MAX_LENGTH, 4000);
});
