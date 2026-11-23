/**
 * AI 回答契約サイクル（2026-11-23 改訂）: AI 応答の詳細ページ（公開共有リンク）に関する
 * 純関数モジュール。外部 import ゼロ（`content-truncate.ts` / `usage-rules.ts` と同じ流儀）。
 *
 * 背景: AI 応答を「人間向け本文」と「詳細」に分ける契約（`response-split-rules.ts`）を導入し、
 * 詳細部分は WebUI・Discord・Telegram 共通でログイン不要の公開リンクに置く
 * （プラットフォームでの出し分けはしない。詳細があるかどうかだけで決まる）。
 * DB には `shareToken`（unique・ランダム 32 文字）/ `shareExpiresAt` のみ持たせ、
 * `Message.content` 本体は従来どおり全文保存する（会話履歴・ナレッジ・コスト集計を保つため）。
 *
 * キルスイッチ `DEVRELAY_RESPONSE_SHARE` は既定 **OFF**（他の多数のキルスイッチと逆方向）。
 * 公開リンクは新しい信頼境界（`DEVRELAY_CROSS_TEAM` 等と同じ判断）のため、黙って開けない。
 * OFF の間は詳細を隠さずそのまま本文に含めて返す（`response-split.ts` 参照。情報を落とさない）。
 */

/** キルスイッチ（既定 OFF）。`'1'` のときだけ有効。 */
export function isResponseShareEnabled(raw: string | undefined): boolean {
  return raw === '1';
}

/** 共有トークンの既定保存期間（日）。ユーザー設定・`DEVRELAY_SHARE_TTL_DAYS` のどちらも未設定/不正値のときに使う。 */
export const DEFAULT_SHARE_TTL_DAYS = 30;
/** TTL のクランプ範囲。 */
export const MIN_SHARE_TTL_DAYS = 1;
export const MAX_SHARE_TTL_DAYS = 365;

/** TTL（日数）を `[MIN_SHARE_TTL_DAYS, MAX_SHARE_TTL_DAYS]` にクランプする。NaN・0・負数は既定値。 */
export function clampShareTtlDays(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_SHARE_TTL_DAYS;
  return Math.min(MAX_SHARE_TTL_DAYS, Math.max(MIN_SHARE_TTL_DAYS, Math.round(raw)));
}

/**
 * 有効な TTL（日数）を決定する。優先順位: 本人の個人設定 → 組織既定（`DEVRELAY_SHARE_TTL_DAYS`、
 * devrelay.io は `3` を設定）→ 既定値 30。どちらも未設定・不正値（数値でない・0以下）なら
 * 次の優先順位にフォールバックする。
 */
export function resolveShareTtlDays(envRaw: string | undefined, userRaw: string | null | undefined): number {
  const userNum = userRaw ? Number.parseInt(userRaw, 10) : NaN;
  if (Number.isFinite(userNum) && userNum > 0) return clampShareTtlDays(userNum);
  const envNum = envRaw ? Number.parseInt(envRaw, 10) : NaN;
  if (Number.isFinite(envNum) && envNum > 0) return clampShareTtlDays(envNum);
  return DEFAULT_SHARE_TTL_DAYS;
}

/** 共有トークンの形式チェック（DB を引く前に弾く。Usage サイネージの `isPlausibleSignageToken` と同じ形式）。 */
export function isPlausibleShareToken(raw: unknown): raw is string {
  return typeof raw === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(raw);
}

/** 期限切れかどうかを判定する（`expiresAt` が無い = 未発行 = 期限切れ扱い）。 */
export function isShareExpired(expiresAt: Date | null | undefined, now: Date = new Date()): boolean {
  if (!expiresAt) return true;
  return expiresAt.getTime() <= now.getTime();
}

/**
 * 案内行の「N日間有効」表示用に、現在時刻から `expiresAt` までの残り日数を切り上げで返す。
 * 期限切れ・未発行（null）なら 0（呼び出し側は `isShareExpired()` で先に弾く前提）。
 */
export function daysRemaining(expiresAt: Date | null | undefined, now: Date = new Date()): number {
  if (!expiresAt) return 0;
  const ms = expiresAt.getTime() - now.getTime();
  if (ms <= 0) return 0;
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}

/**
 * 詳細ページへの案内行を組み立てる。
 *
 * - `discord`: 素の URL を貼ると埋め込みカードが出てしまうため `<url>` で抑制する
 *   （`platforms/discord.ts` の既存の長文注意文と同じ作法）
 * - `telegram`: 無装飾のまま貼る
 * - `markdown`: `[text](url)` 形式。WebUI・Lite・REST 履歴 API など、本文そのものに
 *   リンクを埋め込みたい経路で使う（2026-11-23: 当初 WebUI だけ `shareUrl` を別フィールドで
 *   渡す設計だったが、モバイルアプリ等そのフィールドを知らないクライアントではリンクが
 *   消えてしまう事故が実機で発覚したため、本文に直接埋め込む方式に統一した）
 */
export function buildShareSuffix(platform: 'discord' | 'telegram' | 'markdown', url: string, ttlDays: number): string {
  if (platform === 'discord') return `\n\n📄 詳細（${ttlDays}日間有効）: <${url}>`;
  if (platform === 'markdown') return `\n\n📄 [詳細を見る（${ttlDays}日間有効）](${url})`;
  return `\n\n📄 詳細（${ttlDays}日間有効）: ${url}`;
}

/**
 * 共有リンクの公開ベース URL を決定する。`PUBLIC_URL`（`agent-token-url.ts`/`mcp/oauth.ts` と
 * 同じ既存の規約）が設定されていれば末尾スラッシュ・サブパスを含めてそのまま使う。
 * 壊れた URL ならフォールバックする。未設定時は `oauth.ts` と同じ既定ドメインを使う
 * （本機能は既定 OFF のため、他環境がこのドメインを誤って露出することはない）。
 */
export function resolveShareBaseUrl(env: Record<string, string | undefined> = {}): string {
  const raw = env.PUBLIC_URL?.trim();
  if (raw) {
    try {
      const url = new URL(raw);
      return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
    } catch {
      // 壊れた URL は既定ドメインにフォールバック
    }
  }
  return 'https://app.devrelay.io';
}

/** 共有リンクの完全な URL（`<base>/s/<token>`）を組み立てる。 */
export function buildShareUrl(token: string, env: Record<string, string | undefined> = {}): string {
  return `${resolveShareBaseUrl(env)}/s/${token}`;
}
