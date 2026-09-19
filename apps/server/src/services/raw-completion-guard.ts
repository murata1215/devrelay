/**
 * raw-completion（ゲーム席用の素の completion API、`POST /api/agent/raw-completion`）の
 * 流量制御・同時実行制御の「入口の防御」。
 *
 * `doc/analysis/ask_raw_mode_investigation.md` §11 で判定されたとおり、既存の ask/teamexec とは
 * 流量特性が根本的に異なる（ゲームはピーク 15 回/5分・150 コール/試合 vs ask の 8 回/5分・同時 1 件）。
 * このため `document-api.ts` の `CROSS_RATE_WINDOW_MS` 系の定数・カウント関数
 * （`countRecentCrossSessions` 等）とは完全に分離し、`crossquery_`/`teamexec_` の集計に一切影響しない。
 *
 * 同時実行の単位は「プロジェクト」ではなく「座席（seatKey）」。1 プロジェクトに複数の AI 席が
 * 同時に叩いても構わない（ボードゲームの複数プレイヤー席が同一プロジェクトの盤面 API を叩く想定）。
 *
 * 外部 import ゼロの純関数のみで構成する（#332 `permission-policy.ts` / #348 `cross-query-guard.ts` と
 * 同じ流儀）。`packages/shared` ではなく `apps/server` に置くのは同じ理由（#310 白画面事故の回避、
 * サーバー専用ロジックを web バンドルに巻き込まない）。
 *
 * 状態（`RawGuardState`）は呼び出し側（`raw-completion-api.ts`）がモジュールスコープの
 * シングルトンとして 1 個保持し、本ファイルの関数へ毎回渡す（`state` を内部に隠し持たない）。
 * これによりテストがプロセス全体の状態に影響されず、フレッシュな `state` で決定的に書ける。
 *
 * D3（実装プラン参照）: 同時実行 1 は相互排他プリミティブであり統計値ではないため、
 * DB の `count()`→`create()`（TOCTOU）ではなくメモリ上の Map の test-and-set で判定する。
 * `seatKey` は DB カラムに存在せず、追加すると人手の `ALTER` 手順が必要になるため意図的に DB へ出さない
 * （`Session`/`Message` 行自体は `raw-completion-api.ts` が別途 Prisma で書く。本ファイルの対象外）。
 */

/** raw-completion セッションの sessionId プレフィックス */
export const RAW_SESSION_ID_PREFIX = 'raw_';

/** レート制限のスライディング窓（5 分） */
export const RAW_RATE_WINDOW_MS = 5 * 60 * 1000;

/** 座席（seatKey）あたりのレート上限（窓あたり） */
export const RAW_SEAT_RATE_LIMIT = 60;

/** ユーザー全体のレート上限（窓あたり・座席を変えて回り続けるケースの backstop） */
export const RAW_USER_RATE_LIMIT = 240;

/** 座席あたりの同時実行上限（固定 1。将来の拡張点として定数化） */
export const RAW_SEAT_CONCURRENCY = 1;

/** timeoutS リクエストパラメータの許容範囲（秒） */
export const RAW_TIMEOUT_MIN_S = 5;
export const RAW_TIMEOUT_MAX_S = 180;
/** timeoutS 未指定時の既定値（秒） */
export const RAW_TIMEOUT_DEFAULT_S = 60;

/**
 * 占有スロットを強制解放するまでの経過時間（ミリ秒）。
 * `RAW_TIMEOUT_MAX_S`（180秒）+ 30秒の余裕。プロセスクラッシュや `finally` を経由しない異常終了で
 * スロットが解放されないまま残った場合でも、次回リクエストで自動的に stale reap されることを保証する
 * （これが無いと 1 回のクラッシュで座席が `pm2 restart` まで恒久的に "busy" のまま固まる）。
 */
export const RAW_SLOT_STALE_MS = (RAW_TIMEOUT_MAX_S + 30) * 1000;

/** system / user プロンプトの最大文字数（クライアントの誤送信・DoS 的な巨大入力の防御） */
export const RAW_MAX_SYSTEM_CHARS = 20000;
export const RAW_MAX_USER_CHARS = 20000;

/** seatKey として許容する文字種（英数字・アンダースコア・ハイフン・ドット・コロン） */
const SEAT_KEY_PATTERN = /^[A-Za-z0-9_.:-]+$/;
/** seatKey の最大長 */
const SEAT_KEY_MAX_LEN = 100;

/**
 * raw-completion の流量制御・同時実行制御の状態。
 * `slots`: 占有中の座席（`seatSlotKey` → 占有情報）。
 * `seatHits` / `userHits`: レート制限用の直近リクエスト時刻（ミリ秒）の配列。
 */
export interface RawGuardState {
  slots: Map<string, { sessionId: string; startedAt: number }>;
  seatHits: Map<string, number[]>;
  userHits: Map<string, number[]>;
}

/** 空の `RawGuardState` を作る（呼び出し側がモジュールスコープで 1 個だけ保持する） */
export function createRawGuardState(): RawGuardState {
  return { slots: new Map(), seatHits: new Map(), userHits: new Map() };
}

/**
 * seatKey を検証・正規化する。
 *
 * @param raw リクエストの `seatKey`（未指定・null は不正として扱う）
 * @returns 正規化された seatKey。不正な場合は null
 */
export function normalizeSeatKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > SEAT_KEY_MAX_LEN) return null;
  if (!SEAT_KEY_PATTERN.test(trimmed)) return null;
  return trimmed;
}

/**
 * 座席スロットの Map キーを組み立てる。
 *
 * `userId` で名前空間化する（D3）: 他テナントが座席名を推測して枠を占有できないようにするため。
 * `seatKey` は DB カラムに存在しないユーザー自己申告の識別子であり、テナントを跨いで一意である保証が
 * 無いため、必ず `userId` と組み合わせて使う。
 *
 * @param userId 発信元ユーザー ID
 * @param seatKey 正規化済み seatKey（`normalizeSeatKey` を通した値を渡すこと）
 */
export function seatSlotKey(userId: string, seatKey: string): string {
  return `${userId}:${seatKey}`;
}

/**
 * リクエストの `timeoutS` を許容範囲にクランプし、ミリ秒へ変換する。
 * 未指定・非数値・NaN は既定値（`RAW_TIMEOUT_DEFAULT_S`）にフォールバックする。
 *
 * @param timeoutS リクエストの timeoutS（秒）
 */
export function resolveRawTimeoutMs(timeoutS: number | null | undefined): number {
  const n = typeof timeoutS === 'number' && Number.isFinite(timeoutS) ? timeoutS : RAW_TIMEOUT_DEFAULT_S;
  const clampedS = Math.min(Math.max(n, RAW_TIMEOUT_MIN_S), RAW_TIMEOUT_MAX_S);
  return clampedS * 1000;
}

/**
 * raw-completion 用の sessionId を組み立てる。
 *
 * @param uuid 呼び出し側が生成した UUID（本ファイルは `crypto` を import しないため、
 *   呼び出し側で `crypto.randomUUID()` を実行して渡すこと）
 */
export function buildRawSessionId(uuid: string): string {
  return `${RAW_SESSION_ID_PREFIX}${uuid}`;
}

/**
 * stale になった占有スロットと、窓外に出たレート集計エントリを掃除する。
 * `acquireRawSlot` の内部で毎回呼び出されるため、通常は個別に呼ぶ必要はない
 * （テストで単体挙動を確認する目的、およびリーパーとして定期実行する目的の両方で export する）。
 *
 * @param state 対象の状態（破壊的に変更する）
 * @param nowMs 現在時刻（ミリ秒、テスト容易性のため注入）
 */
export function pruneRawGuardState(state: RawGuardState, nowMs: number): void {
  for (const [key, occupant] of state.slots) {
    if (nowMs - occupant.startedAt > RAW_SLOT_STALE_MS) {
      state.slots.delete(key);
    }
  }

  const cutoff = nowMs - RAW_RATE_WINDOW_MS;
  for (const [key, hits] of state.seatHits) {
    const kept = hits.filter((t) => t >= cutoff);
    if (kept.length > 0) {
      state.seatHits.set(key, kept);
    } else {
      state.seatHits.delete(key);
    }
  }
  for (const [key, hits] of state.userHits) {
    const kept = hits.filter((t) => t >= cutoff);
    if (kept.length > 0) {
      state.userHits.set(key, kept);
    } else {
      state.userHits.delete(key);
    }
  }
}

export type AcquireRawSlotDecision =
  | { ok: true }
  | { ok: false; status: 429; reason: 'targetBusy' }
  | { ok: false; status: 429; reason: 'seatRateLimited' }
  | { ok: false; status: 429; reason: 'userRateLimited' };

/**
 * 座席スロットの取得を試みる。
 *
 * 判定順（この順序を変えないこと。テストで固定している）:
 * 1. stale reap（`pruneRawGuardState`） — 古い占有・レート記録を先に掃除する
 * 2. busy（`targetBusy` → 429） — 同一座席が既に占有中なら拒否（同時実行 1 の強制）
 * 3. seat rate（`seatRateLimited` → 429） — 座席単位の窓内リクエスト数が上限を超えていれば拒否
 * 4. user rate（`userRateLimited` → 429） — ユーザー全体の窓内リクエスト数が上限を超えていれば拒否
 * 5. それ以外は取得成功（スロットを占有し、レート記録に今回の時刻を追加する）
 *
 * @param state 対象の状態（成功時は破壊的に変更する）
 * @param input userId / seatKey（正規化済み）/ sessionId（このリクエストの raw sessionId）/ nowMs
 */
export function acquireRawSlot(
  state: RawGuardState,
  input: { userId: string; seatKey: string; sessionId: string; nowMs: number },
): AcquireRawSlotDecision {
  const { userId, seatKey, sessionId, nowMs } = input;
  pruneRawGuardState(state, nowMs);

  const slotKey = seatSlotKey(userId, seatKey);
  if (state.slots.has(slotKey)) {
    return { ok: false, status: 429, reason: 'targetBusy' };
  }

  const seatHits = state.seatHits.get(slotKey) ?? [];
  if (seatHits.length >= RAW_SEAT_RATE_LIMIT) {
    return { ok: false, status: 429, reason: 'seatRateLimited' };
  }

  const userHits = state.userHits.get(userId) ?? [];
  if (userHits.length >= RAW_USER_RATE_LIMIT) {
    return { ok: false, status: 429, reason: 'userRateLimited' };
  }

  state.slots.set(slotKey, { sessionId, startedAt: nowMs });
  state.seatHits.set(slotKey, [...seatHits, nowMs]);
  state.userHits.set(userId, [...userHits, nowMs]);
  return { ok: true };
}

/**
 * 座席スロットを解放する。`finally` と `request.raw.on('close')` の両方から呼び出すこと
 * （どちらか一方だけだとクライアント切断や例外経路で座席が固まる、実装プラン D3 参照）。
 * 対応するスロットが既に無い（未取得・二重解放・stale reap 済み）場合は無視する。
 *
 * @param state 対象の状態（破壊的に変更する）
 * @param userId 発信元ユーザー ID
 * @param seatKey 正規化済み seatKey
 */
export function releaseRawSlot(state: RawGuardState, userId: string, seatKey: string): void {
  state.slots.delete(seatSlotKey(userId, seatKey));
}
