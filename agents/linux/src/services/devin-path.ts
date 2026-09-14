/**
 * サイクル P3-A: `devin` CLI の実行パスを解決する最小モジュール（`claude-path.ts` の鏡写し）。
 *
 * 承認ノート #5: `probeDevinCapabilities()`（`ai-runner.ts` の module-private 関数）を
 * 共通化・切り出しすることは P2 に見送る。`ai-runner.ts` は Claude Agent SDK と `connection.js` を
 * import しており、そこから `resolveSystemDevin` を呼ぶと adapter の単体テストが SDK 一式を
 * 引き込んでしまい実質テスト不能になる（`claude-path.ts` が `ai-runner.ts` から切り出された
 * P1.3 の理由と同じ）。よって新規に独立したロケータを用意する。
 *
 * node builtins（child_process/fs/os）と外部 import ゼロの `devin-locator.ts` にしか依存しない。
 */
import { execFile, execSync } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import { buildDevinLookupCommand, devinFallbackCandidates } from './devin-locator.js';

const execFileAsync = promisify(execFile);

/**
 * システムにインストールされた devin CLI の実行パスを解決する。
 * PATH（Windows は `where devin`、それ以外は `command -v devin`）を最優先し、
 * 見つからなければ OS 別の既知パスを順に探す（判定ロジックは devin-locator.ts に集約）。
 * `stdio` は `pipe`（stderr も捨てる）+ `windowsHide: true` で、コンソール無し起動時に
 * 新規コンソール窓が開いたり agent.log へ生の cmd エラーが漏れたりしないようにする。
 * @returns 実在する devin のフルパス、無ければ null
 */
export function resolveSystemDevin(): string | null {
  try {
    const lookupCmd = buildDevinLookupCommand(process.platform);
    const raw = execSync(lookupCmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
    // `where` は複数行を返すことがあるため最初の行のみ使う
    const p = raw.split(/\r?\n/)[0]?.trim();
    if (p && fs.existsSync(p)) return p;
  } catch {
    // PATH に無い場合は既知パスへフォールバック
  }
  for (const candidate of devinFallbackCandidates(process.platform, os.homedir())) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return null;
}

/** `resolveDevinRuntimeVersion()` のモジュール内キャッシュ有効期間（Plan §3-7: 6 時間） */
const RUNTIME_VERSION_CACHE_MS = 6 * 60 * 60 * 1000;

let cachedRuntimeVersion: { path: string; version: string | null; cachedAtMs: number } | null = null;

/**
 * `devin --version` を実行してバージョン文字列を取得する。
 * モジュール内 6 時間キャッシュを持ち、idle スイープの繰り返しで spawn が積み上がらないようにする
 * （Plan §3-7）。取得失敗は null（throw しない）。
 */
export async function resolveDevinRuntimeVersion(devinPath: string): Promise<string | null> {
  const now = Date.now();
  if (cachedRuntimeVersion && cachedRuntimeVersion.path === devinPath && (now - cachedRuntimeVersion.cachedAtMs) < RUNTIME_VERSION_CACHE_MS) {
    return cachedRuntimeVersion.version;
  }
  let version: string | null;
  try {
    const { stdout } = await execFileAsync(devinPath, ['--version'], { timeout: 10_000, windowsHide: true });
    version = stdout.trim() || null;
  } catch {
    version = null;
  }
  cachedRuntimeVersion = { path: devinPath, version, cachedAtMs: now };
  return version;
}

/** テスト専用: モジュール内キャッシュをリセットする（通常運用では未使用） */
export function resetDevinRuntimeVersionCacheForTests(): void {
  cachedRuntimeVersion = null;
}
