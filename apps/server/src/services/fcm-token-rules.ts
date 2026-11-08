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

export interface DecideTokenRemovalsInput {
  /** 送信前のトークン一覧 */
  records: FcmTokenRecord[];
  /** 送信結果（records と同じ token を参照） */
  outcomes: FcmSendOutcome[];
  nowIso: string;
  /**
   * true のとき、`ambiguous`（invalid-argument）も即削除する
   * （`DEVRELAY_FCM_STRICT_DELETE=1` 用。既定は false ＝安全側）。
   *
   * 2026-11-02 の iPhone SE3 無音故障（唯一の iOS トークンが `invalid-argument` の
   * 5 連続失敗で自動削除され、削除後に同じトークンを再登録したら問題なく配信できた＝
   * 誤判定だったことが判明）を受けて、`ambiguous` 分類は「連続失敗回数が閾値に達したら
   * 削除する」という既定の自動削除経路を廃止した。既定では `ambiguous` は何回失敗しても
   * 削除されない（`consecutiveFailures` は記録・表示のためだけに増え続ける）。
   * 削除したい場合は本フラグを明示的に true にする必要があり、かつ下記の全滅ガードは
   * strictDelete の場合も必ず適用される。
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
   * true のとき「全滅ガード」または「ゼロ件ガード」が発動した
   * （= 本来削除すべきだったトークンがあっても削除を止めた）。
   * 呼び出し元はこれを見て loud なログ・通知を出すこと。
   */
  loud: boolean;
}

/** 削除予定だったトークンを「削除せず keep する」ときの復元用レコードを作る */
function toKeptAfterBlockedRemoval(record: FcmTokenRecord, nowIso: string, code?: string): FcmTokenRecord {
  return {
    ...record,
    lastFailureAt: nowIso,
    lastErrorCode: code,
    consecutiveFailures: (record.consecutiveFailures ?? 0) + 1,
  };
}

/**
 * 送信結果からトークンの削除・更新を決定する（要件3の本体）。
 *
 * 2 段階で判定する:
 * 1. 個々のトークンについて、分類（`classifyFcmError`）に応じて「削除 or keep」を仮決定する
 *    （`unregistered`/`malformedToken` は削除、`environment`/`transient` は常に keep、
 *    `ambiguous`/`unknown` は `strictDelete` のときだけ削除候補、それ以外は keep）。
 * 2. 「ゼロ件ガード」: 仮決定の削除を全部実行すると、そのユーザーの配信先トークンが
 *    0 件になる場合は、削除を一切実行しない（代わりに keep して失敗情報だけ記録する）。
 *    2026-11-02 の事故は「端末 1 台しか登録していないユーザーは全滅ガード（旧: 2件以上
 *    かつ同一コード全滅のときだけ発動）の保護を受けられない」ことが構造的原因だったため、
 *    件数・コードの種類を問わず無条件に適用する（端末が 1 台でも機能する）。
 *
 * 「全滅ガード」（旧来の診断用シグナル）: 2 件以上のトークン全てが同一の
 * ambiguous/environment/unknown コードで失敗した場合、個々のトークンの問題ではなく
 * payload 不正・サービスアカウント差し替え・Firebase プロジェクトのズレの署名とみなし、
 * `strictDelete` 時の削除も含めて削除件数を 0 に落として loud フラグを立てる。
 */
export function decideTokenRemovals(input: DecideTokenRemovalsInput): DecideTokenRemovalsResult {
  const { records, outcomes, nowIso, strictDelete = false, allowRemoval = true } = input;

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

  // Pass 1: 個々のトークンについて keep / remove を仮決定する
  type Decision =
    | { kind: 'keep'; record: FcmTokenRecord }
    | { kind: 'remove'; token: string; reason: FcmErrorClass; code?: string; fallback: FcmTokenRecord };

  const decisions: Decision[] = records.map((record): Decision => {
    const outcome = outcomeByToken.get(record.token);
    if (!outcome) {
      // 今回送信対象でなかったトークン（ありえないが安全側で保持）
      return { kind: 'keep', record };
    }

    if (outcome.ok) {
      return { kind: 'keep', record: { ...record, lastSuccessAt: nowIso, consecutiveFailures: 0 } };
    }

    const cls = classifyFcmError(outcome.code);
    const failureRecord: FcmTokenRecord = {
      ...record,
      lastFailureAt: nowIso,
      lastErrorCode: outcome.code,
    };

    if (cls === 'unregistered' || cls === 'malformedToken') {
      if (allowRemoval) {
        return {
          kind: 'remove',
          token: record.token,
          reason: cls,
          code: outcome.code,
          fallback: toKeptAfterBlockedRemoval(record, nowIso, outcome.code),
        };
      }
      return { kind: 'keep', record: failureRecord };
    }

    if (cls === 'environment') {
      // 絶対に削除しない。カウントも増やさない（この端末固有の問題ではないため）
      return { kind: 'keep', record: failureRecord };
    }

    if (cls === 'transient') {
      // 削除も失敗カウントもしない（一時障害で閾値を食い潰さない）
      return { kind: 'keep', record: failureRecord };
    }

    // ambiguous または unknown
    if (massFailureGuard) {
      // 全滅ガード発動中は削除せず、カウントも増やさない（loud ログで気づかせる）
      return { kind: 'keep', record: failureRecord };
    }

    if (allowRemoval && cls === 'ambiguous' && strictDelete) {
      // strictDelete（旧挙動の互換キルスイッチ）のときだけ ambiguous を削除候補にする。
      // 既定（strictDelete=false）では連続失敗回数に関わらず一切削除しない。
      return {
        kind: 'remove',
        token: record.token,
        reason: cls,
        code: outcome.code,
        fallback: toKeptAfterBlockedRemoval(record, nowIso, outcome.code),
      };
    }

    const consecutive = (record.consecutiveFailures ?? 0) + 1;
    return { kind: 'keep', record: { ...failureRecord, consecutiveFailures: consecutive } };
  });

  // Pass 2: ゼロ件ガード。仮決定の削除を全部実行すると配信先が 0 件になる場合は、
  // 件数・理由を問わず削除を一切実行しない（端末 1 台のユーザーもここで守られる）。
  const willZeroOutDevices = records.length > 0 && decisions.every((d) => d.kind === 'remove');

  const removals: DecideTokenRemovalsResult['removals'] = [];
  const next: FcmTokenRecord[] = [];

  for (const d of decisions) {
    if (d.kind === 'keep') {
      next.push(d.record);
      continue;
    }
    if (willZeroOutDevices) {
      // 削除をブロックし、失敗情報だけ反映して keep する
      next.push(d.fallback);
      continue;
    }
    removals.push({ token: d.token, reason: d.reason, code: d.code });
  }

  return { next, removals, loud: massFailureGuard || willZeroOutDevices };
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
