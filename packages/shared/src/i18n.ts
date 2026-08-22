/**
 * チャット（Discord/Telegram/LINE/WebUI）で使うメッセージの多言語化。
 * #316: WebUI の言語設定（#312/#313）はブラウザの React 層にしか効いておらず、
 * サーバーが返すチャット応答・Agent の進捗表示・AI へ渡すプロンプトは日本語ハードコードのままだった。
 *
 * server / agents(linux,macos,windows) / web の全パッケージが `@devrelay/shared` に依存しているため、
 * 翻訳カタログをここに集約する（#309 のモデルカタログ集約と同方針）。
 *
 * 既定言語は 'ja'（WebUI の既定 'en' とは異なる）。
 * `UserSettings.language` が未設定の既存ユーザーのチャット言語を維持するための意図的な非対称。
 * 明示的に English を選んだユーザーのみ英語になる。
 */

export type Language = 'en' | 'ja';

/** チャットの既定言語。WebUI の既定（'en'）とは異なる点に注意（既存ユーザー保護のため） */
export const DEFAULT_CHAT_LANGUAGE: Language = 'ja';

export function isLanguage(value: unknown): value is Language {
  return value === 'en' || value === 'ja';
}

/**
 * チャット文言カタログ。`{param}` プレースホルダは `tChat()` の第3引数で置換する。
 * 絵文字は言語非依存のためそのまま両言語の値に含める。
 */
export const chatMessages = {
  // --- 共通 ---
  'common.unknownCommand': { en: '❓ Unknown command. Send `h` for help.', ja: '❓ 不明なコマンドです。`h` でヘルプを表示できます。' },
  'common.notConnected': { en: '⚠️ Not connected to a project.', ja: '⚠️ プロジェクトに接続されていません。' },
  'common.notConnectedGuide': {
    en: '⚠️ Not connected to a project.\n\nConnect with `m` → select agent → `p` → select project.',
    ja: '⚠️ プロジェクトに接続されていません。\n\n`m` → エージェント選択 → `p` → プロジェクト選択 の順で接続してください。',
  },
  'common.agentNotConnected': {
    en: '⚠️ Not connected to an agent.\nSend `m` to list agents and connect.',
    ja: '⚠️ エージェントに接続されていません。\n`m` でエージェント一覧を表示して接続してください。',
  },
  'common.sessionNotFound': { en: '❌ Session not found.', ja: '❌ セッションが見つかりません。' },

  // --- machine (m) ---
  'machine.notLinked': {
    en: '⚠️ Not linked to a WebUI account.\n\nGet a link code with `link` and enter it on the WebUI Settings page.',
    ja: '⚠️ WebUI アカウントに連携されていません。\n\n`link` コマンドでリンクコードを取得し、WebUI の Settings ページで入力してください。',
  },
  'machine.empty': {
    en: '📡 No agents registered.\n\nTo add an agent:\n1. Click "Add Agent" on the WebUI Agents page\n2. Copy the generated token\n3. Run `devrelay setup` on the target machine and enter the token',
    ja: '📡 登録されているエージェントがありません。\n\nエージェントを追加するには:\n1. WebUI の Agents ページで「Add Agent」をクリック\n2. 生成されたトークンをコピー\n3. 対象マシンで `devrelay setup` を実行してトークンを入力',
  },
  'machine.listHeader': { en: '📡 **Agents**\n\n{list}', ja: '📡 **エージェント一覧**\n\n{list}' },
  'machine.notFound': { en: '❌ Agent not found.', ja: '❌ エージェントが見つかりません。' },
  'machine.offline': { en: '⚠️ {name} is offline.', ja: '⚠️ {name} はオフラインです。' },
  'machine.connected': { en: '✅ Connected to **{name}**', ja: '✅ **{name}** に接続しました' },

  // --- project (p) ---
  'project.empty': {
    en: '📁 No projects registered.\n\nRun `devrelay projects add <path>` on the agent side.',
    ja: '📁 プロジェクトが登録されていません。\n\nエージェント側で `devrelay projects add <path>` を実行してください。',
  },
  'project.listHeader': { en: '📁 **Projects** ({machine})\n\n{list}', ja: '📁 **プロジェクト** ({machine})\n\n{list}' },
  'project.notFound': { en: '❌ Project not found.', ja: '❌ プロジェクトが見つかりません。' },
  'project.userInfoFailed': { en: '❌ Failed to get user info.', ja: '❌ ユーザー情報の取得に失敗しました。' },

  // --- select (number) ---
  'select.noList': { en: '⚠️ No list to select from.\nSend `m` or `p` to show a list.', ja: '⚠️ 選択できる一覧がありません。\n`m` または `p` で一覧を表示してください。' },
  'select.outOfRange': { en: '⚠️ {number} is out of range. Enter a number from 1 to {max}.', ja: '⚠️ {number} は範囲外です。1〜{max} の数字を入力してください。' },
  'select.unknown': { en: '⚠️ Unknown selection.', ja: '⚠️ 不明な選択です。' },

  // --- clear (x) ---
  'clear.wWarning': {
    en: '⚠️ You have not run the `w` command (update docs / commit) yet.\n',
    ja: '⚠️ `w` コマンド（ドキュメント更新・コミット）を実行していません。\n',
  },
  'clear.confirm': { en: '{warnPrefix}⚠️ Clear conversation history? Send `x` again to confirm.', ja: '{warnPrefix}⚠️ 会話履歴をクリアしますか？ もう一度 `x` を送信してください。' },
  'clear.done': { en: '🗑️ Conversation history cleared', ja: '🗑️ 会話履歴をクリアしました' },

  // --- ai (a) ---
  'ai.noTools': { en: '⚠️ No AI tools are configured.', ja: '⚠️ AI ツールが設定されていません。' },
  'ai.listHeader': { en: '🤖 **AI Tools**\n\n{list}\n\nSwitch with `a 1` or `a claude`', ja: '🤖 **AI ツール**\n\n{list}\n\n`a 1` または `a claude` で切り替え' },
  'ai.listFailed': { en: '❌ Failed to get AI tool list.', ja: '❌ AI ツール一覧の取得に失敗しました。' },
  'ai.switched': { en: '🔄 Switched AI to **{name}**', ja: '🔄 AI を **{name}** に切り替えました' },
  'ai.switchFailed': { en: '❌ Failed to switch AI: {error}', ja: '❌ AI 切り替えに失敗しました: {error}' },
  'ai.switchFailedGeneric': { en: '❌ Failed to switch AI.', ja: '❌ AI 切り替えに失敗しました。' },
  'ai.unknownError': { en: 'unknown error', ja: '不明なエラー' },

  // --- status (s) / recent (r) / continue (c) ---
  'status.notConnected': { en: '📊 Not connected\n\nSend `m` to list agents', ja: '📊 未接続\n\n`m` でエージェント一覧を表示' },
  'recent.empty': { en: '📜 No work history yet.', ja: '📜 作業履歴がありません。' },
  'recent.header': { en: '📜 **Recent work**\n\n{list}', ja: '📜 **直近の作業**\n\n{list}' },
  'continue.noPrevious': {
    en: '⚠️ No previous connection.\n\nSend `m` to list agents and connect.',
    ja: '⚠️ 前回の接続先がありません。\n\n`m` でエージェント一覧を表示して接続してください。',
  },
  'continue.projectNotFound': {
    en: '❌ Previous project not found.\n\nSend `m` to list agents and connect.',
    ja: '❌ 前回のプロジェクトが見つかりません。\n\n`m` でエージェント一覧を表示して接続してください。',
  },
  'continue.offline': { en: '⚠️ **{name}** is offline.\n\nPrevious: {prev}', ja: '⚠️ **{name}** はオフラインです。\n\n前回: {prev}' },
  'continue.reconnected': { en: '🔄 **{project}** reconnected\n{ai} session restored', ja: '🔄 **{project}** に再接続\n{ai} セッション復元' },
  'continue.connected': { en: '🚀 **{project}** connected\n{ai} started', ja: '🚀 **{project}** に接続\n{ai} 起動完了' },

  // --- update (u) ---
  'update.updating': { en: '🔄 Updating agent...\n(connection will be briefly interrupted)', ja: '🔄 Agent を更新中...\n（接続が一時的に切断されます）' },
  'update.checkFailed': { en: '❌ Version check failed: {error}', ja: '❌ バージョン確認に失敗しました: {error}' },
  'update.devRepoWarning': {
    en: '⚠️ Running from a dev repository, remote update unavailable.\nUse `pnpm deploy-agent` instead.',
    ja: '⚠️ 開発リポジトリから実行中のため、リモート更新は不可。\n`pnpm deploy-agent` を使用してください。',
  },
  'update.upToDate': { en: '✅ Agent is up to date\n  commit: {commit} ({date}){runningCodeLines}', ja: '✅ Agent は最新です\n  commit: {commit} ({date}){runningCodeLines}' },
  'update.available': {
    en: '⚠️ Update available for **{machine}**\n  local: {localCommit} ({localDate})\n  remote: {remoteCommit} ({remoteDate}){runningCodeLines}\n\nSend `u` again to update.',
    ja: 'ℹ️ **{machine}** に更新があります\n  ローカル: {localCommit} ({localDate})\n  リモート: {remoteCommit} ({remoteDate})\n  ⚠️ 更新があります{runningCodeLines}\n\nもう一度 `u` を送信すると更新を実行します。',
  },

  // --- exec (e) ---
  'exec.forwarding': { en: '🔗 Forwarding to {name}...', ja: '🔗 {name} に転送中...' },
  'exec.defaultInstruction': {
    en: 'exec (start executing according to the plan)',
    ja: 'exec（プランに従って実装を開始してください）',
  },
  'exec.sessionInfoNotFound': {
    en: '❌ Session info not found. Send `c` to reconnect.',
    ja: '❌ セッション情報が見つかりません。`c` で再接続してください。',
  },
  'exec.reconnected': { en: '🔄 Reconnected to the last project ({machine} / {project})', ja: '🔄 前回の接続先（{machine} / {project}）に再接続しました' },

  // --- quit (q) ---
  'quit.done': { en: '👋 Disconnected', ja: '👋 切断しました' },

  // --- 権限/セキュリティ ---
  'security.permissionDenied': { en: '🔒 You do not have permission to run commands.', ja: '🔒 コマンドを実行する権限がありません。' },
  'security.ipRestricted': {
    en: '🔒 Organization IP access restriction is active; commands cannot be issued from Discord/Telegram. Please use the WebUI from your corporate network.',
    ja: '🔒 組織のIPアクセス制限が有効なため、Discord/Telegram からのコマンド発行はできません。社内ネットワークから WebUI をご利用ください。',
  },
} as const;

export type ChatMessageKey = keyof typeof chatMessages;

/**
 * チャット文言を言語に応じて取得し、`{param}` プレースホルダを置換する。
 * @param lang 表示言語
 * @param key チャット文言カタログのキー
 * @param params プレースホルダ置換用パラメータ
 */
export function tChat(
  lang: Language,
  key: ChatMessageKey,
  params?: Record<string, string | number>
): string {
  const template = chatMessages[key][lang];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

// -----------------------------------------------------------------------------
// `w` コマンドのプロンプト（AI へ渡す指示文）
// -----------------------------------------------------------------------------

/**
 * 「w」コマンドのワンショット exec プロンプト（日本語版）。
 * 実装後のドキュメント更新＋コミット/プッシュ専用。詳細は各言語版共通のコメントを参照。
 */
const W_COMMAND_PROMPT_JA =
  'まず `git rev-parse --is-inside-work-tree` を実行して、このディレクトリが git リポジトリかどうかを判定してください。' +
  '【git リポジトリの場合】' +
  'git status / git diff で未コミットの変更があるか確認してください。' +
  'コミット対象の変更が無い場合は、存在しないプランを推測せず「コミット対象の変更はありません」とだけ報告して終了してください（追加の実装・調査は不要）。' +
  '変更がある場合のみ以下を行ってください: ' +
  'doc/changelog.md があればそこに今回の変更を追記してください。rules/project.md があれば新しい設計判断を反映してください。CLAUDE.md を必要に応じて更新してください（技術スタック等の変更のみ）。MEMORY.md があれば更新してください。README.md を今回の変更内容で更新してください。更新後、コミットしてプッシュしてください。' +
  '【git リポジトリでない場合（git コマンドが失敗する場合も含む）】' +
  'コミット・プッシュは一切行わないでください。git のエラーは無視して構いません。' +
  'git diff が使えないため、今回の会話でどんな作業を行ったか（作成・変更したファイル、決定事項）を会話履歴と現在のディレクトリの内容から把握し、以下のドキュメント更新のみを行ってください: ' +
  'README.md を今回の内容で更新してください（無ければ新規作成し、プロジェクトの概要・使い方・ディレクトリ構成を記載）。' +
  'MEMORY.md を更新してください（無ければ新規作成し、日付つきで作業メモ・決定事項・次回への引き継ぎを追記）。' +
  'doc/changelog.md・CLAUDE.md・rules/project.md など他の .md は、既に存在する場合のみ併せて更新してください（新規作成は README.md と MEMORY.md のみ）。' +
  '記録すべき作業内容が無い場合は、存在しないプランを推測せず「記録する変更はありません」とだけ報告して終了してください。' +
  '最後に「git リポジトリではないためコミット・プッシュはスキップしました」と、更新したファイルの一覧を報告してください。';

/** 「w」コマンドのワンショット exec プロンプト（英語版）。内容は JA 版と同一。 */
const W_COMMAND_PROMPT_EN =
  'First run `git rev-parse --is-inside-work-tree` to determine whether this directory is a git repository.' +
  '[If it is a git repository] ' +
  'Check git status / git diff for uncommitted changes. ' +
  'If there is nothing to commit, do not invent a plan — just report "There are no changes to commit." and stop (no further implementation or investigation needed). ' +
  'Only if there are changes, do the following: ' +
  'update doc/changelog.md with this change if it exists. Reflect any new design decisions in rules/project.md if it exists. Update CLAUDE.md if needed (tech stack changes only). Update MEMORY.md if it exists. Update README.md to reflect this change. After updating, commit and push. ' +
  '[If it is NOT a git repository (including when the git command fails)] ' +
  'Do not commit or push at all. Ignore any git errors. ' +
  'Since git diff is unavailable, infer what work was done in this conversation (files created/changed, decisions made) from the conversation history and current directory contents, and only update documentation as follows: ' +
  'Update README.md to reflect this work (create it if missing, describing the project overview, usage, and directory structure). ' +
  'Update MEMORY.md (create it if missing, with dated notes on work done, decisions, and handoff notes for next time). ' +
  'Other .md files such as doc/changelog.md, CLAUDE.md, rules/project.md should only be updated if they already exist (only README.md and MEMORY.md may be newly created). ' +
  'If there is nothing worth recording, do not invent a plan — just report "There is nothing to record." and stop. ' +
  'Finally, report "This is not a git repository, so commit/push was skipped." along with a list of the files you updated.';

/** `lang` に応じた `w` コマンドプロンプトを返す */
export function getWCommandPrompt(lang: Language): string {
  return lang === 'en' ? W_COMMAND_PROMPT_EN : W_COMMAND_PROMPT_JA;
}

/**
 * #304 の教訓: `w` 実行判定のプレフィックスはプロンプト本文から自動派生させ、同期漏れを防ぐ。
 * 過去の実行が JA/EN どちらの言語でも判定できるよう、両言語のプレフィックスを返す。
 */
export const W_COMMAND_PROMPT_PREFIXES: readonly [string, string] = [
  W_COMMAND_PROMPT_JA.slice(0, 30),
  W_COMMAND_PROMPT_EN.slice(0, 30),
];
