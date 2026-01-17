import type { UserCommand, UserContext, AiTool } from '@devbridge/shared';
import { SHORTCUTS } from '@devbridge/shared';

/**
 * Parse user input into a command
 * 
 * Supports:
 * - Shortcuts: m, p, s, r, q, h, log, sum
 * - Numbers: 1, 2, 3... (select from last list)
 * - AI switch: ai:claude, ai:gemini
 * - Everything else -> AI prompt
 */
export function parseCommand(input: string, context: UserContext): UserCommand {
  const normalized = input.trim().toLowerCase();
  
  // 1. Check shortcuts
  if (normalized in SHORTCUTS) {
    return parseShortcut(normalized, context);
  }
  
  // 2. Check if it's a number (selection)
  if (/^\d+$/.test(normalized)) {
    return { type: 'select', number: parseInt(normalized) };
  }
  
  // 3. Check AI switch command
  if (normalized.startsWith('ai:')) {
    const tool = normalized.slice(3) as AiTool;
    if (['claude', 'gemini', 'codex', 'aider'].includes(tool)) {
      return { type: 'ai:switch', tool };
    }
  }
  
  // 4. Check log with count
  if (normalized.startsWith('log')) {
    const match = normalized.match(/^log\s*(\d+)?$/);
    if (match) {
      const count = match[1] ? parseInt(match[1]) : undefined;
      return { type: 'log', count };
    }
  }
  
  // 5. Check summary with period
  if (normalized.startsWith('sum')) {
    const match = normalized.match(/^sum\s*(\d+d)?$/);
    if (match) {
      return { type: 'summary', period: match[1] };
    }
  }
  
  // 6. Default: treat as AI prompt
  return { type: 'ai:prompt', text: input };
}

function parseShortcut(shortcut: string, context: UserContext): UserCommand {
  switch (shortcut) {
    case 'm':
      return { type: 'machine:list' };
    case 'p':
      return { type: 'project:list' };
    case 's':
      return { type: 'status' };
    case 'r':
      return { type: 'recent' };
    case 'q':
      return { type: 'quit' };
    case 'h':
      return { type: 'help' };
    case 'log':
      return { type: 'log' };
    case 'sum':
      return { type: 'summary' };
    default:
      return { type: 'ai:prompt', text: shortcut };
  }
}

/**
 * Generate help text
 */
export function getHelpText(): string {
  return `
📖 **DevBridge コマンド一覧**

**基本操作**
\`m\` - マシン一覧
\`p\` - プロジェクト一覧
\`s\` - ステータス
\`1\`, \`2\`, \`3\`... - 一覧から選択

**履歴**
\`r\` - 直近の作業一覧
\`log\` - 会話ログ (直近10件)
\`log20\` - 会話ログ (20件)
\`sum\` - 直近セッションの要約

**AI切り替え**
\`ai:claude\` - Claude Code
\`ai:gemini\` - Gemini CLI
\`ai:codex\` - Codex CLI

**その他**
\`q\` - 切断
\`h\` - このヘルプ

**作業指示**
上記以外のメッセージは AI への指示として処理されます
`.trim();
}
