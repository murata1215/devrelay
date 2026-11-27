import type { UserCommand, UserContext, AiTool, ModelSelectableAiTool, Language } from '@devrelay/shared';
import { SHORTCUTS, DEFAULT_CHAT_LANGUAGE, getWCommandPrompt } from '@devrelay/shared';
import { Project } from '@prisma/client';
import {
  parseNaturalLanguage,
  isTraditionalCommand,
  toTraditionalCommand,
  type ParsedCommand,
} from './natural-language-parser.js';
import { isNaturalLanguageEnabled } from './user-settings.js';
import { prisma } from '../db/client.js';
import { isThreadHandoverEnabled } from './thread-handover-rules.js';
import { AGREEMENT_VERSION } from './agreement-template.js';
import { isTestflightEnabled } from './testflight-manager.js';

/**
 * 「w」コマンドのワンショット exec プロンプト。
 * #316: 本文は packages/shared/src/i18n.ts の getWCommandPrompt() に集約した
 * （server / Agent の両方から参照するため。#309 のモデルカタログ集約と同方針）。
 * ここでは呼び出し元の `context.language` で解決するラッパーとして残す。
 */
function resolveWCommandPrompt(context: UserContext): string {
  return getWCommandPrompt(context.language ?? DEFAULT_CHAT_LANGUAGE);
}

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

  // 1.45. サイクルC3a-1: askreset コマンド（クロス ask の記憶リセット）。コロンを含まないため
  // 下の askMatchNlp（コロン必須）とは構造的に競合しない。ask 規則より前に置く
  // （「ask」で始まる文字列を askMatchNlp に先取りされないため。セッション状態に関わらず検出）。
  const askResetMatchNlp = trimmed.match(/^ask-?reset\s+(.+)$/i);
  if (askResetMatchNlp) {
    return { type: 'ask:reset', targetProject: askResetMatchNlp[1].trim() };
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
        where: { machineId: context.currentMachineId, deletedAt: null },
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
  // #334: promptOrigin='human' — 人間が入力した指示。長さ検証・fence の対象
  const execWithPromptMatch = input.trim().match(/^(?:e|exec)\s*,\s*(.+)$/is);
  if (execWithPromptMatch) {
    const prompt = execWithPromptMatch[1].trim();
    return { type: 'exec', prompt, promptOrigin: 'human' };
  }

  // 0.5. 「testflight」コマンド: テストフライトサービス管理
  const tfMatch = input.trim().match(/^testflight(?:\s+(.+))?$/i);
  if (tfMatch) {
    const arg = tfMatch[1]?.trim();
    if (!arg) return { type: 'testflight', subcommand: 'list' };
    if (arg === 'help') return { type: 'testflight', subcommand: 'help' };
    if (arg.startsWith('rm ')) return { type: 'testflight', subcommand: 'remove', name: arg.slice(3).trim() };
    // cp / copy: サービス複製（testflight cp <src> <dest>）
    if (arg.startsWith('cp ') || arg.startsWith('copy ')) {
      const copyArgs = arg.replace(/^(?:cp|copy)\s+/, '').trim().split(/\s+/);
      if (copyArgs.length === 2) {
        return { type: 'testflight', subcommand: 'copy', srcName: copyArgs[0], destName: copyArgs[1] };
      }
    }
    if (arg.startsWith('info ')) return { type: 'testflight', subcommand: 'info', name: arg.slice(5).trim() };
    // フラグ解析: "mygame --phaser" → name="mygame", template="phaser"
    const parts = arg.split(/\s+/);
    const flags = parts.filter(p => p.startsWith('--'));
    const nameArg = parts.filter(p => !p.startsWith('--'))[0] || arg;
    const template = flags.includes('--phaser') ? 'phaser' : undefined;
    return { type: 'testflight', subcommand: 'create', name: nameArg, template };
  }

  // 0.65. サイクルC3a-1: 「askreset <project>」「ask-reset <project>」パターン: クロス ask の記憶リセット
  // （0.7 の ask パターンより前に置く。コロンを含まないため構造的に競合しない）
  const askResetMatch = input.trim().match(/^ask-?reset\s+(.+)$/i);
  if (askResetMatch) {
    return { type: 'ask:reset', targetProject: askResetMatch[1].trim() };
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

  // 0.9. 「login」コマンド: Claude リモート再ログイン（#326 Phase2）
  // 認可コード（code#state）は大文字小文字を区別するため normalized ではなく input.trim() でマッチする。
  // web 限定にする判定（platform !== 'web' を拒否）は command-handler.ts 側で行う（ここではパースのみ）。
  const loginMatch = input.trim().match(/^login(?:\s+(.+))?$/i);
  if (loginMatch) {
    const arg = loginMatch[1]?.trim();
    if (!arg) return { type: 'login' };
    if (/^cancel$/i.test(arg)) return { type: 'login:cancel' };
    return { type: 'login:code', code: arg };
  }

  // 0.6. 「w」コマンド: ドキュメント更新＋コミットプッシュのワンショット実行
  // #334: promptOrigin='system' — DevRelay 自身が生成した固定プロンプト。長さ検証・fence の対象外
  if (normalized === 'w') {
    return {
      type: 'exec',
      prompt: resolveWCommandPrompt(context),
      promptOrigin: 'system',
    };
  }

  // 0.95. 「u force」「u!」「update force」コマンド: サイクル3.1
  // 実行中 AI ターンによる更新保留（D4）を無視して強制更新する。`u` は 2 文字未満キーのため
  // natural-language-parser.ts の汎用「キー + 空白」パターン（:252）に乗らず、個別パターンで拾う必要がある
  // （:233 の `a <tool>` と同じ理由）。
  if (/^u(?:pdate)?(?:\s+force|!)$/.test(normalized)) {
    return { type: 'update', force: true };
  }

  // 0.955. 「n make」: スレッド引継ぎ（next thread）の引継ぎ書を今のスレッドで作る。キルスイッチ OFF 時は従来どおり AI プロンプト
  if (/^n\s+make$/.test(normalized)) {
    if (!isThreadHandoverEnabled(process.env.DEVRELAY_THREAD_HANDOVER)) {
      return { type: 'ai:prompt', text: input };
    }
    return { type: 'handover:make' };
  }

  // 0.96. 「n <番号>」: スレッド引継ぎ（next thread）の候補選択。キルスイッチ OFF 時は従来どおり AI プロンプト
  const handoverPickMatch = normalized.match(/^n\s+(\d+)$/);
  if (handoverPickMatch) {
    if (!isThreadHandoverEnabled(process.env.DEVRELAY_THREAD_HANDOVER)) {
      return { type: 'ai:prompt', text: input };
    }
    return { type: 'handover:pick', number: parseInt(handoverPickMatch[1]) };
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
    if (['claude', 'gemini', 'codex', 'aider', 'devin'].includes(tool)) {
      return { type: 'ai:switch', tool };
    }
  }

  // 3.5. Check 'a <number>' or 'a <tool>' command
  const aMatch = normalized.match(/^a\s+(\d+|claude|gemini|codex|aider|devin)$/);
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
  
  // 3.6. 「l」コマンド: AI モデル選択（#309: claude 専用から codex/gemini/devin にも拡張）
  // l → 現在セッションのツールのモデル一覧、l sonnet → 両方設定、l plan:haiku → plan のみ、l exec:opus → exec のみ
  // l codex → codex の一覧、l codex:gpt-5.6-terra → codex の両方設定、l codex:plan:gpt-5.6-terra → codex の plan のみ
  const MODEL_TOOL_NAMES = ['claude', 'codex', 'gemini', 'devin'] as const;
  if (normalized === 'l') {
    return { type: 'model:list' };
  }
  const lMatch = normalized.match(/^l\s+(.+)$/);
  if (lMatch) {
    const arg = lMatch[1].trim();

    // `l codex` `l gemini` 等: ツール名単体 → そのツールの一覧表示
    if ((MODEL_TOOL_NAMES as readonly string[]).includes(arg)) {
      return { type: 'model:list', tool: arg as ModelSelectableAiTool };
    }

    // `l codex:plan:gpt-5.6-terra` `l codex:exec:gpt-5.6-sol`: ツール明示 + plan/exec 指定
    const toolModeMatch = arg.match(/^(claude|codex|gemini|devin):(plan|exec):(.+)$/);
    if (toolModeMatch) {
      return { type: 'model:set', target: toolModeMatch[2] as 'plan' | 'exec', model: toolModeMatch[3], tool: toolModeMatch[1] as ModelSelectableAiTool };
    }

    // `l codex:gpt-5.6-terra`: ツール明示、plan/exec 両方
    const toolBothMatch = arg.match(/^(claude|codex|gemini|devin):(.+)$/);
    if (toolBothMatch) {
      return { type: 'model:set', target: 'both', model: toolBothMatch[2], tool: toolBothMatch[1] as ModelSelectableAiTool };
    }

    // `l plan:haiku` `l exec:opus`: ツール省略（現在セッションのツール）+ plan/exec 指定
    const colonMatch = arg.match(/^(plan|exec):(.+)$/);
    if (colonMatch) {
      return { type: 'model:set', target: colonMatch[1] as 'plan' | 'exec', model: colonMatch[2] };
    }

    // `l sonnet`: ツール省略、plan/exec 両方
    return { type: 'model:set', target: 'both', model: arg };
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
      return { type: 'review' };
    case 'recent':
      return { type: 'recent' };
    case 'c':
      return { type: 'continue' };
    case 'x':
      return { type: 'clear' };
    case 'e':
    case 'exec':
      return { type: 'exec' };
    case 'w':
      // w コマンドは parseCommand() の Step 0.6 で処理されるが、念のためフォールバック
      // #334: promptOrigin='system'（Step 0.6 と同じ扱い）
      return {
        type: 'exec',
        prompt: resolveWCommandPrompt(context),
        promptOrigin: 'system',
      };
    case 'link':
      return { type: 'link' };
    case 'a':
      return { type: 'ai:list' };
    case 'n':
      // スレッド引継ぎ（next thread）。キルスイッチ OFF 時は従来どおり AI プロンプトとして扱う
      if (!isThreadHandoverEnabled(process.env.DEVRELAY_THREAD_HANDOVER)) {
        return { type: 'ai:prompt', text: shortcut };
      }
      return { type: 'handover:list' };
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
    case 'd':
    case 'disconnect':
      return { type: 'disconnect' };
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

export interface HelpTextOptions {
  /** 現在のチャットのプラットフォーム（'web' / 'discord' / 'telegram' 等）。未指定なら全節を出す */
  platform?: string;
}

/**
 * Generate help text
 * #316: チャット表示言語（context.language）に応じて en/ja を切り替える。
 * 2026-11-18: 環境に合わせて節を出し分ける（会社 devrelay は testflight 無効・WebUI のみのため）。
 * - テストフライト節: `DEVRELAY_TESTFLIGHT=0` なら出さない（isTestflightEnabled と同じ判定）
 * - スレッド引継ぎ節: `DEVRELAY_THREAD_HANDOVER=0` なら出さない（パーサ側の判定と揃える）
 * - `link`: platform が web のときは出さない（web では「不要」を返すだけ）
 * - `login`: platform が web 以外のときは出さない（web 専用コマンド）
 * - `sum` は未実装（準備中）のためヘルプには載せない（コマンド自体は残す）
 */
export function getHelpText(lang: Language = DEFAULT_CHAT_LANGUAGE, opts: HelpTextOptions = {}): string {
  const platform = opts.platform;
  const showTestflight = isTestflightEnabled(process.env.DEVRELAY_TESTFLIGHT);
  const showHandover = isThreadHandoverEnabled(process.env.DEVRELAY_THREAD_HANDOVER);
  const showLink = platform !== 'web';
  const showLogin = platform === undefined || platform === 'web';

  const en = lang === 'en';
  const sections: (string | false)[] = [];

  sections.push(en ? `📖 **DevRelay Command List**` : `📖 **DevRelay コマンド一覧**`);

  sections.push(en ? `**Basics**
\`m\` - List agents
\`p\` - List projects
\`c\` - Reconnect to the last project
\`s\` or \`session\` - Session info
\`1\`, \`2\`, \`3\`... - Select from a list` : `**基本操作**
\`m\` - エージェント一覧
\`p\` - プロジェクト一覧
\`c\` - 前回の接続先に再接続
\`s\` または \`session\` - セッション情報
\`1\`, \`2\`, \`3\`... - 一覧から選択`);

  sections.push(en ? `**Stop a running turn**
\`k\` or \`kill\` - Stop the running AI turn now (or use the Stop button in the WebUI progress box)` : `**実行中の停止**
\`k\` または \`kill\` - 実行中の AI を今すぐ停止（WebUI は進捗表示の「停止」ボタンでも可）`);

  sections.push(en ? `**Plan execution**
\`e\` or \`exec\` - Start executing the plan
\`e, <instruction>\` or \`exec, <instruction>\` - Execute with an extra instruction (e.g. \`e, commit it\`)
\`w\` - Update docs + commit + push (wrap up)` : `**プラン実行**
\`e\` または \`exec\` - プラン実行開始
\`e, <指示>\` または \`exec, <指示>\` - 指示を添えて実行（例: \`e, コミットして\`）
\`w\` - ドキュメント更新＋コミット＋プッシュ（wrap up）`);

  sections.push(en ? `**History**
\`recent\` - Recent work
\`log\` - Conversation log (last 10)
\`log20\` - Conversation log (20)` : `**履歴**
\`recent\` - 直近の作業一覧
\`log\` - 会話ログ (直近10件)
\`log20\` - 会話ログ (20件)`);

  sections.push(en ? `**AI switching**
\`a\` - List/switch AI tools
\`a 1\`, \`a 2\` - Select from the list by number
\`l\` - Model list (shows settings for the current session's tool)
\`l sonnet\` - Change both Plan/Exec models (current tool)
\`l plan:haiku\` - Change Plan only (current tool)
\`l exec:opus\` - Change Exec only (current tool)
\`l devin\` / \`l codex\` - Show model settings of the given tool
\`l devin:<model>\` - Change both Plan/Exec models of the given tool
\`l codex:plan:gpt-5.6-terra\` - Change the given tool's Plan only` : `**AI切り替え**
\`a\` - AI ツール一覧・切り替え
\`a 1\`, \`a 2\` - 一覧から番号で選択
\`l\` - AI モデル一覧（現在セッションのツールの設定を表示）
\`l sonnet\` - Plan/Exec 両方のモデルを変更（現在のツール）
\`l plan:haiku\` - Plan のみ変更（現在のツール）
\`l exec:opus\` - Exec のみ変更（現在のツール）
\`l devin\` / \`l codex\` - 指定したツールのモデル設定を表示
\`l devin:<モデル>\` - 指定したツールの Plan/Exec 両方を変更
\`l codex:plan:gpt-5.6-terra\` - 指定したツールの Plan のみ変更`);

  sections.push(showLink && (en ? `**Account linking**
\`link\` - Link with your WebUI account` : `**アカウント連携**
\`link\` - WebUI アカウントとリンク`));

  sections.push(en ? `**Build log**
\`b\` or \`build\` - Build log (exec history, per-machine build diffs)` : `**ビルドログ**
\`b\` または \`build\` - ビルドログ（exec 実行履歴・各マシンのビルド差分）`);

  sections.push(showTestflight && (en ? `**TestFlight**
\`testflight\` - List services
\`testflight <name>\` - Create a new service
\`testflight <name> --phaser\` - Create a Phaser game project
\`testflight rm <name>\` - Archive a service
\`testflight info <name>\` - Service details
\`testflight cp <src> <dest>\` - Copy a service
\`testflight help\` - Detailed help` : `**テストフライト**
\`testflight\` - サービス一覧
\`testflight <name>\` - 新規サービス作成
\`testflight <name> --phaser\` - Phaser ゲームプロジェクト作成
\`testflight rm <name>\` - サービスをアーカイブ
\`testflight info <name>\` - サービス詳細
\`testflight cp <src> <dest>\` - サービスを複製
\`testflight help\` - 詳細ヘルプ`));

  sections.push(showHandover && (en ? `**Thread handover**
\`n make\` - In the original thread, have its AI write a handover note (saved in doc/handover/)
\`n\` - In the new thread, list the handover notes created in this project
\`n 1\` - Use that handover note in this thread` : `**スレッド引継ぎ**
\`n make\` - 元のスレッドで、AI に引継ぎ書を書かせる（doc/handover/ に保存）
\`n\` - 新しいスレッドで、このプロジェクトの作成済み引継ぎ書を一覧表示
\`n 1\` - その引継ぎ書を今のスレッドで使う`));

  sections.push(en ? `**Team**
\`ask <project>: <question>\` - Ask another project
\`r\` - Ask this Team's reviewer to check the current conversation once, then reconsider the answer
\`askreset <project>\` - Reset the conversation memory of a cross-user ask target
\`teamexec <project>: <instruction>\` or \`te ...\` - Have another project execute work (\`e\` / \`w\` are then forwarded there)
\`d\` or \`disconnect\` - Release the teamexec target (\`e\` / \`w\` return to your own project)` : `**チーム**
\`ask <project>: <質問>\` - 他プロジェクトに質問
\`r\` - Team のレビュアーに現在の会話を1回だけ確認させ、回答を再考
\`askreset <project>\` - クロスユーザー ask 宛先の記憶をリセット
\`teamexec <project>: <指示>\` または \`te ...\` - 他プロジェクトに作業を実行させる（以後 \`e\` / \`w\` はそのプロジェクトに転送）
\`d\` または \`disconnect\` - teamexec の接続先を解除（\`e\` / \`w\` が自分のプロジェクトに戻る）`);

  sections.push(showLogin && (en ? `**Claude re-login (WebUI only)**
\`login\` - Start remote re-login when Claude login has expired
\`login <code>\` - Submit the authorization code shown after logging in
\`login cancel\` - Cancel the re-login` : `**Claude 再ログイン（WebUI のみ）**
\`login\` - Claude のログインが切れたときにリモート再ログインを開始
\`login <コード>\` - ログイン後に表示された認可コードを送信
\`login cancel\` - 再ログインを中止`));

  sections.push(en ? `**Other**
\`ag\` or \`agreement\` - Apply DevRelay Agreement ${AGREEMENT_VERSION} (creates rules/devrelay.md)
\`u\` or \`update\` - Check/update the agent version (send twice in a row to update)
\`u force\` or \`u!\` - Update now without waiting, even if an AI turn is in progress (connection is briefly interrupted)
\`x\` - Clear conversation history (send twice in a row)
\`recent\` - Show recent work
\`q\` - Disconnect
\`h\` - This help` : `**その他**
\`ag\` または \`agreement\` - DevRelay Agreement ${AGREEMENT_VERSION} を適用（rules/devrelay.md 作成）
\`u\` または \`update\` - Agent バージョン確認・更新（2回連続で更新実行）
\`u force\` または \`u!\` - AI 実行中でも待たずにすぐ更新（接続が一時的に切断されます）
\`x\` - 会話履歴をクリア（2回連続で実行）
\`recent\` - 直近の作業を表示
\`q\` - 切断
\`h\` - このヘルプ`);

  sections.push(en ? `**Work instructions**
Any other message is treated as an instruction to the AI` : `**作業指示**
上記以外のメッセージは AI への指示として処理されます`);

  return sections.filter((s): s is string => typeof s === 'string' && s.length > 0).join('\n\n');
}
