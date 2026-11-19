/**
 * Usage（コスト集計）サイクル: サーバー側の純関数（外部 import なし。dist を node:test から直接 import する）。
 * 集計そのものは `@devrelay/shared` の usage-aggregate.ts。
 */

/** キルスイッチ（既定 ON、`'0'` のときだけ無効）。`DEVRELAY_USAGE`。 */
export function isUsageEnabled(raw: string | undefined): boolean {
  return raw !== '0';
}

/** サイネージ API の結果キャッシュ時間（ミリ秒）。 */
export const USAGE_SIGNAGE_CACHE_MS = 60_000;

/** /usage 画面の集計結果キャッシュ時間（ミリ秒）。グループ・案件の変更時は即時に捨てる。 */
export const USAGE_ROWS_CACHE_MS = 60_000;

/**
 * サイネージ token の形式チェック（DB を引く前に弾く）。
 * 発行は `crypto.randomBytes(24).toString('base64url')`（32 文字）。
 */
export function isPlausibleSignageToken(raw: unknown): raw is string {
  return typeof raw === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(raw);
}

/** サイネージのカード内の切り口（`by=user` なら利用者別、それ以外は案件別）。 */
export function parseSignageInnerAxis(raw: unknown): 'case' | 'user' | 'project' {
  if (raw === 'user' || raw === 'project') return raw;
  return 'case';
}

/** 表示用の利用者名（名前 → メールの @ より前 → userId）。メールアドレス全体は出さない。 */
export function usageDisplayName(user: { id: string; name: string | null; email: string | null }): string {
  const name = user.name?.trim();
  if (name) return name;
  const local = user.email?.split('@')[0]?.trim();
  if (local) return local;
  return user.id;
}

/** 未命名スレッドの表示名（先頭の発言 40 文字 + 開始日 MM/DD、JST）。 */
export function usageThreadTitle(title: string | null, firstUserMessage: string | null, startedAt: Date): string {
  const t = title?.trim();
  if (t) return t;
  const d = new Date(startedAt.getTime() + 9 * 60 * 60 * 1000);
  const md = `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
  const head = (firstUserMessage ?? '').replace(/\s+/g, ' ').trim();
  if (!head) return `(無題) ${md}`;
  return `${head.length > 40 ? head.slice(0, 40) + '…' : head} (${md})`;
}

/**
 * Usage 案件必須サイクル: WebUI のチャットで「案件が空のスレッドでは AI プロンプトを送らせない」か
 * （`DEVRELAY_USAGE_CASE_REQUIRED`、既定 OFF。`'1'` のときだけ ON。他環境の挙動を変えないため既定は OFF）。
 */
export function isUsageCaseRequired(raw: string | undefined): boolean {
  return raw === '1';
}
