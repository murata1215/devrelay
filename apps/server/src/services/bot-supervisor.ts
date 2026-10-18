/**
 * Discord / Telegram bot の起動監督ループ。
 *
 * 背景（2026-10-18 起動ハング障害）: `index.ts` の `main()` が `setupDiscordBot()` /
 * `setupTelegramBot()` を `app.listen()` より前で await していたため、外部ネットワークに
 * 繋がらない間サーバー全体（Web UI・Agent WebSocket・API）が起動できなかった。
 * `doc/server_listen_hang_20261018.md` 参照。
 *
 * 対策: bot の起動は `app.listen()` 成功後に `startBotSupervisors()` で開始し、
 * 1 試行ごとにタイムアウトを付けて、失敗時は間隔を伸ばしながら無制限にリトライする。
 * サーバー本体の起動は bot の状態に左右されない。
 *
 * 設計のポイント（世代カウンタ）: `withTimeout()` は下層の `connect()` をキャンセルしない
 * ため、タイムアウト後に遅れて解決した旧試行が新しい状態を書き換えうる。この対策は
 * `platforms/discord.ts` / `platforms/telegram.ts` 側の世代カウンタに任せている
 * （`generation` が一致しない限りモジュール変数へ代入しない）。supervisor 側は
 * 「`connect()` の解決＝使用可能」という契約だけを信じればよく、逆方向の状態書き戻しは
 * 発生しない。
 */

import { prisma } from '../db/client.js';
import { decrypt } from './user-settings.js';
import { createDiscordBotAttempt } from '../platforms/discord.js';
import { createTelegramBotAttempt } from '../platforms/telegram.js';
import {
  type BotName,
  type BotStatus,
  nextRetryDelayMs,
  applyJitter,
  parsePositiveIntEnv,
  isBotSupervisorEnabled,
  isFatalBotError,
  redactBotError,
  buildBotsHealthPayload,
} from './bot-supervisor-rules.js';

/** 1 回の接続試行を表す。`connect()` の解決＝使用可能（discord: ClientReady、telegram: startPolling 完了）。 */
export interface BotAttempt {
  connect(): Promise<void>;
  dispose(): Promise<void>;
}

const LOGIN_TIMEOUT_MS = parsePositiveIntEnv(process.env.DEVRELAY_BOT_LOGIN_TIMEOUT_MS, 30_000, 5_000, 300_000);
const RETRY_MAX_MS = parsePositiveIntEnv(process.env.DEVRELAY_BOT_RETRY_MAX_MS, 300_000, 10_000, 3_600_000);
const RETRY_BASE_MS = 10_000;

/** 現在のログ抑制状態（上限間隔に達して以降は 10 回に 1 回だけログを出す） */
const FAILURE_LOG_INTERVAL_AFTER_CAP = 10;

function emptyStatus(): BotStatus {
  return {
    phase: 'disabled',
    attempts: 0,
    lastError: null,
    lastAttemptAt: null,
    readySince: null,
    nextRetryAt: null,
    fatal: false,
  };
}

const statuses: Record<BotName, BotStatus> = {
  discord: emptyStatus(),
  telegram: emptyStatus(),
};

/** 監督ループごとの停止フラグ（shutdown 用） */
const stopFlags: Record<BotName, boolean> = {
  discord: false,
  telegram: false,
};

/** 監督ループごとの現在の attempt（stop 時に dispose するため保持） */
const currentAttempts: Record<BotName, BotAttempt | null> = {
  discord: null,
  telegram: null,
};

/** 監督ループごとの保留中タイマー（stop 時にクリアするため保持） */
const pendingTimers: Record<BotName, NodeJS.Timeout | null> = {
  discord: null,
  telegram: null,
};

let started = false;

/**
 * UserSettings からトークンを取得する（UserSettings > 環境変数 の優先順）。
 * index.ts:193-208 から移設。DB 未起動等で throw した場合は呼び出し側でリトライ対象とする。
 */
async function getBotTokenFromSettings(key: string): Promise<string | null> {
  const setting = await prisma.userSettings.findFirst({ where: { key } });
  if (!setting) return null;

  if (setting.encrypted) {
    try {
      return decrypt(setting.value);
    } catch {
      console.error(`Failed to decrypt ${key}`);
      return null;
    }
  }
  return setting.value;
}

/**
 * Discord/Telegram トークンを解決する。throw した場合（DB 未起動等）は呼び出し側で
 * リトライ対象として扱う。トークンが無ければ null を返す（disabled として扱う）。
 */
async function resolveDiscordToken(): Promise<string | null> {
  const fromSettings = await getBotTokenFromSettings('discord_bot_token');
  if (fromSettings) {
    console.log('📝 Using Discord bot token from user settings');
    return fromSettings;
  }
  return process.env.DISCORD_BOT_TOKEN || null;
}

async function resolveTelegramToken(): Promise<string | null> {
  const fromSettings = await getBotTokenFromSettings('telegram_bot_token');
  if (fromSettings) {
    console.log('📝 Using Telegram bot token from user settings');
    return fromSettings;
  }
  return process.env.TELEGRAM_BOT_TOKEN || null;
}

/** `promise` が `ms` 以内に解決しなければ reject する。タイマーは finally で必ず clear + unref。 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out after ${ms}ms`));
    }, ms);
    timer.unref();

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

/**
 * 1 つの bot（discord/telegram）の監督ループ本体。
 * resolveToken() が throw → リトライ対象（DB 未起動等）。null を返す → disabled で終了（未設定）。
 * `DEVRELAY_BOT_SUPERVISOR=0` のときは 1 回だけ試行して諦める（listen 優先・非 await は維持）。
 */
async function supervise(
  name: BotName,
  resolveToken: () => Promise<string | null>,
  createAttempt: (token: string) => BotAttempt
): Promise<void> {
  const supervisorEnabled = isBotSupervisorEnabled(process.env.DEVRELAY_BOT_SUPERVISOR);
  let attemptCount = 0;

  while (!stopFlags[name]) {
    let token: string | null;
    try {
      token = await resolveToken();
    } catch (err) {
      // トークン解決自体の失敗（DB 未起動等）。bot 未設定ではないのでリトライ対象。
      attemptCount++;
      statuses[name] = {
        ...statuses[name],
        phase: 'connecting',
        attempts: attemptCount,
        lastError: redactBotError(err),
        lastAttemptAt: new Date().toISOString(),
      };
      console.error(`⚠️  [bot-supervisor:${name}] トークン取得に失敗（リトライします）:`, err);
      if (!(await waitForRetry(name, attemptCount, supervisorEnabled))) return;
      continue;
    }

    if (!token) {
      statuses[name] = { ...emptyStatus(), phase: 'disabled' };
      console.log(`⚠️  ${name === 'discord' ? 'DISCORD_BOT_TOKEN' : 'TELEGRAM_BOT_TOKEN'} not set, ${name} bot disabled`);
      return;
    }

    attemptCount++;
    statuses[name] = {
      ...statuses[name],
      phase: 'connecting',
      attempts: attemptCount,
      lastAttemptAt: new Date().toISOString(),
      fatal: false,
    };

    const attempt = createAttempt(token);
    currentAttempts[name] = attempt;

    try {
      await withTimeout(attempt.connect(), LOGIN_TIMEOUT_MS);

      if (stopFlags[name]) {
        // 接続完了直後に stop が呼ばれていた場合は使わずに破棄する
        await safeDispose(attempt);
        currentAttempts[name] = null;
        return;
      }

      statuses[name] = {
        phase: 'ready',
        attempts: 0,
        lastError: null,
        lastAttemptAt: statuses[name].lastAttemptAt,
        readySince: new Date().toISOString(),
        nextRetryAt: null,
        fatal: false,
      };
      console.log(`✅ ${name === 'discord' ? 'Discord' : 'Telegram'} bot ready`);
      return; // ready になったら監督ループは終了（以降は discord.js / node-telegram-bot-api 自身の自動再接続に任せる）
    } catch (err) {
      await safeDispose(attempt);
      currentAttempts[name] = null;

      const fatal = isFatalBotError(err);
      statuses[name] = {
        ...statuses[name],
        phase: 'failed',
        lastError: redactBotError(err),
        fatal,
      };

      if (fatal) {
        console.error(`❌ [bot-supervisor:${name}] 致命的なエラーのためリトライを停止します:`, redactBotError(err));
        console.error(`💡 トークンを確認し、設定を直してから再起動してください。`);
        return;
      }

      logFailure(name, attemptCount, err);
      if (!(await waitForRetry(name, attemptCount, supervisorEnabled))) return;
    }
  }
}

async function safeDispose(attempt: BotAttempt): Promise<void> {
  try {
    await attempt.dispose();
  } catch (err) {
    console.error('⚠️  bot attempt dispose failed (ignored):', err);
  }
}

function logFailure(name: BotName, attemptCount: number, err: unknown): void {
  const delayMs = nextRetryDelayMs(attemptCount, { baseMs: RETRY_BASE_MS, maxMs: RETRY_MAX_MS });
  const atCap = delayMs >= RETRY_MAX_MS;
  // 間隔が上限に達するまでは毎回ログ。達して以降は 10 回に 1 回だけ（ログ膨張対策）
  if (!atCap || attemptCount % FAILURE_LOG_INTERVAL_AFTER_CAP === 0) {
    console.error(`⚠️  [bot-supervisor:${name}] 接続失敗（${attemptCount}回目）:`, redactBotError(err));
  }
}

/**
 * 次の試行までバックオフ待機する。stop が呼ばれていたら false を返し、呼び出し側でループを終了させる。
 */
async function waitForRetry(name: BotName, attemptCount: number, supervisorEnabled: boolean): Promise<boolean> {
  if (!supervisorEnabled) {
    // DEVRELAY_BOT_SUPERVISOR=0: 1 回だけ試行して諦める
    console.log(`⏸️  [bot-supervisor:${name}] DEVRELAY_BOT_SUPERVISOR=0 のためリトライを行いません`);
    return false;
  }
  if (stopFlags[name]) return false;

  const baseDelay = nextRetryDelayMs(attemptCount, { baseMs: RETRY_BASE_MS, maxMs: RETRY_MAX_MS });
  const delay = applyJitter(baseDelay, Math.random());
  statuses[name] = { ...statuses[name], nextRetryAt: new Date(Date.now() + delay).toISOString() };

  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delay);
    timer.unref();
    pendingTimers[name] = timer;
  });
  pendingTimers[name] = null;

  return !stopFlags[name];
}

/**
 * bot 監督ループを開始する（await しない fire-and-forget）。
 * `services/sites/health-checker.ts` の `let started` 冪等ガードと同形。
 */
export function startBotSupervisors(): void {
  if (started) return;
  started = true;

  void supervise('discord', resolveDiscordToken, createDiscordBotAttempt);
  void supervise('telegram', resolveTelegramToken, createTelegramBotAttempt);
}

/**
 * shutdown 用: 保留中のリトライタイマーを止め、接続中/接続済みの bot を破棄する。
 * `timeoutMs` 以内に終わらなければ諦めて返す（shutdown 自体が hang しないように）。
 */
export async function stopBotSupervisors(timeoutMs = 3000): Promise<void> {
  (['discord', 'telegram'] as const).forEach((name) => {
    stopFlags[name] = true;
    const timer = pendingTimers[name];
    if (timer) {
      clearTimeout(timer);
      pendingTimers[name] = null;
    }
  });

  const disposals = (['discord', 'telegram'] as const).map(async (name) => {
    const attempt = currentAttempts[name];
    if (attempt) {
      await safeDispose(attempt);
      currentAttempts[name] = null;
    }
  });

  await Promise.race([
    Promise.all(disposals),
    sleep(timeoutMs),
  ]);
}

/** `/health` 用: 現在の bot 状態のスナップショットを返す。 */
export function getBotsHealth(): Record<BotName, BotStatus> {
  return buildBotsHealthPayload(statuses);
}
