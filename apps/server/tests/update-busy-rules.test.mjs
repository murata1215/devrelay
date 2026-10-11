// サイクル3.1: Agent 自己更新の busy 判定・クールダウン・手動 `u` 保留判定
// （apps/server/src/services/update-busy-rules.ts）の単体テスト。
// 外部 import ゼロの純粋関数をコンパイル済み dist から直接 import する
// （auto-update-reconcile.test.mjs と同じ流儀）。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isUpdateBusyGuardEnabled,
  resolveBusyReason,
  resolveCooldownMs,
  decideManualUpdate,
  extractBusyCount,
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

describe('resolveBusyReason: 優先順位（in-flight turn > session running > recent activity）', () => {
  test('in-flight turn があれば件数付きの理由を返す（最優先）', () => {
    const reason = resolveBusyReason({ inFlightTurnCount: 3, sessionRunning: true, recentActivity: true });
    assert.equal(reason, 'busy (in-flight turn: 3)');
  });
  test('in-flight turn が 0 で session running なら session running の理由', () => {
    const reason = resolveBusyReason({ inFlightTurnCount: 0, sessionRunning: true, recentActivity: true });
    assert.equal(reason, 'busy (session running)');
  });
  test('in-flight turn も session running も無く recent activity のみなら recent activity の理由', () => {
    const reason = resolveBusyReason({ inFlightTurnCount: 0, sessionRunning: false, recentActivity: true });
    assert.equal(reason, 'busy (recent activity)');
  });
  test('全て false/0 なら busy でない（null）', () => {
    const reason = resolveBusyReason({ inFlightTurnCount: 0, sessionRunning: false, recentActivity: false });
    assert.equal(reason, null);
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

describe('extractBusyCount', () => {
  test('in-flight turn の件数を数値として取り出す', () => {
    assert.equal(extractBusyCount('busy (in-flight turn: 5)'), 5);
  });
  test('数値を含まない理由は 1 件として扱う', () => {
    assert.equal(extractBusyCount('busy (session running)'), 1);
    assert.equal(extractBusyCount('busy (recent activity)'), 1);
  });
  test('null（busy でない）は 0', () => {
    assert.equal(extractBusyCount(null), 0);
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
