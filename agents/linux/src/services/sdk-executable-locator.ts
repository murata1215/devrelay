/**
 * claude-agent-sdk が同梱する Claude Code 実行ファイルを検出する純関数群（サイクル SDK-1）。
 *
 * 背景（`doc/sdk-0.3-migration-findings.md` 参照）: SDK 0.2 系は `<SDK dir>/cli.js` を同梱していたが、
 * 0.3 系ではこれが消滅し、プラットフォーム別パッケージ（`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`）
 * が同梱するネイティブバイナリ（`claude` / Windows は `claude.exe`）に置き換わった。従来の
 * 「`cli.js` があるか」判定は 0.3 系では常に「欠落」と誤判定してしまう。
 *
 * 本モジュールは **候補集合を「0.2 系 cli.js」∪「0.3 系ネイティブバイナリ」にし、バージョン判定を一切しない**
 * ことで両対応する。**`cli.js` を先に見る**ため、0.2 系のみがインストールされている環境（現行の
 * DevRelay 運用環境を含む）では従来と完全に同一の判定結果になることが構造的に保証される。
 *
 * ネイティブバイナリの specifier 組み立ては、SDK 自身（0.3.278 の `sdk.mjs`、内部関数 `tW()`/`Bze()`、
 * 難読化後の名前）を逆コンパイルして得た規則をそのまま再現している
 * （抽出元・抽出方法は `doc/sdk-executable-runbook.md` に記載）:
 *
 * ```
 * xu = "@anthropic-ai/claude-agent-sdk"
 * candidates = platform === 'android' ? [`${xu}-linux-${arch}-android`]
 *            : platform === 'linux'   ? (preferMusl ? [`${xu}-linux-${arch}-musl`, `${xu}-linux-${arch}`]
 *                                                    : [`${xu}-linux-${arch}`, `${xu}-linux-${arch}-musl`])
 *            : [`${xu}-${platform}-${arch}`]
 * specifiers = candidates.map(pkg => `${pkg}/claude${platform === 'win32' ? '.exe' : ''}`)
 * preferMusl = platform === 'linux' && process.report.getReport().header.glibcVersionRuntime === undefined
 * ```
 *
 * 0.3 系の実行ファイル解決は「解決済み `sdk.mjs` を起点にした `createRequire`」で行うことが絶対条件
 * （findings 訂正3）。pnpm はプラットフォームパッケージを SDK 自身の private `node_modules` にしか
 * リンクしないため、Agent 側モジュール起点の `createRequire` では健全なインストールでも必ず
 * `MODULE_NOT_FOUND` になる。このモジュールは `fs` / `module`（createRequire）を一切 import せず、
 * すべて呼び出し側が注入する関数（`SdkExecutableProbeDeps`）経由でのみ I/O を行う（外部 import ゼロ、
 * `running-code-stale.ts` / `claude-locator.ts` と同じ流儀）。
 *
 * `agents/macos` は本ファイルと byte-identical。
 */

const SDK_PACKAGE_NAME = '@anthropic-ai/claude-agent-sdk';

/** 同梱実行ファイルの検出形態。`unresolved` は SDK エントリ自体が解決できなかったケース（#287 以前の挙動）。 */
export type SdkExecutableForm = 'clijs' | 'native' | 'none' | 'unresolved';

/** 最終的に何を使うか。`sdk-default` は SDK の既定（pathToClaudeCodeExecutable 未指定）に委ねることを意味する。 */
export type SdkExecutableDecision = 'sdk-default' | 'system-claude' | 'none';

export interface SdkExecutableProbe {
  form: SdkExecutableForm;
  /** 検出できた同梱実行ファイルの絶対パス（clijs / native のときのみ非 null） */
  path: string | null;
  sdkEntry: string | null;
  sdkVersion: string | null;
  claudeCodeVersion: string | null;
  platform: string;
  arch: string;
  preferMusl: boolean;
  /** native 探索で実際に試した specifier 一覧（診断用。clijs で確定した場合は空配列） */
  triedSpecifiers: string[];
  /** 'legacy' = ネイティブ検出中に想定外の例外が発生し、cli.js 判定結果へフォールバックした */
  probeStatus: 'ok' | 'legacy';
}

export interface SdkExecutableProbeDeps {
  platform: string;
  arch: string;
  /** `process.report.getReport().header.glibcVersionRuntime` 相当の値（非 linux では無視される） */
  glibcVersionRuntime: string | undefined;
  /** `createRequire(import.meta.url).resolve(SDK_PACKAGE_NAME)` 相当（Agent 側モジュール起点） */
  resolveSdkEntry: () => string;
  /** `createRequire(sdkEntry).resolve(specifier)` 相当（解決済み sdk.mjs 起点、訂正3 の絶対条件） */
  resolveFromSdk: (sdkEntry: string, specifier: string) => string;
  /** `fs.existsSync` 相当 */
  exists: (p: string) => boolean;
  /** SDK ディレクトリの package.json を読む。失敗時は null を返すこと（例外を投げない） */
  readPackageJson: (dir: string) => { version?: string; claudeCodeVersion?: string } | null;
  /** `path.join` 相当 */
  joinPath: (dir: string, file: string) => string;
  /** `path.dirname` 相当 */
  dirname: (p: string) => string;
  /** 想定外の例外発生時の警告出力（`console.warn` 相当） */
  onWarn: (message: string) => void;
}

/**
 * musl 版バイナリを優先すべきか判定する（SDK の `Bze()` と同一ロジック）。
 * @param platform `process.platform` 相当の値
 * @param glibcVersionRuntime `process.report.getReport().header.glibcVersionRuntime` 相当の値
 * @returns linux かつ glibc ランタイム情報が無い（＝ musl ベース、例: Alpine）場合のみ true
 */
export function preferMuslFromGlibc(platform: string, glibcVersionRuntime: string | undefined): boolean {
  return platform === 'linux' && glibcVersionRuntime === undefined;
}

/**
 * SDK が探すネイティブバイナリの specifier 候補を、SDK 自身の `tW()` と同一の順序で組み立てる。
 * @param platform `process.platform` 相当の値
 * @param arch `process.arch` 相当の値
 * @param preferMusl `preferMuslFromGlibc()` の結果
 * @returns `<パッケージ名>/claude[.exe]` 形式の specifier 配列（試行順）
 */
export function sdkNativeBinarySpecifiers(platform: string, arch: string, preferMusl: boolean): string[] {
  const ext = platform === 'win32' ? '.exe' : '';
  let packages: string[];
  if (platform === 'android') {
    packages = [`${SDK_PACKAGE_NAME}-linux-${arch}-android`];
  } else if (platform === 'linux') {
    packages = preferMusl
      ? [`${SDK_PACKAGE_NAME}-linux-${arch}-musl`, `${SDK_PACKAGE_NAME}-linux-${arch}`]
      : [`${SDK_PACKAGE_NAME}-linux-${arch}`, `${SDK_PACKAGE_NAME}-linux-${arch}-musl`];
  } else {
    packages = [`${SDK_PACKAGE_NAME}-${platform}-${arch}`];
  }
  return packages.map((pkg) => `${pkg}/claude${ext}`);
}

/**
 * SDK 同梱の実行ファイルを検出する（cli.js を優先、無ければネイティブバイナリ）。
 *
 * 判定順序:
 * 1. `resolveSdkEntry()` が失敗 → `form:'unresolved'`（SDK エントリ自体が無い。#287 以前と同じ「SDK 既定に委ねる」）
 * 2. `<sdkDir>/cli.js` が存在 → `form:'clijs'`（**0.2 系のみの環境ではここで確定し、以降には一切到達しない**）
 * 3. ネイティブ候補を順に試す → 見つかれば `form:'native'`、全滅なら `form:'none'`
 *
 * 3 の全体を try/catch で包み、想定外の例外（`exists`/`readPackageJson`/`sdkNativeBinarySpecifiers` 自体の
 * 異常等）は `onWarn()` で警告した上で `form:'none'` / `probeStatus:'legacy'` に倒す
 * （＝ 2 の cli.js 判定結果を最終結果として扱う。検出器の不具合で全 AI コマンドを止めない）。
 * 個々の specifier に対する `resolveFromSdk` の失敗（未インストール等、通常想定内）は握りつぶして次を試す。
 *
 * @param deps I/O を注入する依存関数群
 * @returns 検出結果
 */
export function runSdkExecutableProbe(deps: SdkExecutableProbeDeps): SdkExecutableProbe {
  const preferMusl = preferMuslFromGlibc(deps.platform, deps.glibcVersionRuntime);
  const baseline = {
    sdkEntry: null as string | null,
    sdkVersion: null as string | null,
    claudeCodeVersion: null as string | null,
    platform: deps.platform,
    arch: deps.arch,
    preferMusl,
    triedSpecifiers: [] as string[],
  };

  let sdkEntry: string;
  try {
    sdkEntry = deps.resolveSdkEntry();
  } catch {
    return { ...baseline, form: 'unresolved', path: null, probeStatus: 'ok' };
  }

  const sdkDir = deps.dirname(sdkEntry);
  const pkgInfo = deps.readPackageJson(sdkDir);
  const withMeta = {
    ...baseline,
    sdkEntry,
    sdkVersion: pkgInfo?.version ?? null,
    claudeCodeVersion: pkgInfo?.claudeCodeVersion ?? null,
  };

  const bundledCli = deps.joinPath(sdkDir, 'cli.js');
  if (deps.exists(bundledCli)) {
    return { ...withMeta, form: 'clijs', path: bundledCli, probeStatus: 'ok' };
  }

  try {
    const specifiers = sdkNativeBinarySpecifiers(deps.platform, deps.arch, preferMusl);
    const tried: string[] = [];
    for (const specifier of specifiers) {
      tried.push(specifier);
      let resolved: string;
      try {
        resolved = deps.resolveFromSdk(sdkEntry, specifier);
      } catch {
        continue; // 未インストール等、想定内の失敗。次の specifier を試す
      }
      if (deps.exists(resolved)) {
        return { ...withMeta, form: 'native', path: resolved, triedSpecifiers: tried, probeStatus: 'ok' };
      }
    }
    return { ...withMeta, form: 'none', path: null, triedSpecifiers: tried, probeStatus: 'ok' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.onWarn(`[SDK] native binary probe threw unexpectedly, falling back to cli.js-only legacy logic: ${message}`);
    return { ...withMeta, form: 'none', path: null, probeStatus: 'legacy' };
  }
}

/**
 * 検出結果から最終決定（SDK 既定に委ねる／システム claude へフォールバック／どちらも無い）を導出する。
 * @param probe `runSdkExecutableProbe()` の結果
 * @param systemClaude `resolveSystemClaude()` の結果（同梱が使えない場合のみ参照）
 * @returns 最終決定と、`pathToClaudeCodeExecutable` に設定すべき値（sdk-default 時は null）
 */
export function decideSdkExecutable(
  probe: SdkExecutableProbe,
  systemClaude: string | null,
): { decision: SdkExecutableDecision; executable: string | null } {
  if (probe.form === 'clijs' || probe.form === 'native' || probe.form === 'unresolved') {
    return { decision: 'sdk-default', executable: null };
  }
  if (systemClaude) {
    return { decision: 'system-claude', executable: systemClaude };
  }
  return { decision: 'none', executable: null };
}

/**
 * `agent.log` へ起動時 1 回だけ出す固定書式の 1 行を組み立てる（grep キー: `[SDK] claude-exec`）。
 * 空白を含みうる `path=` は必ず末尾に置く。
 * @param probe `runSdkExecutableProbe()` の結果
 * @param decision `decideSdkExecutable()` の結果
 * @param executable `decideSdkExecutable()` が返した実行ファイルパス
 * @returns 1 行のログ文字列（絵文字接頭辞込み）
 */
export function buildSdkExecutableStatusLine(
  probe: SdkExecutableProbe,
  decision: SdkExecutableDecision,
  executable: string | null,
): string {
  const sdk = probe.sdkVersion ?? 'unknown';
  const cc = probe.claudeCodeVersion ?? 'unknown';
  const platformArch = `${probe.platform}-${probe.arch}`;
  let path: string;
  if (decision === 'sdk-default') {
    path = probe.path ?? '-';
  } else if (decision === 'system-claude') {
    path = executable ?? '-';
  } else {
    path = '-';
  }
  return `🩺 [SDK] claude-exec sdk=${sdk} cc=${cc} form=${probe.form} decision=${decision} platform=${platformArch} preferMusl=${probe.preferMusl} probe=${probe.probeStatus} path=${path}`;
}

/**
 * `form:'none'`（同梱実行ファイルが見つからなかった）ときの追加診断行を組み立てる。
 * 見つかった場合（clijs/native/unresolved）は null を返し、呼び出し側は出力しない。
 * @param probe `runSdkExecutableProbe()` の結果
 * @returns 診断行、または null
 */
export function buildSdkExecutableTriedLine(probe: SdkExecutableProbe): string | null {
  if (probe.form !== 'none' || probe.triedSpecifiers.length === 0) return null;
  return `🩺 [SDK] claude-exec tried=${probe.triedSpecifiers.join(',')}`;
}
