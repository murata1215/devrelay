/**
 * bot-supervisor（Discord/Telegram の起動監督ループ）の判定ロジック（純粋関数のみ）。
 *
 * import 文ゼロ。discord.js / node-telegram-bot-api / prisma を芋づるでロードしないよう、
 * 副作用のある `bot-supervisor.ts` から意図的に分離している
 * （`services/sites/sites-rules.ts` ↔ `tests/sites-rules.test.mjs` と同じ流儀）。
 * テストは `tests/bot-supervisor-rules.test.mjs` からこのファイルだけを読む。
 */

/** 監督対象の bot 名 */
export type BotName = 'discord' | 'telegram';

/** bot の現在状態。disabled=トークン未設定／connecting=試行中／ready=使用可能／failed=直近の試行が失敗（リトライ待ちまたは fatal で打ち切り） */
export type BotPhase = 'disabled' | 'connecting' | 'ready' | 'failed';

/** `/health` に載せる bot 1 件分の状態 */
export interface BotStatus {
  phase: BotPhase;
  /** 直近の connecting 開始からの試行回数（ready になったら 0 に戻る） */
  attempts: number;
  /** 直近の失敗内容（マスク済み・300 文字以内）。無ければ null */
  lastError: string | null;
  /** 直近の試行開始時刻（ISO 8601）。一度も試行していなければ null */
  lastAttemptAt: string | null;
  /** 最後に ready になった時刻（ISO 8601）。ready でなければ null */
  readySince: string | null;
  /** 次の試行予定時刻（ISO 8601）。リトライ待ちでなければ null */
  nextRetryAt: string | null;
  /** fatal なエラー（無効トークン等）でリトライを打ち切ったか */
  fatal: boolean;
}

/** `nextRetryDelayMs` のオプション（既定値は呼び出し側の env 解決結果を渡す想定） */
export interface RetryDelayOptions {
  /** 初回（attempt=1）の遅延(ms) */
  baseMs?: number;
  /** 遅延の上限(ms) */
  maxMs?: number;
  /** 指数バックオフの倍率 */
  factor?: number;
}

/**
 * 試行回数（1 始まり）から、次の試行までの遅延(ms)を返す純粋関数。
 * `baseMs * factor^(attempt-1)` を `maxMs` でクランプする。
 * `maxMs` を先に用いて `Math.min` するため、attempt が巨大でも `factor ** 巨大数` が
 * Infinity になっても `Math.min(Infinity, maxMs) === maxMs` で問題なく打ち止まる。
 * NaN・負値・0 の attempt は 1 として扱う（必ず有限の正数を返す）。
 */
export function nextRetryDelayMs(attempt: number, options: RetryDelayOptions = {}): number {
  const baseMs = options.baseMs ?? 10_000;
  const maxMs = options.maxMs ?? 300_000;
  const factor = options.factor ?? 2;

  const safeAttempt = Number.isFinite(attempt) && attempt >= 1 ? Math.floor(attempt) : 1;
  const exponential = baseMs * Math.pow(factor, safeAttempt - 1);
  return Math.min(maxMs, exponential);
}

/**
 * 遅延(ms)に 0.8〜1.2 倍のジッターを適用する純粋関数。
 * `Math.random()` を直接呼ばず `rand`（0〜1）を引数化することでテスト可能にしている。
 * 呼び出し側は `applyJitter(ms, Math.random())` として使う。
 */
export function applyJitter(ms: number, rand: number): number {
  const safeRand = Number.isFinite(rand) ? Math.min(1, Math.max(0, rand)) : 0.5;
  return Math.round(ms * (0.8 + 0.4 * safeRand));
}

/**
 * 環境変数の文字列を正の整数としてパースし、範囲外・非数値・未設定なら既定値にフォールバックする。
 */
export function parsePositiveIntEnv(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

/**
 * `DEVRELAY_BOT_SUPERVISOR` キルスイッチの判定。既存の `isSitesHealthEnabled` 等と同じ流儀で
 * 明示的に `'0'` のときだけ無効（未設定・それ以外の値は有効側に倒す）。
 */
export function isBotSupervisorEnabled(raw: string | undefined): boolean {
  return raw !== '0';
}

/**
 * 無制限リトライしても回復しない「fatal」なエラーかどうかを判定する。
 * fatal の場合、無効トークンで Discord/Telegram を無限に叩き続ける事故を避けるため
 * リトライを打ち切る。ネットワーク系の一時的な失敗（タイムアウト・DNS 失敗等）は fatal ではない。
 */
export function isFatalBotError(err: unknown): boolean {
  if (!err) return false;

  // discord.js の DiscordjsError は `.code` に ErrorCodes の文字列を持つ
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') {
    const fatalCodes = ['TokenInvalid', 'DisallowedIntents', 'ShardingRequired'];
    if (fatalCodes.includes(code)) return true;
  }

  // node-telegram-bot-api のエラーはメッセージに "401" / "Unauthorized" を含む
  const message = err instanceof Error ? err.message : String(err);
  if (/\b401\b/.test(message) && /unauthorized/i.test(message)) return true;
  if (/\bTokenInvalid\b/.test(message)) return true;

  return false;
}

/** マスク対象（トークン様文字列）を検出する正規表現。Discord/Telegram のトークン形式の両方をカバー */
const TOKEN_LIKE_PATTERN = /[\w-]{20,}\.[\w-]{6,}\.[\w-]{20,}|\d{6,}:[\w-]{30,}/g;
const REDACT_MAX_LENGTH = 300;

/**
 * エラーメッセージからトークン様文字列をマスクし、長さを制限する。
 * `/health` は認証不要で誰でも叩けるため、エラー内容をそのまま載せない。
 */
export function redactBotError(err: unknown): string {
  let message: string;
  if (err instanceof Error) {
    message = err.message || err.name || 'Unknown error';
  } else if (typeof err === 'string') {
    message = err;
  } else if (err === undefined || err === null) {
    message = 'Unknown error';
  } else {
    try {
      message = String(err);
    } catch {
      message = 'Unknown error';
    }
  }

  const redacted = message.replace(TOKEN_LIKE_PATTERN, '[REDACTED]');
  return redacted.length > REDACT_MAX_LENGTH
    ? `${redacted.substring(0, REDACT_MAX_LENGTH)}...`
    : redacted;
}

/**
 * 各 bot の `BotStatus` から `/health` レスポンスの `bots` フィールドを組み立てる。
 * HTTP ステータスを左右する情報は含まない（常に 200 を返す前提）。
 */
export function buildBotsHealthPayload(statuses: Record<BotName, BotStatus>): Record<BotName, BotStatus> {
  return {
    discord: { ...statuses.discord },
    telegram: { ...statuses.telegram },
  };
}
