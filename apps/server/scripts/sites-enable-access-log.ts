#!/usr/bin/env -S npx tsx
/**
 * DevRelay Sites Phase 1-B — access log 設定を Caddy に適用するスクリプト。
 *
 * **`--dry-run` が既定。**`--apply` を明示しない限り Caddy 設定には一切触れない。
 * `sudo tee` / `sudo rm` / `sudo systemctl reload caddy`（`testflight-manager.ts` と同じ
 * execAsync パターン。tee は shell interpolation を避けるため spawn+stdin で渡す）
 * 以外の sudo は使わない（devrelay の NOPASSWD 範囲内）。
 *
 * fail-closed の原則:
 *   - `/var/log/caddy/sites` が無い・権限が期待どおりでない → 即終了（Caddy に触れない）
 *   - `caddy adapt` が失敗する限り reload しない
 *   - W2（複数 host）を対象にする場合、`ROLLOUT_ROLL_CONFIG` が未確定なら即終了
 *     （`resolveRollConfig('rollout')` が投げる `RollConfigNotConfirmedError` をそのまま伝播させる）
 *   - 一括適用（`--apply` かつ `--only` なし）時、eligible host 集合が `W2_TARGET_HOSTS` と
 *     完全一致しない場合は即終了（denylist/inline host list の意図しない変化を検知）
 *   - 既適用 host は no-op（silent duplication は起こさない）。inconsistent（import 2 個等）は
 *     run 全体を中止する（pre-W2 修正 A）
 *   - rollback は batchId 完全一致でのみ実行し、既定は dry-run（`--apply` 併用で実行）
 *   - `--no-reload`（既定 off）: apply はするが `caddy adapt` 成功後の `systemctl reload` を
 *     行わない。W2 本番 rollout で「apply → 実ファイルに対する semantic diff / adapt JSON 検証
 *     → 問題なければ人間が明示的に reload」の間に検証ゲートを挟むためのフラグ（サイクル 2.0）。
 *     batchId とバックアップ先・手動 reload コマンドをログに出して終了する。
 *
 * 使い方:
 *   npx tsx scripts/sites-enable-access-log.ts --dry-run
 *   npx tsx scripts/sites-enable-access-log.ts --apply --only dangou-card-viewer.devrelay.io
 *   npx tsx scripts/sites-enable-access-log.ts --apply --only dangou-card-viewer.devrelay.io --no-skip-rules
 *   npx tsx scripts/sites-enable-access-log.ts --apply            (W2: 対象 host を指定しない=一括。roll 確定必須)
 *   npx tsx scripts/sites-enable-access-log.ts --apply --no-reload (W2: apply のみ行い reload は人間が実行)
 *   npx tsx scripts/sites-enable-access-log.ts --mode inline --apply --only <host>
 *   npx tsx scripts/sites-enable-access-log.ts --verify-mirror    (本番非接触。/tmp ミラーで W2 相当を検証)
 *   npx tsx scripts/sites-enable-access-log.ts --list-backups
 *   npx tsx scripts/sites-enable-access-log.ts --rollback <batchId>              (dry-run: 対象一覧のみ表示)
 *   npx tsx scripts/sites-enable-access-log.ts --rollback <batchId> --apply      (実行)
 *
 * W4（pixblog.net / ribbon-re.jp — 既存独自 logger を Sites 共有 snippet へ置換。Plan
 * 「DevRelay Sites Phase 1-B — W4 Final 2 Hosts Rollout Plan」参照）:
 *   npx tsx scripts/sites-enable-access-log.ts --w4-stage
 *     → sites.d/ribbon-re.jp・Caddyfile とも一切書き込まない（Caddy 無変更）。
 *       backup manifest 作成 + /tmp ミラーで W4 後の最終形を検証し、
 *       staging 済み Caddyfile を batchDir に置いて human sudo コマンドを表示して終了する。
 *   （human が表示された `sudo cp .../Caddyfile.new /etc/caddy/Caddyfile` を実行）
 *   npx tsx scripts/sites-enable-access-log.ts --w4-apply <batchId>
 *     → Caddyfile が staging 済み内容と一致することを確認 → sites.d/ribbon-re.jp を
 *       sudo tee で適用 → 実ファイルに対し caddy adapt + 構造検証 → PASS 時のみ reload 1 回。
 */

import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { readFile, readdir, writeFile, stat, mkdir, mkdtemp, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';
import {
  ACCESS_LOG_DIR,
  ACCESS_LOG_SNIPPET_FILE,
  RollConfigNotConfirmedError,
  W2_TARGET_HOSTS,
  W4_EXPECTED,
  isEligibleForAutoLog,
  isW3ExcludedHost,
  renderSnippet,
  resolveRollConfig,
  type SiteLogRollConfig,
} from '../src/services/sites/site-log-rules.js';
import {
  SITES_D_DIR,
  applyLogConfig,
  assertNoReservedMatcherCollision,
  assertSitesDPath,
  classifyHostForApply,
  detectAppliedState,
  isValidBatchId,
  newBatchId,
  parseManifest,
  planRollback,
  replaceLegacyLogWithSnippetImport,
  sha256Hex,
  verifyAdaptedConfig,
  type BackupManifest,
  type BackupManifestEntry,
  type HostClass,
} from '../src/services/sites/site-log-apply.js';

const execFileAsync = promisify(execFile);

const CADDY_SITES_DIR = SITES_D_DIR;
const CADDYFILE = '/etc/caddy/Caddyfile';
const BACKUP_DIR = join(homedir(), '.devrelay', 'sites-backups');
const TMP_DIR = tmpdir();

// ---------------------------------------------------------------------------
// W4 専用定数（Plan「DevRelay Sites Phase 1-B — W4 Final 2 Hosts Rollout Plan」§8 で
// 記録した preflight baseline。--w4-stage / --w4-apply 実行時にこの sha256 と現在の
// ファイル内容が一致することを確認し、Plan 作成時点からの drift を検知する）。
// ---------------------------------------------------------------------------

/** Plan 作成時点（2026-09-23 16:00:57 JST）の `/etc/caddy/Caddyfile` の sha256。 */
const W4_BASELINE_CADDYFILE_SHA256 = 'b5fdb4a06bdb3939b1b7a4b7c15e7062288920b7fdc4ed8df39ab3d70f830ce4';

/** Plan 作成時点（W1〜W3 で未変更・2026-08-14 14:19:08 JST）の `sites.d/ribbon-re.jp` の sha256。 */
const W4_BASELINE_RIBBON_SHA256 = '45bab8bf084dd4f24aea6db378cea742d4cc6ac3781625237a1a276420fb4648';

/**
 * `pixblog.net` ブロック内の既存独自 logger 部分（`/etc/caddy/Caddyfile` から
 * 正確に抽出した文字列。「アクセスログ（BOT比率の分析用）」というコメント込み）。
 * `reverse_proxy localhost:3002` の直後から、`log { }` ブロックの閉じ `\t}` までを含む
 * （site ブロック自体の閉じ `}` は含まない）。
 */
const PIXBLOG_LEGACY_LOG_BLOCK =
  '\n\t# アクセスログ（BOT比率の分析用）\n\tlog {\n\t\toutput file /var/log/caddy/pixblog.access.log {\n\t\t\troll_size 50MiB\n\t\t\troll_keep 7\n\t\t}\n\t}\n';

/**
 * `pixblog.net` ブロック全文（`/etc/caddy/Caddyfile` から正確に抽出）。
 *
 * `applyLogConfig`（延いては `replaceLegacyLogWithSnippetImport`）は「渡された content 全体が
 * ちょうど 1 個の site block である」ことを前提にしている（`findBlockOpenIndex` は content 内で
 * **最初に見つかった** `{` 終わりの行を site の開始行とみなす）。sites.d の各ファイルはこの前提を
 * 満たすが、`Caddyfile` はグローバルオプション block や他の複数 host block を含む
 * ため、`Caddyfile` 全文をそのまま渡すと誤って別の block（グローバルオプション等）の直後に
 * import を挿入してしまう。そのため pixblog.net は「block を丸ごと切り出して変換し、
 * 変換後の block を Caddyfile 全文へ 1 対 1 で差し戻す」という 2 段階の処理にする。
 */
const PIXBLOG_BLOCK_ORIGINAL = `pixblog.net {\n\treverse_proxy localhost:3002\n${PIXBLOG_LEGACY_LOG_BLOCK}}\n`;

/**
 * `sites.d/ribbon-re.jp` 末尾の既存独自 logger 部分（`file_server` の直後から
 * `log { }` ブロックの閉じ `\t}` までを含む。site ブロック自体の閉じ `}` は含まない）。
 */
const RIBBON_LEGACY_LOG_BLOCK =
  '\n\tlog {\n\t\toutput file /home/ribbon/sites/ribbon-re.jp/logs/access.log {\n\t\t\tmode 0644\n\t\t}\n\t}\n';

interface Args {
  apply: boolean;
  only: string | null;
  mode: 'snippet' | 'inline';
  noSkipRules: boolean;
  rollback: string | null;
  target: 'pilot' | 'rollout';
  listBackups: boolean;
  verifyMirror: boolean;
  force: boolean;
  /** apply はするが reload しない（W2 rollout での reload 前検証ゲート用。既定 false）。 */
  noReload: boolean;
  /** W4: sites.d/Caddyfile 無変更で backup manifest + /tmp ミラー検証のみ行う。 */
  w4Stage: boolean;
  /** W4: --w4-stage が出力した batchId を指定し、Caddyfile 配置後の適用を行う。 */
  w4Apply: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    apply: false,
    only: null,
    mode: 'snippet',
    noSkipRules: false,
    rollback: null,
    target: 'pilot',
    listBackups: false,
    verifyMirror: false,
    force: false,
    noReload: false,
    w4Stage: false,
    w4Apply: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--dry-run') args.apply = false;
    else if (a === '--only') args.only = argv[++i] ?? null;
    else if (a === '--mode') args.mode = argv[++i] === 'inline' ? 'inline' : 'snippet';
    else if (a === '--no-skip-rules') args.noSkipRules = true;
    else if (a === '--rollback') args.rollback = argv[++i] ?? null;
    else if (a === '--target') args.target = argv[++i] === 'rollout' ? 'rollout' : 'pilot';
    else if (a === '--list-backups') args.listBackups = true;
    else if (a === '--verify-mirror') args.verifyMirror = true;
    else if (a === '--force') args.force = true;
    else if (a === '--no-reload') args.noReload = true;
    else if (a === '--w4-stage') args.w4Stage = true;
    else if (a === '--w4-apply') args.w4Apply = argv[++i] ?? null;
  }
  return args;
}

function log(msg: string): void {
  console.log(msg);
}

function fail(msg: string): never {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// setgid ログディレクトリの検証（W0 は人間が事前実行。ここでは検査のみ）
// ---------------------------------------------------------------------------

async function resolveUidByName(name: string): Promise<number | null> {
  const text = await readFile('/etc/passwd', 'utf-8').catch(() => '');
  for (const line of text.split('\n')) {
    const parts = line.split(':');
    if (parts[0] === name) return Number(parts[2]);
  }
  return null;
}

async function resolveGidByName(name: string): Promise<number | null> {
  const text = await readFile('/etc/group', 'utf-8').catch(() => '');
  for (const line of text.split('\n')) {
    const parts = line.split(':');
    if (parts[0] === name) return Number(parts[2]);
  }
  return null;
}

async function checkAccessLogDir(): Promise<{ ok: boolean; reason?: string }> {
  if (!existsSync(ACCESS_LOG_DIR)) {
    return {
      ok: false,
      reason: `${ACCESS_LOG_DIR} が存在しません。人間が W0（setgid dir 作成: sudo mkdir/chown/chmod）を先に実行してください。`,
    };
  }
  const st = await stat(ACCESS_LOG_DIR);
  const modeOctal = st.mode & 0o7777;
  if (modeOctal !== 0o2750) {
    return { ok: false, reason: `${ACCESS_LOG_DIR} の mode が 2750 ではありません（現在 0${modeOctal.toString(8)}）。` };
  }
  const [caddyUid, devrelayGid] = await Promise.all([resolveUidByName('caddy'), resolveGidByName('devrelay')]);
  if (caddyUid === null || caddyUid !== st.uid) {
    return { ok: false, reason: `${ACCESS_LOG_DIR} の owner が caddy ではありません（uid=${st.uid}）。` };
  }
  if (devrelayGid === null || devrelayGid !== st.gid) {
    return { ok: false, reason: `${ACCESS_LOG_DIR} の group が devrelay ではありません（gid=${st.gid}）。` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 対象 host の判定（既適用/不整合を eligibility より先に見る。要件 A）
// ---------------------------------------------------------------------------

interface HostState {
  host: string;
  path: string;
  classification: HostClass;
}

async function listHostStates(): Promise<HostState[]> {
  const entries = await readdir(CADDY_SITES_DIR).catch(() => [] as string[]);
  const result: HostState[] = [];
  for (const host of entries) {
    if (host === ACCESS_LOG_SNIPPET_FILE) continue;
    const path = join(CADDY_SITES_DIR, host);
    const content = await readFile(path, 'utf-8').catch(() => null);
    if (content === null) continue;
    if (isW3ExcludedHost(host)) {
      result.push({ host, path, classification: { kind: 'ineligible', reason: 'W3 denylist（自動変更対象外）' } });
      continue;
    }
    result.push({ host, path, classification: classifyHostForApply(host, content, isEligibleForAutoLog) });
  }
  return result.sort((a, b) => a.host.localeCompare(b.host));
}

function describeClassification(c: HostClass): string {
  switch (c.kind) {
    case 'eligible':
      return 'eligible';
    case 'already-applied':
      return `already-applied（mode=${c.state.mode}）`;
    case 'inconsistent':
      return `inconsistent: ${c.reason}`;
    case 'ineligible':
      return `ineligible: ${c.reason}`;
  }
}

// ---------------------------------------------------------------------------
// caddy adapt 検証（validate ではなく adapt を使う。#258 と同因で validate は既存ログを開けず失敗する）
// ---------------------------------------------------------------------------

async function runAdapt(configPath: string): Promise<{ ok: boolean; output?: string; json?: unknown }> {
  try {
    const { stdout } = await execFileAsync('caddy', ['adapt', '--config', configPath, '--adapter', 'caddyfile']);
    return { ok: true, json: JSON.parse(stdout) };
  } catch (err) {
    const anyErr = err as { stderr?: string; message?: string };
    return { ok: false, output: anyErr.stderr || anyErr.message || String(err) };
  }
}

async function verifyAdapt(): Promise<{ ok: boolean; output?: string }> {
  const result = await runAdapt(CADDYFILE);
  return { ok: result.ok, output: result.output };
}

// ---------------------------------------------------------------------------
// sudo tee / sudo rm / reload（shell を経由しない。パスは必ず assertSitesDPath を通す）
// ---------------------------------------------------------------------------

/** `sudo tee <destPath>` に content を stdin 経由で渡す（cat | sudo tee のシェル連結を廃止）。 */
function sudoWriteFile(destPath: string, content: string): Promise<void> {
  assertSitesDPath(destPath);
  return new Promise((resolve, reject) => {
    const proc = spawn('sudo', ['tee', destPath], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`sudo tee ${destPath} が失敗しました（code=${code}）: ${stderr}`));
    });
    proc.stdin.write(content, 'utf-8');
    proc.stdin.end();
  });
}

/**
 * `sudo rm <path>`（引数ちょうど 1 個。`-f` を付けない）。
 * NOPASSWD は `/bin/rm /etc/caddy/sites.d/*` の 1 引数パターンのみ許可されており（B2-4 F4）、
 * `-f` を付けると非対話実行が失敗し得る。ファイルが元から無ければ何もしない（no-op）。
 */
async function sudoRemoveFile(path: string): Promise<void> {
  assertSitesDPath(path);
  if (!existsSync(path)) return; // -f が隠していた「既に無い」ケースを明示的に no-op 化
  await execFileAsync('sudo', ['rm', path]);
}

async function sudoReloadCaddy(): Promise<void> {
  await execFileAsync('sudo', ['systemctl', 'reload', 'caddy']);
}

// ---------------------------------------------------------------------------
// backup manifest の永続化（要件 C・D・E）
// ---------------------------------------------------------------------------

interface PreparedChange {
  originalPath: string;
  originalContent: string | null; // null = 新規作成（例: snippet 初回配備）
  newContent: string;
}

/**
 * バッチ用の backup ディレクトリ + manifest.json を作成する（sudo 不要・ローカル I/O のみ）。
 * **すべての sudo tee 実行前**にこれを完了させる（途中で失敗しても rollback 可能な状態を保つ）。
 */
async function prepareBackupManifest(
  changes: PreparedChange[],
  mode: 'snippet' | 'inline',
  target: 'pilot' | 'rollout',
  rollConfig: SiteLogRollConfig,
): Promise<{ batchId: string; batchDir: string; manifest: BackupManifest }> {
  const batchId = newBatchId(new Date(), randomBytes(4).toString('hex'));
  const batchDir = join(BACKUP_DIR, batchId);
  await mkdir(batchDir, { recursive: true });

  const entries: BackupManifestEntry[] = [];
  let seq = 0;
  for (const change of changes) {
    const sha256After = sha256Hex(change.newContent);
    if (change.originalContent === null) {
      entries.push({ originalPath: change.originalPath, action: 'created', backupFile: null, sha256Before: null, sha256After });
      continue;
    }
    seq += 1;
    const backupFile = `b${String(seq).padStart(4, '0')}.bak`;
    await writeFile(join(batchDir, backupFile), change.originalContent, 'utf-8');
    entries.push({
      originalPath: change.originalPath,
      action: 'modified',
      backupFile,
      sha256Before: sha256Hex(change.originalContent),
      sha256After,
    });
  }

  const manifest: BackupManifest = {
    version: 1,
    batchId,
    createdAt: new Date().toISOString(),
    mode,
    target,
    rollConfig,
    entries,
  };
  await writeFile(join(batchDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
  return { batchId, batchDir, manifest };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  assertNoReservedMatcherCollision();

  if (args.listBackups) {
    await doListBackups();
    return;
  }
  if (args.verifyMirror) {
    await doVerifyMirror();
    return;
  }
  if (args.rollback) {
    await doRollback(args.rollback, args.apply, args.force);
    return;
  }
  if (args.w4Stage) {
    await doW4Stage();
    return;
  }
  if (args.w4Apply) {
    await doW4Apply(args.w4Apply);
    return;
  }

  const dirCheck = await checkAccessLogDir();
  if (!dirCheck.ok) fail(dirCheck.reason ?? 'access log dir check failed');
  log(`✅ ${ACCESS_LOG_DIR} の権限確認 OK（uid=caddy / gid=devrelay / mode=2750）`);

  const states = await listHostStates();
  const inconsistent = states.filter((s) => s.classification.kind === 'inconsistent');
  if (inconsistent.length > 0) {
    for (const s of inconsistent) log(`❌ inconsistent: ${s.host} — ${describeClassification(s.classification)}`);
    fail('inconsistent な host が見つかりました。手動確認・修正が必要です（silent duplication を避けるため run 全体を中止します）。');
  }

  let targets: HostState[];
  if (args.only) {
    const found = states.find((s) => s.host === args.only);
    if (!found) fail(`--only ${args.only} は sites.d に見つかりません`);
    if (found.classification.kind === 'ineligible') {
      fail(`--only ${args.only} は自動変更対象ではありません（${describeClassification(found.classification)}）`);
    }
    if (found.classification.kind === 'already-applied') {
      log(`⏭️  ${args.only} は既に適用済みです（${describeClassification(found.classification)}）。no-op で終了します。`);
      return;
    }
    targets = [found];
  } else {
    const eligible = states.filter((s) => s.classification.kind === 'eligible');
    const alreadyApplied = states.filter((s) => s.classification.kind === 'already-applied');
    const eligibleHosts = eligible.map((s) => s.host).sort();
    const expectedHosts = [...W2_TARGET_HOSTS].sort();
    if (JSON.stringify(eligibleHosts) !== JSON.stringify(expectedHosts)) {
      log(`eligible host（${eligibleHosts.length} 件）: ${eligibleHosts.join(', ')}`);
      log(`W2_TARGET_HOSTS（${expectedHosts.length} 件）: ${expectedHosts.join(', ')}`);
      fail(
        '一括適用の対象は W2_TARGET_HOSTS と完全一致する必要があります。denylist/inline host list が変化した可能性があります（fail-closed）。',
      );
    }
    if (alreadyApplied.length > 0) {
      log(`ℹ️  既に適用済み（no-op・対象から除外）: ${alreadyApplied.map((s) => s.host).join(', ')}`);
    }
    targets = eligible;
    if (targets.length === 0) {
      log('✅ 一括適用対象は全て既に適用済みです（no-op）。');
      return;
    }
  }

  const resolveTarget: Args['target'] = args.only ? args.target : 'rollout';
  let rollConfig: SiteLogRollConfig;
  try {
    rollConfig = resolveRollConfig(resolveTarget);
  } catch (err) {
    if (err instanceof RollConfigNotConfirmedError) {
      fail(err.message);
    }
    throw err;
  }
  if (rollConfig.provisional) {
    log(`⚠️  暫定 roll 設定（pilot 用）を使用します: ${JSON.stringify(rollConfig)}`);
  }

  log(`対象 host（${targets.length} 件）: ${targets.map((t) => t.host).join(', ')}`);
  log(`mode=${args.mode} / skip rules 適用=${!args.noSkipRules} / apply=${args.apply}`);

  // 適用結果テキストを事前に全て計算する（sudo tee 前に自己検査・manifest 準備を終える）
  const preparedTargets: { host: string; path: string; original: string; updated: string }[] = [];
  for (const t of targets) {
    const original = await readFile(t.path, 'utf-8');
    const { updated, changed } = applyLogConfig(t.host, original, args.mode, rollConfig, !args.noSkipRules);
    if (!changed) {
      log(`⏭️  ${t.host} は変更なし（no-op）`);
      continue;
    }
    preparedTargets.push({ host: t.host, path: t.path, original, updated });
  }

  const snippetPath = join(CADDY_SITES_DIR, ACCESS_LOG_SNIPPET_FILE);
  const newSnippetContent = args.mode === 'snippet' ? renderSnippet(rollConfig) : null;

  if (!args.apply) {
    log('🔍 dry-run のため、ここで終了します（Caddy 設定は一切変更していません）。');
    if (newSnippetContent) {
      log(`--- ${ACCESS_LOG_SNIPPET_FILE} 適用予定の内容 ---`);
      log(newSnippetContent);
    }
    for (const p of preparedTargets) {
      log(`--- ${p.host} 適用予定の差分プレビュー ---`);
      log(p.updated);
    }
    return;
  }

  if (preparedTargets.length === 0 && !newSnippetContent) {
    log('✅ 適用対象の変更はありません（no-op）。');
    return;
  }

  // backup manifest を準備（sudo 呼び出し前にローカルへ確定させる）
  const changes: PreparedChange[] = [];
  if (newSnippetContent) {
    const existingSnippet = await readFile(snippetPath, 'utf-8').catch(() => null);
    changes.push({ originalPath: snippetPath, originalContent: existingSnippet, newContent: newSnippetContent });
  }
  for (const p of preparedTargets) {
    changes.push({ originalPath: p.path, originalContent: p.original, newContent: p.updated });
  }

  const { batchId, batchDir } = await prepareBackupManifest(changes, args.mode, resolveTarget, rollConfig);
  log(`🗂️  backup manifest 作成: ${batchDir}/manifest.json（batchId=${batchId}）`);

  // 1. snippet モードなら snippet ファイルを配備（inline モードでは不要）
  if (newSnippetContent) {
    await sudoWriteFile(snippetPath, newSnippetContent);
    log(`📝 snippet 配備: ${snippetPath}`);
  }

  // 2. 対象 site ファイルへ log 設定 + skip ルールを反映
  for (const p of preparedTargets) {
    await sudoWriteFile(p.path, p.updated);
    log(`📝 site 設定更新: ${p.path}`);
  }

  // 3. adapt 検証（成功するまで絶対に reload しない）
  const adaptResult = await verifyAdapt();
  if (!adaptResult.ok) {
    log(`❌ caddy adapt に失敗しました。reload は行いません。出力: ${adaptResult.output}`);
    log(`↩️  原状復帰する場合: npx tsx scripts/sites-enable-access-log.ts --rollback ${batchId} --apply`);
    process.exit(1);
  }
  log('✅ caddy adapt 成功');

  // 4. reload（--no-reload 時はここで止め、reload は人間が明示的に実行する）
  if (args.noReload) {
    log('⏸️  --no-reload のため reload をスキップしました（apply のみ完了）。');
    log(`バックアップ: ${batchDir}（batchId=${batchId}）`);
    log('   検証後に reload する場合: sudo systemctl reload caddy');
    log(`   問題があり戻す場合: npx tsx scripts/sites-enable-access-log.ts --rollback ${batchId} --apply`);
    return;
  }
  await sudoReloadCaddy();
  log('🔄 caddy reload 完了');
  log(`バックアップ: ${batchDir}（batchId=${batchId}）`);
}

// ---------------------------------------------------------------------------
// --list-backups
// ---------------------------------------------------------------------------

async function doListBackups(): Promise<void> {
  const entries = await readdir(BACKUP_DIR, { withFileTypes: true }).catch(() => []);
  const batchDirs = entries.filter((e) => e.isDirectory() && isValidBatchId(e.name));
  const legacyFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.bak'));

  if (batchDirs.length === 0 && legacyFiles.length === 0) {
    log(`バックアップはありません（${BACKUP_DIR}）`);
    return;
  }

  for (const dir of batchDirs.sort((a, b) => a.name.localeCompare(b.name))) {
    const manifestPath = join(BACKUP_DIR, dir.name, 'manifest.json');
    const raw = await readFile(manifestPath, 'utf-8').catch(() => null);
    if (raw === null) {
      log(`⚠️  ${dir.name}: manifest.json が見つかりません`);
      continue;
    }
    try {
      const manifest = parseManifest(JSON.parse(raw));
      log(
        `📦 ${manifest.batchId}  created=${manifest.createdAt}  mode=${manifest.mode}  target=${manifest.target}  entries=${manifest.entries.length}`,
      );
    } catch (err) {
      log(`⚠️  ${dir.name}: manifest.json の形式が不正です（${err instanceof Error ? err.message : String(err)}）`);
    }
  }
  if (legacyFiles.length > 0) {
    log(`--- legacy（manifest なし・rollback 非対応）: ${legacyFiles.length} 件 ---`);
    for (const f of legacyFiles) log(`  ${f.name}`);
  }
}

// ---------------------------------------------------------------------------
// --rollback <batchId> [--apply] [--force]
// ---------------------------------------------------------------------------

async function doRollback(batchId: string, apply: boolean, force: boolean): Promise<void> {
  if (!isValidBatchId(batchId)) {
    fail(`batchId の形式が不正です: ${JSON.stringify(batchId)}（--list-backups で正しい ID を確認してください）`);
  }
  const batchDir = join(BACKUP_DIR, batchId);
  const manifestPath = join(batchDir, 'manifest.json');
  const raw = await readFile(manifestPath, 'utf-8').catch(() => null);
  if (raw === null) {
    fail(`batchId ${batchId} の manifest.json が見つかりません（${manifestPath}）。--list-backups で確認してください。`);
  }
  const manifest = parseManifest(JSON.parse(raw!));

  const currentHashes = new Map<string, string>();
  for (const entry of manifest.entries) {
    assertSitesDPath(entry.originalPath);
    const content = await readFile(entry.originalPath, 'utf-8').catch(() => null);
    if (content !== null) currentHashes.set(entry.originalPath, sha256Hex(content));
  }

  const ops = planRollback(manifest, currentHashes);
  if (ops.length === 0) {
    fail('rollback 対象が 0 件です（manifest の entries と現在の状態が一致しません）。fail-closed のため中止します。');
  }

  log(`--- rollback 計画（batchId=${batchId}） ---`);
  for (const op of ops) {
    if (op.kind === 'restore') log(`  復元: ${op.originalPath} ← ${op.backupFile}`);
    else if (op.kind === 'delete') log(`  削除: ${op.originalPath}（このバッチで新規作成されたファイル）`);
    else log(`  ⚠️  drift: ${op.originalPath} — ${op.reason}`);
  }

  const driftOps = ops.filter((op) => op.kind === 'drift');
  if (driftOps.length > 0 && !force) {
    fail(`drift が ${driftOps.length} 件検出されました。適用後に別の変更が入っている可能性があります。--force で無視して続行できます（fail-closed）。`);
  }

  if (!apply) {
    log('🔍 dry-run のため、ここで終了します（--apply を付けると実行します）。');
    return;
  }

  for (const op of ops) {
    if (op.kind === 'drift') {
      log(`⏭️  drift のためスキップ（--force）: ${op.originalPath}`);
      continue;
    }
    if (op.kind === 'restore') {
      const backupContent = await readFile(join(batchDir, op.backupFile), 'utf-8');
      await sudoWriteFile(op.originalPath, backupContent);
      log(`↩️  復元: ${op.originalPath}`);
    } else if (op.kind === 'delete') {
      await sudoRemoveFile(op.originalPath);
      log(`🗑️  削除: ${op.originalPath}`);
    }
  }

  const adaptResult = await verifyAdapt();
  if (!adaptResult.ok) {
    fail(`rollback 後の caddy adapt に失敗しました。手動確認が必要です。出力: ${adaptResult.output}`);
  }
  await sudoReloadCaddy();
  log('✅ rollback 完了・caddy reload 済み');
}

// ---------------------------------------------------------------------------
// 期待される host / block 数の算出（sites.d + Caddyfile 両方を走査する）
//
// 修正前（W3 適用時点で発覚。W4 Plan §5.1）: この計算は `sites.d` の readdir のみを見ており、
// Caddyfile 直書き host（devrelay.io 等 7 件・W3）を一切数えていなかった。そのため
// `--verify-mirror` は W3 適用後、常に「期待 22 / 実際 31」で FAIL する状態だった
// （sites.d 分 22 のみを期待し、Caddyfile 分 9 を無視していたため）。
//
// ここでは sites.d の各ファイルと Caddyfile の各トップレベル block（インデント無しで
// `{` 終わりの行から、次のインデント無し `}` 行まで）の双方を走査し、
// `import sites_access_log` または inline log ブロックを持つものだけを対象にする。
// block のヘッダ行（`host1, host2 {`）から host をカンマ区切りで抽出するため、
// `ribbon-re.jp, www.ribbon-re.jp` のような複数 host 1 block も正しく host 数に反映される
// （block 数は 1 のまま・host 数は 2 になる）。
// ---------------------------------------------------------------------------

interface ExpectedSitesLoggerState {
  /** access log を持つ（べき）host 一覧（alias 含む・重複排除・ソート済み） */
  hosts: string[];
  /** access log を持つ（べき）block 数（= 期待される logger 数） */
  blocks: number;
}

/**
 * Caddy テキストのトップレベル block（インデント無し `header {` 〜 次のインデント無し `}`）を
 * 抽出する。`Caddyfile` だけでなく `sites.d/<host>` ファイルにも使う共通ロジック
 * （host header 行が `#` コメントで無効化されている行は `[^\s#{}]` により候補から除外される。
 * これにより `sites.d/pixterm-server.devrelay.io` のような「先頭にコメントアウト版の旧定義が
 * 残っている」ファイルでも、実際に有効な block だけを host として数える）。
 */
function extractCaddyfileTopLevelBlocks(content: string): { header: string; body: string }[] {
  const lines = content.split('\n');
  const blocks: { header: string; body: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // トップレベル＝行頭に空白が無い。コメント行・空行・`}` 単体行は除外。
    const m = /^([^\s#{}][^{}]*?)\s*\{\s*$/.exec(line);
    if (!m) continue;
    const header = m[1].trim();
    let j = i + 1;
    const bodyLines: string[] = [];
    while (j < lines.length && lines[j] !== '}') {
      bodyLines.push(lines[j]);
      j++;
    }
    blocks.push({ header, body: bodyLines.join('\n') });
    i = j;
  }
  return blocks;
}

/**
 * `sitesDir`（`sites.d` 相当）と `caddyfilePath`（`Caddyfile` 相当）を走査し、
 * access log（snippet import または inline log ブロック）を持つ host / block 数を算出する。
 * 本番・`/tmp` ミラーの両方で同じロジックを使うため、パスを引数化してある。
 */
async function computeExpectedSitesLoggerState(sitesDir: string, caddyfilePath: string): Promise<ExpectedSitesLoggerState> {
  const hosts = new Set<string>();
  let blocks = 0;

  const addEligibleBlocks = (content: string): void => {
    for (const block of extractCaddyfileTopLevelBlocks(content)) {
      const state = detectAppliedState(block.body);
      if (state.mode !== 'snippet' && state.mode !== 'inline') continue;
      for (const h of block.header.split(',').map((h) => h.trim()).filter(Boolean)) hosts.add(h);
      blocks += 1;
    }
  };

  // sites.d/*（snippet ファイル自身は除外。ファイル内に複数 block がある場合
  // ＝ pixterm-server.devrelay.io のような「コメントアウト版の旧定義＋実定義」も
  // block 単位で正しく判定される）
  const files = await readdir(sitesDir).catch(() => [] as string[]);
  for (const f of files) {
    if (f === ACCESS_LOG_SNIPPET_FILE) continue;
    const content = await readFile(join(sitesDir, f), 'utf-8').catch(() => null);
    if (content === null) continue;
    addEligibleBlocks(content);
  }

  // Caddyfile 直書き block（W3: devrelay.io 等・W4: pixblog.net）
  const caddyfileContent = await readFile(caddyfilePath, 'utf-8').catch(() => '');
  addEligibleBlocks(caddyfileContent);

  return { hosts: [...hosts].sort(), blocks };
}

// ---------------------------------------------------------------------------
// --verify-mirror（本番 Caddy 非接触。/tmp ミラーで W2 適用後の構造を検証する）
// ---------------------------------------------------------------------------

async function doVerifyMirror(): Promise<void> {
  const mirrorDir = await mkdtemp(join(TMP_DIR, 'drl-sites-verify-'));
  const mirrorSitesDir = join(mirrorDir, 'sites.d');
  try {
    await mkdir(mirrorSitesDir, { recursive: true });

    const hostFiles = await readdir(CADDY_SITES_DIR).catch(() => [] as string[]);
    for (const f of hostFiles) {
      const content = await readFile(join(CADDY_SITES_DIR, f), 'utf-8').catch(() => null);
      if (content !== null) await writeFile(join(mirrorSitesDir, f), content, 'utf-8');
    }

    const caddyfileContent = await readFile(CADDYFILE, 'utf-8');
    const mirrorCaddyfile = caddyfileContent.replace(
      new RegExp(`import\\s+${CADDY_SITES_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\*`),
      `import ${mirrorSitesDir}/*`,
    );
    if (mirrorCaddyfile === caddyfileContent) {
      fail(`Caddyfile 内に "import ${CADDY_SITES_DIR}/*" が見つかりませんでした。ミラー検証を中止します。`);
    }
    const mirrorCaddyfilePath = join(mirrorDir, 'Caddyfile');
    await writeFile(mirrorCaddyfilePath, mirrorCaddyfile, 'utf-8');

    const rollConfig = resolveRollConfig('rollout');

    // snippet を確定値（health skip 込み）で上書き（B2-4 D2・pre-W2 修正 F）
    await writeFile(join(mirrorSitesDir, ACCESS_LOG_SNIPPET_FILE), renderSnippet(rollConfig), 'utf-8');

    // eligible host（W2_TARGET_HOSTS と一致するはず）に snippet import を適用
    let appliedCount = 0;
    for (const host of hostFiles) {
      if (host === ACCESS_LOG_SNIPPET_FILE) continue;
      if (isW3ExcludedHost(host)) continue;
      const path = join(mirrorSitesDir, host);
      const content = await readFile(path, 'utf-8').catch(() => null);
      if (content === null) continue;
      const classification = classifyHostForApply(host, content, isEligibleForAutoLog);
      if (classification.kind !== 'eligible') continue; // already-applied はミラーの snippet 書き換えだけで恩恵を受ける
      const { updated, changed } = applyLogConfig(host, content, 'snippet', rollConfig, true);
      if (changed) {
        await writeFile(path, updated, 'utf-8');
        appliedCount += 1;
      }
    }
    log(`ミラー上で ${appliedCount} host に import を適用しました。`);

    // 最終的にログ設定が有効な host / block 数を再スキャン（sites.d + Caddyfile 直書き双方を数える。
    // W4 Plan §5.1 で発覚した「Caddyfile 直書き host を数えていない」不具合の修正版）
    const expected = await computeExpectedSitesLoggerState(mirrorSitesDir, mirrorCaddyfilePath);
    log(`期待される logger 保持 host（${expected.hosts.length} 件）: ${expected.hosts.join(', ')}`);
    log(`期待される block（logger）数: ${expected.blocks}`);

    const adaptResult = await runAdapt(mirrorCaddyfilePath);
    if (!adaptResult.ok) {
      fail(`ミラー上の caddy adapt に失敗しました: ${adaptResult.output}`);
    }
    log('✅ ミラー上の caddy adapt 成功');

    const assertion = verifyAdaptedConfig(adaptResult.json, { hosts: expected.hosts, blocks: expected.blocks, rollConfig });
    log(
      `構造検証: logger数=${assertion.stats.loggerCount} / health matcher数=${assertion.stats.healthMatcherCount} / roll設定種類=${assertion.stats.rollVariants} / 複数logger host=${assertion.stats.multiLoggerHosts.length}`,
    );
    if (!assertion.ok) {
      for (const f of assertion.failures) log(`❌ ${f}`);
      fail('ミラー検証 FAIL（本番 Caddy には一切触れていません）。');
    }
    log('✅ ミラー検証 PASS（本番 Caddy には一切触れていません）。');
  } finally {
    await rm(mirrorDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// W4（pixblog.net / ribbon-re.jp — 既存独自 logger を Sites 共有 snippet へ置換）
//
// 通常の `--apply` 経路は使わない: `ribbon-re.jp` / Caddyfile 直書き host は
// `isEligibleForAutoLog` が false を返す（W3 denylist）ため、そもそも対象にならない。
// 仮に denylist を外しても `detectAppliedState` の inline 検出は
// `/var/log/caddy/sites/sites.access.log` のみを見るため、既存の独自 `log { }` を
// 検出できず import が追加されるだけ（1 host = 2 logger になり不変条件を破る）。
// このため W4 専用に「既存 log ブロックを削除 → import を挿入」を行う。
//
// Caddyfile は `assertSitesDPath` の対象外（sites.d 以外への書き込みを構造的に拒否する
// 安全装置をそのまま維持する）ため、agent は sudo tee できない。Plan の要求どおり、
// Caddyfile への書き込みは常に human sudo（`sudo cp`）を経由させる。
// ---------------------------------------------------------------------------

interface W4Changes {
  caddyfileContent: string;
  caddyfileUpdated: string;
  ribbonPath: string;
  ribbonContent: string;
  ribbonUpdated: string;
  rollConfig: SiteLogRollConfig;
}

/**
 * 現在の実ファイルを読み、Plan 記録時点からの drift が無いことを確認したうえで、
 * legacy log ブロックの削除 + `import sites_access_log` 挿入後の内容を計算する
 * （純粋な読み取り＋計算のみ。sudo は一切呼ばない）。
 */
async function buildW4Changes(): Promise<W4Changes> {
  const rollConfig = resolveRollConfig('rollout');

  const caddyfileContent = await readFile(CADDYFILE, 'utf-8');
  const caddyfileSha = sha256Hex(caddyfileContent);
  if (caddyfileSha !== W4_BASELINE_CADDYFILE_SHA256) {
    fail(
      `/etc/caddy/Caddyfile が Plan 記録時点から変化しています（drift）。期待 sha256=${W4_BASELINE_CADDYFILE_SHA256} / 実際 ${caddyfileSha}。Plan の再確認が必要です。`,
    );
  }

  const ribbonPath = join(CADDY_SITES_DIR, 'ribbon-re.jp');
  const ribbonContent = await readFile(ribbonPath, 'utf-8');
  const ribbonSha = sha256Hex(ribbonContent);
  if (ribbonSha !== W4_BASELINE_RIBBON_SHA256) {
    fail(
      `sites.d/ribbon-re.jp が Plan 記録時点から変化しています（drift）。期待 sha256=${W4_BASELINE_RIBBON_SHA256} / 実際 ${ribbonSha}。Plan の再確認が必要です。`,
    );
  }

  // pixblog.net は Caddyfile 全文の中の 1 block に過ぎないため、その block だけを切り出して
  // 変換し、変換後の block を Caddyfile 全文へ差し戻す（buildW4Changes 直上のコメント参照）。
  const pixblogOccurrences = caddyfileContent.split(PIXBLOG_BLOCK_ORIGINAL).length - 1;
  if (pixblogOccurrences !== 1) {
    fail(
      `pixblog.net block の出現数が想定外です（期待 1 / 実際 ${pixblogOccurrences}）。Caddyfile の内容が Plan 記録時点から変化している可能性があります。`,
    );
  }
  const pixblogBlockResult = replaceLegacyLogWithSnippetImport('pixblog.net', PIXBLOG_BLOCK_ORIGINAL, PIXBLOG_LEGACY_LOG_BLOCK, rollConfig);
  const caddyfileUpdated = caddyfileContent.split(PIXBLOG_BLOCK_ORIGINAL).join(pixblogBlockResult.updated);

  const ribbonResult = replaceLegacyLogWithSnippetImport(
    'ribbon-re.jp,www.ribbon-re.jp',
    ribbonContent,
    RIBBON_LEGACY_LOG_BLOCK,
    rollConfig,
  );

  return {
    caddyfileContent,
    caddyfileUpdated,
    ribbonPath,
    ribbonContent,
    ribbonUpdated: ribbonResult.updated,
    rollConfig,
  };
}

interface W4RibbonChange {
  ribbonPath: string;
  ribbonContent: string;
  ribbonUpdated: string;
  rollConfig: SiteLogRollConfig;
}

/**
 * `--w4-apply` 専用。`buildW4Changes`（`--w4-stage` 専用）とは異なり、Caddyfile が
 * **cp 前**（`W4_BASELINE_CADDYFILE_SHA256`）であることは要求しない — `doW4Apply` は既に
 * sidecar（`caddyfile-change.json.sha256After`）で「staging 済み内容と完全一致」を確認済み
 * であり、そちらのほうが厳格なチェックのため二重には行わない。
 *
 * ribbon-re.jp 側の drift 検証（`W4_BASELINE_RIBBON_SHA256`）はそのまま維持し、さらに
 * 計算結果が `manifest.json` の `sha256After`（stage 時点で確定した適用後内容）と一致する
 * ことを書き込み前に assert する（fail-closed。不一致なら `sudoWriteFile` に到達しない）。
 */
async function buildW4RibbonChange(batchId: string): Promise<W4RibbonChange> {
  const rollConfig = resolveRollConfig('rollout');

  const batchDir = join(BACKUP_DIR, batchId);
  const manifestPath = join(batchDir, 'manifest.json');
  const manifestRaw = await readFile(manifestPath, 'utf-8').catch(() => null);
  if (manifestRaw === null) {
    fail(`${manifestPath} が見つかりません。先に --w4-stage を実行してください（batchId=${batchId}）。`);
  }
  const manifest = parseManifest(JSON.parse(manifestRaw!));
  const ribbonPath = join(CADDY_SITES_DIR, 'ribbon-re.jp');
  const ribbonEntry = manifest.entries.find((e) => e.originalPath === ribbonPath);
  if (!ribbonEntry) {
    fail(`manifest.json（batchId=${batchId}）に sites.d/ribbon-re.jp のエントリが見つかりません。`);
  }

  const ribbonContent = await readFile(ribbonPath, 'utf-8');
  const ribbonSha = sha256Hex(ribbonContent);
  if (ribbonSha !== W4_BASELINE_RIBBON_SHA256) {
    fail(
      `sites.d/ribbon-re.jp が Plan 記録時点から変化しています（drift）。期待 sha256=${W4_BASELINE_RIBBON_SHA256} / 実際 ${ribbonSha}。Plan の再確認が必要です。`,
    );
  }

  const ribbonResult = replaceLegacyLogWithSnippetImport(
    'ribbon-re.jp,www.ribbon-re.jp',
    ribbonContent,
    RIBBON_LEGACY_LOG_BLOCK,
    rollConfig,
  );

  const ribbonUpdatedSha = sha256Hex(ribbonResult.updated);
  if (ribbonUpdatedSha !== ribbonEntry!.sha256After) {
    fail(
      `sites.d/ribbon-re.jp の計算後内容が manifest.json の sha256After と一致しません（期待 ${ribbonEntry!.sha256After} / 実際 ${ribbonUpdatedSha}）。書き込みは行いません。`,
    );
  }

  return {
    ribbonPath,
    ribbonContent,
    ribbonUpdated: ribbonResult.updated,
    rollConfig,
  };
}

/** W4 の期待値（host 34 / block 33）と一致するかを検証する（不一致なら fail-closed）。 */
function assertW4Expected(expected: ExpectedSitesLoggerState, label: string, rollbackHint = ''): void {
  if (expected.blocks !== W4_EXPECTED.blocks || expected.hosts.length !== W4_EXPECTED.hosts) {
    fail(
      `${label}: 期待値が Plan と不一致です（期待 blocks=${W4_EXPECTED.blocks}/hosts=${W4_EXPECTED.hosts} / 実際 blocks=${expected.blocks}/hosts=${expected.hosts.length}）。処理を中止します。${rollbackHint}`,
    );
  }
}

/**
 * `/tmp` ミラー上に W4 適用後の最終形を再現し、`caddy adapt` + `verifyAdaptedConfig` で検証する。
 * 本番 Caddy には一切触れない。
 */
async function verifyW4Mirror(changes: W4Changes): Promise<void> {
  const mirrorDir = await mkdtemp(join(TMP_DIR, 'drl-sites-w4-'));
  try {
    const mirrorSitesDir = join(mirrorDir, 'sites.d');
    await mkdir(mirrorSitesDir, { recursive: true });

    const hostFiles = await readdir(CADDY_SITES_DIR).catch(() => [] as string[]);
    for (const f of hostFiles) {
      const content = f === 'ribbon-re.jp' ? changes.ribbonUpdated : await readFile(join(CADDY_SITES_DIR, f), 'utf-8').catch(() => null);
      if (content === null) continue;
      await writeFile(join(mirrorSitesDir, f), content, 'utf-8');
    }

    const mirrorCaddyfile = changes.caddyfileUpdated.replace(
      new RegExp(`import\\s+${CADDY_SITES_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\*`),
      `import ${mirrorSitesDir}/*`,
    );
    if (mirrorCaddyfile === changes.caddyfileUpdated) {
      fail(`W4 ミラー: Caddyfile 内に "import ${CADDY_SITES_DIR}/*" が見つかりませんでした。検証を中止します。`);
    }
    const mirrorCaddyfilePath = join(mirrorDir, 'Caddyfile');
    await writeFile(mirrorCaddyfilePath, mirrorCaddyfile, 'utf-8');

    const adaptResult = await runAdapt(mirrorCaddyfilePath);
    if (!adaptResult.ok) {
      fail(`W4 ミラー: caddy adapt に失敗しました: ${adaptResult.output}`);
    }
    log('✅ W4 ミラー: caddy adapt 成功');

    const expected = await computeExpectedSitesLoggerState(mirrorSitesDir, mirrorCaddyfilePath);
    log(`W4 ミラー: 期待される host 数=${expected.hosts.length} / block 数=${expected.blocks}`);
    assertW4Expected(expected, 'W4 ミラー');

    const assertion = verifyAdaptedConfig(adaptResult.json, {
      hosts: expected.hosts,
      blocks: expected.blocks,
      rollConfig: changes.rollConfig,
    });
    log(
      `W4 ミラー構造検証: logger数=${assertion.stats.loggerCount} / health matcher数=${assertion.stats.healthMatcherCount} / roll設定種類=${assertion.stats.rollVariants} / 複数logger host=${assertion.stats.multiLoggerHosts.length}`,
    );
    if (!assertion.ok) {
      for (const f of assertion.failures) log(`❌ ${f}`);
      fail('W4 ミラー検証 FAIL（本番 Caddy には一切触れていません）。');
    }
    log('✅ W4 ミラー検証 PASS（本番 Caddy には一切触れていません）。');
  } finally {
    await rm(mirrorDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * `--w4-stage`: 本番 Caddy・sites.d に一切書き込まない。
 * backup manifest（ribbon 分。既存の manifest 方式をそのまま使い `--rollback` で戻せるようにする）と、
 * Caddyfile 側の staging ファイル（`Caddyfile.new` + sidecar JSON。sites.d 外のため
 * manifest 方式の自動 rollback 対象外。human sudo cp のみで戻す）を同一 batchDir に作成し、
 * `/tmp` ミラーで W4 適用後の最終形を検証したうえで、human 用の実行コマンドを表示して終了する。
 */
async function doW4Stage(): Promise<void> {
  const changes = await buildW4Changes();
  log('✅ Caddyfile / sites.d/ribbon-re.jp とも Plan 記録時点から変化していません（drift なし）。');

  const before = await computeExpectedSitesLoggerState(CADDY_SITES_DIR, CADDYFILE);
  log(`W4 適用前: host 数=${before.hosts.length} / block 数=${before.blocks}（W2/W3 の 31 と一致するはず）`);

  await verifyW4Mirror(changes);

  // backup manifest は ribbon（sites.d）のみを対象にする（Caddyfile は assertSitesDPath の対象外）
  const manifestChanges: PreparedChange[] = [
    { originalPath: changes.ribbonPath, originalContent: changes.ribbonContent, newContent: changes.ribbonUpdated },
  ];
  const { batchId, batchDir } = await prepareBackupManifest(manifestChanges, 'snippet', 'rollout', changes.rollConfig);
  log(`🗂️  backup manifest 作成: ${batchDir}/manifest.json（batchId=${batchId}）`);

  const ribbonPreviewPath = join(batchDir, 'ribbon-re.jp.new');
  await writeFile(ribbonPreviewPath, changes.ribbonUpdated, 'utf-8');

  const caddyfileBeforePath = join(batchDir, 'Caddyfile.before');
  const caddyfileNewPath = join(batchDir, 'Caddyfile.new');
  await writeFile(caddyfileBeforePath, changes.caddyfileContent, 'utf-8');
  await writeFile(caddyfileNewPath, changes.caddyfileUpdated, 'utf-8');
  const caddyfileSidecar = {
    path: CADDYFILE,
    sha256Before: sha256Hex(changes.caddyfileContent),
    sha256After: sha256Hex(changes.caddyfileUpdated),
    note: 'sites.d 外のため sudoWriteFile 経由の自動 rollback 対象外。戻す場合は human sudo cp のみ（Caddyfile.before を参照）。',
  };
  await writeFile(join(batchDir, 'caddyfile-change.json'), JSON.stringify(caddyfileSidecar, null, 2), 'utf-8');

  log('');
  log('⏸️  ここで停止します。Caddyfile の変更は human sudo が必要です。以下を実行してください:');
  log('');
  log(`   sudo cp ${caddyfileNewPath} ${CADDYFILE}`);
  log('');
  log(`バックアップ・staging: ${batchDir}（batchId=${batchId}）`);
  log('上記コマンド実行後、続けて以下を実行してください（sites.d/ribbon-re.jp の適用 + reload 前検証 + reload）:');
  log('');
  log(`   npx tsx scripts/sites-enable-access-log.ts --w4-apply ${batchId}`);
  log('');
  log('本番 Caddy・sites.d には一切書き込んでいません（reload 0 回）。');
}

/**
 * `--w4-apply <batchId>`: human が Caddyfile を配置した後に呼ぶ。
 * 1) Caddyfile が staging 済み内容と一致することを確認
 * 2) sites.d/ribbon-re.jp を sudo tee で適用（NOPASSWD）
 * 3) 実ファイルに対し caddy adapt + 構造検証（PASS 時のみ）
 * 4) reload 1 回（失敗時は reload しない。追加 reload も行わない）
 */
async function doW4Apply(batchId: string): Promise<void> {
  if (!isValidBatchId(batchId)) {
    fail(`batchId の形式が不正です: ${JSON.stringify(batchId)}`);
  }
  const batchDir = join(BACKUP_DIR, batchId);
  const sidecarPath = join(batchDir, 'caddyfile-change.json');
  const sidecarRaw = await readFile(sidecarPath, 'utf-8').catch(() => null);
  if (sidecarRaw === null) {
    fail(`${sidecarPath} が見つかりません。先に --w4-stage を実行してください（batchId=${batchId}）。`);
  }
  const sidecar = JSON.parse(sidecarRaw!) as { path: string; sha256Before: string; sha256After: string };

  const currentCaddyfile = await readFile(CADDYFILE, 'utf-8');
  const currentCaddyfileSha = sha256Hex(currentCaddyfile);
  if (currentCaddyfileSha !== sidecar.sha256After) {
    fail(
      `/etc/caddy/Caddyfile が staging 済みの内容と一致しません（期待 ${sidecar.sha256After} / 実際 ${currentCaddyfileSha}）。` +
        `human が \`sudo cp ${join(batchDir, 'Caddyfile.new')} /etc/caddy/Caddyfile\` を実行したか確認してください。`,
    );
  }
  log('✅ /etc/caddy/Caddyfile が staging 済みの内容と一致することを確認しました。');

  // manifest から ribbon の適用予定内容を取得（stage 時に書いた b0001.bak は「適用前」なので、
  // 適用後の内容は再計算する。ribbon 側ファイルはまだ書き換えていないため、
  // buildW4RibbonChange の drift チェック（W4_BASELINE_RIBBON_SHA256 比較）はここでも安全に
  // 機能する。buildW4Changes（Caddyfile が cp 前であることを要求する --w4-stage 専用）は
  // ここでは使わない — Caddyfile 側は直前で sidecar sha256After により既に確認済み）
  const changes = await buildW4RibbonChange(batchId);

  await sudoWriteFile(changes.ribbonPath, changes.ribbonUpdated);
  log(`📝 site 設定更新: ${changes.ribbonPath}`);

  const adaptResult = await runAdapt(CADDYFILE);
  if (!adaptResult.ok) {
    fail(
      `caddy adapt に失敗しました。reload は行いません。出力: ${adaptResult.output}\n` +
        `↩️  原状復帰: sudo cp ${join(batchDir, 'Caddyfile.before')} /etc/caddy/Caddyfile && ` +
        `npx tsx scripts/sites-enable-access-log.ts --rollback ${batchId} --apply`,
    );
  }
  log('✅ caddy adapt 成功（実ファイル）');

  const expected = await computeExpectedSitesLoggerState(CADDY_SITES_DIR, CADDYFILE);
  log(`W4 適用後: host 数=${expected.hosts.length} / block 数=${expected.blocks}`);
  const rollbackHint =
    `\n↩️  原状復帰: sudo cp ${join(batchDir, 'Caddyfile.before')} /etc/caddy/Caddyfile && ` +
    `npx tsx scripts/sites-enable-access-log.ts --rollback ${batchId} --apply`;
  assertW4Expected(expected, 'W4 適用後（reload 前）', rollbackHint);

  const assertion = verifyAdaptedConfig(adaptResult.json, {
    hosts: expected.hosts,
    blocks: expected.blocks,
    rollConfig: changes.rollConfig,
  });
  log(
    `構造検証: logger数=${assertion.stats.loggerCount} / health matcher数=${assertion.stats.healthMatcherCount} / roll設定種類=${assertion.stats.rollVariants} / 複数logger host=${assertion.stats.multiLoggerHosts.length}`,
  );
  if (!assertion.ok) {
    for (const f of assertion.failures) log(`❌ ${f}`);
    fail(
      `W4 実ファイル検証 FAIL。reload しません。\n` +
        `↩️  原状復帰: sudo cp ${join(batchDir, 'Caddyfile.before')} /etc/caddy/Caddyfile && ` +
        `npx tsx scripts/sites-enable-access-log.ts --rollback ${batchId} --apply`,
    );
  }
  log('✅ W4 実ファイル検証 PASS');

  await sudoReloadCaddy();
  log('🔄 caddy reload 完了（Phase 1-B 累計 6 回目）');
  log(`バックアップ: ${batchDir}（batchId=${batchId}）`);
}

main().catch((err) => {
  fail(err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err));
});
