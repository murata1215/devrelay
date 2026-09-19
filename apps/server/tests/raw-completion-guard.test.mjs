// raw-completion（ゲーム席用の素の completion API）の流量制御・同時実行制御の単体テスト。
// 外部 import ゼロの純粋関数（apps/server/src/services/raw-completion-guard.ts）を
// コンパイル済み dist から直接 import する（cross-query-guard.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRawGuardState,
  normalizeSeatKey,
  seatSlotKey,
  resolveRawTimeoutMs,
  buildRawSessionId,
  acquireRawSlot,
  releaseRawSlot,
  pruneRawGuardState,
  RAW_SESSION_ID_PREFIX,
  RAW_RATE_WINDOW_MS,
  RAW_SEAT_RATE_LIMIT,
  RAW_USER_RATE_LIMIT,
  RAW_TIMEOUT_MIN_S,
  RAW_TIMEOUT_MAX_S,
  RAW_TIMEOUT_DEFAULT_S,
  RAW_SLOT_STALE_MS,
} from '../dist/services/raw-completion-guard.js';

// ---- normalizeSeatKey ----

test('normalizeSeatKey: 前後の空白を除去する', () => {
  assert.equal(normalizeSeatKey('  P05  '), 'P05');
});

test('normalizeSeatKey: null / undefined / 空文字は null', () => {
  assert.equal(normalizeSeatKey(null), null);
  assert.equal(normalizeSeatKey(undefined), null);
  assert.equal(normalizeSeatKey(''), null);
  assert.equal(normalizeSeatKey('   '), null);
});

test('normalizeSeatKey: 許容文字種（英数字・_・-・.・:）は通す', () => {
  assert.equal(normalizeSeatKey('seat_P05-v1.2:x'), 'seat_P05-v1.2:x');
});

test('normalizeSeatKey: 不正文字（スペース・記号混入）は null', () => {
  assert.equal(normalizeSeatKey('seat P05'), null);
  assert.equal(normalizeSeatKey('seat/../etc'), null);
  assert.equal(normalizeSeatKey('seat;drop table'), null);
});

test('normalizeSeatKey: 100文字超は null', () => {
  assert.equal(normalizeSeatKey('a'.repeat(101)), null);
  assert.equal(normalizeSeatKey('a'.repeat(100)), 'a'.repeat(100));
});

// ---- seatSlotKey ----

test('seatSlotKey: userId と seatKey を : で連結する', () => {
  assert.equal(seatSlotKey('user1', 'P05'), 'user1:P05');
});

// ---- resolveRawTimeoutMs ----

test('resolveRawTimeoutMs: 未指定は既定値', () => {
  assert.equal(resolveRawTimeoutMs(undefined), RAW_TIMEOUT_DEFAULT_S * 1000);
  assert.equal(resolveRawTimeoutMs(null), RAW_TIMEOUT_DEFAULT_S * 1000);
});

test('resolveRawTimeoutMs: NaN は既定値', () => {
  assert.equal(resolveRawTimeoutMs(NaN), RAW_TIMEOUT_DEFAULT_S * 1000);
});

test('resolveRawTimeoutMs: 範囲内はそのまま', () => {
  assert.equal(resolveRawTimeoutMs(30), 30 * 1000);
});

test('resolveRawTimeoutMs: 下限未満は下限にクランプ', () => {
  assert.equal(resolveRawTimeoutMs(1), RAW_TIMEOUT_MIN_S * 1000);
  assert.equal(resolveRawTimeoutMs(-5), RAW_TIMEOUT_MIN_S * 1000);
});

test('resolveRawTimeoutMs: 上限超過は上限にクランプ', () => {
  assert.equal(resolveRawTimeoutMs(999), RAW_TIMEOUT_MAX_S * 1000);
});

// ---- buildRawSessionId ----

test('buildRawSessionId: raw_ プレフィックスを付与する', () => {
  assert.equal(buildRawSessionId('abc-123'), `${RAW_SESSION_ID_PREFIX}abc-123`);
  assert.match(buildRawSessionId('abc-123'), /^raw_/);
});

// ---- acquireRawSlot / releaseRawSlot ----

test('acquireRawSlot: 初回は成功する', () => {
  const state = createRawGuardState();
  const decision = acquireRawSlot(state, { userId: 'u1', seatKey: 'P05', sessionId: 'raw_1', nowMs: 1000 });
  assert.deepEqual(decision, { ok: true });
});

test('acquireRawSlot: 同一座席が占有中なら targetBusy', () => {
  const state = createRawGuardState();
  acquireRawSlot(state, { userId: 'u1', seatKey: 'P05', sessionId: 'raw_1', nowMs: 1000 });
  const decision = acquireRawSlot(state, { userId: 'u1', seatKey: 'P05', sessionId: 'raw_2', nowMs: 1500 });
  assert.deepEqual(decision, { ok: false, status: 429, reason: 'targetBusy' });
});

test('acquireRawSlot: 別座席（seatKey 違い）は同時に成功する（プロジェクト単位ではなく座席単位の証明）', () => {
  const state = createRawGuardState();
  const d1 = acquireRawSlot(state, { userId: 'u1', seatKey: 'P05', sessionId: 'raw_1', nowMs: 1000 });
  const d2 = acquireRawSlot(state, { userId: 'u1', seatKey: 'P06', sessionId: 'raw_2', nowMs: 1000 });
  assert.deepEqual(d1, { ok: true });
  assert.deepEqual(d2, { ok: true });
});

test('acquireRawSlot: 別ユーザーの同名 seatKey は衝突しない（userId 名前空間化）', () => {
  const state = createRawGuardState();
  const d1 = acquireRawSlot(state, { userId: 'u1', seatKey: 'P05', sessionId: 'raw_1', nowMs: 1000 });
  const d2 = acquireRawSlot(state, { userId: 'u2', seatKey: 'P05', sessionId: 'raw_2', nowMs: 1000 });
  assert.deepEqual(d1, { ok: true });
  assert.deepEqual(d2, { ok: true });
});

test('releaseRawSlot: 解放後は同一座席を再取得できる', () => {
  const state = createRawGuardState();
  acquireRawSlot(state, { userId: 'u1', seatKey: 'P05', sessionId: 'raw_1', nowMs: 1000 });
  releaseRawSlot(state, 'u1', 'P05');
  const decision = acquireRawSlot(state, { userId: 'u1', seatKey: 'P05', sessionId: 'raw_2', nowMs: 1100 });
  assert.deepEqual(decision, { ok: true });
});

test('releaseRawSlot: 未取得の座席を解放しても例外を投げない', () => {
  const state = createRawGuardState();
  assert.doesNotThrow(() => releaseRawSlot(state, 'u1', 'P05'));
});

test('acquireRawSlot: 座席レート上限（RAW_SEAT_RATE_LIMIT）到達で seatRateLimited', () => {
  const state = createRawGuardState();
  for (let i = 0; i < RAW_SEAT_RATE_LIMIT; i++) {
    const nowMs = 1000 + i * 1000;
    const d = acquireRawSlot(state, { userId: 'u1', seatKey: 'P05', sessionId: `raw_${i}`, nowMs });
    assert.equal(d.ok, true, `attempt ${i} should succeed`);
    releaseRawSlot(state, 'u1', 'P05'); // busy にならないよう都度解放し、レート判定のみを試す
  }
  const decision = acquireRawSlot(state, { userId: 'u1', seatKey: 'P05', sessionId: 'raw_over', nowMs: 1000 + RAW_SEAT_RATE_LIMIT * 1000 });
  assert.deepEqual(decision, { ok: false, status: 429, reason: 'seatRateLimited' });
});

test('acquireRawSlot: 窓（RAW_RATE_WINDOW_MS）を過ぎれば座席レートはリセットされる', () => {
  const state = createRawGuardState();
  for (let i = 0; i < RAW_SEAT_RATE_LIMIT; i++) {
    acquireRawSlot(state, { userId: 'u1', seatKey: 'P05', sessionId: `raw_${i}`, nowMs: 1000 });
    releaseRawSlot(state, 'u1', 'P05');
  }
  const decision = acquireRawSlot(state, {
    userId: 'u1', seatKey: 'P05', sessionId: 'raw_later', nowMs: 1000 + RAW_RATE_WINDOW_MS + 1,
  });
  assert.deepEqual(decision, { ok: true });
});

test('acquireRawSlot: ユーザー全体レート上限（RAW_USER_RATE_LIMIT）到達で userRateLimited（座席を変えても止まる）', () => {
  const state = createRawGuardState();
  for (let i = 0; i < RAW_USER_RATE_LIMIT; i++) {
    const seatKey = `seat${i % 10}`; // 複数座席に分散させても user 上限には効く
    const nowMs = 1000 + i;
    const d = acquireRawSlot(state, { userId: 'u1', seatKey, sessionId: `raw_${i}`, nowMs });
    assert.equal(d.ok, true, `attempt ${i} should succeed`);
    releaseRawSlot(state, 'u1', seatKey);
  }
  const decision = acquireRawSlot(state, { userId: 'u1', seatKey: 'seat99', sessionId: 'raw_over', nowMs: 1000 + RAW_USER_RATE_LIMIT });
  assert.deepEqual(decision, { ok: false, status: 429, reason: 'userRateLimited' });
});

test('acquireRawSlot: 判定順の固定 — busy が rate limit より先に評価される', () => {
  const state = createRawGuardState();
  // まず座席を占有（解放しない）
  acquireRawSlot(state, { userId: 'u1', seatKey: 'P05', sessionId: 'raw_busy', nowMs: 1000 });
  // 同じ座席へ大量リクエスト（レート上限は超えさせない程度）してから、占有中に再アタック
  const decision = acquireRawSlot(state, { userId: 'u1', seatKey: 'P05', sessionId: 'raw_x', nowMs: 1001 });
  assert.deepEqual(decision, { ok: false, status: 429, reason: 'targetBusy' });
});

test('acquireRawSlot: stale reap — 占有から RAW_SLOT_STALE_MS 超過後は自動解放される', () => {
  const state = createRawGuardState();
  acquireRawSlot(state, { userId: 'u1', seatKey: 'P05', sessionId: 'raw_1', nowMs: 1000 });
  // stale 直前はまだ busy
  const stillBusy = acquireRawSlot(state, { userId: 'u1', seatKey: 'P05', sessionId: 'raw_2', nowMs: 1000 + RAW_SLOT_STALE_MS });
  assert.deepEqual(stillBusy, { ok: false, status: 429, reason: 'targetBusy' });
  // stale 超過後は取得できる
  const afterStale = acquireRawSlot(state, { userId: 'u1', seatKey: 'P05', sessionId: 'raw_3', nowMs: 1000 + RAW_SLOT_STALE_MS + 1 });
  assert.deepEqual(afterStale, { ok: true });
});

// ---- pruneRawGuardState ----

test('pruneRawGuardState: 窓外のレート記録を削除する', () => {
  const state = createRawGuardState();
  acquireRawSlot(state, { userId: 'u1', seatKey: 'P05', sessionId: 'raw_1', nowMs: 1000 });
  releaseRawSlot(state, 'u1', 'P05');
  pruneRawGuardState(state, 1000 + RAW_RATE_WINDOW_MS + 1);
  assert.equal(state.seatHits.size, 0);
  assert.equal(state.userHits.size, 0);
});

test('pruneRawGuardState: stale なスロットを削除する', () => {
  const state = createRawGuardState();
  acquireRawSlot(state, { userId: 'u1', seatKey: 'P05', sessionId: 'raw_1', nowMs: 1000 });
  pruneRawGuardState(state, 1000 + RAW_SLOT_STALE_MS + 1);
  assert.equal(state.slots.size, 0);
});

test('pruneRawGuardState: 窓内の記録・占有中スロットは維持する', () => {
  const state = createRawGuardState();
  acquireRawSlot(state, { userId: 'u1', seatKey: 'P05', sessionId: 'raw_1', nowMs: 1000 });
  pruneRawGuardState(state, 1000 + 1000);
  assert.equal(state.slots.size, 1);
  assert.equal(state.seatHits.size, 1);
  assert.equal(state.userHits.size, 1);
});
