/**
 * FCM プッシュ通知: トークン管理の純粋関数（外部 import ゼロ）。
 *
 * 2026-10-22 の「アプリ入れ直し後、通知が無音のまま届かなくなった」事故（origin: iOS 側の
 * 再インストールで通知許可がリセットされ、再登録が行われなかった）の再発防止策。
 * `fcm-service.ts` から呼ばれる判定ロジックをここに集約し、I/O なしに全分岐を
 * ユニットテストで検証できるようにする（`update-busy-rules.ts` と同じ流儀）。
 *
 * 今回の事故の構造的な問題は「配信先が壊れていることを誰も観測できなかった」こと。
 * このファイルの関数群は「削除していいか」「ログに出すべきか」「健全か」を判定するだけで、
 * I/O（DB・FCM 呼び出し・ログ出力）は一切行わない。
 */

/** FCM トークンレコード（v2。追加フィールドは全て optional = 既存データと後方互換） */
export interface FcmTokenRecord {
  /** FCM registration token（素の値。API レスポンスには絶対に含めない） */
  token: string;
  /** プラットフォーム識別（ios / android） */
  platform: 'ios' | 'android';
  /** 初回登録日時（ISO 文字列）。同一トークンの再 subscribe では更新しない */
  registeredAt: string;
  /** 最後に subscribe された日時（再登録ごとに更新） */
  lastRegisteredAt?: string;
  /** 最後に messaging.send() が成功した日時 */
  lastSuccessAt?: string;
  /** 最後に送信が失敗した日時 */
  lastFailureAt?: string;
  /** 直近の FCM エラーコード */
  lastErrorCode?: string;
  /** 連続失敗回数（成功で 0 にリセット） */
  consecutiveFailures?: number;
  /** Firebase Installations ID（Phase E: Flutter 側対応後に送られてくる想定、現状は未使用） */
  installationId?: string;
  /** 端末表示名（Phase E、例: "iPhone SE3 / iOS 18.2"） */
  deviceLabel?: string;
}

/**
 * 不正な値が混じっていても安全にレコードへ正規化する。
 * `token` が非空文字列でない場合は捨てる（null を返す）。
 */
export function normalizeFcmTokenRecord(raw: unknown, nowIso: string): FcmTokenRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.token !== 'string' || r.token.length === 0) return null;
  const platform: 'ios' | 'android' = r.platform === 'android' ? 'android' : 'ios';
  const registeredAt = typeof r.registeredAt === 'string' && r.registeredAt.length > 0 ? r.registeredAt : nowIso;

  const record: FcmTokenRecord = { token: r.token, platform, registeredAt };
  if (typeof r.lastRegisteredAt === 'string') record.lastRegisteredAt = r.lastRegisteredAt;
  if (typeof r.lastSuccessAt === 'string') record.lastSuccessAt = r.lastSuccessAt;
  if (typeof r.lastFailureAt === 'string') record.lastFailureAt = r.lastFailureAt;
  if (typeof r.lastErrorCode === 'string') record.lastErrorCode = r.lastErrorCode;
  if (typeof r.consecutiveFailures === 'number' && Number.isFinite(r.consecutiveFailures)) {
    record.consecutiveFailures = Math.max(0, Math.floor(r.consecutiveFailures));
  }
  if (typeof r.installationId === 'string') record.installationId = r.installationId;
  if (typeof r.deviceLabel === 'string') record.deviceLabel = r.deviceLabel;
  return record;
}

/**
 * 配列でないもの（旧データ破損・パース失敗時の空文字列など）を空配列に、
 * 不正な要素を除去し、重複 token を畳む（後勝ち。`lastSuccessAt` が新しい方を残す）。
 */
export function normalizeFcmTokenList(raw: unknown, nowIso: string): FcmTokenRecord[] {
  if (!Array.isArray(raw)) return [];
  const byToken = new Map<string, FcmTokenRecord>();
  for (const item of raw) {
    const record = normalizeFcmTokenRecord(item, nowIso);
    if (!record) continue;
    const existing = byToken.get(record.token);
    if (!existing) {
      byToken.set(record.token, record);
      continue;
    }
    // 重複: lastSuccessAt / lastRegisteredAt が新しい方（文字列比較で足りる ISO 8601 前提）を残す
    const existingStamp = existing.lastSuccessAt ?? existing.lastRegisteredAt ?? existing.registeredAt;
    const newStamp = record.lastSuccessAt ?? record.lastRegisteredAt ?? record.registeredAt;
    if (newStamp >= existingStamp) byToken.set(record.token, record);
  }
  return Array.from(byToken.values());
}

export interface UpsertFcmTokenInput {
  list: FcmTokenRecord[];
  token: string;
  platform: 'ios' | 'android';
  nowIso: string;
}

export type UpsertFcmTokenAction = 'created' | 'refreshed';

/**
 * トークンを登録（subscribe）する。同一トークンが既にあれば `registeredAt`（初回登録時刻）は
 * 保持したまま `lastRegisteredAt` だけ更新する（既存の実装は毎回 `registeredAt` を上書きしていたバグ）。
 */
export function upsertFcmTokenRecord(
  input: UpsertFcmTokenInput
): { next: FcmTokenRecord[]; action: UpsertFcmTokenAction } {
  const { list, token, platform, nowIso } = input;
  const idx = list.findIndex((t) => t.token === token);
  if (idx < 0) {
    const created: FcmTokenRecord = { token, platform, registeredAt: nowIso, lastRegisteredAt: nowIso };
    return { next: [...list, created], action: 'created' };
  }
  const next = list.slice();
  next[idx] = { ...next[idx], platform, lastRegisteredAt: nowIso };
  return { next, action: 'refreshed' };
}

/** FCM / APNs エラーコードの分類 */
export type FcmErrorClass = 'unregistered' | 'malformedToken' | 'ambiguous' | 'environment' | 'transient' | 'unknown';

/**
 * FCM エラーコードを分類する。
 *
 * - unregistered / malformedToken: FCM が「この端末は存在しない／トークンが壊れている」と断言しているので即削除してよい
 * - ambiguous: payload 不正や別 Firebase プロジェクト発行トークンでも返るため、1 回では削除しない
 * - environment: サービスアカウント差し替え・Firebase プロジェクトのズレの署名。削除すると正しいトークンまで消えるため絶対に削除しない
 * - transient: 一時的な障害。削除も失敗カウントもしない
 */
export function classifyFcmError(code: string | undefined): FcmErrorClass {
  switch (code) {
    case 'messaging/registration-token-not-registered':
      return 'unregistered';
    case 'messaging/invalid-registration-token':
      return 'malformedToken';
    case 'messaging/invalid-argument':
      return 'ambiguous';
    case 'messaging/mismatched-credential':
    case 'messaging/sender-id-mismatch':
      return 'environment';
    case 'messaging/server-unavailable':
    case 'messaging/internal-error':
    case 'messaging/quota-exceeded':
    case 'messaging/unavailable':
    case 'messaging/third-party-auth-error':
      return 'transient';
    default:
      return 'unknown';
  }
}

/** 個々のトークンへの送信結果 */
export interface FcmSendOutcome {
  token: string;
  ok: boolean;
  /** 失敗時の FCM エラーコード */
  code?: string;
}

/** 送信結果の集計（ログ出力用） */
export interface FcmSendSummary {
  total: number;
  success: number;
  failed: number;
  byCode: Record<string, number>;
}

/** 送信結果を集計する（ログの素材。I/O なし） */
export function summarizeSendResult(outcomes: FcmSendOutcome[]): FcmSendSummary {
  const byCode: Record<string, number> = {};
  let success = 0;
  for (const o of outcomes) {
    if (o.ok) {
      success += 1;
    } else if (o.code) {
      byCode[o.code] = (byCode[o.code] ?? 0) + 1;
    } else {
      byCode['unknown'] = (byCode['unknown'] ?? 0) + 1;
    }
  }
  return { total: outcomes.length, success, failed: outcomes.length - success, byCode };
}

/** `consecutiveFailures` が削除閾値に到達したとみなす回数（既定5） */
const DEFAULT_AMBIGUOUS_DELETE_THRESHOLD = 5;

export interface DecideTokenRemovalsInput {
  /** 送信前のトークン一覧 */
  records: FcmTokenRecord[];
  /** 送信結果（records と同じ token を参照） */
  outcomes: FcmSendOutcome[];
  nowIso: string;
  /** `ambiguous` 分類の連続失敗が何回で削除するか（既定 5） */
  threshold?: number;
  /**
   * true のとき、`ambiguous`（invalid-argument）も旧挙動どおり即削除する
   * （`DEVRELAY_FCM_STRICT_DELETE=1` 用。既定は false ＝安全側）。
   */
  strictDelete?: boolean;
  /**
   * false のとき、削除条件を満たしても一切削除しない（失敗の記録は行う）。
   * テスト送信 API（`POST /api/push/fcm/test`）が「診断ボタンがトークン削除装置になる」
   * 事故を防ぐために使う。既定 true。
   */
  allowRemoval?: boolean;
}

export interface DecideTokenRemovalsResult {
  /** 削除・更新後のトークン一覧 */
  next: FcmTokenRecord[];
  /** 削除されたトークン（ログ用） */
  removals: { token: string; reason: FcmErrorClass; code?: string }[];
  /**
   * true のとき「全滅ガード」が発動した（= 本来削除すべきだったトークンがあっても削除を止めた）。
   * 呼び出し元はこれを見て loud なログ・通知を出すこと。
   */
  loud: boolean;
}

/**
 * 送信結果からトークンの削除・更新を決定する（要件3の本体）。
 *
 * 「全滅ガード」: 2 件以上のトークン全てが同一の ambiguous/environment/unknown コードで失敗した場合、
 * 個々のトークンの問題ではなく payload 不正・サービスアカウント差し替え・Firebase プロジェクトのズレの
 * 署名とみなし、削除件数を 0 に落として loud フラグを立てる。これにより「環境ズレで正しいトークンまで
 * 消える」事故を構造的に防ぐ。`total === 1` のときは比較対象が無いため全滅ガードは発動しない。
 */
export function decideTokenRemovals(input: DecideTokenRemovalsInput): DecideTokenRemovalsResult {
  const { records, outcomes, nowIso, strictDelete = false, allowRemoval = true } = input;
  const threshold = input.threshold ?? DEFAULT_AMBIGUOUS_DELETE_THRESHOLD;

  const byToken = new Map(records.map((r) => [r.token, r]));
  const outcomeByToken = new Map(outcomes.map((o) => [o.token, o]));

  // 全滅ガードの判定: 2件以上・全失敗・全て同一コードの ambiguous/environment/unknown
  const total = outcomes.length;
  const failed = outcomes.filter((o) => !o.ok);
  let massFailureGuard = false;
  if (total >= 2 && failed.length === total) {
    const codes = new Set(failed.map((o) => o.code));
    if (codes.size === 1) {
      const cls = classifyFcmError(failed[0].code);
      if (cls === 'ambiguous' || cls === 'environment' || cls === 'unknown') {
        massFailureGuard = true;
      }
    }
  }

  const removals: DecideTokenRemovalsResult['removals'] = [];
  const next: FcmTokenRecord[] = [];

  for (const record of records) {
    const outcome = outcomeByToken.get(record.token);
    if (!outcome) {
      // 今回送信対象でなかったトークン（ありえないが安全側で保持）
      next.push(record);
      continue;
    }

    if (outcome.ok) {
      next.push({ ...record, lastSuccessAt: nowIso, consecutiveFailures: 0 });
      continue;
    }

    const cls = classifyFcmError(outcome.code);
    const failureRecord: FcmTokenRecord = {
      ...record,
      lastFailureAt: nowIso,
      lastErrorCode: outcome.code,
    };

    if (cls === 'unregistered' || cls === 'malformedToken') {
      if (allowRemoval) {
        removals.push({ token: record.token, reason: cls, code: outcome.code });
        continue; // next に積まない = 削除
      }
      next.push(failureRecord);
      continue;
    }

    if (cls === 'environment') {
      // 絶対に削除しない。カウントも増やさない（この端末固有の問題ではないため）
      next.push(failureRecord);
      continue;
    }

    if (cls === 'transient') {
      // 削除も失敗カウントもしない（一時障害で閾値を食い潰さない）
      next.push(failureRecord);
      continue;
    }

    // ambiguous または unknown
    if (massFailureGuard) {
      // 全滅ガード発動中は削除せず、カウントも増やさない（loud ログで気づかせる）
      next.push(failureRecord);
      continue;
    }

    const consecutive = (record.consecutiveFailures ?? 0) + 1;
    if (allowRemoval && cls === 'ambiguous' && (strictDelete || consecutive >= threshold)) {
      removals.push({ token: record.token, reason: cls, code: outcome.code });
      continue;
    }
    next.push({ ...failureRecord, consecutiveFailures: consecutive });
  }

  // records に無いが byToken 経由で参照だけした場合（理論上到達しないが型安全のため）
  void byToken;

  return { next, removals, loud: massFailureGuard };
}

/**
 * `summarizePushHealth` の既定 staleDays（1日）。
 * 2026-10-22 の事故は再インストールの翌日まで誰も気づかなかったため、
 * 「最終成功から 1 日経過」で stale（黄色）に倒すことを優先する。
 */
export const DEFAULT_PUSH_HEALTH_STALE_DAYS = 1;

/** プッシュ通知の健全性ステータス */
export type PushHealthStatus = 'noDevice' | 'failing' | 'neverSucceeded' | 'stale' | 'healthy';

export interface PushHealthSummary {
  status: PushHealthStatus;
  deviceCount: number;
  lastRegisteredAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
}

/**
 * トークン一覧から健全性ステータスを導出する。優先順位:
 * noDevice > failing > neverSucceeded > stale > healthy
 */
export function summarizePushHealth(
  list: FcmTokenRecord[],
  nowIso: string,
  staleDays: number
): PushHealthSummary {
  const lastRegisteredAt = maxIso(list.map((r) => r.lastRegisteredAt ?? r.registeredAt));
  const lastSuccessAt = maxIso(list.map((r) => r.lastSuccessAt).filter((v): v is string => !!v));
  const lastFailureAt = maxIso(list.map((r) => r.lastFailureAt).filter((v): v is string => !!v));

  const base: Omit<PushHealthSummary, 'status'> = {
    deviceCount: list.length,
    lastRegisteredAt,
    lastSuccessAt,
    lastFailureAt,
  };

  if (list.length === 0) return { ...base, status: 'noDevice' };

  const anyFailing = list.some((r) => (r.consecutiveFailures ?? 0) > 0);
  if (anyFailing) return { ...base, status: 'failing' };

  if (!lastSuccessAt) return { ...base, status: 'neverSucceeded' };

  const staleMs = staleDays * 24 * 60 * 60 * 1000;
  const ageMs = new Date(nowIso).getTime() - new Date(lastSuccessAt).getTime();
  if (Number.isFinite(ageMs) && ageMs > staleMs) return { ...base, status: 'stale' };

  return { ...base, status: 'healthy' };
}

function maxIso(values: string[]): string | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => (b > a ? b : a));
}

/**
 * トークンをログ・API レスポンスに出す際のマスク処理。
 * 素のトークンが戻り値に含まれないことがこの関数の唯一の責務。
 */
export function maskFcmToken(token: string): string {
  if (token.length <= 12) return `${token}…`;
  return `${token.slice(0, 12)}…(${token.length})`;
}

/** FCM 関連キルスイッチ・ポリシーの解決結果 */
export interface FcmPolicy {
  /** 無音故障の可視化ログを出すか（既定 true、'0' で無効） */
  diagEnabled: boolean;
  /** `invalid-argument` を旧挙動（即削除）にするか（既定 false ＝安全側） */
  strictDelete: boolean;
  /** テスト送信 API を有効にするか（既定 true、'0' で無効） */
  testApiEnabled: boolean;
}

/**
 * `DEVRELAY_*` 環境変数から FCM ポリシーを解決する（純粋関数。既定値はすべて安全側）。
 * `Record<string, string | undefined>` を受けるのは `process.env`（`NodeJS.ProcessEnv`）を
 * そのまま渡せるようにするため（具体的なキーだけの型にすると TS2559 で弾かれる）。
 */
export function resolveFcmPolicy(env: Record<string, string | undefined>): FcmPolicy {
  return {
    diagEnabled: env.DEVRELAY_PUSH_DIAG !== '0',
    strictDelete: env.DEVRELAY_FCM_STRICT_DELETE === '1',
    testApiEnabled: env.DEVRELAY_FCM_TEST_API !== '0',
  };
}
