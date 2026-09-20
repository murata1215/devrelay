/**
 * サイクルP1.3: `resolveSystemClaude()` を `ai-runner.ts` から切り出した最小モジュール。
 *
 * 背景: `ai-runner.ts` は Claude Agent SDK と `connection.js` を import しており
 * （`connection.ts` はモジュールロード時に `capabilities/claude-plugin-adapter.ts` を登録するため
 * `connection → ai-runner → connection` の循環がすでに存在する）、
 * `claude-plugin-adapter.ts`（単体テストしたい）が `ai-runner.ts` から `resolveSystemClaude` を
 * import すると、adapter の単体テストが SDK 一式を引き込んでしまい実質テスト不能になる。
 *
 * このファイルは node builtins（child_process/fs/os）と既存の外部 import ゼロの
 * `claude-locator.ts` にしか依存しない。`ai-runner.ts` は本ファイルから re-export することで
 * `src/index.ts` / `services/claude-auth.ts` からの既存 import（`from './ai-runner.js'` /
 * `from './ai-runner.js'`）をそのまま維持する（後方互換、挙動変更ゼロ）。
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import { buildClaudeLookupCommand, claudeFallbackCandidates } from './claude-locator.js';

/**
 * システムにインストールされた claude CLI の実行パスを解決する。
 * PATH（Windows は `where claude`、それ以外は `command -v claude`、#350）を最優先し、
 * 見つからなければ OS 別の既知パスを順に探す（判定ロジックは claude-locator.ts に集約）。
 * `stdio` は `pipe`（stderr も捨てる）+ `windowsHide: true` で、コンソール無し起動時に
 * 新規コンソール窓が開いたり agent.log へ生の cmd エラーが漏れたりしないようにする。
 * @returns 実在する claude のフルパス、無ければ null
 */
export function resolveSystemClaude(): string | null {
  try {
    const lookupCmd = buildClaudeLookupCommand(process.platform);
    const raw = execSync(lookupCmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
    // `where` は複数行を返すことがあるため最初の行のみ使う（resolveClaudePath と同じ扱い）
    const p = raw.split(/\r?\n/)[0]?.trim();
    if (p && fs.existsSync(p)) return p;
  } catch {
    // PATH に無い場合は既知パスへフォールバック
  }
  for (const candidate of claudeFallbackCandidates(process.platform, os.homedir())) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return null;
}
