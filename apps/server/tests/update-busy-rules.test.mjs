// サイクル3.1: Agent 自己更新の busy 判定・クールダウン・手動 `u` 保留判定
// （apps/server/src/services/update-busy-rules.ts）の単体テスト。
// 外部 import ゼロの純粋関数をコンパイル済み dist から直接 import する
// （auto-update-reconcile.test.mjs と同じ流儀）。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isUpdateBusyGuardEnabled,
  resolveBusyReason,
  resolveBusyState,
  formatBusyReason,
  resolveCooldownMs,
  decideManualUpdate,
  resolveDeferredBusyMessage,
  buildBusyHoldApiMessage,
  buildRecentAiActivityWhere,
} from '../dist/services/update-busy-rules.js';
import { evaluateAutoUpdateGates } from '../dist/services/auto-updater.js';

describe('isUpdateBusyGuardEnabled', () => {
  test('未設定（undefined）は有効（既定 ON）', () => {
    assert.equal(isUpdateBusyGuardEnabled(undefined), true);
  });
  test(`'1' は有効`, () => {
    assert.equal(isUpdateBusyGuardEnabled('1'), true);
  });
  test(`'0' のときだけ無効`, () => {
    assert.equal(isUpdateBusyGuardEnabled('0'), false);
  });
  test('その他の文字列は有効扱い（"0" 以外は fail-safe で ON）', () => {
    assert.equal(isUpdateBusyGuardEnabled('nope'), true);
  });
});

describe('resolveBusyReason: 優先順位（in-flight turn > session running > recent ai output）', () => {
  test('in-flight turn があれば件数付きの理由を返す（最優先）', () => {
    const reason = resolveBusyReason({ inFlightTurnCount: 3, sessionRunning: true, recentActivity: true });
    assert.equal(reason, 'busy (in-flight turn: 3)');
  });
  test('in-flight turn が 0 で session running なら session running の理由', () => {
    const reason = resolveBusyReason({ inFlightTurnCount: 0, sessionRunning: true, recentActivity: true });
    assert.equal(reason, 'busy (session running)');
  });
  test('in-flight turn も session running も無く recent activity のみなら recent ai output の理由', () => {
    const reason = resolveBusyReason({ inFlightTurnCount: 0, sessionRunning: false, recentActivity: true });
    assert.equal(reason, 'busy (recent ai output)');
  });
  test('全て false/0 なら busy でない（null）', () => {
    const reason = resolveBusyReason({ inFlightTurnCount: 0, sessionRunning: false, recentActivity: false });
    assert.equal(reason, null);
  });
});

describe('resolveBusyState / formatBusyReason: 件数は数えた値のみ（session-running/recent-ai-output は null）', () => {
  test('in-flight-turn は count に実数が入る', () => {
    const state = resolveBusyState({ inFlightTurnCount: 5, sessionRunning: false, recentActivity: false });
    assert.deepEqual(state, { kind: 'in-flight-turn', count: 5 });
    assert.equal(formatBusyReason(state), 'busy (in-flight turn: 5)');
  });
  test('session-running は count が null（件数という概念が無い）', () => {
    const state = resolveBusyState({ inFlightTurnCount: 0, sessionRunning: true, recentActivity: false });
    assert.deepEqual(state, { kind: 'session-running', count: null });
    assert.equal(formatBusyReason(state), 'busy (session running)');
  });
  test('recent-ai-output も count が null', () => {
    const state = resolveBusyState({ inFlightTurnCount: 0, sessionRunning: false, recentActivity: true });
    assert.deepEqual(state, { kind: 'recent-ai-output', count: null });
    assert.equal(formatBusyReason(state), 'busy (recent ai output)');
  });
  test('busy でなければ null', () => {
    assert.equal(resolveBusyState({ inFlightTurnCount: 0, sessionRunning: false, recentActivity: false }), null);
    assert.equal(formatBusyReason(null), null);
  });
  test('agent-reported-turn は count に実数が入る（maybeAutoUpdate の自己申告経路）', () => {
    const state = { kind: 'agent-reported-turn', count: 2 };
    assert.equal(formatBusyReason(state), 'busy (agent-reported turn: 2)');
  });
});

describe('resolveCooldownMs', () => {
  const cooldowns = { normalMs: 30 * 60 * 1000, deferredMs: 10 * 60 * 1000 };
  test(`lastStatus === 'deferred' のときだけ短縮クールダウン`, () => {
    assert.equal(resolveCooldownMs('deferred', cooldowns), cooldowns.deferredMs);
  });
  test('success 等、deferred 以外は通常クールダウン', () => {
    assert.equal(resolveCooldownMs('success', cooldowns), cooldowns.normalMs);
  });
  test('null/undefined は通常クールダウン', () => {
    assert.equal(resolveCooldownMs(null, cooldowns), cooldowns.normalMs);
    assert.equal(resolveCooldownMs(undefined, cooldowns), cooldowns.normalMs);
  });
});

describe('decideManualUpdate: 手動 `u` / server:agent:restart の保留判定', () => {
  test('busy かつ force 無し → hold', () => {
    assert.equal(decideManualUpdate({ busy: true, force: false }), 'hold');
  });
  test('busy かつ force あり → proceed（force が busy を無視する）', () => {
    assert.equal(decideManualUpdate({ busy: true, force: true }), 'proceed');
  });
  test('busy でなければ force の有無に関わらず proceed', () => {
    assert.equal(decideManualUpdate({ busy: false, force: false }), 'proceed');
    assert.equal(decideManualUpdate({ busy: false, force: true }), 'proceed');
  });
});

describe('resolveDeferredBusyMessage: 手動 `u` の保留応答（理由別・数えていない値は件数を出さない）', () => {
  test('in-flight-turn は件数つきキー', () => {
    const msg = resolveDeferredBusyMessage({ kind: 'in-flight-turn', count: 3 });
    assert.equal(msg.key, 'update.deferredBusyTurn');
    assert.deepEqual(msg.params, { count: 3 });
  });
  test('agent-reported-turn も件数つきキー（チャット文言は in-flight turn と同じ扱い）', () => {
    const msg = resolveDeferredBusyMessage({ kind: 'agent-reported-turn', count: 2 });
    assert.equal(msg.key, 'update.deferredBusyTurn');
    assert.deepEqual(msg.params, { count: 2 });
  });
  test('session-running は件数なしキー（params に count を含まない）', () => {
    const msg = resolveDeferredBusyMessage({ kind: 'session-running', count: null });
    assert.equal(msg.key, 'update.deferredBusySessionRunning');
    assert.deepEqual(msg.params, {});
  });
  test('recent-ai-output も件数なしキー', () => {
    const msg = resolveDeferredBusyMessage({ kind: 'recent-ai-output', count: null });
    assert.equal(msg.key, 'update.deferredBusyRecentAi');
    assert.deepEqual(msg.params, {});
  });
  test('null（想定外呼び出し）は従来の固定文言キーにフォールバック', () => {
    const msg = resolveDeferredBusyMessage(null);
    assert.equal(msg.key, 'update.deferredBusy');
  });
});

describe('buildBusyHoldApiMessage: 手動 restart の 409 応答本文（理由別）', () => {
  test('in-flight-turn は件数つき本文', () => {
    assert.match(buildBusyHoldApiMessage({ kind: 'in-flight-turn', count: 3 }), /AI turn in progress \(3\)/);
  });
  test('session-running は件数を出さない本文', () => {
    const msg = buildBusyHoldApiMessage({ kind: 'session-running', count: null });
    assert.match(msg, /currently running/);
    assert.doesNotMatch(msg, /\(null\)/);
  });
  test('recent-ai-output は件数を出さない本文', () => {
    const msg = buildBusyHoldApiMessage({ kind: 'recent-ai-output', count: null });
    assert.match(msg, /last 10 minutes/);
  });
  test('{ "force": true } の再試行案内はどの理由でも維持される', () => {
    for (const state of [
      { kind: 'in-flight-turn', count: 1 },
      { kind: 'session-running', count: null },
      { kind: 'recent-ai-output', count: null },
    ]) {
      assert.match(buildBusyHoldApiMessage(state), /force.*true/);
    }
  });
});

describe('buildRecentAiActivityWhere: 自家中毒の再現テスト（role 限定の根拠）', () => {
  // auto-updater.ts が実際に使う prisma where を素朴なインメモリフィルタに適用し、
  // 「u 自身の入力/応答行（role=user/system）だけでは busy と誤判定しない」ことを示す
  // （2026-10-24 の自家中毒: WebUI が `u` 入力を role='user' で保存 → 直後の busy 判定が
  // 自分の行を踏んで recent activity と誤検知していた）。
  function applyWhere(messages, where) {
    const sinceMs = where.createdAt.gte.getTime();
    return messages.filter(m =>
      where.sessionId.in.includes(m.sessionId) &&
      m.role === where.role &&
      m.createdAt.getTime() >= sinceMs
    );
  }

  const sessionIds = ['s1'];
  const now = new Date('2026-10-24T12:00:00Z');
  const since = new Date(now.getTime() - 10 * 60 * 1000);

  test('role が user/system だけの Message では 0 件（busy にならない）', () => {
    const messages = [
      { sessionId: 's1', role: 'user', createdAt: new Date(now.getTime() - 1000) }, // `u` 自身の入力行
      { sessionId: 's1', role: 'system', createdAt: new Date(now.getTime() - 500) }, // hold 応答行
    ];
    const where = buildRecentAiActivityWhere(sessionIds, since);
    assert.equal(where.role, 'ai');
    const hits = applyWhere(messages, where);
    assert.equal(hits.length, 0);
  });

  test('role=ai の Message が 1 件でもあれば busy になる', () => {
    const messages = [
      { sessionId: 's1', role: 'user', createdAt: new Date(now.getTime() - 1000) },
      { sessionId: 's1', role: 'ai', createdAt: new Date(now.getTime() - 500) },
    ];
    const where = buildRecentAiActivityWhere(sessionIds, since);
    const hits = applyWhere(messages, where);
    assert.equal(hits.length, 1);
  });
});

describe('evaluateAutoUpdateGates: busyReason による skip 理由の区別（受け入れ条件3）', () => {
  const baseInput = {
    globallyEnabled: true,
    machineEnabled: true,
    isDevRepo: false,
    hasUpdate: true,
    remoteDate: '2026-01-01 00:00:00 +0900', // bake time を確実に超過させる
    lastAttemptAt: null,
    lastAttemptCommit: null,
    lastAttemptStatus: null,
    remoteCommit: 'abc1234567890',
    attempts: 0,
    concurrent: 0,
    now: new Date('2026-06-01T00:00:00Z'),
    bakeMinutes: 120,
  };

  test('busyReason 付きで in-flight turn による skip は理由文字列で区別できる', () => {
    const decision = evaluateAutoUpdateGates({
      ...baseInput,
      busy: true,
      busyReason: 'busy (in-flight turn: 1)',
    });
    assert.deepEqual(decision, { action: 'skip', reason: 'busy (in-flight turn: 1)' });
  });

  test('busyReason 省略時は従来の固定文言にフォールバックする（既存シグネチャ非破壊）', () => {
    const decision = evaluateAutoUpdateGates({
      ...baseInput,
      busy: true,
      // busyReason を渡さない
    });
    assert.deepEqual(decision, { action: 'skip', reason: 'busy (session running)' });
  });

  test('busy=false なら busyReason があっても無視され update へ進む', () => {
    const decision = evaluateAutoUpdateGates({
      ...baseInput,
      busy: false,
      busyReason: 'busy (in-flight turn: 1)', // 矛盾した入力でも busy フラグが優先される
    });
    assert.equal(decision.action, 'update');
  });

  test('lastAttemptStatus=deferred のときクールダウンが短縮される（10分: 通常30分なら skip の境界が変わる）', () => {
    const lastAttemptAt = new Date(baseInput.now.getTime() - 15 * 60 * 1000); // 15分前
    // 通常クールダウン(30分)なら cooldown で skip のはずが、deferred短縮(10分)なら通過する
    const decision = evaluateAutoUpdateGates({
      ...baseInput,
      busy: false,
      lastAttemptAt,
      lastAttemptStatus: 'deferred',
    });
    assert.notEqual(decision.reason, 'cooldown');
  });

  test('lastAttemptStatus=success（非deferred）なら通常クールダウン(30分)が効く', () => {
    const lastAttemptAt = new Date(baseInput.now.getTime() - 15 * 60 * 1000); // 15分前
    const decision = evaluateAutoUpdateGates({
      ...baseInput,
      busy: false,
      lastAttemptAt,
      lastAttemptStatus: 'success',
    });
    assert.deepEqual(decision, { action: 'skip', reason: 'cooldown' });
  });
});
