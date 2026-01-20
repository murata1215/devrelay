import type { UserCommand, UserContext, AiTool } from '@devrelay/shared';
import { SHORTCUTS } from '@devrelay/shared';
import {
  parseNaturalLanguage,
  isTraditionalCommand,
  toTraditionalCommand,
  type ParsedCommand,
} from './natural-language-parser.js';
import { isNaturalLanguageEnabled } from './user-settings.js';
import { prisma } from '../db/client.js';

/**
 * Parse user input into a command (with natural language support)
 *
 * Flow:
 * 1. Check if input is a traditional command (m, p, 1, 2, etc.)
 * 2. If not and user has OpenAI API key, use NLP to interpret
 * 3. Fall back to treating as AI prompt
 */
export async function parseCommandWithNLP(
  input: string,
  context: UserContext
): Promise<UserCommand> {
  const trimmed = input.trim();

  // 1. First try traditional command parsing
  if (isTraditionalCommand(trimmed)) {
    return parseCommand(trimmed, context);
  }

  // 2. If already connected to a project (has active session), skip NLP and send directly to AI
  //    (NLP is only needed for navigation commands like p, c, x, q, h)
  if (context.currentSessionId) {
    console.log('🧠 NLP: Skipping - already connected to project');
    return { type: 'ai:prompt', text: trimmed };
  }

  // 3. Check if natural language is enabled for this user
  const user = await prisma.user.findFirst({
    where: { platformLinks: { some: { platformUserId: context.userId } } },
  });

  if (user && (await isNaturalLanguageEnabled(user.id))) {
    // Get available projects for context
    let availableProjects: string[] = [];
    if (context.currentMachineId) {
      const projects = await prisma.project.findMany({
        where: { machineId: context.currentMachineId },
        select: { name: true },
      });
      availableProjects = projects.map((p) => p.name);
    }

    // Parse with NLP
    const parsed = await parseNaturalLanguage(user.id, trimmed, {
      currentSession: !!context.currentSessionId,
      availableProjects,
      pendingSelection: !!context.lastListItems,
    });

    // Convert parsed command to UserCommand
    if (parsed.type !== 'unknown' && parsed.confidence >= 0.7) {
      return nlpToUserCommand(parsed, context, trimmed);
    }
  }

  // 4. Fall back to traditional parsing (will treat as AI prompt)
  return parseCommand(trimmed, context);
}

/**
 * Convert NLP parsed command to UserCommand
 */
function nlpToUserCommand(
  parsed: ParsedCommand,
  context: UserContext,
  originalInput: string
): UserCommand {
  switch (parsed.type) {
    case 'message':
      return { type: 'ai:prompt', text: parsed.message || originalInput };

    case 'select_project':
      // Trigger project list first, then user can select
      return { type: 'project:list' };

    case 'select_option':
      if (parsed.optionNumber !== undefined) {
        return { type: 'select', number: parsed.optionNumber };
      }
      return { type: 'ai:prompt', text: originalInput };

    case 'continue':
      return { type: 'continue' };

    case 'clear':
      return { type: 'clear' };

    case 'quit':
      return { type: 'quit' };

    case 'help':
      return { type: 'help' };

    default:
      return { type: 'ai:prompt', text: originalInput };
  }
}

/**
 * Parse user input into a command (traditional mode)
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
    case 'c':
      return { type: 'continue' };
    case 'x':
      return { type: 'clear' };
    case 'e':
    case 'exec':
      return { type: 'exec' };
    case 'link':
      return { type: 'link' };
    case 'a':
    case 'agreement':
      return { type: 'agreement' };
    case 'se':
    case 'session':
      return { type: 'session' };
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
📖 **DevRelay コマンド一覧**

**基本操作**
\`m\` - マシン一覧
\`p\` - プロジェクト一覧
\`c\` - 前回の接続先に再接続
\`s\` - ステータス
\`1\`, \`2\`, \`3\`... - 一覧から選択

**プラン実行**
\`e\` または \`exec\` - プラン実行開始（会話履歴をリセットして実装開始）

**履歴**
\`r\` - 直近の作業一覧
\`log\` - 会話ログ (直近10件)
\`log20\` - 会話ログ (20件)
\`sum\` - 直近セッションの要約

**AI切り替え**
\`ai:claude\` - Claude Code
\`ai:gemini\` - Gemini CLI
\`ai:codex\` - Codex CLI

**アカウント連携**
\`link\` - WebUI アカウントとリンク

**その他**
\`se\` - セッション情報を表示
\`a\` - DevRelay Agreement を適用
\`x\` - 会話履歴をクリア
\`q\` - 切断
\`h\` - このヘルプ

**作業指示**
上記以外のメッセージは AI への指示として処理されます
`.trim();
}
