/**
 * `sdk-executable-locator.ts`（純関数）の I/O 薄皮（サイクル SDK-1）。
 *
 * `#287`（`getClaudeExecutableFallback()` / `logClaudeExecutableStatus()`）を、SDK 0.2 系（`cli.js`）と
 * 0.3 系（プラットフォーム別ネイティブバイナリ）の両対応にするために置き換えた実体。
 * 純粋なロジックはすべて `sdk-executable-locator.ts` にあり、本ファイルは `node:module`（createRequire）・
 * `fs`・`path`・`process` を使って実際の I/O を行う薄い層に徹する。
 *
 * `getClaudeExecutableFallback()` / `logClaudeExecutableStatus()` の関数シグネチャ・戻り値の意味は
 * `ai-runner.ts` にあった旧実装と完全互換（呼び出し元は無変更）。
 *
 * `agents/macos` は本ファイルと byte-identical。
 */
import { createRequire } from 'module';
import * as fs from 'fs';
import * as path from 'path';
import { resolveSystemClaude } from './claude-path.js';
import {
  runSdkExecutableProbe,
  decideSdkExecutable,
  buildSdkExecutableStatusLine,
  buildSdkExecutableTriedLine,
  type SdkExecutableProbe,
  type SdkExecutableProbeDeps,
} from './sdk-executable-locator.js';

const SDK_PACKAGE_NAME = '@anthropic-ai/claude-agent-sdk';

// #287 由来: 同梱実行ファイル欠落時のフォールバック警告を毎ターン繰り返さない（プロセス寿命中 1 回だけ）。
let claudeFallbackLogged = false;

/**
 * `process.report` から glibc ランタイム情報を安全に取り出す（取得失敗時は undefined）。
 * @returns `process.report.getReport().header.glibcVersionRuntime` 相当の値
 */
function readGlibcVersionRuntime(): string | undefined {
  try {
    const report = typeof process.report?.getReport === 'function' ? process.report.getReport() : null;
    const header = (report as { header?: { glibcVersionRuntime?: string } } | null)?.header;
    return header?.glibcVersionRuntime;
  } catch {
    return undefined;
  }
}

/**
 * `sdk-executable-locator.ts` へ渡す実 I/O 依存を組み立てる。
 * `resolveFromSdk` は解決済み `sdk.mjs`（`sdkEntry`）を起点にした `createRequire` を使う
 * （findings 訂正3: pnpm 環境では Agent 側モジュール起点だと必ず失敗するため絶対条件）。
 * @returns `runSdkExecutableProbe()` に渡す依存関数群
 */
function buildProbeDeps(): SdkExecutableProbeDeps {
  return {
    platform: process.platform,
    arch: process.arch,
    glibcVersionRuntime: readGlibcVersionRuntime(),
    resolveSdkEntry: () => createRequire(import.meta.url).resolve(SDK_PACKAGE_NAME),
    resolveFromSdk: (sdkEntry: string, specifier: string) => createRequire(sdkEntry).resolve(specifier),
    exists: (p: string) => fs.existsSync(p),
    readPackageJson: (dir: string) => {
      try {
        const raw = fs.readFileSync(path.join(dir, 'package.json'), 'utf-8');
        return JSON.parse(raw) as { version?: string; claudeCodeVersion?: string };
      } catch {
        return null;
      }
    },
    joinPath: (dir: string, file: string) => path.join(dir, file),
    dirname: (p: string) => path.dirname(p),
    onWarn: (message: string) => console.warn(message),
  };
}

/**
 * SDK 同梱実行ファイルの検出結果を返す（`cli.js` を優先、無ければネイティブバイナリ）。
 * @returns 検出結果
 */
export function probeSdkExecutable(): SdkExecutableProbe {
  return runSdkExecutableProbe(buildProbeDeps());
}

/**
 * Claude Agent SDK が spawn する実行ファイルを解決する（#287、SDK-1 で 0.2/0.3 両対応化）。
 *
 * SDK は `pathToClaudeCodeExecutable` 未指定時、自前バンドルの実行ファイル（0.2 系は `cli.js`、
 * 0.3 系はプラットフォーム別ネイティブバイナリ）を使う。これが不完全インストール等で欠落していると
 * 全 AI コマンドが「Claude Code executable not found」で失敗する（pixdata 機で発生、#287）。
 * その場合はシステムにインストールされた claude へフォールバックさせる。
 *
 * @returns フォールバック先の claude パス。同梱実行ファイルが健全なら null（＝同梱版を使う）
 */
export function getClaudeExecutableFallback(): string | null {
  try {
    const probe = probeSdkExecutable();
    const sys = probe.form === 'none' ? resolveSystemClaude() : null;
    const { decision, executable } = decideSdkExecutable(probe, sys);
    if (decision !== 'sdk-default' && !claudeFallbackLogged) {
      if (decision === 'system-claude') {
        console.warn(`⚠️ [SDK] bundled executable missing (form=${probe.form}) → falling back to system claude: ${executable}`);
      } else {
        console.error(`❌ [SDK] bundled executable missing (form=${probe.form}) and no system claude found. Run a clean reinstall in ~/.devrelay/agent (rm -rf node_modules/@anthropic-ai/claude-agent-sdk && pnpm install)`);
      }
      claudeFallbackLogged = true;
    }
    return executable;
  } catch {
    // 解決に失敗した場合は同梱版に委ねる（従来動作を壊さない）
    return null;
  }
}

/**
 * 起動時セルフチェック（#287・B-2、SDK-1 で 0.2/0.3 両対応化）。SDK 同梱実行ファイルの状態を
 * `agent.log` に 1 度だけ、機械判定できる固定書式（grep キー: `[SDK] claude-exec`）で明示する。
 * 欠落時は毎コマンドの暗号的エラーを待たず、起動直後に状況とフォールバック先を通知する。
 */
export function logClaudeExecutableStatus(): void {
  try {
    const probe = probeSdkExecutable();
    const sys = probe.form === 'none' ? resolveSystemClaude() : null;
    const { decision, executable } = decideSdkExecutable(probe, sys);
    const line = buildSdkExecutableStatusLine(probe, decision, executable);
    if (decision === 'sdk-default') {
      console.log(line);
    } else if (decision === 'system-claude') {
      console.warn(line);
    } else {
      console.error(line);
    }
    const triedLine = buildSdkExecutableTriedLine(probe);
    if (triedLine) console.log(triedLine);
  } catch {
    // 解決失敗時は無視（従来どおり実行時に SDK 既定で判定される）
  }
}
