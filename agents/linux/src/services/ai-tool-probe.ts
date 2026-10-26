/**
 * AI ツールの実在確認（I/O を伴う側）。判定方針は `ai-tool-presence.ts`（純関数）に集約している。
 *
 * - claude: system claude CLI（`resolveSystemClaude()`）が見つかる、または認証情報
 *   （`~/.claude/.credentials.json` / `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`）がある場合に実在とみなす。
 *   Claude は SDK 同梱バイナリでも動くため CLI が PATH に無くても使える端末がある。その場合でも認証情報が
 *   あれば「使える」と判定し、従来挙動を変えない。
 * - それ以外: config の command を PATH（Windows は `where`、それ以外は `command -v`）→ 既知パスの順で探す。
 *
 * 結果は 10 分キャッシュする（`getAvailableAiTools()` は接続時とプロンプト送信ごとに呼ばれるため、
 * 毎回 where/which を spawn しない）。
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveSystemClaude } from './claude-path.js';
import { aiToolFallbackCandidates, isPathLikeCommand } from './ai-tool-presence.js';

/**
 * 2026-10-26 `spawn codex ENOENT` 障害の根治: Agent 自身を起動している node（`process.execPath`）
 * の bin ディレクトリ。nvm 等でグローバルインストールした AI CLI（codex 等）はその node
 * バージョン専用の bin にしかないため、フォールバック候補の先頭に加える（`ai-tool-presence.ts` 参照）。
 */
const execDir = path.dirname(process.execPath);

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { present: boolean; at: number }>();

function existsSafe(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function lookupOnPath(command: string): boolean {
  // command はコマンド名のみ（config.yaml 由来）。念のためシェルメタ文字を含むものは PATH 検索しない
  if (!/^[A-Za-z0-9._-]+$/.test(command)) return false;
  const lookup = process.platform === 'win32' ? `where ${command}` : `command -v ${command}`;
  try {
    const raw = execSync(lookup, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, windowsHide: true }).trim();
    return raw.length > 0;
  } catch {
    return false;
  }
}

function hasClaudeCredentials(): boolean {
  if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN) return true;
  return existsSafe(path.join(os.homedir(), '.claude', '.credentials.json'));
}

function probe(tool: string, command: string): boolean {
  if (isPathLikeCommand(command)) return existsSafe(command);
  if (tool === 'claude' && command === 'claude') {
    return resolveSystemClaude() !== null || hasClaudeCredentials();
  }
  if (lookupOnPath(command)) return true;
  return aiToolFallbackCandidates(tool, command, process.platform, os.homedir(), execDir).some(existsSafe);
}

/**
 * 指定ツールがこの端末で実際に使えるかを返す（10 分キャッシュ）。
 * @param tool AI ツール名
 * @param command config.yaml の `aiTools.<tool>.command`（未指定ならツール名）
 */
export function isAiToolPresent(tool: string, command?: string): boolean {
  const cmd = (command || tool).trim();
  const key = `${tool}\u0000${cmd}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.present;
  const present = probe(tool, cmd);
  cache.set(key, { present, at: now });
  return present;
}

/** テスト・再検出用: キャッシュを破棄する */
export function resetAiToolPresenceCache(): void {
  cache.clear();
}
