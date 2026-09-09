// core#376（旧 core#336）: apps/server/src/services/submission-guard.ts の単体テスト。
// approve_implementation の検証・claim・plan セッション記録ロジックを DB 非接続で検証する
// （org-ai-defaults.test.mjs と同じ流儀でコンパイル済み dist から直接 import する）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateApproveGuard,
  decideClaimResult,
  buildClaimReleaseWhere,
  buildExecMessageRollbackWhere,
  shouldRecordPlanAiSession,
  buildPlanAiSessionWhere,
  buildTurnId,
} from '../dist/services/submission-guard.js';

// --- buildTurnId（MCP submit_instruction 経路 vs 対話経路） ---

test('buildTurnId: turn-<ms>-<suffix> 形式で組み立てる', () => {
  assert.equal(buildTurnId(1000, 'abc1234'), 'turn-1000-abc1234');
});

test('buildTurnId: 時系列に単調増加する（ms 部分が採番順を反映する）', () => {
  const a = buildTurnId(1000, 'aaa0000');
  const b = buildTurnId(2000, 'bbb1111');
  const msOf = (turnId) => Number(turnId.split('-')[1]);
  assert.ok(msOf(b) > msOf(a));
});

test('MCP 経路 vs 対話経路: MCP は turnId を組み立てるが対話経路は undefined のまま', () => {
  // MCP submit_instruction 経路（tools.ts）は毎回 buildTurnId() で組み立てる
  const mcpTurnId = buildTurnId(Date.now(), Math.random().toString(36).slice(2, 9));
  assert.match(mcpTurnId, /^turn-\d+-[a-z0-9]+$/);

  // 対話経路（ask/teamexec 等）は turnId 自体を組み立てないため undefined のまま
  // shouldRecordPlanAiSession() 経由で「保存しない」に倒れることを確認する
  const dialogTurnId = undefined;
  assert.equal(shouldRecordPlanAiSession({ isComplete: true, turnId: dialogTurnId, aiSessionId: 'sess-x' }), false);
});

// --- evaluateApproveGuard: 拒否 5 ケース ---

test('evaluateApproveGuard: notFound（session が null）', () => {
  const result = evaluateApproveGuard({
    session: null,
    requestedProjectId: 'proj-1',
    requestedUserId: 'user-1',
    hasPlanMessage: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'notFound');
  assert.equal(result.message, 'Submission not found');
});

test('evaluateApproveGuard: projectMismatch', () => {
  const result = evaluateApproveGuard({
    session: { projectId: 'proj-OTHER', userId: 'user-1', planAiSessionId: 'sess-x' },
    requestedProjectId: 'proj-1',
    requestedUserId: 'user-1',
    hasPlanMessage: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'projectMismatch');
  assert.equal(result.message, 'Submission does not belong to this project');
});

test('evaluateApproveGuard: userMismatch', () => {
  const result = evaluateApproveGuard({
    session: { projectId: 'proj-1', userId: 'user-OTHER', planAiSessionId: 'sess-x' },
    requestedProjectId: 'proj-1',
    requestedUserId: 'user-1',
    hasPlanMessage: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'userMismatch');
  assert.equal(result.message, 'Submission does not belong to this user');
});

test('evaluateApproveGuard: planNotReady（plan メッセージ未完了）', () => {
  const result = evaluateApproveGuard({
    session: { projectId: 'proj-1', userId: 'user-1', planAiSessionId: null },
    requestedProjectId: 'proj-1',
    requestedUserId: 'user-1',
    hasPlanMessage: false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'planNotReady');
  assert.equal(result.message, 'Plan is not ready yet. Call get_plan first.');
});

test('evaluateApproveGuard: planAiSessionMissing（plan 完了だが agent 未更新等で未記録）', () => {
  const result = evaluateApproveGuard({
    session: { projectId: 'proj-1', userId: 'user-1', planAiSessionId: null },
    requestedProjectId: 'proj-1',
    requestedUserId: 'user-1',
    hasPlanMessage: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'planAiSessionMissing');
  assert.match(result.message, /plan のセッション ID が記録されていません/);
});

test('evaluateApproveGuard: すべて満たす場合は ok:true', () => {
  const result = evaluateApproveGuard({
    session: { projectId: 'proj-1', userId: 'user-1', planAiSessionId: 'sess-x' },
    requestedProjectId: 'proj-1',
    requestedUserId: 'user-1',
    hasPlanMessage: true,
  });
  assert.deepEqual(result, { ok: true });
});

// --- 並行 approve: decideClaimResult + in-memory fake updateMany ---

test('並行 approve: 単一行に対する updateMany を模した fake で 2 要求のうち 1 件のみ成功する', () => {
  // 実 DB の「WHERE id = ? AND approvedAt IS NULL」updateMany を模した単純な in-memory fake。
  // 単一行に対する呼び出しが直列に実行される前提（Node のシングルスレッド実行そのもの）で、
  // 2 回目の呼び出し時点で既に approvedAt が非 null になっていることを検証する。
  const fakeRow = { id: 'sub-1', approvedAt: null };
  function fakeUpdateMany(where, data) {
    if (fakeRow.id === where.id && fakeRow.approvedAt === where.approvedAt) {
      Object.assign(fakeRow, data);
      return { count: 1 };
    }
    return { count: 0 };
  }

  const claim1 = fakeUpdateMany({ id: 'sub-1', approvedAt: null }, { approvedAt: new Date() });
  const claim2 = fakeUpdateMany({ id: 'sub-1', approvedAt: null }, { approvedAt: new Date() });

  assert.equal(decideClaimResult(claim1.count).claimed, true);
  assert.equal(decideClaimResult(claim2.count).claimed, false);
});

test('decideClaimResult: count===1 のみ claimed:true、それ以外は false', () => {
  assert.equal(decideClaimResult(1).claimed, true);
  assert.equal(decideClaimResult(0).claimed, false);
  assert.equal(decideClaimResult(2).claimed, false);
});

// --- buildClaimReleaseWhere: 自要求の claim だけを解放する ---

test('buildClaimReleaseWhere: claimedAt 一致を必須にし、他要求が入れた値を巻き戻さない', () => {
  const claimedAtA = new Date('2026-09-08T00:00:00Z');
  const claimedAtB = new Date('2026-09-08T00:00:01Z');

  // fake: 現在の approvedAt は要求 B が claim した claimedAtB になっている
  const fakeRow = { id: 'sub-1', approvedAt: claimedAtB };
  function fakeUpdateManyRelease(where, data) {
    if (fakeRow.id === where.id && fakeRow.approvedAt.getTime() === where.approvedAt.getTime()) {
      Object.assign(fakeRow, data);
      return { count: 1 };
    }
    return { count: 0 };
  }

  // 要求 A が exec 起動失敗で自分の claimedAtA を解放しようとしても、
  // 現在の approvedAt は claimedAtB のため一致せず 0 件（B の claim を巻き戻さない）
  const releaseA = fakeUpdateManyRelease(buildClaimReleaseWhere('sub-1', claimedAtA), { approvedAt: null });
  assert.equal(releaseA.count, 0);
  assert.equal(fakeRow.approvedAt.getTime(), claimedAtB.getTime());

  // 要求 B が自分の claimedAtB で解放すれば成功する
  const releaseB = fakeUpdateManyRelease(buildClaimReleaseWhere('sub-1', claimedAtB), { approvedAt: null });
  assert.equal(releaseB.count, 1);
  assert.equal(fakeRow.approvedAt, null);
});

// --- shouldRecordPlanAiSession + buildPlanAiSessionWhere ---

test('shouldRecordPlanAiSession: isComplete + turnId + aiSessionId が揃った場合のみ true', () => {
  assert.equal(shouldRecordPlanAiSession({ isComplete: true, turnId: 't1', aiSessionId: 's1' }), true);
  assert.equal(shouldRecordPlanAiSession({ isComplete: false, turnId: 't1', aiSessionId: 's1' }), false);
  assert.equal(shouldRecordPlanAiSession({ isComplete: true, turnId: undefined, aiSessionId: 's1' }), false);
  assert.equal(shouldRecordPlanAiSession({ isComplete: true, turnId: 't1', aiSessionId: undefined }), false);
});

test('buildPlanAiSessionWhere + fake updateMany: planTurnId 一致時のみ保存、exec/retry の異なる turnId では 0 件更新', () => {
  // fake: セッション行は plan 送信時に turnId='turn-plan' を記録している
  const fakeRow = { id: 'sess-1', planTurnId: 'turn-plan', planAiSessionId: null };
  function fakeUpdateManyPlanAiSession(where, data) {
    if (fakeRow.id === where.id && fakeRow.planTurnId === where.planTurnId) {
      Object.assign(fakeRow, data);
      return { count: 1 };
    }
    return { count: 0 };
  }

  // plan ターンの完了報告（turnId 一致）→ 保存される
  const planResult = fakeUpdateManyPlanAiSession(
    buildPlanAiSessionWhere('sess-1', 'turn-plan'),
    { planAiSessionId: 'ai-sess-abc' }
  );
  assert.equal(planResult.count, 1);
  assert.equal(fakeRow.planAiSessionId, 'ai-sess-abc');

  // exec/retry の遅延した完了報告（turnId 不一致）→ 0 件更新、誤上書きされない
  const execResult = fakeUpdateManyPlanAiSession(
    buildPlanAiSessionWhere('sess-1', 'turn-exec-retry'),
    { planAiSessionId: 'ai-sess-WRONG' }
  );
  assert.equal(execResult.count, 0);
  assert.equal(fakeRow.planAiSessionId, 'ai-sess-abc'); // 巻き戻らない
});

// --- buildExecMessageRollbackWhere: exec 起動失敗時の exec Message 削除 ---
// 2026-09-09 調査サイクル: claim 解放（approvedAt を null に戻す）だけでは
// 既に作成済みの exec Message が残り、get_build_status が「実行中」を
// 永久に返し続ける状態異常が起きていたバグへの対処。

test('buildExecMessageRollbackWhere: 生成した exec Message の id を where 句に含める', () => {
  assert.deepEqual(buildExecMessageRollbackWhere('msg-123'), { id: 'msg-123' });
});

test('buildExecMessageRollbackWhere + fake delete: 自要求が作成した exec Message だけが削除される', () => {
  // fake: 2件の exec Message が存在（別 submission の要求が作った msg-OTHER と自要求の msg-123）
  const fakeMessages = new Map([
    ['msg-123', { id: 'msg-123', sessionId: 'sub-1', content: 'exec' }],
    ['msg-OTHER', { id: 'msg-OTHER', sessionId: 'sub-2', content: 'exec' }],
  ]);
  function fakeDelete(where) {
    if (!fakeMessages.has(where.id)) return null;
    const deleted = fakeMessages.get(where.id);
    fakeMessages.delete(where.id);
    return deleted;
  }

  const deleted = fakeDelete(buildExecMessageRollbackWhere('msg-123'));
  assert.equal(deleted.sessionId, 'sub-1');
  assert.equal(fakeMessages.has('msg-123'), false);
  // 他要求（別 submission）の exec Message は無傷
  assert.equal(fakeMessages.has('msg-OTHER'), true);
});
