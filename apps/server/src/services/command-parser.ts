import type { UserCommand, UserContext, AiTool } from '@devrelay/shared';
import { SHORTCUTS } from '@devrelay/shared';
import { Project } from '@prisma/client';
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
  const isTraditional = isTraditionalCommand(trimmed);
  console.log(`📝 Command parsing: input="${trimmed}", isTraditional=${isTraditional}, hasSession=${!!context.currentSessionId}`);

  if (isTraditional) {
    const cmd = parseCommand(trimmed, context);
    console.log(`📝 Traditional command result: ${JSON.stringify(cmd)}`);
    return cmd;
  }

  // 1.5. ask コマンド: セッション状態に関わらず検出（AI プロンプトに流さない）
  const askMatchNlp = trimmed.match(/^ask\s+([^:]+):\s*(.+)$/is);
  if (askMatchNlp) {
    return { type: 'ask:member', targetProject: askMatchNlp[1].trim(), question: askMatchNlp[2].trim() };
  }

  // 1.6. teamexec コマンド: 他プロジェクトに実行依頼（exec モード）
  const teamexecMatchNlp = trimmed.match(/^(?:teamexec|te)\s+([^:]+):\s*(.+)$/is);
  if (teamexecMatchNlp) {
    return { type: 'teamexec:member', targetProject: teamexecMatchNlp[1].trim(), instruction: teamexecMatchNlp[2].trim() };
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
      availableProjects = projects.map((p: { name: string }) => p.name);
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

  // 0. 「e, 〜」「exec, 〜」パターン: カンマの後の指示を実行モードで直接実行
  const execWithPromptMatch = input.trim().match(/^(?:e|exec)\s*,\s*(.+)$/is);
  if (execWithPromptMatch) {
    const prompt = execWithPromptMatch[1].trim();
    return { type: 'exec', prompt };
  }

  // 0.5. 「testflight」コマンド: テストフライトサービス管理
  const tfMatch = input.trim().match(/^testflight(?:\s+(.+))?$/i);
  if (tfMatch) {
    const arg = tfMatch[1]?.trim();
    if (!arg) return { type: 'testflight', subcommand: 'list' };
    if (arg.startsWith('rm ')) return { type: 'testflight', subcommand: 'remove', name: arg.slice(3).trim() };
    if (arg.startsWith('info ')) return { type: 'testflight', subcommand: 'info', name: arg.slice(5).trim() };
    return { type: 'testflight', subcommand: 'create', name: arg };
  }

  // 0.7. 「ask <project>: <question>」パターン: 他プロジェクトに質問
  const askMatch = input.trim().match(/^ask\s+([^:]+):\s*(.+)$/is);
  if (askMatch) {
    return { type: 'ask:member', targetProject: askMatch[1].trim(), question: askMatch[2].trim() };
  }

  // 0.8. 「teamexec <project>: <instruction>」パターン: 他プロジェクトに実行依頼
  const teamexecMatch = input.trim().match(/^(?:teamexec|te)\s+([^:]+):\s*(.+)$/is);
  if (teamexecMatch) {
    return { type: 'teamexec:member', targetProject: teamexecMatch[1].trim(), instruction: teamexecMatch[2].trim() };
  }

  // 0.6. 「w」コマンド: ドキュメント更新＋コミットプッシュのワンショット実行
  if (normalized === 'w') {
    return {
      type: 'exec',
      prompt: 'doc/changelog.md があればそこに今回の変更を追記してください。rules/project.md があれば新しい設計判断を反映してください。CLAUDE.md を必要に応じて更新してください（技術スタック等の変更のみ）。MEMORY.md があれば更新してください。README.md を今回の変更内容で更新してください。更新後、コミットしてプッシュしてください。',
    };
  }

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

  // 3.5. Check 'a <number>' or 'a <tool>' command
  const aMatch = normalized.match(/^a\s+(\d+|claude|gemini|codex|aider)$/);
  if (aMatch) {
    const arg = aMatch[1];
    if (/^\d+$/.test(arg)) {
      // 'a 1', 'a 2' etc - select from AI list
      return { type: 'select', number: parseInt(arg) };
    } else {
      // 'a claude', 'a gemini' etc - direct switch
      return { type: 'ai:switch', tool: arg as AiTool };
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
    // case 's': 現在未使用
    //   return { type: 'status' };
    case 'r':
      return { type: 'recent' };
    case 'c':
      return { type: 'continue' };
    case 'x':
      return { type: 'clear' };
    case 'e':
    case 'exec':
      return { type: 'exec' };
    case 'w':
      // w コマンドは parseCommand() の Step 0.5 で処理されるが、念のためフォールバック
      return {
        type: 'exec',
        prompt: 'doc/changelog.md があればそこに今回の変更を追記してください。rules/project.md があれば新しい設計判断を反映してください。CLAUDE.md を必要に応じて更新してください（技術スタック等の変更のみ）。MEMORY.md があれば更新してください。README.md を今回の変更内容で更新してください。更新後、コミットしてプッシュしてください。',
      };
    case 'link':
      return { type: 'link' };
    case 'a':
      return { type: 'ai:list' };
    case 'ag':
    case 'agreement':
      return { type: 'agreement' };
    case 's':
    case 'session':
      return { type: 'session' };
    case 'b':
    case 'build':
      return { type: 'build' };
    case 'k':
    case 'kill':
      return { type: 'kill' };
    case 'u':
    case 'update':
      return { type: 'update' };
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
\`m\` - エージェント一覧
\`p\` - プロジェクト一覧
\`c\` - 前回の接続先に再接続
\`s\` - セッション情報
\`1\`, \`2\`, \`3\`... - 一覧から選択

**プラン実行**
\`e\` または \`exec\` - プラン実行開始
\`e, <指示>\` - プランをスキップして直接実行（例: \`e, コミットして\`）
\`w\` - ドキュメント更新＋コミット＋プッシュ（wrap up）

**履歴**
\`r\` - 直近の作業一覧
\`log\` - 会話ログ (直近10件)
\`log20\` - 会話ログ (20件)
\`sum\` - 直近セッションの要約

**AI切り替え**
\`a\` - AI ツール一覧・切り替え
\`a 1\`, \`a 2\` - 一覧から番号で選択

**アカウント連携**
\`link\` - WebUI アカウントとリンク

**ビルドログ**
\`b\` - ビルドログ（exec 実行履歴・各マシンのビルド差分）

**テストフライト**
\`testflight\` - サービス一覧
\`testflight <name>\` - 新規サービス作成
\`testflight rm <name>\` - サービスをアーカイブ
\`testflight info <name>\` - サービス詳細

**チーム**
\`ask <project>: <質問>\` - 他プロジェクトに質問

**その他**
\`ag\` - DevRelay Agreement v4 を適用（rules/devrelay.md 作成）
\`u\` - Agent バージョン確認・更新（2回連続で更新実行）
\`k\` - 実行中の AI プロセスを強制停止
\`x\` - 会話履歴をクリア（2回連続で実行）
\`q\` - 切断
\`h\` - このヘルプ

**作業指示**
上記以外のメッセージは AI への指示として処理されます
`.trim();
}
