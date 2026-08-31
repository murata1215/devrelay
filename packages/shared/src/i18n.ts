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
    en: '📦 **{machine}**\n  local: {localCommit} ({localDate})\n  remote: {remoteCommit} ({remoteDate})\n  ⚠️ Update available{runningCodeLines}\n\nSend `u` again to update.',
    ja: '📦 **{machine}**\n  ローカル: {localCommit} ({localDate})\n  リモート: {remoteCommit} ({remoteDate})\n  ⚠️ 更新があります{runningCodeLines}\n\nもう一度 `u` を送信すると更新を実行します。',
  },
  // #320: u の非同期通知（agent-manager.ts、sessionId/UserContext を持たないためここに専用キー）
  'update.completed': { en: '✅ **{machine}** update completed', ja: '✅ **{machine}** の更新が完了しました' },
  'update.failed': { en: '❌ Agent update failed: {error}', ja: '❌ Agent 更新に失敗しました: {error}' },
  'update.timedOut': {
    en: '⚠️ Agent update timed out (5 min).\nCheck `~/.devrelay/logs/update.log`.',
    ja: '⚠️ Agent 更新がタイムアウトしました（5分）。\n`~/.devrelay/logs/update.log` を確認してください。',
  },
  'update.agentOffline': { en: 'Agent is offline', ja: 'Agent がオフラインです' },
  'update.versionCheckTimeout': { en: 'Timed out', ja: 'タイムアウト' },
  'update.required': { en: '⚠️ This agent needs an update. Send `u` to update.', ja: '⚠️ この Agent は更新が必要です。`u` コマンドで更新してください。' },

  // --- claude auth（Claude ログイン切れ検知、リモート再ログイン中継 Phase1） ---
  'claudeAuth.expired': {
    en: '🔒 **{machine}**: Claude login has expired. Log in again on that machine, or send `login` from the WebUI chat for that machine to reconnect remotely.',
    ja: '🔒 **{machine}**: Claude のログインが切れました。そのマシンで再ログインするか、そのマシンの WebUI チャットから `login` を送信してリモート再ログインしてください。',
  },
  'claudeAuth.recovered': { en: '✅ **{machine}**: Claude login recovered', ja: '✅ **{machine}**: Claude のログインが復旧しました' },
  'claudeAuth.runtimeExpiredHint': {
    en: '🔒 Claude login has expired on this machine. Log in again there, or send `login` from the WebUI chat for that machine to continue.',
    ja: '🔒 このマシンで Claude のログインが切れています。再ログインするか、WebUI チャットから `login` を送信してから続けてください。',
  },

  // --- claude login（`login` コマンド、リモート再ログイン中継 Phase2） ---
  'claudeLogin.starting': {
    en: '🔐 Starting Claude re-login for **{machine}**… (fetching the login URL can take up to a minute)',
    ja: '🔐 **{machine}** の Claude 再ログインを開始しています…（URL の取得に数十秒かかることがあります）',
  },
  'claudeLogin.started': {
    en: '🔐 Started Claude re-login for **{machine}**.\nOpen the URL below in your browser, log in, then send the code shown as `login <code>` (within 10 minutes).\n{url}',
    ja: '🔐 **{machine}** の Claude 再ログインを開始しました。\n下の URL をブラウザで開いてログインし、表示されたコードを `login <コード>` の形式で送ってください（10分以内）。\n{url}',
  },
  'claudeLogin.codeAccepted': {
    en: '🔐 Authorization code submitted. Waiting for the result…',
    ja: '🔐 認可コードを送信しました。結果をお待ちください…',
  },
  'claudeLogin.success': {
    en: '✅ **{machine}** re-logged in to Claude{account}',
    ja: '✅ **{machine}** の Claude に再ログインしました{account}',
  },
  'claudeLogin.failed': { en: '❌ Claude re-login failed: {error}', ja: '❌ Claude 再ログインに失敗しました: {error}' },
  'claudeLogin.noFlow': {
    en: '⚠️ No re-login is in progress. Send `login` first.',
    ja: '⚠️ 進行中の再ログインがありません。先に `login` を送ってください。',
  },
  'claudeLogin.timeout': {
    en: '⚠️ Claude re-login timed out (10 min). Send `login` again.',
    ja: '⚠️ Claude 再ログインがタイムアウトしました（10分）。もう一度 `login` を送ってください。',
  },
  'claudeLogin.cancelled': { en: '⛔ Claude re-login cancelled', ja: '⛔ Claude 再ログインを中止しました' },
  'claudeLogin.invalidCode': {
    en: '⚠️ Invalid code format. Please paste only the code shown after logging in.',
    ja: '⚠️ コードの形式が正しくありません。ログイン後に表示されたコードだけを貼り付けてください。',
  },
  'claudeLogin.webOnly': {
    en: '🔒 `login` is only available from the WebUI (to prevent account hijacking via shared channels).',
    ja: '🔒 `login` は WebUI からのみ実行できます（共有チャンネル経由のアカウント乗っ取りを防ぐため）。',
  },
  'claudeLogin.offline': { en: '⚠️ No machine is connected, or it is offline.', ja: '⚠️ 接続中のマシンがない、またはオフラインです。' },
  'claudeLogin.unsupportedAgent': {
    en: '⚠️ This Agent does not support remote re-login (old Agent, or Claude could not be started at all). Please log in directly on that machine (`claude auth login`).',
    ja: '⚠️ この Agent はリモート再ログインに対応していません（旧 Agent、または Claude が全く起動できない状態）。そのマシンで直接ログインしてください（`claude auth login`）。',
  },

  // --- link ---
  'link.webNotNeeded': {
    en: '✅ You are operating directly from the Web interface, so account linking is not needed.',
    ja: '✅ Web インターフェースから直接操作しているため、アカウント連携は不要です。',
  },
  'link.alreadyLinked': {
    en: '✅ This account is already linked to a WebUI account.\n\nLinked to: {target}\nLinked on: {date}',
    ja: '✅ このアカウントは既に WebUI にリンクされています。\n\nリンク先: {target}\nリンク日: {date}',
  },
  'link.code': {
    en: '🔗 **Account Link Code**\n\n`{code}`\n\nEnter this code on the DevRelay WebUI Settings page.\n⏰ Expires in: 5 minutes\n\nWebUI: https://devrelay.io/settings',
    ja: '🔗 **アカウント連携コード**\n\n`{code}`\n\nこのコードを DevRelay WebUI の Settings ページで入力してください。\n⏰ 有効期限: 5分\n\nWebUI: https://devrelay.io/settings',
  },

  // --- agreement ---
  'agreement.sessionUnavailable': { en: '⚠️ Could not retrieve session info.', ja: '⚠️ セッション情報を取得できませんでした' },

  // --- log ---
  'log.notStarted': { en: '⚠️ No session has been started.', ja: '⚠️ セッションが開始されていません。' },
  'log.empty': { en: '📝 No messages.', ja: '📝 メッセージがありません。' },
  'log.header': { en: '📝 **Conversation Log** ({count} messages)\n\n{log}', ja: '📝 **会話ログ** ({count}件)\n\n{log}' },

  // --- summary ---
  'summary.comingSoon': { en: '📋 Summary feature coming soon.\n\nUse `log` to check the log.', ja: '📋 要約機能は準備中です。\n\n`log` でログを確認できます。' },

  // --- disconnect (remote) ---
  'disconnect.notConnected': { en: 'No remote project is currently connected.', ja: '接続中のリモートプロジェクトはありません。' },
  'disconnect.done': { en: '🔌 Disconnected from {name}. `e` / `w` will return to your own project.', ja: '🔌 {name} との接続を解除しました。`e` / `w` は自身のプロジェクトに戻ります。' },

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

  // --- progress（サーバー進捗ボックス + Agent ツール使用表示、#318） ---
  // #318: elapsedSec/elapsedMin はアイコン無しの「経過時間ラベル」。
  // session-manager.ts では自前で ⏱️ を前置し、ai-runner.ts の Devin/Codex ハートビートでは
  // 「(45s elapsed)」のように括弧内へそのまま埋め込むため、あえてアイコンを含めない。
  'progress.processing': { en: '🤖 **Processing...**', ja: '🤖 **処理中...**' },
  'progress.elapsedSec': { en: '{n}s elapsed', ja: '{n}秒経過' },
  'progress.elapsedMin': { en: '{n}m elapsed', ja: '{n}分経過' },
  'progress.usingTool': { en: '🔧 Using {tool}...', ja: '🔧 {tool}を使用中...' },
  'progress.mcpTool': { en: 'MCP tool', ja: 'MCP ツール' },
  'progress.devinRunning': { en: '⏳ Devin running... ({label}{limit})', ja: '⏳ Devin 実行中... ({label}{limit})' },
  'progress.codexRunning': { en: '⏳ Codex running... ({label})', ja: '⏳ Codex 実行中... ({label})' },
  'progress.runtimeLimitSuffix': { en: ' / limit {min}m', ja: ' / 上限{min}分' },
  'progress.timeout': { en: '⏱️ Timeout: no response from agent ({min} minutes elapsed)', ja: '⏱️ タイムアウト: エージェントから応答がありませんでした（{min}分経過）' },
  'progress.complete': { en: '✅ Done', ja: '✅ 完了' },

  // --- agent-manager.ts（sessionId のみ保持するハンドラ、#319） ---
  'aiStatus.error': { en: '❌ Error: {error}', ja: '❌ Error: {error}' },
  'aiStatus.running': { en: '🤖 AI Status: {status}', ja: '🤖 AI Status: {status}' },
  'agreement.upToDate': { en: '✅ DevRelay Agreement up to date', ja: '✅ DevRelay Agreement 対応済み' },
  'agreement.outdated': { en: '⚠️ DevRelay Agreement outdated - update to the latest with `ag`', ja: '⚠️ DevRelay Agreement 旧版 - `ag` で最新版に更新できます' },
  'agreement.none': { en: '⚠️ DevRelay Agreement not applied - apply it with `ag`', ja: '⚠️ DevRelay Agreement 未対応 - `ag` で対応できます' },
  'storage.saved': { en: '💾 Storage context saved ({n} chars)', ja: '💾 ストレージコンテキストを保存しました（{n}文字）' },
  'cancel.done': { en: '⛔ AI process cancelled', ja: '⛔ AI プロセスをキャンセルしました' },

  // --- session-manager.ts 残り（#319） ---
  'session.machineOffline': { en: '⚠️ Session ended because the machine went offline. Send `c` to reconnect.', ja: '⚠️ マシンがオフラインになったため、セッションが終了しました。`c` で再接続できます。' },

  // --- command-handler.ts の formatDuration/formatRunningCodeLines/handleSession/handleBuild（#319） ---
  'duration.hoursMinutes': { en: '{h}h {m}m', ja: '{h}時間{m}分' },
  'duration.minutesSeconds': { en: '{m}m {s}s', ja: '{m}分{s}秒' },
  'duration.seconds': { en: '{s}s', ja: '{s}秒' },
  'runningCode.line': { en: '\n  Running code: {mtime}', ja: '\n  実行中コード: {mtime}' },
  'runningCode.staleWarning': { en: '\n  ⚠️ Running code may be stale (missed rebuild? Please rebuild the Agent)', ja: '\n  ⚠️ 実行中コードが古い可能性（再ビルド漏れ？ Agent を再ビルドしてください）' },
  'session.notConnected': { en: '📍 Not connected', ja: '📍 未接続' },
  'session.lastConnection': { en: '   Last: {machine} / {project} (send `c` to reconnect)', ja: '   前回: {machine} / {project} (c で再接続)' },
  'session.fetchFailed': { en: '⚠️ Failed to retrieve session information', ja: '⚠️ セッション情報を取得できませんでした' },
  'build.noLogsYet': { en: '📋 No build logs yet. Build logs are recorded when you run `e` / `exec`.', ja: '📋 ビルドログがありません。`e` / `exec` で実行するとビルドが記録されます。' },
  'build.noProjects': { en: '⚠️ No projects found.', ja: '⚠️ プロジェクトがありません。' },
  'build.header': { en: '📋 **Build Log**', ja: '📋 **ビルドログ**' },

  // --- Agent 3OS ai-runner.ts の Codex/Devin 進捗表示 残り（#318 で mcp_tool_call のみ対応済み、#319） ---
  'progress.codexCommand': { en: '💻 Running command: {cmd}', ja: '💻 コマンド実行中: {cmd}' },
  'progress.codexFile': { en: '📝 Updating {path}...', ja: '📝 {path} を更新中...' },
  'progress.codexSearch': { en: '🔍 Searching: {query}', ja: '🔍 検索中: {query}' },
  'progress.devinStep': { en: '{tool} running', ja: '{tool} を実行中' },

  // --- 権限/セキュリティ ---
  'security.permissionDenied': { en: '🔒 You do not have permission to run commands.', ja: '🔒 コマンドを実行する権限がありません。' },
  'security.ipRestricted': {
    en: '🔒 Organization IP access restriction is active; commands cannot be issued from Discord/Telegram. Please use the WebUI from your corporate network.',
    ja: '🔒 組織のIPアクセス制限が有効なため、Discord/Telegram からのコマンド発行はできません。社内ネットワークから WebUI をご利用ください。',
  },

  // --- Devin CLI 非対応フラグ対応（#329: caps 駆動化 + 静かなフォールバック禁止） ---
  // #345: {detail} は「本当に非対応と判定したのか、環境差の疑いがあるのか」を切り分けるための
  // 診断サフィックス（例: "devin 3000.1.27 / help 4128 chars / probe=ok"）。全 OS の呼び出し側で必ず渡す。
  // #347: --config（--agent-config の後継）が使える端末では読み取り専用は実際に強制される（自動）。
  // このキーが出るのは --config も --agent-config も無い端末だけになった（両方見て先頭分岐が選ばれなかった場合）。
  'devin.readonlyUnsupported': {
    en: '⚠️ This machine\'s Devin CLI has neither `--config` nor `--agent-config`. Plan-mode read-only enforcement is prompt-instruction only (file writes cannot be fully blocked). For a permanent fix, add a `permissions.deny` rule to this machine\'s Devin CLI config file (e.g. `~/.config/devin/config.json` or `%APPDATA%\\devin\\config.json`), such as `"permissions": { "deny": ["Write(**)", "Exec(**)"] }`.\n({detail})',
    ja: '⚠️ この端末の Devin CLI には `--config` も `--agent-config` もありません。プランモードの読み取り専用強制はプロンプト指示のみになります（ファイル書き込みを完全にはブロックできません）。恒久的な対策としては、この端末の Devin CLI の config ファイル（例: `~/.config/devin/config.json` や `%APPDATA%\\devin\\config.json`）に `"permissions": { "deny": ["Write(**)", "Exec(**)"] }` のような `permissions.deny` ルールを追加してください。\n({detail})',
  },
  // --- #346: --agent-config 非対応時に「このマシンで何が使えるか」を1回だけ可視化する（診断強化） ---
  'devin.flagList': {
    en: '🔎 Flags exposed by this machine\'s Devin CLI: {flags}',
    ja: '🔎 この端末の Devin CLI が公開しているフラグ: {flags}',
  },
  'devin.unknownFlagRetry': {
    en: '⚠️ Devin CLI rejected the `{flag}` flag as unknown. Retrying without it...',
    ja: '⚠️ Devin CLI が `{flag}` フラグを認識しませんでした。外して再試行します...',
  },
  'devin.unknownFlagFailed': {
    en: '❌ Devin CLI still failed after removing `{flag}`. Please check the devin CLI version on this machine (`devin --help` / `devin update`).\n\n[stderr]\n{stderr}',
    ja: '❌ `{flag}` を外しても Devin CLI が失敗しました。この端末の devin CLI バージョンを確認してください（`devin --help` / `devin update`）。\n\n[stderr]\n{stderr}',
  },

  // --- #344: probe 失敗時の楽観化 + argv フォールバック廃止 + (No response from AI) の置き換え ---
  'ai.cliNotFound': {
    en: '❌ {tool} CLI (`{command}`) was not found by the Agent. If you installed or updated it, restart the Agent with `u` so it can be detected again.',
    ja: '❌ {tool} CLI（`{command}`）が Agent から見つかりませんでした。インストール・更新した直後の場合は `u` で Agent を再起動すると再検出されます。',
  },
  'ai.cliFailed': {
    en: '❌ {tool} CLI exited with code {code} without producing any output.\n\n[stderr]\n{stderr}',
    ja: '❌ {tool} CLI が出力なしで終了しました（exit {code}）。\n\n[stderr]\n{stderr}',
  },
  'devin.probeFailed': {
    en: '⚠️ Failed to probe this machine\'s Devin CLI (`devin --help`). Proceeding assuming all flags are supported; if an unsupported flag is rejected, DevRelay will automatically retry without it.\n({detail})',
    ja: '⚠️ この端末の Devin CLI のプローブ（`devin --help`）に失敗しました。全フラグ対応ありと仮定して続行します。非対応フラグが拒否された場合は自動的に外して再試行します。\n({detail})',
  },
  'devin.promptFileUnsupported': {
    en: '❌ This machine\'s Devin CLI does not support `--prompt-file`, so DevRelay cannot safely deliver the prompt (passing it as a raw command-line argument is unsafe and was removed in #344). Please update the devin CLI on this machine.',
    ja: '❌ この端末の Devin CLI は `--prompt-file` に対応していないため、プロンプトを安全に渡せません（コマンドライン引数への直接展開は #344 で廃止しました）。この端末の devin CLI を更新してください。',
  },
  'devin.execPermissionUnsupported': {
    en: '⚠️ This machine\'s Devin CLI does not support `--permission-mode`, so tool auto-approval in exec mode is not enforced by a flag (Devin\'s own default behavior applies).\n({detail})',
    ja: '⚠️ この端末の Devin CLI は `--permission-mode` に対応していないため、exec モードのツール自動承認はフラグでは強制されません（Devin 自身の既定動作に従います）。\n({detail})',
  },
  // --- #345: workspace trust 拒否（devin --respect-workspace-trust）への対処案内 ---
  'devin.workspaceUntrusted': {
    en: '❌ Devin CLI refused to run because it does not trust this workspace ({path}).\n\n① If your Agent is not yet updated, run `u` — DevRelay now passes `--respect-workspace-trust false` automatically (restores Devin\'s own documented default for non-interactive/print mode).\n② If it still happens, run `devin` interactively once in that directory on that machine to trust it.\n③ Or set `respect_workspace_trust: false` in the Devin CLI config on that machine.',
    ja: '❌ Devin CLI がこのワークスペース（{path}）を信頼していないため実行を拒否しました。\n\n① Agent が未更新の場合は `u` を実行してください — DevRelay は `--respect-workspace-trust false` を自動的に付与するようになりました（Devin 自身が文書化している非対話/print モードの既定値に戻すだけです）。\n② それでも発生する場合は、そのマシンでそのディレクトリで一度 `devin` を対話起動して trust してください。\n③ または、そのマシンの Devin CLI の config で `respect_workspace_trust: false` を設定してください。',
  },

  // --- #334: 人間入力テキストの長さ上限（ゲート②: チャット `e,<指示>`） ---
  'humanText.tooLong': {
    en: '❌ Instruction is too long ({rawLength} chars, limit {limit} chars). Please shorten it and try again (not truncated automatically).',
    ja: '❌ 指示が長すぎます（{rawLength}文字、上限{limit}文字）。短くして再送してください（自動での切り詰めは行いません）。',
  },

  // --- #335: 人間入力テキストの長さ上限（ゲート⑤: ask <project>: <question>） ---
  'humanText.questionTooLong': {
    en: '❌ Question is too long ({rawLength} chars, limit {limit} chars). Please shorten it and try again (not truncated automatically).',
    ja: '❌ 質問が長すぎます（{rawLength}文字、上限{limit}文字）。短くして再送してください（自動での切り詰めは行いません）。',
  },

  // --- #348: 同一プロジェクトへの並行実行検知（輻輳の可視化） ---
  'concurrency.sameProjectRunning': {
    en: 'ℹ️ Note: {count} other session(s) are currently running for this project ({project}).',
    ja: 'ℹ️ 参考: 現在このプロジェクト（{project}）に対して他に{count}件のセッションが実行中です。',
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
  if (!params) {
    warnIfUnresolvedPlaceholder(key, template);
    return template;
  }
  const result = template.replace(/\{(\w+)\}/g, (match, name) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
  warnIfUnresolvedPlaceholder(key, result);
  return result;
}

// #345: packages/shared は Node.js 固有 API を使わない方針（tsconfig の lib に DOM/Node 型を含まない）
// のため、token.ts の btoa/atob と同じ流儀でグローバルの最小シグネチャだけを宣言する。
declare const console: { warn(...args: unknown[]): void };

/**
 * #345: 置換後の文字列に未解決の `{placeholder}` が残っていないか検出する。
 * #86→#90 / #293→#304 / #345 §40 の `{tool}` 欠落と同クラスの「呼び出し側の同期漏れ」を
 * テストではなく実行時の構造で検出するための最小限のガード。表示は一切変えない（warn のみ）。
 */
function warnIfUnresolvedPlaceholder(key: ChatMessageKey, text: string): void {
  if (/\{[a-zA-Z][a-zA-Z0-9_]*\}/.test(text)) {
    console.warn(`[i18n] unresolved placeholder in tChat('${key}'): ${text}`);
  }
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
