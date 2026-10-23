/**
 * FCM プッシュ通知の端末一覧（設定画面）向けの純粋関数（外部 import ゼロ）。
 *
 * 2026-10-22 の事故（アプリ再インストール後、サーバー側が無音のまま配信し続けた）の
 * 再発防止として、`GET /api/push/fcm/devices` のレスポンスから WebUI 表示用の
 * 色・ラベル・並び順を導出する。I/O は一切行わない（`clearance-rules.ts` と同じ流儀）。
 */

/** プッシュ通知の健全性ステータス（サーバー `fcm-token-rules.ts` の `PushHealthStatus` と同じ値） */
export type PushHealthStatus = 'noDevice' | 'failing' | 'neverSucceeded' | 'stale' | 'healthy';

/** `GET /api/push/fcm/devices` の `health` フィールド */
export interface PushHealth {
  status: PushHealthStatus;
  deviceCount: number;
  lastRegisteredAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
}

/** `GET /api/push/fcm/devices` の `devices[]` の要素（素のトークンは含まれない） */
export interface PushDevice {
  tokenPrefix: string;
  platform: 'ios' | 'android';
  registeredAt: string;
  lastRegisteredAt: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastErrorCode: string | null;
  consecutiveFailures: number;
  deviceLabel: string | null;
}

/** `GET /api/push/fcm/devices` の `metrics` フィールド（プロセス再起動でリセットされる値） */
export interface PushMetrics {
  attempts: number;
  sendOk: number;
  sendFail: number;
  dropNoToken: number;
  lastErrorCode: string | null;
  since: string;
}

/** `GET /api/push/fcm/devices` のレスポンス全体 */
export interface PushDevicesResponse {
  enabled: boolean;
  health: PushHealth;
  devices: PushDevice[];
  metrics: PushMetrics;
}

/** `POST /api/push/fcm/test` の端末ごとの結果 */
export interface PushTestResult {
  tokenPrefix: string;
  ok: boolean;
  errorCode: string | null;
}

/** `POST /api/push/fcm/test` のレスポンス */
export interface PushTestResponse {
  total: number;
  success: number;
  failed: number;
  results: PushTestResult[];
  hint?: string;
}

/** バッジの色調 */
export type BadgeTone = 'ok' | 'warn' | 'error';

/** 全体ヘルスバッジの表示情報 */
export interface HealthBadge {
  tone: BadgeTone;
  label: string;
}

/**
 * `PushHealth.status` から設定画面のバッジ表示（色調 + ラベル）を導出する。
 * noDevice/neverSucceeded/failing は赤、stale は黄、healthy は緑。
 */
export function deriveHealthBadge(status: PushHealthStatus): HealthBadge {
  switch (status) {
    case 'noDevice':
      return { tone: 'error', label: '登録済み端末がありません（プッシュ通知は届きません）' };
    case 'neverSucceeded':
      return { tone: 'error', label: '登録はありますが、一度も送信に成功していません' };
    case 'failing':
      return { tone: 'error', label: '通知の送信に失敗しています' };
    case 'stale':
      return { tone: 'warn', label: '最後に成功した送信から時間が経っています' };
    case 'healthy':
      return { tone: 'ok', label: '正常に動作しています' };
  }
}

/**
 * 端末 1 件ごとの行の色調を導出する（一覧テーブルの行の強調表示用）。
 * `consecutiveFailures > 0` または直近エラーがあれば warn、一度も成功していなければ error。
 */
export function derivePushDeviceStatus(device: PushDevice): BadgeTone {
  if (!device.lastSuccessAt) return 'error';
  if (device.consecutiveFailures > 0) return 'warn';
  return 'ok';
}

/**
 * ISO 文字列を「n分前」「n時間前」「n日前」の相対時刻表示に変換する。
 * 未来時刻（クロックスキュー等）は「たった今」に丸める。無効な値は null を返す。
 */
export function formatRelativeTime(iso: string | null, nowIso: string): string | null {
  if (!iso) return null;
  const target = new Date(iso).getTime();
  const now = new Date(nowIso).getTime();
  if (!Number.isFinite(target) || !Number.isFinite(now)) return null;

  const diffMs = now - target;
  if (diffMs <= 0) return 'たった今';

  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diffMs < minute) return 'たった今';
  if (diffMs < hour) return `${Math.floor(diffMs / minute)}分前`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)}時間前`;
  return `${Math.floor(diffMs / day)}日前`;
}

/**
 * 端末一覧を「最終成功 → 最終登録」の新しい順にソートする（どちらも無い端末は末尾）。
 * `Array.prototype.sort` は安定ソートなので、同値のものは元の順序を保つ。
 */
export function sortDevices(devices: PushDevice[]): PushDevice[] {
  const rank = (d: PushDevice): string => d.lastSuccessAt ?? d.lastRegisteredAt ?? d.registeredAt ?? '';
  return devices.slice().sort((a, b) => (rank(b) > rank(a) ? 1 : rank(b) < rank(a) ? -1 : 0));
}
