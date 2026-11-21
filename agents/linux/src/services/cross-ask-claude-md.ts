/**
 * サイクルS2a（2026-11-12）: クロス ask スコープは `settingSources: []` のため SDK 自身は
 * プロジェクトの `CLAUDE.md` を読まない（`sdk.d.ts` の `settingSources` JSDoc: 「`'project'` を
 * 含まないと CLAUDE.md は読み込まれない」）。`['project']` を採用しなかった理由（プロジェクト
 * `.claude/settings.json`/`.mcp.json`/hooks/agents/commands/skills の 5 系統が同時に開くため）は
 * `cross-ask-scope-rules.ts` の `buildCrossAskSdkOverrides()` JSDoc 参照。
 *
 * 代わりに Agent 側でルート `CLAUDE.md` を自分で読み、安全化（パスゲート通過・`@` 取り込み行の
 * 除去・サイズ上限）してプロンプトへ注入する。`@` 行除去は、質問文自体を `client_composed:true`
 * で送る対策（抜け道⑦: 質問文中の `@パス` 自動展開）と二重化する防御であり、CLAUDE.md 本文に
 * 混入した `@../../secret` のような相対 import がユーザー発の質問文以外の経路（例: 将来 Agent が
 * この文字列を別の prompt に再利用する変更）で展開されてしまう事故を予防する。
 */

import fs from 'fs';
import path from 'path';
import { checkCrossAskPath } from './cross-ask-path-guard.js';

/** CLAUDE.md 注入のサイズ上限（文字数）。超過分は末尾を切り詰め、省略した旨を明記する。 */
export const CROSS_ASK_CLAUDE_MD_MAX_CHARS = 8000;

/**
 * CLAUDE.md 本文から `@` で始まる取り込み行（Claude Code 自身のネストした import 構文）を除去する。
 * 行頭の空白を許容し、行全体が `@` から始まる場合のみ対象とする（本文中の `email@example.com` 等を
 * 誤って除去しないため、行頭一致のみとする）。
 */
export function stripClaudeMdImportLines(content: string): string {
  return content
    .split('\n')
    .filter((line) => !/^\s*@\S/.test(line))
    .join('\n');
}

/**
 * CLAUDE.md 本文をサイズ上限でクランプする（上限超過時は末尾に省略注記を付ける）。
 */
export function clampClaudeMdContent(content: string, maxChars: number = CROSS_ASK_CLAUDE_MD_MAX_CHARS): string {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n...(${content.length - maxChars} 文字省略)`;
}

/**
 * プロジェクトルートの `CLAUDE.md` を読み、安全化して返す。存在しない・読み取り不可・
 * パスゲート（`checkCrossAskPath`）を通らない場合は `null` を返す（Agent は何も注入しない）。
 *
 * @param projectRootReal `resolveProjectRootReal()` で事前に解決したプロジェクトルート
 */
export function loadCrossAskClaudeMd(projectRootReal: string): string | null {
  const claudeMdPath = path.join(projectRootReal, 'CLAUDE.md');
  const pathCheck = checkCrossAskPath(projectRootReal, claudeMdPath);
  if (!pathCheck.allowed) return null;

  let raw: string;
  try {
    raw = fs.readFileSync(claudeMdPath, 'utf-8');
  } catch {
    return null;
  }

  const stripped = stripClaudeMdImportLines(raw);
  return clampClaudeMdContent(stripped);
}

/**
 * プロンプトに注入する CLAUDE.md ブロックを組み立てる（本文が無い場合は空文字列）。
 */
export function buildCrossAskClaudeMdPrompt(projectRootReal: string): string {
  const content = loadCrossAskClaudeMd(projectRootReal);
  if (!content) return '';
  return `\n\n--- Project CLAUDE.md (read-only) ---\n${content}\n--- End Project CLAUDE.md ---`;
}
