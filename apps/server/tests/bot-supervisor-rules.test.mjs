// 2026-10-18 起動ハング障害対策A: services/bot-supervisor-rules.ts の純粋関数の単体テスト。
// 監督ループの副作用（discord.js / node-telegram-bot-api への接続）そのものはここではテストしない
// （proxy-dispatcher.test.mjs と同じ流儀で、判定ロジックだけを純粋関数として切り出してテストする）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextRetryDelayMs,
  applyJitter,
  parsePositiveIntEnv,
  isBotSupervisorEnabled,
  isFatalBotError,
  redactBotError,
  buildBotsHealthPayload,
} from '../dist/services/bot-supervisor-rules.js';

// ---------------------------------------------------------------------------
// nextRetryDelayMs
// ---------------------------------------------------------------------------

test('nextRetryDelayMs: 指数バックオフで増加する', () => {
  assert.equal(nextRetryDelayMs(1), 10_000);
  assert.equal(nextRetryDelayMs(2), 20_000);
  assert.equal(nextRetryDelayMs(3), 40_000);
  assert.equal(nextRetryDelayMs(5), 160_000);
});

test('nextRetryDelayMs: 上限(300秒)でクランプされる', () => {
  assert.equal(nextRetryDelayMs(6), 300_000);
  assert.equal(nextRetryDelayMs(100), 300_000); // 2**99 が Infinity になっても Math.min で正しく打ち止まる
});

test('nextRetryDelayMs: attempt が 0 / 負値 / NaN でも base 以上 max 以下の有限値を返す', () => {
  for (const attempt of [0, -1, -100, NaN]) {
    const delay = nextRetryDelayMs(attempt);
    assert.ok(Number.isFinite(delay));
    assert.ok(delay >= 10_000);
    assert.ok(delay <= 300_000);
  }
});

test('nextRetryDelayMs: options でベース/上限/倍率を調整できる', () => {
  assert.equal(nextRetryDelayMs(1, { baseMs: 1000, maxMs: 5000, factor: 2 }), 1000);
  assert.equal(nextRetryDelayMs(3, { baseMs: 1000, maxMs: 5000, factor: 2 }), 4000);
  assert.equal(nextRetryDelayMs(10, { baseMs: 1000, maxMs: 5000, factor: 2 }), 5000);
});

// ---------------------------------------------------------------------------
// applyJitter
// ---------------------------------------------------------------------------

test('applyJitter: rand=0 で 0.8 倍', () => {
  assert.equal(applyJitter(1000, 0), 800);
});

test('applyJitter: rand=1 で 1.2 倍', () => {
  assert.equal(applyJitter(1000, 1), 1200);
});

test('applyJitter: rand=0.5 で 1.0 倍', () => {
  assert.equal(applyJitter(1000, 0.5), 1000);
});

test('applyJitter: 常に整数かつ [0.8x, 1.2x] の範囲内', () => {
  for (const rand of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
    const result = applyJitter(10_000, rand);
    assert.ok(Number.isInteger(result));
    assert.ok(result >= 8000);
    assert.ok(result <= 12000);
  }
});

test('applyJitter: rand が範囲外・非数でも安全にフォールバックする', () => {
  assert.ok(Number.isFinite(applyJitter(1000, -1)));
  assert.ok(Number.isFinite(applyJitter(1000, 2)));
  assert.ok(Number.isFinite(applyJitter(1000, NaN)));
});

// ---------------------------------------------------------------------------
// parsePositiveIntEnv
// ---------------------------------------------------------------------------

test('parsePositiveIntEnv: 未設定は既定値', () => {
  assert.equal(parsePositiveIntEnv(undefined, 30_000, 5_000, 300_000), 30_000);
  assert.equal(parsePositiveIntEnv('', 30_000, 5_000, 300_000), 30_000);
});

test('parsePositiveIntEnv: 0 / 負値 / 非数値は既定値', () => {
  assert.equal(parsePositiveIntEnv('0', 30_000, 5_000, 300_000), 30_000);
  assert.equal(parsePositiveIntEnv('-100', 30_000, 5_000, 300_000), 30_000);
  assert.equal(parsePositiveIntEnv('abc', 30_000, 5_000, 300_000), 30_000);
});

test('parsePositiveIntEnv: 範囲外の値は clamp される', () => {
  assert.equal(parsePositiveIntEnv('1', 30_000, 5_000, 300_000), 5_000);
  assert.equal(parsePositiveIntEnv('999999', 30_000, 5_000, 300_000), 300_000);
});

test('parsePositiveIntEnv: 範囲内の正常値は採用される', () => {
  assert.equal(parsePositiveIntEnv('60000', 30_000, 5_000, 300_000), 60_000);
});

// ---------------------------------------------------------------------------
// isBotSupervisorEnabled
// ---------------------------------------------------------------------------

test('isBotSupervisorEnabled: 既定は有効', () => {
  assert.equal(isBotSupervisorEnabled(undefined), true);
  assert.equal(isBotSupervisorEnabled('1'), true);
  assert.equal(isBotSupervisorEnabled('false'), true); // '0' 以外は有効側に倒す既存の流儀
});

test('isBotSupervisorEnabled: "0" のときだけ無効', () => {
  assert.equal(isBotSupervisorEnabled('0'), false);
});

// ---------------------------------------------------------------------------
// isFatalBotError
// ---------------------------------------------------------------------------

test('isFatalBotError: discord.js の fatal error code を検出する', () => {
  assert.equal(isFatalBotError({ code: 'TokenInvalid', message: 'Invalid token' }), true);
  assert.equal(isFatalBotError({ code: 'DisallowedIntents', message: 'intents' }), true);
  assert.equal(isFatalBotError({ code: 'ShardingRequired', message: 'sharding' }), true);
});

test('isFatalBotError: telegram の 401 Unauthorized を検出する', () => {
  assert.equal(isFatalBotError(new Error('ETELEGRAM: 401 Unauthorized')), true);
});

test('isFatalBotError: ネットワーク系の一時的エラーは fatal ではない', () => {
  assert.equal(isFatalBotError(new Error('ENOTFOUND discord.com')), false);
  assert.equal(isFatalBotError(new Error('ETIMEDOUT')), false);
  assert.equal(isFatalBotError(new Error('Timed out after 30000ms')), false);
  assert.equal(isFatalBotError({ code: 'ECONNREFUSED', message: 'refused' }), false);
});

test('isFatalBotError: null/undefined は false', () => {
  assert.equal(isFatalBotError(null), false);
  assert.equal(isFatalBotError(undefined), false);
});

// ---------------------------------------------------------------------------
// redactBotError
// ---------------------------------------------------------------------------

test('redactBotError: トークン様文字列がマスクされる', () => {
  // 実際のトークンに似せすぎると GitHub の secret scanning に誤検知されるため、
  // 正規表現の長さ条件だけを満たす無意味な文字列（base64 デコードしても意味を持たない）を使う
  const discordLike = redactBotError(new Error('failed with token zzzzzzzzzzzzzzzzzzzzzzzz.yyyyyy.xxxxxxxxxxxxxxxxxxxxxxxxxxx'));
  assert.ok(!discordLike.includes('zzzzzzzzzzzzzzzzzzzzzzzz'));
  assert.ok(discordLike.includes('[REDACTED]'));

  const telegramLike = redactBotError(new Error('bot123456789:zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz unauthorized'));
  assert.ok(!telegramLike.includes('zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'));
});

test('redactBotError: 長文は 300 文字程度で切り詰められる', () => {
  const longMessage = 'x'.repeat(1000);
  const result = redactBotError(new Error(longMessage));
  assert.ok(result.length <= 310);
  assert.ok(result.endsWith('...'));
});

test('redactBotError: 非 Error（string/undefined/null）でも落ちない', () => {
  assert.equal(typeof redactBotError('plain string error'), 'string');
  assert.equal(typeof redactBotError(undefined), 'string');
  assert.equal(typeof redactBotError(null), 'string');
  assert.equal(typeof redactBotError(12345), 'string');
});

// ---------------------------------------------------------------------------
// buildBotsHealthPayload
// ---------------------------------------------------------------------------

function emptyStatus(phase) {
  return {
    phase,
    attempts: 0,
    lastError: null,
    lastAttemptAt: null,
    readySince: null,
    nextRetryAt: null,
    fatal: false,
  };
}

test('buildBotsHealthPayload: discord/telegram の両キーが期待通りに出る', () => {
  const payload = buildBotsHealthPayload({
    discord: emptyStatus('ready'),
    telegram: emptyStatus('disabled'),
  });
  assert.equal(payload.discord.phase, 'ready');
  assert.equal(payload.telegram.phase, 'disabled');
});

test('buildBotsHealthPayload: ready は lastError/nextRetryAt が null', () => {
  const payload = buildBotsHealthPayload({
    discord: { ...emptyStatus('ready'), readySince: '2026-10-18T00:00:00.000Z' },
    telegram: emptyStatus('disabled'),
  });
  assert.equal(payload.discord.lastError, null);
  assert.equal(payload.discord.nextRetryAt, null);
});

test('buildBotsHealthPayload: disabled は attempts=0', () => {
  const payload = buildBotsHealthPayload({
    discord: emptyStatus('disabled'),
    telegram: emptyStatus('disabled'),
  });
  assert.equal(payload.discord.attempts, 0);
  assert.equal(payload.telegram.attempts, 0);
});

test('buildBotsHealthPayload: 入力のコピーを返す（参照を変更しても影響しない）', () => {
  const input = {
    discord: emptyStatus('ready'),
    telegram: emptyStatus('disabled'),
  };
  const payload = buildBotsHealthPayload(input);
  payload.discord.phase = 'failed';
  assert.equal(input.discord.phase, 'ready');
});
