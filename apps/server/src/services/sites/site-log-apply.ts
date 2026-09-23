/**
 * DevRelay Sites Phase 1-B — pre-W2 必須修正（サイクル1.9）。
 *
 * `sites-enable-access-log.ts` から呼ばれる「適用状態の判定・適用テキスト生成・
 * backup manifest・rollback 計画・caddy adapt 結果の構造検証」を純粋関数として集約する。
 * 外部 I/O ゼロ（sudo tee / rm / caddy adapt の実行は呼び出し側のスクリプトが行う）。
 *
 * 目的（B2-4 Findings F3・F4・F7・F8 の是正。Plan「pre-W2 必須修正」A〜F）:
 *   - A: 同一 host への複数回適用で import / matcher が重複しない（冪等化）
 *   - B: sudo rm の引数形状を NOPASSWD の実パターンに一致させる（呼び出し側で使う assertSitesDPath）
 *   - C/D/E: backup を manifest 方式にし、`/`↔`_` の非可逆変換・timestamp 部分一致を廃止する
 *   - F: health checker 除外（UA 完全一致）が正しく生成されることを構造的に確認する
 */

import { basename, dirname, join, normalize } from 'path';
import { createHash } from 'crypto';
import {
  HEALTH_CHECK_UA,
  HEALTH_SKIP_MATCHER_NAME,
  allSkipRuleMatcherNames,
  getSkipRulesForHost,
  renderImportLine,
  renderInlineLogBlock,
  renderSkipDirectives,
  type SiteLogRollConfig,
  type SiteLogRule,
} from './site-log-rules.js';

// ---------------------------------------------------------------------------
// パス制約（要件 B・C・E の共通基盤）
// ---------------------------------------------------------------------------

/** `sudoRemoveFile` / `sudoWriteFile` / backup 復元が対象にしてよいディレクトリ。 */
export const SITES_D_DIR = '/etc/caddy/sites.d';

/** ファイル名として許容する文字集合（英数字・`.`・`_`・`-` のみ。隠しファイル・空文字は不可）。 */
const SAFE_BASENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * 指定パスが `/etc/caddy/sites.d` 直下の安全なファイル名であることを検証する。
 * 違反時は理由付きで throw する（fail-closed。呼び出し側は sudo 実行前に必ずこれを通す）。
 *
 * 検査項目:
 *   - 絶対パスであること
 *   - `normalize()` 後も `dirname` が `SITES_D_DIR` と完全一致（`..` によるエスケープを拒否）
 *   - `basename` が `SAFE_BASENAME_RE` に一致（`/`, `\0`, 先頭ドットなど不可）
 */
export function assertSitesDPath(path: string): void {
  if (!path || typeof path !== 'string') {
    throw new Error('assertSitesDPath: path が空です');
  }
  if (path.includes('\0')) {
    throw new Error(`assertSitesDPath: NUL 文字を含むパスは拒否します: ${JSON.stringify(path)}`);
  }
  if (!path.startsWith('/')) {
    throw new Error(`assertSitesDPath: 絶対パスではありません: ${path}`);
  }
  const normalized = normalize(path);
  if (normalized !== path) {
    throw new Error(`assertSitesDPath: 正規化前後でパスが変化します（traversal の疑い）: ${path}`);
  }
  const dir = dirname(normalized);
  if (dir !== SITES_D_DIR) {
    throw new Error(`assertSitesDPath: ${SITES_D_DIR} 配下ではありません: ${path}`);
  }
  const base = basename(normalized);
  if (!SAFE_BASENAME_RE.test(base)) {
    throw new Error(`assertSitesDPath: ファイル名が不正です: ${JSON.stringify(base)}`);
  }
}

// ---------------------------------------------------------------------------
// 適用状態の検出（要件 A: 冪等化の基盤）
// ---------------------------------------------------------------------------

export type AppliedMode = 'none' | 'snippet' | 'inline' | 'mixed';

export interface AppliedState {
  mode: AppliedMode;
  /** `import sites_access_log` の出現回数 */
  importCount: number;
  /** inline `log { ... }` ブロック（`output file .../sites.access.log` を含む）の出現回数 */
  inlineLogCount: number;
  /** ファイル内に存在する `@drl_skip_*` matcher 名の一覧（重複を含む） */
  skipMatchers: string[];
}

const IMPORT_LINE_RE = /^\s*import\s+sites_access_log\s*$/m;
const INLINE_LOG_MARKER_RE = /output file\s+\/var\/log\/caddy\/sites\/sites\.access\.log/g;
const SKIP_MATCHER_DEF_RE = /^\s*(@drl_skip_[A-Za-z0-9_]+)\s*\{/gm;

/** ファイル内容から現在の適用状態を検出する（純粋関数。副作用なし）。 */
export function detectAppliedState(content: string): AppliedState {
  const importCount = (content.match(new RegExp(IMPORT_LINE_RE, 'gm')) ?? []).length;
  const inlineLogCount = (content.match(INLINE_LOG_MARKER_RE) ?? []).length;
  const skipMatchers = [...content.matchAll(SKIP_MATCHER_DEF_RE)].map((m) => m[1]);

  let mode: AppliedMode;
  if (importCount > 0 && inlineLogCount > 0) {
    mode = 'mixed';
  } else if (importCount > 0) {
    mode = 'snippet';
  } else if (inlineLogCount > 0) {
    mode = 'inline';
  } else {
    mode = 'none';
  }

  return { mode, importCount, inlineLogCount, skipMatchers };
}

// ---------------------------------------------------------------------------
// host の分類（eligibility より「既適用/不整合」判定を優先する。要件 A の核心）
// ---------------------------------------------------------------------------

export type HostClass =
  | { kind: 'eligible' }
  | { kind: 'already-applied'; state: AppliedState }
  | { kind: 'inconsistent'; reason: string; state: AppliedState }
  | { kind: 'ineligible'; reason: string };

/**
 * host を「これから適用してよい（eligible）」「既に適用済み（no-op 対象）」
 * 「不整合（fail-closed で run 全体を中止すべき）」「対象外（ineligible）」に分類する。
 *
 * 判定順序が重要: `already-applied` / `inconsistent` を `isEligibleForAutoLog` の
 * 行数上限より**先に**見る。現行ロジックは 8 行 host に 1 回 import を追加すると 9 行になり
 * `isEligibleForAutoLog` を依然として通過してしまう（B2-4 F3）。ここで先に「既に import 済み」
 * を検出することで、2 回目の適用が「eligible として再度 import を足す」ことを構造的に防ぐ。
 */
export function classifyHostForApply(
  host: string,
  content: string,
  isEligible: (host: string, content: string) => boolean,
): HostClass {
  const state = detectAppliedState(content);

  if (state.mode === 'mixed') {
    return {
      kind: 'inconsistent',
      reason: `snippet（import）と inline（log ブロック）が混在しています（host=${host}）。手動確認が必要です。`,
      state,
    };
  }
  if (state.importCount > 1) {
    return {
      kind: 'inconsistent',
      reason: `import sites_access_log が ${state.importCount} 回出現しています（host=${host}）。二重適用の疑いがあります。`,
      state,
    };
  }
  if (state.inlineLogCount > 1) {
    return {
      kind: 'inconsistent',
      reason: `inline log ブロックが ${state.inlineLogCount} 回出現しています（host=${host}）。二重適用の疑いがあります。`,
      state,
    };
  }
  // 同一 skip matcher 名が複数回定義されている（health / polling 問わず）
  const dupMatcher = state.skipMatchers.find((name, i) => state.skipMatchers.indexOf(name) !== i);
  if (dupMatcher) {
    return {
      kind: 'inconsistent',
      reason: `skip matcher ${dupMatcher} が複数回定義されています（host=${host}）。`,
      state,
    };
  }
  if (state.mode !== 'none') {
    return { kind: 'already-applied', state };
  }
  if (!isEligible(host, content)) {
    return { kind: 'ineligible', reason: `isEligibleForAutoLog が false を返しました（host=${host}）` };
  }
  return { kind: 'eligible' };
}

// ---------------------------------------------------------------------------
// 適用テキスト生成（冪等・自己検査付き）
// ---------------------------------------------------------------------------

export interface ApplyLogConfigResult {
  updated: string;
  /** false の場合、`updated` は入力と同一内容（何もしていない = no-op） */
  changed: boolean;
}

function findBlockOpenIndex(lines: string[]): number {
  const idx = lines.findIndex((l) => /\{\s*$/.test(l));
  if (idx === -1) throw new Error('site ファイルの先頭ブロック開始行 `{` が見つかりません');
  return idx;
}

function buildSkipRuleText(host: string): string | null {
  const skip = getSkipRulesForHost(host);
  if (skip.length === 0) return null;
  const rule: SiteLogRule = { host, skip };
  return renderSkipDirectives(rule);
}

/**
 * host 固有の log 設定（import/inline + skip ルール）を挿入した内容を返す。
 * **呼び出し前提**: `classifyHostForApply` が `eligible` を返した host にのみ呼ぶこと
 * （`already-applied` / `inconsistent` はこの関数を呼ばず no-op / 中止する）。
 *
 * 生成後に自己検査を行い、import ちょうど 1・各 skip matcher ちょうど 1 でなければ throw する
 * （sudo tee で書き込む前に構造的な不整合を検知する。要件 A の第 2 防衛線）。
 */
export function applyLogConfig(
  host: string,
  content: string,
  mode: 'snippet' | 'inline',
  rollConfig: SiteLogRollConfig,
  applySkipRules: boolean,
): ApplyLogConfigResult {
  const lines = content.split('\n');
  const openIdx = findBlockOpenIndex(lines);
  const insertion =
    mode === 'snippet' ? renderImportLine().replace(/\n$/, '') : renderInlineLogBlock(rollConfig).replace(/\n$/, '');

  const before = lines.slice(0, openIdx + 1);
  const after = lines.slice(openIdx + 1);
  let updatedLines = [...before, insertion, ...after];

  if (applySkipRules) {
    const skipText = buildSkipRuleText(host);
    if (skipText) {
      const before2 = updatedLines.slice(0, openIdx + 1);
      const after2 = updatedLines.slice(openIdx + 1);
      updatedLines = [...before2, ...skipText.split('\n').map((l) => `\t${l}`), ...after2];
    }
  }

  const updated = updatedLines.join('\n');

  // 自己検査（sudo tee 到達前に構造不整合を検知する）
  const finalState = detectAppliedState(updated);
  if (finalState.mode === 'mixed') {
    throw new Error(`applyLogConfig 自己検査失敗: mode=mixed になりました（host=${host}）`);
  }
  if (mode === 'snippet' && finalState.importCount !== 1) {
    throw new Error(`applyLogConfig 自己検査失敗: import が ${finalState.importCount} 個です（host=${host}）`);
  }
  if (mode === 'inline' && finalState.inlineLogCount !== 1) {
    throw new Error(`applyLogConfig 自己検査失敗: inline log ブロックが ${finalState.inlineLogCount} 個です（host=${host}）`);
  }
  const dupMatcher = finalState.skipMatchers.find((name, i) => finalState.skipMatchers.indexOf(name) !== i);
  if (dupMatcher) {
    throw new Error(`applyLogConfig 自己検査失敗: skip matcher ${dupMatcher} が重複しています（host=${host}）`);
  }
  const reservedCollision = finalState.skipMatchers.includes(HEALTH_SKIP_MATCHER_NAME) && mode === 'snippet';
  if (reservedCollision) {
    // snippet モードでは host 側に health matcher を書かない設計（snippet 側にのみ置く）。
    // host 側に紛れ込んでいたら生成ロジックの誤りなので検知する。
    throw new Error(`applyLogConfig 自己検査失敗: host 側に予約 matcher ${HEALTH_SKIP_MATCHER_NAME} が混入しました（host=${host}）`);
  }

  return { updated, changed: updated !== content };
}

/**
 * W4（pixblog.net / ribbon-re.jp の既存独自 logger を Sites 共有 snippet に置換）専用。
 *
 * `legacyLogBlock` は対象ファイル内に**正確に 1 回だけ**出現する必要がある文字列（既存の
 * 独自 `log { ... }` ブロック本体そのもの。呼び出し側が host ごとに実ファイルから確認した
 * 正確な文字列を渡す）。0 回・2 回以上のいずれでも fail-closed で throw する。
 *
 * 処理: `legacyLogBlock` を削除 → `applyLogConfig(..., 'snippet', ...)` で
 * `import sites_access_log` を先頭ブロック直後に挿入。既存の `applyLogConfig` 自己検査
 * （import ちょうど 1・mixed にならない等）をそのまま再利用する。
 */
export function replaceLegacyLogWithSnippetImport(
  host: string,
  content: string,
  legacyLogBlock: string,
  rollConfig: SiteLogRollConfig,
): ApplyLogConfigResult {
  const occurrences = content.split(legacyLogBlock).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `replaceLegacyLogWithSnippetImport: legacy log ブロックの出現数が想定外です（host=${host} / 期待 1 / 実際 ${occurrences}）`,
    );
  }
  const withoutLegacy = content.split(legacyLogBlock).join('');
  const result = applyLogConfig(host, withoutLegacy, 'snippet', rollConfig, false);

  // 自己検査（applyLogConfig の自己検査に加え、legacy ブロックが確実に消えたことを再確認する）
  if (result.updated.includes(legacyLogBlock)) {
    throw new Error(`replaceLegacyLogWithSnippetImport 自己検査失敗: legacy log ブロックが除去後も残っています（host=${host}）`);
  }

  return result;
}

/** `SITE_LOG_RULES` の id から生成される matcher 名が予約名と衝突していないかを検査する。 */
export function assertNoReservedMatcherCollision(): void {
  const names = allSkipRuleMatcherNames();
  if (names.includes(HEALTH_SKIP_MATCHER_NAME)) {
    throw new Error(`SITE_LOG_RULES の id から予約 matcher 名 ${HEALTH_SKIP_MATCHER_NAME} と衝突する matcher が生成されました`);
  }
}

// ---------------------------------------------------------------------------
// backup manifest（要件 C・D・E）
// ---------------------------------------------------------------------------

export interface BackupManifestEntry {
  /** 元ファイルの絶対パス（`/etc/caddy/sites.d/<name>`） */
  originalPath: string;
  /** 'modified' = 既存ファイルを変更、'created' = このバッチで新規作成 */
  action: 'modified' | 'created';
  /** backup 本体のファイル名（`BACKUP_DIR/<batchId>/` 直下、連番）。'created' の場合は null */
  backupFile: string | null;
  /** 適用前の内容の sha256（'created' の場合は null） */
  sha256Before: string | null;
  /** 適用後（このバッチで書き込んだ内容）の sha256 */
  sha256After: string;
}

export interface BackupManifest {
  version: 1;
  batchId: string;
  createdAt: string;
  mode: 'snippet' | 'inline';
  target: 'pilot' | 'rollout';
  rollConfig: SiteLogRollConfig;
  entries: BackupManifestEntry[];
}

const BATCH_ID_RE = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/;

/** `newBatchId()` が生成する形式: `<YYYYMMDDTHHMMSSZ>-<8hex>`。 */
export function newBatchId(now: Date, randomHex8: string): string {
  const iso = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const id = `${iso}-${randomHex8}`;
  if (!BATCH_ID_RE.test(id)) {
    throw new Error(`newBatchId: 生成された ID が想定形式ではありません: ${id}`);
  }
  return id;
}

/** batchId として安全か（ディレクトリ名に使う。traversal 不可）。 */
export function isValidBatchId(id: string): boolean {
  return typeof id === 'string' && BATCH_ID_RE.test(id) && !id.includes('/') && !id.includes('..');
}

export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/** manifest JSON の形式検証（不正なら throw）。 */
export function parseManifest(json: unknown): BackupManifest {
  if (typeof json !== 'object' || json === null) throw new Error('parseManifest: manifest が object ではありません');
  const m = json as Record<string, unknown>;
  if (m.version !== 1) throw new Error('parseManifest: version が 1 ではありません');
  if (typeof m.batchId !== 'string' || !isValidBatchId(m.batchId)) {
    throw new Error(`parseManifest: batchId が不正です: ${JSON.stringify(m.batchId)}`);
  }
  if (typeof m.createdAt !== 'string') throw new Error('parseManifest: createdAt がありません');
  if (m.mode !== 'snippet' && m.mode !== 'inline') throw new Error('parseManifest: mode が不正です');
  if (m.target !== 'pilot' && m.target !== 'rollout') throw new Error('parseManifest: target が不正です');
  if (!Array.isArray(m.entries) || m.entries.length === 0) {
    throw new Error('parseManifest: entries が空です（fail-closed: 空 manifest からの rollback は禁止）');
  }
  const entries: BackupManifestEntry[] = m.entries.map((raw, i) => {
    const e = raw as Record<string, unknown>;
    if (typeof e.originalPath !== 'string') throw new Error(`parseManifest: entries[${i}].originalPath が不正です`);
    assertSitesDPath(e.originalPath); // path traversal 拒否（manifest 自体が汚染されていても弾く）
    if (e.action !== 'modified' && e.action !== 'created') {
      throw new Error(`parseManifest: entries[${i}].action が不正です`);
    }
    if (e.action === 'modified' && typeof e.backupFile !== 'string') {
      throw new Error(`parseManifest: entries[${i}] は modified なのに backupFile がありません`);
    }
    if (e.action === 'created' && e.backupFile !== null) {
      throw new Error(`parseManifest: entries[${i}] は created なのに backupFile が null ではありません`);
    }
    if (typeof e.sha256After !== 'string') throw new Error(`parseManifest: entries[${i}].sha256After が不正です`);
    return {
      originalPath: e.originalPath,
      action: e.action,
      backupFile: (e.backupFile as string | null) ?? null,
      sha256Before: (e.sha256Before as string | null) ?? null,
      sha256After: e.sha256After,
    };
  });
  return {
    version: 1,
    batchId: m.batchId,
    createdAt: m.createdAt,
    mode: m.mode,
    target: m.target,
    rollConfig: m.rollConfig as SiteLogRollConfig,
    entries,
  };
}

// ---------------------------------------------------------------------------
// rollback 計画（要件 D・E: exact batch matching・新規作成物の一般化）
// ---------------------------------------------------------------------------

export type RollbackOp =
  | { kind: 'restore'; originalPath: string; backupFile: string }
  | { kind: 'delete'; originalPath: string }
  | { kind: 'drift'; originalPath: string; reason: string };

/**
 * manifest と「現在のファイル内容の sha256」から rollback 計画を立てる（純粋関数）。
 * `currentHashes` に存在しない originalPath（＝現在ファイルが無い）は
 * `action:'modified'` なら drift 扱い（本来あるはずのファイルが消えている）、
 * `action:'created'` なら「既に無い＝delete 不要」として計画から除外する。
 *
 * drift（適用後に別の変更が入っている）は既定で計画に含めて呼び出し側に警告させる
 * （force 上書きするかどうかは呼び出し側の判断）。
 */
export function planRollback(manifest: BackupManifest, currentHashes: ReadonlyMap<string, string>): RollbackOp[] {
  const ops: RollbackOp[] = [];
  for (const entry of manifest.entries) {
    const currentHash = currentHashes.get(entry.originalPath);
    if (entry.action === 'created') {
      if (currentHash === undefined) continue; // 既に存在しない＝delete 不要
      if (currentHash !== entry.sha256After) {
        ops.push({
          originalPath: entry.originalPath,
          kind: 'drift',
          reason: `作成後に別の変更が入っています（sha256 不一致）: ${entry.originalPath}`,
        });
        continue;
      }
      ops.push({ kind: 'delete', originalPath: entry.originalPath });
      continue;
    }
    // action === 'modified'
    if (currentHash === undefined) {
      ops.push({ kind: 'drift', originalPath: entry.originalPath, reason: `ファイルが存在しません: ${entry.originalPath}` });
      continue;
    }
    if (currentHash !== entry.sha256After) {
      ops.push({
        kind: 'drift',
        originalPath: entry.originalPath,
        reason: `適用後に別の変更が入っています（sha256 不一致）: ${entry.originalPath}`,
      });
      continue;
    }
    if (!entry.backupFile) {
      ops.push({ kind: 'drift', originalPath: entry.originalPath, reason: `backupFile が記録されていません: ${entry.originalPath}` });
      continue;
    }
    ops.push({ kind: 'restore', originalPath: entry.originalPath, backupFile: entry.backupFile });
  }
  return ops;
}

// ---------------------------------------------------------------------------
// caddy adapt 出力の構造検証（W2 前ゲート。本番 Caddy 非接触で成立を確認する）
// ---------------------------------------------------------------------------

export interface AdaptExpectation {
  /**
   * access log を持つべき host 一覧（W2 対象 + 既適用 host。例: 21 + dangou = 22）。
   * `missingHosts`（dangling 検出）と `multiLoggerHosts`（1 host = 1 logger 検出）の
   * カバレッジ判定にのみ使う。**block 数（= logger 数）の期待値には使わない**（W4 で
   * `ribbon-re.jp, www.ribbon-re.jp` のように 1 block が複数 host を担当するようになり、
   * host 数と logger 数が一致しなくなるため。要件は §「W4 修正」参照）。
   */
  hosts: string[];
  /**
   * `sites.access.log` へ書く logger（= Caddy `log { }` block）の期待数。
   * 通常は `hosts.length` と一致するが、複数 host が 1 block を共有する場合はそれより少ない。
   */
  blocks: number;
  rollConfig: SiteLogRollConfig;
}

export interface AdaptAssertion {
  ok: boolean;
  failures: string[];
  stats: {
    loggerCount: number;
    healthMatcherCount: number;
    multiLoggerHosts: string[];
    rollVariants: number;
  };
}

function rollSizeToMb(rollSize: string): number {
  const m = /^(\d+)MiB$/.exec(rollSize);
  if (!m) throw new Error(`rollSizeToMb: 想定外の形式です: ${rollSize}`);
  return Number(m[1]);
}

function rollKeepForToDays(rollKeepFor: string): number {
  const m = /^(\d+)h$/.exec(rollKeepFor);
  if (!m) throw new Error(`rollKeepForToDays: 想定外の形式です: ${rollKeepFor}`);
  return Math.round(Number(m[1]) / 24);
}

/**
 * `caddy adapt --adapter caddyfile` の出力 JSON を受け取り、W2 が構造的に正しいことを検証する。
 * 検査項目（N4: `/tmp` ミラーでの実測により全て観測済み。W4 で block/host 分離を追加）:
 *   - `srv0.logs.logger_names` において 1 host = 1 logger（複数 logger を持つ host が 0 件）
 *   - `expected.hosts` の全 host が `logger_names` に存在する（dangling 検出）
 *   - `sites.access.log` へ書く logger 数が `expected.blocks` と一致（W4: host 数とは限らない）
 *   - それら logger の roll 設定がただ 1 種類（`expected.rollConfig` と一致）
 *   - health matcher（`DevRelay-Sites/1.0`）の出現数が logger 数と一致（block ごとに 1 回）
 */
export function verifyAdaptedConfig(adaptJson: unknown, expected: AdaptExpectation): AdaptAssertion {
  const failures: string[] = [];
  const root = adaptJson as {
    apps?: { http?: { servers?: Record<string, { logs?: { logger_names?: Record<string, string[]> } }> } };
    logging?: { logs?: Record<string, { writer?: { filename?: string; roll_size_mb?: number; roll_keep?: number; roll_keep_days?: number } }> };
  };

  const servers = root.apps?.http?.servers ?? {};
  const serverKeys = Object.keys(servers);
  if (serverKeys.length === 0) {
    failures.push('apps.http.servers が空です（adapt 出力の形式が想定外）');
  }

  const loggerNamesAll: Record<string, string[]> = {};
  for (const key of serverKeys) {
    Object.assign(loggerNamesAll, servers[key].logs?.logger_names ?? {});
  }

  const multiLoggerHosts = Object.entries(loggerNamesAll)
    .filter(([, loggers]) => loggers.length > 1)
    .map(([host]) => host);
  if (multiLoggerHosts.length > 0) {
    failures.push(`1 host = 1 logger 違反（複数 logger を持つ host）: ${multiLoggerHosts.join(', ')}`);
  }

  const loggers = root.logging?.logs ?? {};
  const sitesLoggerKeys = Object.entries(loggers)
    .filter(([, v]) => v.writer?.filename?.endsWith('sites/sites.access.log'))
    .map(([k]) => k);

  const missingHosts = expected.hosts.filter((h) => !(h in loggerNamesAll));
  if (missingHosts.length > 0) {
    failures.push(`logger が無い host があります: ${missingHosts.join(', ')}`);
  }
  if (sitesLoggerKeys.length !== expected.blocks) {
    failures.push(
      `sites.access.log へ書く logger 数が期待値と不一致です（期待 ${expected.blocks} / 実際 ${sitesLoggerKeys.length}）`,
    );
  }

  const expectedMb = rollSizeToMb(expected.rollConfig.rollSize);
  const expectedDays = rollKeepForToDays(expected.rollConfig.rollKeepFor);
  const rollVariants = new Set(
    sitesLoggerKeys.map((k) => {
      const w = loggers[k].writer;
      return `${w?.roll_size_mb}/${w?.roll_keep}/${w?.roll_keep_days}`;
    }),
  );
  if (rollVariants.size > 1) {
    failures.push(`roll 設定が複数種類混在しています: ${[...rollVariants].join(', ')}`);
  } else if (rollVariants.size === 1) {
    const expectedVariant = `${expectedMb}/${expected.rollConfig.rollKeep}/${expectedDays}`;
    const actualVariant = [...rollVariants][0];
    if (actualVariant !== expectedVariant) {
      failures.push(`roll 設定が期待値と不一致です（期待 ${expectedVariant} / 実際 ${actualVariant}）`);
    }
  }

  const jsonText = JSON.stringify(adaptJson);
  const healthMatcherCount = (jsonText.match(new RegExp(HEALTH_CHECK_UA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? [])
    .length;
  if (healthMatcherCount !== sitesLoggerKeys.length) {
    failures.push(
      `health matcher の出現数が logger 数と不一致です（期待 ${sitesLoggerKeys.length} / 実際 ${healthMatcherCount}）`,
    );
  }

  return {
    ok: failures.length === 0,
    failures,
    stats: {
      loggerCount: sitesLoggerKeys.length,
      healthMatcherCount,
      multiLoggerHosts,
      rollVariants: rollVariants.size,
    },
  };
}
