// =============================================================================
// DevRelay Shared Constants
// =============================================================================

// Shortcut commands (works without API key)
export const SHORTCUTS: Record<string, string> = {
  'm': 'machine:list',
  'p': 'project:list',
  // 's': 'status',  // 現在未使用
  'r': 'recent',
  'c': 'continue',  // 前回の接続先に再接続
  'x': 'clear',     // 会話履歴をクリア
  'e': 'exec',      // プラン実行開始
  'exec': 'exec',   // プラン実行開始（フルコマンド）
  'w': 'wrap',       // ドキュメント更新＋コミットプッシュ（wrap up）
  'link': 'link',   // プラットフォームリンクコード生成
  'a': 'ai:list',   // AI ツール一覧・切り替え
  'ag': 'agreement', // DevRelay Agreement を CLAUDE.md に追加
  'agreement': 'agreement',
  's': 'session',    // セッション情報を表示
  'session': 'session',
  'b': 'build',     // ビルドログ（exec 実行履歴）
  'build': 'build',
  'k': 'kill',     // AI プロセスを強制停止
  'kill': 'kill',
  'u': 'update',   // Agent バージョン確認・更新
  'update': 'update',
  'q': 'quit',
  'd': 'disconnect',  // 接続プロジェクト解除（Manager 用）
  'disconnect': 'disconnect',
  'h': 'help',
  'log': 'log',
  'sum': 'summary',
  'testflight': 'testflight',
};

// AI tool display names
export const AI_TOOL_NAMES: Record<string, string> = {
  'claude': 'Claude Code',
  'gemini': 'Gemini CLI',
  'codex': 'Codex CLI',
  'aider': 'Aider',
  'devin': 'Devin CLI',
};

// =============================================================================
// AI モデルカタログ（Plan/Exec モデル分離設定の選択肢定義）
// =============================================================================

/** モデル選択肢の 1 件（id は各 CLI にそのまま渡す値） */
export interface ModelOption {
  /** CLI にそのまま渡すモデル ID（例: 'sonnet', 'gpt-5.6-terra'） */
  id: string;
  /** UI 表示名 */
  name: string;
  /** 補足説明 */
  description: string;
}

/**
 * plan/exec モデル分離設定 (`l` コマンド・WebUI 設定ページ) が対象とする AI ツール。
 * aider は generic シェル起動のみでモデル指定 CLI 引数を持たないため対象外。
 */
export type ModelSelectableAiTool = 'claude' | 'codex' | 'gemini' | 'devin';

/**
 * ツールごとのモデル選択肢カタログ。
 * server（command-handler.ts）・web（SettingsPage.tsx）の両方がここだけを参照する単一情報源。
 * ここに無い ID もチャット/WebUI から自由入力で指定可能（新モデル追従のため、カタログは随時更新する運用）。
 * 2026-08 時点のスナップショット。
 */
export const AI_MODEL_CATALOG: Record<ModelSelectableAiTool, ModelOption[]> = {
  claude: [
    { id: 'claude-fable-5', name: 'Claude Fable 5', description: '最高性能（Mythos クラス）' },
    { id: 'claude-opus-5', name: 'Claude Opus 5', description: '高性能（最新）' },
    { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', description: '高性能' },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', description: 'バランス型（最新）' },
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', description: '高速・低コスト（最新）' },
    { id: 'opus', name: 'Claude Opus（CLI版）', description: 'CLI デフォルト解決' },
    { id: 'sonnet', name: 'Claude Sonnet（CLI版）', description: 'CLI デフォルト解決' },
    { id: 'haiku', name: 'Claude Haiku（CLI版）', description: 'CLI デフォルト解決' },
  ],
  // #310 追記: 2026-08-18 に実機の `~/.codex/models_cache.json`（codex-cli 0.147.0）で
  // visibility==='list' なモデルを priority 昇順で確認して置き換え。
  // 旧カタログの gpt-5.3-codex/gpt-5.2-codex/gpt-5.1-codex-max/gpt-5.1-codex は
  // このバージョンには存在しない（#309 実装時に実機確認せず記載した誤り）。
  // 実際の CLI 既定モデルは gpt-5.5 ではなく gpt-5.6-sol（過去セッションログで実測確認済み）。
  codex: [
    { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', description: '最上位・難バグ/設計（CLI 既定）' },
    { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', description: 'バランス型・普段使いの本命' },
    { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', description: '軽量・高速・低コスト' },
    { id: 'gpt-5.5', name: 'GPT-5.5', description: '旧世代上位' },
    { id: 'gpt-5.4', name: 'GPT-5.4', description: '旧世代・日常コーディング' },
    { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', description: '旧世代・小型高速' },
  ],
  gemini: [
    { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', description: '最新フラッグシップ' },
    { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', description: '高速（最新）' },
    { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', description: '高速' },
    { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash-Lite', description: '軽量・低コスト' },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: '旧世代・実績重視' },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', description: '旧世代・高速' },
  ],
  devin: [
    { id: 'opus', name: 'Claude Opus', description: 'fuzzy 名（family/alias）で指定' },
    { id: 'sonnet', name: 'Claude Sonnet', description: 'fuzzy 名（family/alias）で指定' },
    { id: 'gpt-5.5', name: 'GPT-5.5', description: 'fuzzy 名（family/alias）で指定' },
    { id: 'gemini', name: 'Gemini', description: 'fuzzy 名（family/alias）で指定' },
  ],
};

/** モデル ID として許可しない危険文字を含むかチェック（CLI 引数・TOML インジェクション防止） */
export function isUnsafeModelId(value: string): boolean {
  return /["'`;$\n\r]/.test(value) || /\s/.test(value);
}

/** ツール名が plan/exec モデル分離設定の対象かどうか判定 */
export function isModelSelectableAiTool(aiTool: string): aiTool is ModelSelectableAiTool {
  return aiTool === 'claude' || aiTool === 'codex' || aiTool === 'gemini' || aiTool === 'devin';
}

// Status emojis
export const STATUS_EMOJI = {
  online: '🟢',
  offline: '⚪',
  running: '🤖',
  starting: '🚀',
  stopped: '⏹️',
  error: '❌',
} as const;

// プランモード中に許可する読み取り専用 Bash コマンドのデフォルトリスト（Linux 用）
// 注意: `Bash(cmd)` は完全一致（引数なし）、`Bash(cmd *)` はプレフィックスマッチ（引数付き）
// 引数なしでも使うコマンドには両方必要
export const DEFAULT_ALLOWED_TOOLS_LINUX: string[] = [
  // PM2 ログ・ステータス確認
  'Bash(pm2 logs)',
  'Bash(pm2 logs *)',
  'Bash(pm2 log *)',
  'Bash(pm2 status)',
  'Bash(pm2 status *)',
  'Bash(pm2 list)',
  'Bash(pm2 list *)',
  'Bash(pm2 show *)',
  'Bash(pm2 describe *)',
  // システム・ログ確認
  'Bash(journalctl *)',
  'Bash(systemctl status *)',
  'Bash(systemctl is-active *)',
  // Git 読み取り
  'Bash(git log)',
  'Bash(git log *)',
  'Bash(git status)',
  'Bash(git status *)',
  'Bash(git diff)',
  'Bash(git diff *)',
  'Bash(git show *)',
  'Bash(git branch)',
  'Bash(git branch *)',
  // システム情報
  'Bash(ps *)',
  'Bash(free)',
  'Bash(free *)',
  'Bash(df)',
  'Bash(df *)',
  'Bash(du *)',
  'Bash(ss *)',
  'Bash(netstat)',
  'Bash(netstat *)',
  // Docker（参照のみ）
  'Bash(docker ps)',
  'Bash(docker ps *)',
  'Bash(docker logs *)',
  'Bash(docker compose ps)',
  'Bash(docker compose ps *)',
  'Bash(docker compose logs *)',
  // ファイル検索（読み取り専用）
  'Bash(find *)',
  'Bash(locate *)',
  'Bash(which *)',
  // ログ・ファイル読み取り
  'Bash(tail *)',
  'Bash(head *)',
  'Bash(wc *)',
  'Bash(ls)',
  'Bash(ls *)',
  // ネットワーク・サーバー状態
  'Bash(curl *)',
  'Bash(lsof *)',
  'Bash(uptime)',
  'Bash(uptime *)',
  // リバースプロキシ確認
  'Bash(caddy *)',
  // #332: 検証コマンド（テスト・型チェックのみ。ファイルを書く pnpm build 等は含めない）
  'Bash(pnpm test)',
  'Bash(pnpm test *)',
  'Bash(pnpm lint)', // --fix で書き込み得るため引数付き(*)は追加しない
  'Bash(npx tsc --noEmit)',
  'Bash(npx tsc --noEmit *)',
];

/**
 * #332: plan モードの strictReadonly ポリシー時に Bash 以外で常時許可するツール名。
 * 判断基準: 「読み取り専用か判断に迷うものは deny ではなく allow 側に倒す」（人間承認時の追記）。
 * - Read/Glob/Grep/NotebookRead: ファイル読み取り専用
 * - Task: サブエージェント起動（内部ツール呼び出しは親の canUseTool を経由する前提。実機 E2E で要確認）
 * - ToolSearch/TaskOutput/TaskStop: 前サイクルの調査ログで実使用を確認済みの読み取り/制御系ツール
 *   （TaskStop は実行中タスクの停止で書き込みではないため allow 側）
 * - TodoWrite: ファイル書き込みではなくセッション内タスクリストの更新のみのため allow 側
 * - WebFetch/WebSearch: 外部読み取りのみでリポジトリを変更しない
 * Write/Edit/MultiEdit/NotebookEdit/ExitPlanMode は意図的に含めない。
 */
export const PLAN_READONLY_TOOLS: string[] = [
  'Read',
  'Glob',
  'Grep',
  'NotebookRead',
  'Task',
  'ToolSearch',
  'TaskOutput',
  'TaskStop',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
];

/**
 * #333: strictReadonly の Bash 判定で「先頭コマンド名が単体で読み取り専用と確定できる」もの。
 * ここに載っていれば引数にグロブ（* ? []）や複数パスが含まれていても deny 理由にしない
 * （#333 の根本原因: 従来はコマンド文字列全体の前方一致だったため `ls doc/*` のような
 * グロブ付き読み取りコマンドが allowedTools のプレフィックスと一致せず deny されていた）。
 * サブコマンドで書き込みになり得るもの（git/pm2/docker/npm 等）はここに含めず、
 * 個別の allowedTools ルール（Bash(git log *) 等）側で判定する。
 * `env` は `env rm file` のように別コマンドの前段として書き込みを隠せるため意図的に含めない。
 * `sed`/`awk`/`xargs`/`echo`/`printf` も書き込み手段になり得るため含めない。
 */
export const PLAN_READONLY_BASH_COMMANDS: string[] = [
  'ls', 'cat', 'head', 'tail', 'wc',
  'grep', 'egrep', 'fgrep', 'rg',
  'find', 'locate', 'which', 'file', 'stat',
  'sort', 'uniq', 'cut', 'tr', 'nl', 'column', 'diff', 'jq',
  'basename', 'dirname', 'realpath', 'readlink', 'pwd', 'cd',
  'date', 'whoami', 'id', 'hostname', 'uname', 'printenv',
  'df', 'du', 'free', 'uptime', 'ps', 'pgrep', 'lsof', 'ss', 'netstat',
  // Windows CLI Agent（agents/linux で実行）向け
  'dir', 'type', 'where',
];

/**
 * #333: strictReadonly の Bash 判定で単体・先頭一致した時点で常に write（書き込み系）とみなすコマンド。
 * 単語 1 語のもの（例: 'rm'）は argv0 一致、"cmd sub" 形式（例: 'git commit'）は
 * git のグローバルフラグ（-C 等）を読み飛ばした先頭 2 トークン一致で判定する
 * （decideBashCommand/isWriteBashCommand を参照）。
 */
export const PLAN_WRITE_BASH_COMMANDS: string[] = [
  'rm', 'mv', 'cp', 'touch', 'mkdir', 'rmdir', 'chmod', 'chown', 'chgrp',
  'ln', 'dd', 'truncate', 'tee', 'install', 'kill', 'pkill',
  'git add', 'git commit', 'git push', 'git checkout', 'git reset',
  'git rm', 'git mv', 'git clean', 'git merge', 'git rebase',
  'git cherry-pick', 'git stash',
  'pm2 restart', 'pm2 stop', 'pm2 delete', 'pm2 kill',
  'systemctl start', 'systemctl stop', 'systemctl restart',
  'systemctl enable', 'systemctl disable', 'systemctl mask',
  'docker run', 'docker rm', 'docker exec', 'docker stop', 'docker kill',
  'docker rmi', 'docker build',
  'npm install', 'npm i', 'npm build', 'npm add', 'npm uninstall',
  'npm remove', 'npm ci', 'npm update', 'npm publish',
  'pnpm install', 'pnpm add', 'pnpm build', 'pnpm remove',
  'pnpm update', 'pnpm publish',
  'yarn install', 'yarn add', 'yarn build', 'yarn remove', 'yarn upgrade',
];

/**
 * #333: strictReadonly で Bash 以外に常に deny（writeTool 理由）とみなすツール名。
 * PLAN_READONLY_TOOLS には含まれないファイル書き込み系ツール一覧。
 */
export const PLAN_WRITE_TOOLS: string[] = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

// プランモード中に許可する読み取り専用 Bash コマンドのデフォルトリスト（Windows 用）
// 注意: `Bash(cmd)` は完全一致（引数なし）、`Bash(cmd *)` はプレフィックスマッチ（引数付き）
// 引数なしでも使うコマンドには両方必要
export const DEFAULT_ALLOWED_TOOLS_WINDOWS: string[] = [
  // PM2 ログ・ステータス確認
  'Bash(pm2 logs)',
  'Bash(pm2 logs *)',
  'Bash(pm2 log *)',
  'Bash(pm2 status)',
  'Bash(pm2 status *)',
  'Bash(pm2 list)',
  'Bash(pm2 list *)',
  'Bash(pm2 show *)',
  'Bash(pm2 describe *)',
  // Git 読み取り
  'Bash(git log)',
  'Bash(git log *)',
  'Bash(git status)',
  'Bash(git status *)',
  'Bash(git diff)',
  'Bash(git diff *)',
  'Bash(git show *)',
  'Bash(git branch)',
  'Bash(git branch *)',
  // システム情報（PowerShell）
  'Bash(Get-Service *)',
  'Bash(Get-Process *)',
  'Bash(Get-EventLog *)',
  'Bash(tasklist)',
  'Bash(tasklist *)',
  'Bash(sc query *)',
  'Bash(netstat)',
  'Bash(netstat *)',
  // Docker（参照のみ）
  'Bash(docker ps)',
  'Bash(docker ps *)',
  'Bash(docker logs *)',
  'Bash(docker compose ps)',
  'Bash(docker compose ps *)',
  'Bash(docker compose logs *)',
  // ファイル検索・読み取り
  'Bash(Get-Content *)',
  'Bash(type *)',
  'Bash(dir *)',
  'Bash(where *)',
  'Bash(find *)',
  'Bash(Get-ChildItem *)',
  // ネットワーク・サーバー状態
  'Bash(curl *)',
  'Bash(Invoke-WebRequest *)',
  // #332: 検証コマンド（テスト・型チェックのみ。ファイルを書く pnpm build 等は含めない）
  'Bash(pnpm test)',
  'Bash(pnpm test *)',
  'Bash(pnpm lint)', // --fix で書き込み得るため引数付き(*)は追加しない
  'Bash(npx tsc --noEmit)',
  'Bash(npx tsc --noEmit *)',
];

// =============================================================================
// Scaffold テンプレート定義（プロジェクト雛形作成）
// =============================================================================

/** scaffold テンプレートが対応する OS 種別（Machine.managementInfo.os と一致） */
export type ScaffoldTemplateOs = 'linux' | 'darwin' | 'win32';

/**
 * scaffold テンプレートのメタデータ定義
 * サーバーのテンプレート検証・OS 制限・スキル SKILL.md 生成の単一ソース。
 * テンプレートの実体（ファイル内容・生成コマンド）は各 Agent 側の
 * scaffold-templates.ts に定義される（このリストは ID とメタ情報のみ）。
 */
export interface ScaffoldTemplateDef {
  /** テンプレート ID（API の template パラメータ値） */
  id: string;
  /** 表示ラベル */
  label: string;
  /** 説明文 */
  description: string;
  /** 対応 OS（この配列に含まれない OS のマシンでは使用不可） */
  os: ScaffoldTemplateOs[];
  /** 生成に必要な外部 CLI ツール名（未指定なら不要）。Agent 側が which/where で検出 */
  requiredTool?: string;
}

/** 利用可能な scaffold テンプレート一覧 */
export const SCAFFOLD_TEMPLATE_DEFS: ScaffoldTemplateDef[] = [
  {
    id: 'vite-react-web',
    label: 'Vite + React Web',
    description: 'Vite + React 19 + TypeScript + Tailwind CSS v4',
    os: ['linux', 'darwin', 'win32'],
  },
  {
    id: 'flutter-app',
    label: 'Flutter アプリ',
    description: 'flutter create による Flutter プロジェクト（iOS/Android/Web 対応）',
    os: ['linux', 'darwin', 'win32'],
    requiredTool: 'flutter',
  },
  {
    id: 'android-kotlin',
    label: 'Android (Kotlin)',
    description: 'Gradle Kotlin DSL の最小 Android アプリ',
    os: ['linux', 'darwin', 'win32'],
  },
  {
    id: 'xcode-swiftui',
    label: 'Xcode (SwiftUI)',
    description: 'XcodeGen による SwiftUI 最小 iOS アプリ（macOS 専用）',
    os: ['darwin'],
    requiredTool: 'xcodegen',
  },
  {
    id: 'empty',
    label: '空プロジェクト',
    description: 'CLAUDE.md のみの空プロジェクト（用途未定・自由記述向け）',
    os: ['linux', 'darwin', 'win32'],
  },
];

/** テンプレート ID から定義を取得（未定義なら undefined） */
export function getScaffoldTemplateDef(id: string): ScaffoldTemplateDef | undefined {
  return SCAFFOLD_TEMPLATE_DEFS.find((t) => t.id === id);
}

// Default config values
export const DEFAULTS = {
  logCount: 10,
  maxLogCount: 100,
  summaryPeriodDays: 1,
  sessionTimeoutMinutes: 30,
  websocketPingInterval: 30000,
  websocketReconnectDelay: 5000,
  // 再接続設定（baseDelay × 2^attempts でバックオフ、maxDelay で上限）
  reconnect: {
    baseDelay: 2000,      // 初回遅延: 2秒
    maxDelay: 30000,      // 最大遅延: 30秒
    maxAttempts: 30,      // 最大試行回数
    jitterRange: 1000,    // 0-1秒のランダムジッター（複数 Agent の同時再接続を分散）
  },
  /** 接続がこの時間以上安定していたら reconnectAttempts をリセット（ミリ秒） */
  reconnectStableThreshold: 60000,
} as const;
