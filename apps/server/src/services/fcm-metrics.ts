/**
 * FCM 送信のプロセス寿命メトリクス（再起動で消える）。
 *
 * 2026-10-22 の無音故障（配信先 0 件のまま 110 回以上の送信が消えた）で「何件送って
 * 何件失敗したか」をどこからも確認できなかったことへの対策。永続が必要な値
 * （`lastSuccessAt` 等）は `fcm-token-rules.ts` の `FcmTokenRecord` 側に持たせるため、
 * ここはプロセス起動以降の集計値のみ（`GET /api/push/fcm/devices` の `metrics.since` で
 * 「再起動でリセットされる値である」ことを明示する）。
 */

/** ユーザー 1 人分の送信メトリクス */
export interface FcmUserMetrics {
  attempts: number;
  dropNoToken: number;
  sendOk: number;
  sendFail: number;
  lastDropAt: string | null;
  lastOkAt: string | null;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
  lastPersistAt: string | null;
  /** テスト送信 API のレートリミット用 */
  lastTestAt: string | null;
}

const EMPTY_METRICS: FcmUserMetrics = {
  attempts: 0,
  dropNoToken: 0,
  sendOk: 0,
  sendFail: 0,
  lastDropAt: null,
  lastOkAt: null,
  lastErrorCode: null,
  lastErrorAt: null,
  lastPersistAt: null,
  lastTestAt: null,
};

/** プロセス起動時刻（`since` としてレスポンスに出す） */
export const FCM_METRICS_SINCE = new Date().toISOString();

/** LRU 上限（登録ユーザー数が無制限に増えてもメモリを圧迫しないため） */
const MAX_TRACKED_USERS = 500;

/** userId → メトリクス。Map は挿入順を保持するため、再アクセス時に末尾へ移動させれば LRU になる */
const metricsByUser = new Map<string, FcmUserMetrics>();

function touch(userId: string): FcmUserMetrics {
  let m = metricsByUser.get(userId);
  if (m) {
    // LRU: 既存エントリを一度削除して再挿入すると「最近使った」扱いになる
    metricsByUser.delete(userId);
  } else {
    m = { ...EMPTY_METRICS };
  }
  metricsByUser.set(userId, m);
  if (metricsByUser.size > MAX_TRACKED_USERS) {
    const oldestKey = metricsByUser.keys().next().value;
    if (oldestKey !== undefined) metricsByUser.delete(oldestKey);
  }
  return m;
}

/** 配信先トークンが 0 件で送信を破棄したことを記録 */
export function recordFcmDropNoToken(userId: string, nowIso: string): FcmUserMetrics {
  const m = touch(userId);
  m.attempts += 1;
  m.dropNoToken += 1;
  m.lastDropAt = nowIso;
  return m;
}

/** 送信結果（成功/失敗の内訳）を記録 */
export function recordFcmSendResult(
  userId: string,
  nowIso: string,
  summary: { success: number; failed: number; byCode: Record<string, string | undefined> | Record<string, number> }
): FcmUserMetrics {
  const m = touch(userId);
  m.attempts += 1;
  m.sendOk += summary.success;
  m.sendFail += summary.failed;
  if (summary.success > 0) m.lastOkAt = nowIso;
  if (summary.failed > 0) {
    m.lastErrorAt = nowIso;
    const codes = Object.keys(summary.byCode);
    if (codes.length > 0) m.lastErrorCode = codes[0];
  }
  return m;
}

/** トークン保存を行った時刻を記録（書き込みスロットル判定用） */
export function recordFcmPersist(userId: string, nowIso: string): void {
  const m = touch(userId);
  m.lastPersistAt = nowIso;
}

/** テスト送信 API 呼び出し時刻を記録（レートリミット判定用） */
export function recordFcmTestCall(userId: string, nowIso: string): void {
  const m = touch(userId);
  m.lastTestAt = nowIso;
}

/** 現在のメトリクスを取得（無ければ空値） */
export function getFcmMetrics(userId: string): FcmUserMetrics {
  return metricsByUser.get(userId) ?? { ...EMPTY_METRICS };
}
