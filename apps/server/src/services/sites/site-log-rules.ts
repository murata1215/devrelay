/**
 * DevRelay Sites Phase 1-B — site 固有 access log 設定の「単一の真実」。
 *
 * - 高頻度 polling の除外ルール表（`SITE_LOG_RULES`）と、その Caddy テキスト生成
 * - ログ保持設定（`roll_size` / `roll_keep` / `roll_keep_for`）の定数化
 * - snippet / inline 用の `log { }` ブロックテキスト生成
 * - W3（手編集 3 件・Caddyfile 直書き host）を自動変更対象から除外する判定
 *
 * すべて外部 I/O ゼロの純粋関数・定数のみ（`sites-enable-access-log.ts` がここから
 * テキストを生成し `sudo tee` する。Caddy 設定文字列を手書きしない）。
 * server / UI 双方がこの表を読むため、詳細ドロワーの「除外ルール」チップと
 * Caddy 実設定が構造的にズレない（Plan「修正1 / 2-3」参照）。
 */

/** 高頻度 polling 等を除外する 1 ルール（`log_skip` に対応）。 */
export interface SiteLogSkipRule {
  /** ルール ID（matcher 名の生成に使う。英数字と `-`/`_` のみ想定） */
  id: string;
  /** UI チップに出す短いラベル */
  label: string;
  /** 未指定なら method を絞らない */
  method?: string;
  /** RE2 互換の正規表現（Caddy `path_regexp` にそのまま渡す） */
  pathRegexp: string;
  /** 除外理由（UI チップのツールチップに出す） */
  reason: string;
  /** 除外ルール適用開始日（'YYYY-MM-DD'）。この日より前のログとの断絶を UI に出すため */
  since: string;
}

/** 1 host 分の skip ルール表。 */
export interface SiteLogRule {
  host: string;
  skip: SiteLogSkipRule[];
}

/**
 * site 固有の polling 除外ルール（確定値）。
 *
 * dangou-card-viewer の実 polling endpoint は `/api/games/{trial_dir}/{game_id}/state`
 * （2 秒間隔、`?view=god|public` 付与あり）と人間から提示された（Plan rev.5 修正1）。
 * `[^/]+` を 2 階層に厳密限定することで、`GET /api/games`・`GET /api/games/<id>`・
 * `POST .../state`・`.../state/history` は除外しない（通常操作を消さない）。
 * query（`?view=...`）は Caddy `path_regexp` の対象外（escaped path のみを見る）なので
 * 追加の query matcher は不要 — 何もしなくても同じルールで除外される。
 */
export const SITE_LOG_RULES: SiteLogRule[] = [
  {
    host: 'dangou-card-viewer.devrelay.io',
    skip: [
      {
        id: 'poll-game-state',
        label: 'GET /api/games/*/*/state',
        method: 'GET',
        pathRegexp: '^/api/games/[^/]+/[^/]+/state/?$',
        reason: '2秒ポーリング（?view=god|public を含む。query は path matcher の対象外）',
        // W1 pilot 適用日に確定する（B1 時点ではプレースホルダ。Plan「承認を要する逸脱6」参照）
        since: '2026-09-22',
      },
    ],
  },
];

/** 指定 host の skip ルールを返す（無ければ空配列）。 */
export function getSkipRulesForHost(host: string): SiteLogSkipRule[] {
  return SITE_LOG_RULES.find((r) => r.host === host)?.skip ?? [];
}

/** 指定 host に 1 件以上の skip ルールがあるか（UI の「除外あり」注記用）。 */
export function hasSkipRules(host: string): boolean {
  return getSkipRulesForHost(host).length > 0;
}

/**
 * 指定 host・method・path（query を含まない）が、その host の skip ルールに
 * マッチする（＝ログから除外される）かどうかを判定する（テスト・aggregator 双方から使う）。
 */
export function isExcludedByRules(host: string, method: string, path: string): boolean {
  const rules = getSkipRulesForHost(host);
  return rules.some((rule) => {
    if (rule.method && rule.method !== method) return false;
    return new RegExp(rule.pathRegexp).test(path);
  });
}

/** ルール ID から Caddy matcher 名を作る（`@drl_skip_<id>`。id 内の非英数字は `_` に正規化）。 */
function matcherName(rule: SiteLogSkipRule): string {
  return `@drl_skip_${rule.id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

/**
 * 予約済みの skip matcher 名（health checker 除外用）。
 * `SITE_LOG_RULES` のどの id からもこの名前が生成されないことをテストで固定する
 * （pre-W2 修正 F・B2-4 D2）。
 */
export const HEALTH_SKIP_MATCHER_NAME = '@drl_skip_health';

/** すべての `SiteLogSkipRule.id` から生成される matcher 名の一覧（衝突検査用）。 */
export function allSkipRuleMatcherNames(): string[] {
  return SITE_LOG_RULES.flatMap((r) => r.skip.map((s) => matcherName(s)));
}

/** 1 host 分の `log_skip` ディレクティブ群を Caddy テキストとして生成する。 */
export function renderSkipDirectives(rule: SiteLogRule): string {
  return rule.skip
    .map((s) => {
      const name = matcherName(s);
      const lines = [`${name} {`];
      if (s.method) lines.push(`\tmethod ${s.method}`);
      lines.push(`\tpath_regexp ${s.pathRegexp}`);
      lines.push('}');
      lines.push(`log_skip ${name}`);
      return lines.join('\n');
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// ログ保持設定（修正2: W1 pilot 実測後に人間確認で確定する。先に固定しない）
// ---------------------------------------------------------------------------

/** ログ保持設定（`output file { ... }` の roll 系パラメータ）。 */
export interface SiteLogRollConfig {
  rollSize: string; // 例 '32MiB'
  rollKeep: number; // 例 8
  rollKeepFor: string; // 例 '168h'
  /** true = W1 pilot 用の暫定値（30 日保持を保証する確定値ではない） */
  provisional: boolean;
}

/**
 * W1 pilot（dangou 1 件・短時間）専用の暫定 roll 設定。
 * 最大 32MiB × 8 = 256MiB（gz 実使用はさらに小さい）に抑えた保守的な値で、
 * pilot 中にディスクを圧迫しない「器」として使う。30 日保持を保証する値ではない。
 */
export const PILOT_ROLL_CONFIG: SiteLogRollConfig = {
  rollSize: '32MiB',
  rollKeep: 8,
  rollKeepFor: '168h',
  provisional: true,
};

/**
 * W2 rollout（21 件本番適用）用の確定 roll 設定。
 *
 * B2-4（`doc/devlog/2026-09-23_133642.md` D3）で確定した最終値：
 * `roll_size=64MiB` / `roll_keep=12` / `roll_keep_for=1440h`（60日）/ `provisional=false`。
 * 上限コーパス 64MiB×13=832MiB は scan budget 1.5GiB の 54%（F6 の制約から逆算した値であり、
 * 恒久的な数値ではない。`SITES_LOG_SCAN_BYTES_MAX` や host 数が変われば再計算が必要）。
 *
 * 型は `| null` のまま維持する（fail-closed 機構そのものは撤去しない）。
 * 値の変更が必要な場合も、必ず人間確認を経てここへ直接書き込む運用とする。
 */
export const ROLLOUT_ROLL_CONFIG: SiteLogRollConfig | null = {
  rollSize: '64MiB',
  rollKeep: 12,
  rollKeepFor: '1440h',
  provisional: false,
};

/** roll 設定が未確定であることを示すエラー（fail-closed ガードが投げる）。 */
export class RollConfigNotConfirmedError extends Error {
  constructor() {
    super('ROLLOUT_ROLL_CONFIG が未確定です。W1 pilot の実測と人間確認を先に実施してください（Phase 1-B 修正2）。');
    this.name = 'RollConfigNotConfirmedError';
  }
}

/**
 * `resolveRollConfig()` の内部実装。`rolloutConfig` を引数化することで、
 * `ROLLOUT_ROLL_CONFIG` が確定済みの現在も `null` 時の fail-closed 挙動をテストで固定できる。
 */
export function resolveRollConfigFrom(
  target: 'pilot' | 'rollout',
  rolloutConfig: SiteLogRollConfig | null,
): SiteLogRollConfig {
  if (target === 'pilot') return PILOT_ROLL_CONFIG;
  if (!rolloutConfig) throw new RollConfigNotConfirmedError();
  return rolloutConfig;
}

/**
 * 用途（'pilot' | 'rollout'）に応じた roll 設定を返す。
 * 'rollout' 指定時に `ROLLOUT_ROLL_CONFIG` が未確定なら `RollConfigNotConfirmedError` を投げる
 * （呼び出し側 = `sites-enable-access-log.ts` はこれを捕捉して W2 対象の適用を拒否する）。
 */
export function resolveRollConfig(target: 'pilot' | 'rollout'): SiteLogRollConfig {
  return resolveRollConfigFrom(target, ROLLOUT_ROLL_CONFIG);
}

/** `roll_size` / `roll_keep` / `roll_keep_for` の 3 行を生成する。 */
export function renderRollDirectives(config: SiteLogRollConfig, indent = '\t\t'): string {
  return [
    `${indent}roll_size ${config.rollSize}`,
    `${indent}roll_keep ${config.rollKeep}`,
    `${indent}roll_keep_for ${config.rollKeepFor}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// snippet / inline の `log { }` ブロック本体（1 行サイズ削減 format filter 込み）
// ---------------------------------------------------------------------------

export const ACCESS_LOG_SNIPPET_NAME = 'sites_access_log';
export const ACCESS_LOG_SNIPPET_FILE = '00-snippets';
export const ACCESS_LOG_PATH = '/var/log/caddy/sites/sites.access.log';
export const ACCESS_LOG_DIR = '/var/log/caddy/sites';

/**
 * DevRelay 自身のヘルスチェック UA（`health-checker.ts` の `USER_AGENT` / `sites-rules.ts` の
 * `OWN_HEALTH_CHECK_UA` と同一値。単一の真実はここ）。
 *
 * B2-4（D2）で確定：**UA 完全一致のみ**を条件とする。path は使わない（health は実ユーザーの
 * `GET /` と同一パスのため、path を条件に加えると PV がほぼ全滅する）。前方一致も採用しない
 * （`DevRelay-Sites-ReadOnlyCheck/1.0` 等の手動検証プローブまで巻き込むため）。
 */
export const HEALTH_CHECK_UA = 'DevRelay-Sites/1.0';

/**
 * snippet 内に 1 箇所だけ配置する health checker 除外の `log_skip` ディレクティブ（2 行）。
 * 各 site ファイルには影響しない（既存の `import sites_access_log` 1 行のままで効く）。
 * Caddy の `header` matcher は既定で完全一致（前方一致にはならない）。
 */
export function renderHealthSkipDirectives(indent = '\t'): string {
  return [
    `${indent}${HEALTH_SKIP_MATCHER_NAME} header User-Agent ${HEALTH_CHECK_UA}`,
    `${indent}log_skip ${HEALTH_SKIP_MATCHER_NAME}`,
  ].join('\n');
}

/**
 * `log { }` ブロック本体（snippet 定義・inline 展開の両方で共有するコア部分）。
 * `Cookie` / `Authorization` 等の削除は保持設計以前のプライバシー要件（生ログに含めない）。
 * `remote_ip` は UU ハッシュ計算に必要なので残すが、ファイル自体は `0640`（group のみ読める）。
 */
function renderLogBlockBody(config: SiteLogRollConfig): string {
  return `\tlog {
\t\toutput file ${ACCESS_LOG_PATH} {
\t\t\tmode 0640
${renderRollDirectives(config, '\t\t\t')}
\t\t}
\t\tformat filter {
\t\t\twrap json
\t\t\trequest>headers>Cookie delete
\t\t\trequest>headers>Authorization delete
\t\t\trequest>headers>Proxy-Authorization delete
\t\t\trequest>tls delete
\t\t\tresp_headers delete
\t\t}
\t}`;
}

/**
 * `00-snippets` ファイルに書く snippet 定義全文（named block, args なし・logger 名なし）。
 * health checker 除外（UA 完全一致）を snippet 冒頭に 1 箇所だけ配置する（pre-W2 修正 F）。
 */
export function renderSnippet(config: SiteLogRollConfig): string {
  return `(${ACCESS_LOG_SNIPPET_NAME}) {\n${renderHealthSkipDirectives('\t')}\n${renderLogBlockBody(config)}\n}\n`;
}

/** snippet が使えない環境向け：各 site ファイルへ直接埋め込む `log { }` ブロック本体のみ。 */
export function renderInlineLogBlock(config: SiteLogRollConfig): string {
  return `${renderHealthSkipDirectives('\t')}\n${renderLogBlockBody(config)}\n`;
}

/** 各 site ファイル先頭付近に置く `import` 行（snippet モード）。 */
export function renderImportLine(): string {
  return `\timport ${ACCESS_LOG_SNIPPET_NAME}\n`;
}

// ---------------------------------------------------------------------------
// W3（手編集・Caddyfile 直書き host）を自動変更対象から除外
// ---------------------------------------------------------------------------

/** `sites.d` 内の手編集 3 件（Phase 1-B の自動変更対象に含めない）。 */
export const W3_SITES_D_MANUAL_HOSTS: ReadonlySet<string> = new Set([
  'pixterm-server.devrelay.io',
  'pixterm.devrelay.io',
  'ribbon-re.jp',
]);

/** Caddyfile 直書き host（`sites.d` を経由しないため、そもそも enable script の対象にならない）。 */
export const W3_CADDYFILE_INLINE_HOSTS: ReadonlySet<string> = new Set([
  'devrelay.io',
  'app.devrelay.io',
  'clipped.devrelay.io',
  'pixblog.net',
  'draft.pixblog.net',
  'news.pixblog.net',
  'shelf.pixblog.net',
  'manual.pixblog.net',
]);

/** W3（Phase 1-B の自動変更対象外）に該当する host かどうか。 */
export function isW3ExcludedHost(host: string): boolean {
  return W3_SITES_D_MANUAL_HOSTS.has(host) || W3_CADDYFILE_INLINE_HOSTS.has(host);
}

/**
 * W2 rollout（一括適用）の対象として固定された 21 host（B2-4 D4 で確定）。
 * `dangou-card-viewer.devrelay.io`（W1 pilot で適用済み・14 行のため ineligible）と
 * W3（denylist）は含まない。known-broken host（`game001.devrelay.io`, 502）も
 * 意図的に含める（4xx/5xx 可視化が目的、health 除外後はログ量リスクがないため）。
 *
 * `--apply`（`--only` を指定しない一括適用）時、`sites.d` から算出した eligible 集合が
 * この定数と完全一致しない場合は fail-closed で中止する（denylist/inline host list の
 * 意図しない変化を検知するゲート。要件 A・W2 前ゲート）。
 */
export const W2_TARGET_HOSTS: readonly string[] = [
  'apkserver.devrelay.io',
  'chrome-bookmark.devrelay.io',
  'freecell.devrelay.io',
  'game001.devrelay.io',
  'game002.devrelay.io',
  'game2048.devrelay.io',
  'hanabitest.devrelay.io',
  'klotski.devrelay.io',
  'manager.devrelay.io',
  'mimamori-server.devrelay.io',
  'nim.devrelay.io',
  'pixql.devrelay.io',
  'test004.devrelay.io',
  'test005.devrelay.io',
  'test006.devrelay.io',
  'test007.devrelay.io',
  'test008.devrelay.io',
  'test009.devrelay.io',
  'test010.devrelay.io',
  'tetris.devrelay.io',
  'vixbtc.devrelay.io',
];

const MAX_ELIGIBLE_LINES = 9;

/**
 * 自動生成 `sites.d/<host>` ファイルが安全に自動変更してよい形式かどうかを判定する
 * （純粋関数。ファイル内容の実読み込みは呼び出し側）。
 * 「1 行目 `<host> {`」∧「`reverse_proxy localhost:N` を含む」∧「総行数 ≤ 9」∧
 * 「W3 denylist に無い」の全てを満たす場合のみ true（Plan「W3」の安全装置）。
 */
export function isEligibleForAutoLog(host: string, fileContent: string): boolean {
  if (isW3ExcludedHost(host)) return false;
  const lines = fileContent.split('\n').filter((_, i, arr) => !(i === arr.length - 1 && arr[i] === ''));
  if (lines.length > MAX_ELIGIBLE_LINES) return false;
  const first = (lines[0] ?? '').trim();
  const escapedHost = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`^${escapedHost}\\s*\\{$`).test(first)) return false;
  return lines.some((l) => /^\s*reverse_proxy\s+localhost:\d+\s*$/.test(l));
}

// ---------------------------------------------------------------------------
// W4（pixblog.net / ribbon-re.jp の既存独自 logger を Sites 共有 snippet に置換）
// ---------------------------------------------------------------------------

/**
 * W4 対象 host（既存独自 logger を持つため W3 denylist に含まれてきた 2 件のうち、
 * 実際に置換対象とするもの）。`ribbon-re.jp` は `sites.d` の 1 block が
 * `www.ribbon-re.jp` も担当するため、host 数（34）と block 数（33）が一致しない
 * （`AdaptExpectation.blocks` を参照）。
 */
export const W4_TARGET_HOSTS: readonly string[] = ['pixblog.net', 'ribbon-re.jp', 'www.ribbon-re.jp'];

/**
 * W4 完了後に期待される Sites 構造値（Plan「W4 最終 2 host 統合」§3 で確定）。
 * `--w4-stage` / `--w4-apply`（`sites-enable-access-log.ts`）双方が、/tmp ミラーおよび
 * 実ファイル適用後の両方でこの値と一致することを確認してから次の段階に進む。
 *
 *   host 数   : 31 (W2/W3) + 3 (W4: pixblog.net / ribbon-re.jp / www.ribbon-re.jp) = 34
 *   block 数  : 31 (W2/W3) + 2 (W4: pixblog.net 1 block・ribbon 1 block=2 host) = 33
 *   health matcher : block 数と同数 = 33
 */
export const W4_EXPECTED = {
  hosts: 34,
  blocks: 33,
  healthMatchers: 33,
} as const;
