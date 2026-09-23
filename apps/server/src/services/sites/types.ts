/**
 * DevRelay Sites Phase 1-A — 型定義。
 *
 * 「Caddy が公開している site を DevRelay 自身が観測する」機能の骨格。
 * すべての値は `Evidence<T>` でラップし、どこから来た情報か（source）と
 * どれだけ確からしいか（confidence）を必ず併記する。
 * confidence の意味（プラン docs/floating-wandering-melody.md 参照）:
 *   - confirmed:   一次情報源から直接取得（Caddy Admin API / ss / /etc/passwd 等）
 *   - conditional: 取得はできるが規約・前提が崩れると外れる（DB リンクなし、規約突合のみ 等）
 *   - inferred:    複数の弱い手がかりからの推測（ps args、名前の部分一致 等）
 *   - unknown:     判定不能
 *
 * 外部 I/O を行わない純粋な型モジュール（値は他ファイルで実行時に組み立てる）。
 */

/** 情報の信頼度（4 段階）。プラン docs の「確定/条件付き/推測/不明」に対応。 */
export type Confidence = 'confirmed' | 'conditional' | 'inferred' | 'unknown';

/** 1 つの値とその出どころ・確からしさをセットで持つラッパー。 */
export interface Evidence<T> {
  value: T | null;
  confidence: Confidence;
  /** 'caddy-admin' | 'ss' | 'ss+passwd' | 'proc-cwd' | 'ps-args' | 'db:TestflightService' 等 */
  source: string;
  /** 補足説明（UI にそのまま出せる短文） */
  note?: string;
}

/** 値が無い場合の Evidence を作る小さなヘルパー（各所で使い回す）。 */
export function unknownEvidence<T>(source: string, note?: string): Evidence<T> {
  return { value: null, confidence: 'unknown', source, note };
}

/** サイトの種別（Caddy 設定から機械分類）。 */
export type SiteKind = 'testflight' | 'reverse_proxy' | 'file_server' | 'php' | 'other';

/** ヘルスチェックの状態。 */
export type HealthState = 'up' | 'degraded' | 'down' | 'unknown';

/** 警告の重大度。 */
export type WarningSeverity = 'error' | 'warn' | 'info';

/** 警告 1 件。 */
export interface SiteWarning {
  code: string;
  severity: WarningSeverity;
  message: string;
}

/** Caddy Admin API から抽出した 1 site 分の生インベントリ（`caddy-inventory.ts` の出力）。 */
export interface CaddySiteEntry {
  host: string;
  aliases: string[];
  kind: SiteKind;
  /** reverse_proxy / php_fastcgi の upstream dial 文字列（例: 'localhost:9023'）。複数ある場合は最頻出を採用。 */
  upstreamDial: string | null;
  upstreamPort: number | null;
  /** 通常ルートの static root（vars.root）。file_server 系サイトのみ。 */
  staticRoot: string | null;
  /** handle_errors（Caddy `errors.routes`）側の root。testflight の placeholder 検出に使う。 */
  errorsRoot: string | null;
  /** このホストが `logging.logs.<server>.logger_names` に明示的に含まれるか（= 専用ログ設定あり）。 */
  hasAccessLog: boolean;
}

/** Caddy Admin API 全体のインベントリ結果。 */
export interface CaddyInventory {
  reachable: boolean;
  sites: CaddySiteEntry[];
  error?: string;
}

/** `process-probe.ts` が返す、1 ポートぶんの LISTEN 情報。 */
export interface ListenInfo {
  port: number;
  bind: string;
  uid: number;
  cgroup: string | null;
}

/** cgroup パスから抽出した末端セグメント（systemd unit 名 or pm2 wrapper 名の手がかり）。 */
export interface CgroupHint {
  raw: string;
  /** cgroup パスの最終セグメント（例: 'dangou-viewer.service', 'pm2-devrelay.service'） */
  lastSegment: string | null;
  /** lastSegment が `pm2-*.service` 形式（= PM2 配下の全プロセス共通の cgroup。個別サイトの識別には使えない） */
  isPm2Wrapper: boolean;
}

/** `ps -eo user,pid,args` から得た、特定ポートに関連しそうなプロセスのヒント。 */
export interface ProcessHint {
  pid: number;
  user: string;
  args: string;
}

/** Git 情報（読める場合のみ）。 */
export interface GitInfo {
  branch: string | null;
  head: string | null;
  remote: string | null;
}

/** Project 候補（複数出しうる）。 */
export interface ProjectCandidate {
  id: string;
  name: string;
  displayName: string | null;
  path: string;
  machineName: string;
  confidence: Confidence;
  reason: string;
}

/** TestflightService 由来の情報（Evidence の中身。index アクセスで `| null` が二重に付くのを避けるため名前付きで定義）。 */
export interface TestflightInfo {
  id: string;
  name: string;
  port: number;
  directory: string;
  status: string;
  template: string | null;
  ownerUserId: string;
  createdAt: string;
}

/** Project 突合結果（最上位候補）の情報。 */
export interface ProjectInfo {
  id: string;
  name: string;
  displayName: string | null;
  path: string;
  machineName: string;
}

/** Machine 突合結果の情報。 */
export interface MachineInfo {
  id: string;
  name: string;
  online: boolean;
}

/** health-checker.ts が保持する最新のヘルス結果。 */
export interface HealthResult {
  state: HealthState;
  httpStatus: number | null;
  latencyMs: number | null;
  checkedAt: string | null;
  error: string | null;
}

/** `/api/sites` `/api/sites/:host` が返す 1 site 分のレコード。 */
export interface SiteRecord {
  host: string;
  aliases: string[];
  kind: SiteKind;
  configSource: string | null; // 'sites.d/<file>' | 'caddyfile' | null(不明)
  upstream: Evidence<{ dial: string; port: number | null }>;
  staticRoot: Evidence<string>;
  hasAccessLog: boolean;
  listen: Evidence<{ bind: string; uid: number; unixUser: string | null; cgroupUnit: string | null }>;
  process: Evidence<{ pid: number; cwd: string | null; cmdline: string }>;
  testflight: Evidence<TestflightInfo>;
  directories: {
    registered: Evidence<string>;
    runtime: Evidence<string>;
    candidates: ProjectCandidate[];
  };
  project: Evidence<ProjectInfo>;
  machine: Evidence<MachineInfo>;
  git: Evidence<GitInfo>;
  health: HealthResult;
  warnings: SiteWarning[];
  /** Phase 1-B: アクセス解析統計。ログ未導入 site や集計未完了時は null（`statsReady` 参照）。 */
  stats: SiteStats | null;
}

/** `/api/sites/_meta` が返す全体メタ情報。 */
export interface SitesMeta {
  caddyAdminReachable: boolean;
  ssAvailable: boolean;
  hostname: string;
  healthEnabled: boolean;
  lastHealthRunAt: string | null;
  counts: { up: number; degraded: number; down: number; unknown: number; withoutAccessLog: number };
  orphans: Array<{ kind: 'testflight-row-no-caddy' | 'directory-only'; name: string; path: string; status?: string }>;
  /**
   * Phase 1-B: アクセスログ未導入（= `hasAccessLog === false`）の site 数。
   * 上部サマリーに出す（「未計測 site 数」）。`counts.withoutAccessLog` と同値だが、
   * Phase 1-B の UI 文言（未計測）に対応する専用フィールドとして明示的に持つ。
   */
  unmeasuredCount: number;
  /**
   * Phase 1-B: access log aggregator の初回 cold scan が完了したか。
   * false の間はアクセスログ導入済みの site でも `stats: null` を返す（500 にしない）。
   */
  statsReady: boolean;
  /** day bucket 集計の基準タイムゾーン（B2-0 修正3。常に 'Asia/Tokyo'）。 */
  timeZone: 'Asia/Tokyo';
}

// ============================================================================
// DevRelay Sites Phase 1-B — Access Analytics（PV/UU/Referer/UTM/bot/4xx5xx）
// ============================================================================

/**
 * 30 日 window の実カバレッジ。「30日」ラベルを無条件に出さないための構造
 * （修正2: roll 保持設定が未確定の間は特に重要。サーバー側で 30 日値に補外・推定しない）。
 */
export interface StatsCoverage {
  requestedDays: 30;
  /** 実際にログが遡れた最古日（'YYYY-MM-DD'）。null は集計未実施。 */
  oldestCoveredDate: string | null;
  /** 実際にカバーできている日数。 */
  coveredDays: number;
  /** `coveredDays >= requestedDays && !truncated` */
  complete: boolean;
  truncated: boolean;
  truncatedReason: 'byte_budget' | 'log_retention' | 'gap_detected' | null;
  /** ログ導入日（最古行の ts）。この日より前は「計測前」であり 0 ではなく null（欠測）扱い。 */
  measuredSince: string | null;
  /** day bucket 集計の基準タイムゾーン（B2-0 修正3。常に 'Asia/Tokyo'）。 */
  timeZone: 'Asia/Tokyo';
}

/** 日別 PV。`count === null` は `measuredSince` より前の欠測（0 と区別する）。 */
export interface DailyPv {
  date: string; // 'YYYY-MM-DD'
  count: number | null;
}

/** カーディナリティ上限で畳んだ集計エントリの 1 件（`topPaths` / `referers` / `utm.*` 共通）。 */
export interface StatsCountEntry {
  key: string;
  count: number;
}

/** 1 site 分のアクセス解析統計（`access-aggregator.ts` の出力）。 */
export interface SiteStats {
  today: { pv: number; uu: number | null; uuTruncated: boolean };
  last7d: { pv: number };
  last30d: { pv: number; daily: DailyPv[] };
  topPaths: StatsCountEntry[];
  referers: StatsCountEntry[];
  utm: { source: StatsCountEntry[]; medium: StatsCountEntry[]; campaign: StatsCountEntry[] };
  /** bot 判定された request の比率（0〜1）。分母データが無い場合は null。 */
  botRatio: number | null;
  status4xx: number;
  status5xx: number;
  /** `topPaths` / `referers` / `utm.*` のいずれかがカーディナリティ上限で `(other)` に畳まれたか。 */
  detailTruncated: boolean;
  coverage: StatsCoverage;
  /** この host に `SITE_LOG_RULES` の skip ルールが適用されているか（UI の「除外あり」注記用）。 */
  excludedByRules: boolean;
}

