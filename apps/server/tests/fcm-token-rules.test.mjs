// FCM プッシュ通知トークン管理（apps/server/src/services/fcm-token-rules.ts）の単体テスト。
// 2026-10-22 の無音故障（アプリ再インストール後、サーバーには配信先の無い古いトークンだけが
// 残り、エラーも出ないまま通知が届かなくなった）の再発防止策の回帰テスト。
// 外部 import ゼロの純粋関数をコンパイル済み dist から直接 import する（update-busy-rules.test.mjs と同じ流儀）。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeFcmTokenRecord,
  normalizeFcmTokenList,
  upsertFcmTokenRecord,
  classifyFcmError,
  summarizeSendResult,
  decideTokenRemovals,
  summarizePushHealth,
  maskFcmToken,
  resolveFcmPolicy,
  DEFAULT_PUSH_HEALTH_STALE_DAYS,
} from '../dist/services/fcm-token-rules.js';

const NOW = '2026-10-23T00:00:00.000Z';

function record(overrides = {}) {
  return {
    token: 'tokenA',
    platform: 'ios',
    registeredAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('normalizeFcmTokenRecord', () => {
  test('token が無ければ null', () => {
    assert.equal(normalizeFcmTokenRecord({ platform: 'ios' }, NOW), null);
  });
  test('token が空文字列なら null', () => {
    assert.equal(normalizeFcmTokenRecord({ token: '', platform: 'ios' }, NOW), null);
  });
  test('object でない値は null', () => {
    assert.equal(normalizeFcmTokenRecord('not-an-object', NOW), null);
    assert.equal(normalizeFcmTokenRecord(null, NOW), null);
  });
  test('platform が不正値なら ios に正規化', () => {
    const r = normalizeFcmTokenRecord({ token: 't1', platform: 'windows' }, NOW);
    assert.equal(r.platform, 'ios');
  });
  test('platform が android ならそのまま保持', () => {
    const r = normalizeFcmTokenRecord({ token: 't1', platform: 'android' }, NOW);
    assert.equal(r.platform, 'android');
  });
  test('registeredAt が無ければ nowIso で補う', () => {
    const r = normalizeFcmTokenRecord({ token: 't1', platform: 'ios' }, NOW);
    assert.equal(r.registeredAt, NOW);
  });
  test('旧スキーマ（3フィールドのみ）は欠落フィールド無しで安全に正規化される', () => {
    const r = normalizeFcmTokenRecord({ token: 't1', platform: 'ios', registeredAt: '2026-01-01T00:00:00.000Z' }, NOW);
    assert.deepEqual(r, { token: 't1', platform: 'ios', registeredAt: '2026-01-01T00:00:00.000Z' });
  });
  test('追加フィールドをすべて保持する', () => {
    const r = normalizeFcmTokenRecord(
      {
        token: 't1',
        platform: 'ios',
        registeredAt: '2026-01-01T00:00:00.000Z',
        lastRegisteredAt: '2026-10-01T00:00:00.000Z',
        lastSuccessAt: '2026-10-02T00:00:00.000Z',
        lastFailureAt: '2026-10-03T00:00:00.000Z',
        lastErrorCode: 'messaging/invalid-argument',
        consecutiveFailures: 2,
        installationId: 'inst-1',
        deviceLabel: 'iPhone SE3',
      },
      NOW
    );
    assert.equal(r.lastRegisteredAt, '2026-10-01T00:00:00.000Z');
    assert.equal(r.lastSuccessAt, '2026-10-02T00:00:00.000Z');
    assert.equal(r.lastFailureAt, '2026-10-03T00:00:00.000Z');
    assert.equal(r.lastErrorCode, 'messaging/invalid-argument');
    assert.equal(r.consecutiveFailures, 2);
    assert.equal(r.installationId, 'inst-1');
    assert.equal(r.deviceLabel, 'iPhone SE3');
  });
  test('consecutiveFailures が負数や小数なら 0 以上の整数に丸める', () => {
    assert.equal(normalizeFcmTokenRecord({ token: 't1', platform: 'ios', consecutiveFailures: -3 }, NOW).consecutiveFailures, 0);
    assert.equal(normalizeFcmTokenRecord({ token: 't1', platform: 'ios', consecutiveFailures: 2.7 }, NOW).consecutiveFailures, 2);
  });
});

describe('normalizeFcmTokenList', () => {
  test('配列でない値（文字列・null・オブジェクト）は空配列', () => {
    assert.deepEqual(normalizeFcmTokenList('broken', NOW), []);
    assert.deepEqual(normalizeFcmTokenList(null, NOW), []);
    assert.deepEqual(normalizeFcmTokenList({}, NOW), []);
  });
  test('不正な要素は除去され、正常な要素だけ残る', () => {
    const list = normalizeFcmTokenList([{ token: 't1', platform: 'ios' }, { platform: 'ios' }, null], NOW);
    assert.equal(list.length, 1);
    assert.equal(list[0].token, 't1');
  });
  test('重複 token は後勝ち（lastSuccessAt が新しい方を残す）', () => {
    const list = normalizeFcmTokenList(
      [
        { token: 't1', platform: 'ios', registeredAt: '2026-01-01T00:00:00.000Z', lastSuccessAt: '2026-10-01T00:00:00.000Z' },
        { token: 't1', platform: 'ios', registeredAt: '2026-01-01T00:00:00.000Z', lastSuccessAt: '2026-10-05T00:00:00.000Z' },
      ],
      NOW
    );
    assert.equal(list.length, 1);
    assert.equal(list[0].lastSuccessAt, '2026-10-05T00:00:00.000Z');
  });
});

describe('upsertFcmTokenRecord', () => {
  test('新規トークンは created として追加される', () => {
    const { next, action } = upsertFcmTokenRecord({ list: [], token: 't1', platform: 'ios', nowIso: NOW });
    assert.equal(action, 'created');
    assert.equal(next.length, 1);
    assert.equal(next[0].registeredAt, NOW);
    assert.equal(next[0].lastRegisteredAt, NOW);
  });
  test('同一トークンの再登録は registeredAt を保持し lastRegisteredAt のみ更新する（既存バグの回帰テスト）', () => {
    const existing = [record({ registeredAt: '2026-01-01T00:00:00.000Z' })];
    const { next, action } = upsertFcmTokenRecord({ list: existing, token: 'tokenA', platform: 'ios', nowIso: NOW });
    assert.equal(action, 'refreshed');
    assert.equal(next[0].registeredAt, '2026-01-01T00:00:00.000Z');
    assert.equal(next[0].lastRegisteredAt, NOW);
  });
  test('他のトークンは変更されない', () => {
    const existing = [record({ token: 'tokenB' })];
    const { next } = upsertFcmTokenRecord({ list: existing, token: 'tokenA', platform: 'ios', nowIso: NOW });
    assert.equal(next.length, 2);
  });
});

describe('classifyFcmError', () => {
  test('registration-token-not-registered は unregistered', () => {
    assert.equal(classifyFcmError('messaging/registration-token-not-registered'), 'unregistered');
  });
  test('invalid-registration-token は malformedToken', () => {
    assert.equal(classifyFcmError('messaging/invalid-registration-token'), 'malformedToken');
  });
  test('invalid-argument は ambiguous', () => {
    assert.equal(classifyFcmError('messaging/invalid-argument'), 'ambiguous');
  });
  test('mismatched-credential / sender-id-mismatch は environment', () => {
    assert.equal(classifyFcmError('messaging/mismatched-credential'), 'environment');
    assert.equal(classifyFcmError('messaging/sender-id-mismatch'), 'environment');
  });
  test('server-unavailable 等は transient', () => {
    assert.equal(classifyFcmError('messaging/server-unavailable'), 'transient');
    assert.equal(classifyFcmError('messaging/internal-error'), 'transient');
    assert.equal(classifyFcmError('messaging/quota-exceeded'), 'transient');
    assert.equal(classifyFcmError('messaging/third-party-auth-error'), 'transient');
  });
  test('未知のコード・undefined は unknown', () => {
    assert.equal(classifyFcmError('messaging/something-else'), 'unknown');
    assert.equal(classifyFcmError(undefined), 'unknown');
  });
});

describe('summarizeSendResult', () => {
  test('成功・失敗・コード内訳を正しく集計する', () => {
    const summary = summarizeSendResult([
      { token: 't1', ok: true },
      { token: 't2', ok: false, code: 'messaging/invalid-argument' },
      { token: 't3', ok: false, code: 'messaging/invalid-argument' },
      { token: 't4', ok: false },
    ]);
    assert.equal(summary.total, 4);
    assert.equal(summary.success, 1);
    assert.equal(summary.failed, 3);
    assert.deepEqual(summary.byCode, { 'messaging/invalid-argument': 2, unknown: 1 });
  });
});

describe('decideTokenRemovals', () => {
  test('registration-token-not-registered は即削除される', () => {
    const records = [record()];
    const outcomes = [{ token: 'tokenA', ok: false, code: 'messaging/registration-token-not-registered' }];
    const { next, removals, loud } = decideTokenRemovals({ records, outcomes, nowIso: NOW });
    assert.equal(next.length, 0);
    assert.equal(removals.length, 1);
    assert.equal(removals[0].reason, 'unregistered');
    assert.equal(loud, false);
  });

  test('invalid-argument 1件では削除されず consecutiveFailures が 1 になる', () => {
    const records = [record()];
    const outcomes = [{ token: 'tokenA', ok: false, code: 'messaging/invalid-argument' }];
    const { next, removals } = decideTokenRemovals({ records, outcomes, nowIso: NOW });
    assert.equal(removals.length, 0);
    assert.equal(next.length, 1);
    assert.equal(next[0].consecutiveFailures, 1);
  });

  test('invalid-argument が閾値（既定5）に到達すると削除される', () => {
    const records = [record({ consecutiveFailures: 4 })];
    const outcomes = [{ token: 'tokenA', ok: false, code: 'messaging/invalid-argument' }];
    const { next, removals } = decideTokenRemovals({ records, outcomes, nowIso: NOW });
    assert.equal(removals.length, 1);
    assert.equal(next.length, 0);
  });

  test('invalid-argument が閾値未満（4回目）ではまだ削除されない', () => {
    const records = [record({ consecutiveFailures: 3 })];
    const outcomes = [{ token: 'tokenA', ok: false, code: 'messaging/invalid-argument' }];
    const { next, removals } = decideTokenRemovals({ records, outcomes, nowIso: NOW });
    assert.equal(removals.length, 0);
    assert.equal(next[0].consecutiveFailures, 4);
  });

  test('全滅ガード: 2件以上すべてが同一の invalid-argument で失敗したら削除0件・loud', () => {
    const records = [record({ token: 't1' }), record({ token: 't2' }), record({ token: 't3' })];
    const outcomes = [
      { token: 't1', ok: false, code: 'messaging/invalid-argument' },
      { token: 't2', ok: false, code: 'messaging/invalid-argument' },
      { token: 't3', ok: false, code: 'messaging/invalid-argument' },
    ];
    const { next, removals, loud } = decideTokenRemovals({ records, outcomes, nowIso: NOW });
    assert.equal(removals.length, 0);
    assert.equal(next.length, 3);
    assert.equal(loud, true);
  });

  test('全滅ガード: total===1 のときは発動しない（比較対象が無い）', () => {
    const records = [record({ consecutiveFailures: 10 })];
    const outcomes = [{ token: 'tokenA', ok: false, code: 'messaging/invalid-argument' }];
    const { removals, loud } = decideTokenRemovals({ records, outcomes, nowIso: NOW });
    assert.equal(loud, false);
    assert.equal(removals.length, 1); // 閾値超過で通常どおり削除される
  });

  test('全滅ガード: コードが揃っていない場合は発動しない', () => {
    const records = [record({ token: 't1' }), record({ token: 't2' })];
    const outcomes = [
      { token: 't1', ok: false, code: 'messaging/invalid-argument' },
      { token: 't2', ok: false, code: 'messaging/registration-token-not-registered' },
    ];
    const { removals, loud, next } = decideTokenRemovals({ records, outcomes, nowIso: NOW });
    assert.equal(loud, false);
    // t2 は unregistered なので削除、t1 は ambiguous 1回目で削除されない
    assert.equal(removals.length, 1);
    assert.equal(removals[0].token, 't2');
    assert.equal(next.length, 1);
  });

  test('mismatched-credential（environment）は件数に関わらず削除せず loud', () => {
    const records = [record({ token: 't1' }), record({ token: 't2' })];
    const outcomes = [
      { token: 't1', ok: false, code: 'messaging/mismatched-credential' },
      { token: 't2', ok: false, code: 'messaging/mismatched-credential' },
    ];
    const { next, removals, loud } = decideTokenRemovals({ records, outcomes, nowIso: NOW });
    assert.equal(removals.length, 0);
    assert.equal(next.length, 2);
    assert.equal(loud, true);
  });

  test('server-unavailable（transient）は削除せず consecutiveFailures も加算しない', () => {
    const records = [record({ consecutiveFailures: 2 })];
    const outcomes = [{ token: 'tokenA', ok: false, code: 'messaging/server-unavailable' }];
    const { next, removals } = decideTokenRemovals({ records, outcomes, nowIso: NOW });
    assert.equal(removals.length, 0);
    assert.equal(next[0].consecutiveFailures, 2);
  });

  test('成功したトークンは consecutiveFailures が 0 にリセットされ lastSuccessAt が更新される', () => {
    const records = [record({ consecutiveFailures: 3 })];
    const outcomes = [{ token: 'tokenA', ok: true }];
    const { next } = decideTokenRemovals({ records, outcomes, nowIso: NOW });
    assert.equal(next[0].consecutiveFailures, 0);
    assert.equal(next[0].lastSuccessAt, NOW);
  });

  test('strictDelete: true なら invalid-argument も即削除される（旧挙動の互換性）', () => {
    const records = [record()];
    const outcomes = [{ token: 'tokenA', ok: false, code: 'messaging/invalid-argument' }];
    const { removals } = decideTokenRemovals({ records, outcomes, nowIso: NOW, strictDelete: true });
    assert.equal(removals.length, 1);
  });

  test('allowRemoval: false なら削除条件を満たしても削除しない（テスト送信用）', () => {
    const records = [record()];
    const outcomes = [{ token: 'tokenA', ok: false, code: 'messaging/registration-token-not-registered' }];
    const { next, removals } = decideTokenRemovals({ records, outcomes, nowIso: NOW, allowRemoval: false });
    assert.equal(removals.length, 0);
    assert.equal(next.length, 1);
  });

  test('今回送信対象でなかったトークンはそのまま保持される', () => {
    const records = [record({ token: 't1' }), record({ token: 't2' })];
    const outcomes = [{ token: 't1', ok: true }];
    const { next } = decideTokenRemovals({ records, outcomes, nowIso: NOW });
    assert.equal(next.length, 2);
    assert.ok(next.some((r) => r.token === 't2'));
  });
});

describe('summarizePushHealth', () => {
  test('トークン0件は noDevice', () => {
    const h = summarizePushHealth([], NOW, DEFAULT_PUSH_HEALTH_STALE_DAYS);
    assert.equal(h.status, 'noDevice');
    assert.equal(h.deviceCount, 0);
  });
  test('consecutiveFailures > 0 があれば failing（他の条件より優先）', () => {
    const list = [record({ consecutiveFailures: 1, lastSuccessAt: NOW })];
    const h = summarizePushHealth(list, NOW, DEFAULT_PUSH_HEALTH_STALE_DAYS);
    assert.equal(h.status, 'failing');
  });
  test('lastSuccessAt が無ければ neverSucceeded', () => {
    const list = [record()];
    const h = summarizePushHealth(list, NOW, DEFAULT_PUSH_HEALTH_STALE_DAYS);
    assert.equal(h.status, 'neverSucceeded');
  });
  test('最終成功から staleDays 超過で stale', () => {
    const list = [record({ lastSuccessAt: '2026-10-01T00:00:00.000Z' })];
    const h = summarizePushHealth(list, NOW, 1);
    assert.equal(h.status, 'stale');
  });
  test('最終成功が staleDays 以内なら healthy', () => {
    const list = [record({ lastSuccessAt: '2026-10-22T23:00:00.000Z' })];
    const h = summarizePushHealth(list, NOW, 1);
    assert.equal(h.status, 'healthy');
  });
  test('優先順位: noDevice > failing > neverSucceeded > stale > healthy', () => {
    // failing が neverSucceeded より優先される（成功歴が無くても失敗カウントがあれば failing）
    const list = [record({ consecutiveFailures: 1 })];
    const h = summarizePushHealth(list, NOW, DEFAULT_PUSH_HEALTH_STALE_DAYS);
    assert.equal(h.status, 'failing');
  });
});

describe('maskFcmToken', () => {
  test('長いトークンは先頭12文字 + 長さ表示にマスクされる', () => {
    const masked = maskFcmToken('abcdefghijklmnopqrstuvwxyz');
    assert.ok(!masked.includes('klmnopqrstuvwxyz'));
    assert.ok(masked.startsWith('abcdefghijkl'));
  });
  test('短いトークン・空文字列でも素の値が漏れない形で返る', () => {
    assert.equal(maskFcmToken(''), '…');
    assert.ok(maskFcmToken('short').startsWith('short'));
  });
});

describe('resolveFcmPolicy', () => {
  test('既定値は安全側（diag ON, strictDelete OFF, testApi ON）', () => {
    const p = resolveFcmPolicy({});
    assert.equal(p.diagEnabled, true);
    assert.equal(p.strictDelete, false);
    assert.equal(p.testApiEnabled, true);
  });
  test(`DEVRELAY_PUSH_DIAG='0' で diag を無効化できる`, () => {
    assert.equal(resolveFcmPolicy({ DEVRELAY_PUSH_DIAG: '0' }).diagEnabled, false);
  });
  test(`DEVRELAY_FCM_STRICT_DELETE='1' のときだけ strictDelete が有効になる`, () => {
    assert.equal(resolveFcmPolicy({ DEVRELAY_FCM_STRICT_DELETE: '1' }).strictDelete, true);
    assert.equal(resolveFcmPolicy({ DEVRELAY_FCM_STRICT_DELETE: 'yes' }).strictDelete, false);
  });
  test(`DEVRELAY_FCM_TEST_API='0' で test API を無効化できる`, () => {
    assert.equal(resolveFcmPolicy({ DEVRELAY_FCM_TEST_API: '0' }).testApiEnabled, false);
  });
});
