# DevRelay プロジェクト固有ルール

> このファイルには、DevRelay の開発時に守るべき設計判断・注意事項を記載する。
> 変更履歴は `doc/changelog.md` に記載すること。

---

## サービス再起動禁止

DevRelay 自身のサーバーやエージェントを修正した場合：
- ビルド（`pnpm build`）は実行してOK
- **サービスの再起動は実行しない**（`systemctl restart` / `pm2 restart` 禁止）
- **ソースコード（`.ts` ファイル等）を変更して `pnpm build` を実際に実行した場合のみ**、再起動案内を出す
- ドキュメント（`.md`）のみの変更ではビルド・再起動案内は **不要**

理由：自分自身を再起動すると WebSocket 接続が切れ、応答が途中で消失するため。

再起動案内の条件：
- `.ts` ファイルを変更した → `pnpm build` を実行 → 成功 → 案内を出す
- `.md` ファイルのみ変更 → ビルド不要 → 案内も不要

案内例（ビルド実行時のみ）：
```
ビルド完了。以下のコマンドでサービスを再起動してください：
pm2 restart devrelay-server devrelay-agent
```

---

## アーキテクチャ概要

### ディレクトリ構造
```
devrelay/
├── apps/
│   ├── server/          # Center Server (Fastify + WebSocket + Prisma)
│   ├── web/             # WebUI (Vite + React)
│   └── landing/         # ランディングページ (devrelay.io)
├── agents/
│   ├── linux/           # CLI Agent (Linux + Windows クロスプラットフォーム)
│   ├── macos/           # CLI Agent (macOS 専用、launchd 管理)
│   └── windows/         # Windows Agent (Electron タスクトレイアプリ)
├── packages/
│   └── shared/          # 共通型定義・ユーティリティ
├── scripts/             # インストーラー (install-agent.sh, install-agent.ps1)
├── rules/               # DevRelay ルール・設計判断
├── doc/                 # 変更履歴・ドキュメント
└── CLAUDE.md            # 軽量ハブ
```

### 主要ファイル

#### Server
| ファイル | 責務 |
|---------|------|
| `apps/server/src/services/agent-manager.ts` | Agent 通信管理・セッション復元 |
| `apps/server/src/services/session-manager.ts` | セッション管理 |
| `apps/server/src/services/command-handler.ts` | コマンド処理の中心 |
| `apps/server/src/services/command-parser.ts` | コマンドパース・NLP統合 |
| `apps/server/src/services/build-summarizer.ts` | AI ビルド要約（マルチプロバイダー） |
| `apps/server/src/services/natural-language-parser.ts` | 自然言語コマンド解析 |
| `apps/server/src/services/user-settings.ts` | ユーザー設定（API キー暗号化保存） |
| `apps/server/src/services/dev-report-generator.ts` | Dev Reports 生成（マルチプロバイダー） |
| `apps/server/src/routes/api.ts` | REST API エンドポイント |
| `apps/server/src/routes/public-api.ts` | パブリック API（トークン検証） |
| `apps/server/src/platforms/discord.ts` | Discord Bot |
| `apps/server/src/platforms/telegram.ts` | Telegram Bot |

#### Agent (Linux/Windows 共通 CLI)
| ファイル | 責務 |
|---------|------|
| `agents/linux/src/services/connection.ts` | WebSocket 接続・メッセージ処理 |
| `agents/linux/src/services/ai-runner.ts` | Claude Code / Gemini CLI 実行 |
| `agents/linux/src/services/output-collector.ts` | 出力ファイル収集・Agreement 定数 |
| `agents/linux/src/services/conversation-store.ts` | 会話履歴の永続化 |
| `agents/linux/src/services/session-store.ts` | セッション ID・コンテキスト使用量 |
| `agents/linux/src/services/management-info.ts` | 管理コマンド生成（環境自動検出） |
| `agents/linux/src/services/config.ts` | 設定管理（OS 別パス分岐） |

#### Agent (macOS 専用 CLI)
| ファイル | 責務 |
|---------|------|
| `agents/macos/src/services/management-info.ts` | macOS 管理コマンド生成（launchd/PM2/nohup） |
| `agents/macos/src/services/config.ts` | macOS 設定管理（ホームディレクトリのみ） |
| `agents/macos/src/cli/commands/setup.ts` | launchd LaunchAgent 登録 |
| `agents/macos/src/cli/commands/status.ts` | launchctl ベースのステータス確認 |
| `agents/macos/src/cli/commands/uninstall.ts` | launchctl unload + plist 削除 |

#### Shared
| ファイル | 責務 |
|---------|------|
| `packages/shared/src/types.ts` | 共通型定義 |
| `packages/shared/src/constants.ts` | ショートカット定義・allowedTools デフォルト定数 |
| `packages/shared/src/token.ts` | トークンユーティリティ |

---

## shared パッケージ制約

- Node.js 固有 API を使わない（`Buffer` 不可）
- `btoa`/`atob` は `declare` で型宣言して使用
- tsconfig: `"lib": ["ES2022"]`（DOM なし）

---

## machineName フォーマット

- `hostname/username` 形式（スラッシュ区切り）
- 例: `ubuntu-dev/pixblog`, `DESKTOP-Q43QT7L/fwjg2`
- 1 Agent = 1 User モデル（同一マシン上の複数ユーザーを区別）

---

## トークン形式

- 新形式: `drl_<serverUrl_base64url>_<random64hex>`
  - Base64URL: 標準 Base64 の `+` → `-`, `/` → `_`, パディング `=` を除去
- 旧形式: `machine_<random64hex>`（後方互換のためサポート継続）

---

## Agent 追加フロー

1. WebUI「+ Add Agent」→ 名前入力なし → 即座にトークン＋ワンライナー表示
2. サーバーが仮名 `agent-N` を自動生成 → Agent 接続時に `hostname/username` で上書き
3. 名前自動更新条件: 仮名（`agent-*`）または旧形式（hostname のみ → hostname/username）の場合に上書き

---

## Agent 再起動セッション復元

- `needsSessionRestart` Set（machineId ベース）で Agent 再接続を検知
- `handleAiPrompt()`/`handleExec()` でフラグ確認 → 新セッション作成 + `server:session:start` 再送
- `handleProjectConnect()` でフラグクリア（自動再接続時の二重作成防止）
- `handleAgentDisconnect()` で stale WebSocket 判定（Race Condition 防止）
- `sendToAgent()` で CLOSED な WebSocket を検出時に自動クリーンアップ（stale 参照の自己修復）
- `handleAgentConnect()` で旧 WebSocket が残っていれば `terminate()` で即座に破棄（`close()` はハンドシェイク待ちで stuck するため不可）
- Agent 側の `connectToServer()` で旧 WS を `removeAllListeners()` + `terminate()` でクリーンアップしてから新 WS を作成
- Agent 側の close ハンドラで `thisWs` 参照をキャプチャし、既に新 WS に置き換えられていたら再接続をスキップ
- `context.userId` は Discord プラットフォーム ID。DB の `Session.userId` には `oldSession.userId` を使う
- **サーバー起動時の ChannelSession 保持**: マシンがオフラインでも `currentMachineId`/`currentSessionId` をクリアしない。サーバー起動時は全マシンが offline のため、クリアすると全セッション情報が消失する。Agent 再接続時に `restoreSessionParticipantsForMachine()` で復元される
- **Agent 更新完了通知**: `pendingUpdateNotify` Map で更新リクエスト元を記録し、Agent 再接続時に `handleAgentConnect()` で完了メッセージを送信

---

## Windows CLI Agent の構造

- `agents/linux/` が Linux + Windows 両対応（`process.platform === 'win32'` で分岐）
- パッケージ名: `@devrelay/agent`（`@devrelay/agent-linux` からリネーム）
- Windows config: `%APPDATA%\devrelay\config.yaml`
- Windows 自動起動: Startup フォルダ + VBS ランチャー（CMD+VBS 二段構成）
- Windows Claude ラッパー: `.cmd` バッチファイル（symlink ではなく）
- PowerShell インストーラー: `scripts/install-agent.ps1`

---

## macOS Agent の構造

- `agents/linux/` をフォークして `agents/macos/` に macOS 専用 Agent を配置
- パッケージ名: `@devrelay/agent-macos`（`agents/linux` の `@devrelay/agent` とは別パッケージ）
- プロセス管理: launchd（LaunchAgent plist）。systemd の macOS 相当
- plist パス: `~/Library/LaunchAgents/io.devrelay.agent.plist`
- macOS config: `~/.devrelay/config.yaml`（Linux と同じパス）
- デフォルト projectsDirs: ホームディレクトリのみ（`/opt` は macOS で一般的でないため除外）
- install-agent.sh: `uname -s` で OS 判定、macOS は `base64 -D`、`sed -i ''`、`darwin-arm64` Node.js URL
- launchd restart: `launchctl kickstart -k gui/$(id -u)/io.devrelay.agent`
- Apple Silicon Homebrew パス: `/opt/homebrew/bin` を PATH に含む

---

## Machine DisplayName (Hostname Alias)

- DB: `Machine.displayName String?`（nullable）
- 表示ルール: `displayName ?? name` を全箇所で使用
- ホスト名レベルエイリアス: `PUT /api/machines/hostname-alias` で同一ホスト名の全 Agent を一括更新
- 自動計算: `handleAgentConnect()` で兄弟マシンの displayName からエイリアスを継承

---

## マルチプロバイダー AI

- SDK: `@anthropic-ai/sdk`, `@google/generative-ai`（apps/server に追加）
- 型: `AiProvider = 'openai' | 'anthropic' | 'gemini' | 'none'`
- SettingKeys: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `BUILD_SUMMARY_PROVIDER`, `CHAT_AI_PROVIDER`
- モデル: gpt-4o-mini / claude-haiku-4-5-20251001 / gemini-2.0-flash
- `build-summarizer.ts`: マルチプロバイダー要約サービス（fire-and-forget パターン）

---

## インストーラーの依存関係

| ツール | Linux/macOS | Windows | 扱い |
|-------|------------|---------|------|
| git | 必須（手動インストール） | 必須（手動） | `exit 1` |
| Node.js 20+ | 自動インストール | 必須（手動） | Linux: DL、Win: `$Missing++` |
| pnpm | 自動インストール（npm→sudo） | 自動インストール（npm） | 自動 |
| Claude Code | 必須（手動インストール） | 必須（手動） | `exit 1` / `$Missing++` |

- Claude Code は #112 で必須依存に変更（以前はオプション）
- Linux/macOS: `~/.local/bin/claude` がある場合は自動 PATH 追加で救済

---

## インストーラーのトラブルシューティング知見

- **Linux nohup**: `< /dev/null` 必須（`curl|bash` で stdin が消費される）
- **Linux pgrep**: `\.devrelay.*index\.js` パターン（node パスに devrelay が含まれるケースに対応）
- **Linux node パス**: `$(which node)` で絶対パス取得
- **Windows プロセス検出**: `Get-CimInstance Win32_Process` を使う（`Get-Process` は VBS 経由起動で CommandLine が空）
- **Windows アンインストール**: `Stop-Process` 後に `Start-Sleep -Seconds 2` が必要
- **set -e + pgrep/grep**: `|| true` を必ず付ける
- **再インストール時の config.yaml**: token・serverUrl・machineName の3つ全てを更新
- **プロキシ設定順序**: プロキシプロンプトは依存ツールチェック（Step 1）より前に配置（Node.js DL / pnpm 自動インストールで必要）
- **pnpm 自動インストール**: `npm install -g pnpm` → 権限不足なら `sudo npm install -g pnpm` にフォールバック
- **systemd サービス PATH**: `.bashrc` を読み込まないため `~/.local/bin`（claude CLI）、`~/.devrelay/bin`（devrelay-claude）、Node.js ディレクトリを `Environment=PATH=...` で明示指定
- **systemd プロキシ**: プロキシ環境では `HTTP_PROXY`/`HTTPS_PROXY`/`http_proxy`/`https_proxy` を `Environment=` で設定（大文字・小文字両方必要）
- **macOS LaunchAgent**: plist の `EnvironmentVariables` で PATH に `~/.local/bin` を含め、プロキシも設定
- **crontab 環境変数**: `@reboot PATH=... HTTP_PROXY=... cd ... && node ...` 形式でインライン指定

---

## 設定ファイル

### Agent 設定
- Linux: `~/.devrelay/config.yaml`
- macOS: `~/.devrelay/config.yaml`
- Windows: `%APPDATA%\devrelay\config.yaml`

```yaml
machineName: ubuntu-dev/user
machineId: ""
serverUrl: wss://devrelay.io/ws/agent
token: drl_xxxxx_xxxxx
projectsDirs:
  - /home/user
  - /opt
aiTools:
  default: claude
  claude:
    command: claude
logLevel: debug
proxy:  # オプション
  url: http://proxy.example.com:8080
```

---

## 起動方法

### 開発時
```bash
cd apps/server && pnpm start      # Server
cd agents/linux && pnpm start     # Agent
cd agents/windows && pnpm build && npx electron .  # Windows Electron Agent
```

### 本番（PM2）
```bash
pm2 start /opt/devrelay/apps/server/dist/index.js --name devrelay-server
pm2 start /opt/devrelay/agents/linux/dist/index.js --name devrelay-agent
pm2 save && pm2 startup
```

---

## インフラ

- ドメイン: `devrelay.io` (server), `app.devrelay.io` (WebUI)
- リバースプロキシ: Caddy
- DB: PostgreSQL
- プロセスマネージャー: PM2
- Git: `murata1215` / `fwjg2507@gmail.com`

---

## Agreement v4 アーキテクチャ

- Agreement ルール本体は `rules/devrelay.md` に配置（CLAUDE.md には軽量マーカーのみ）
- `getAgreementStatusType()` は `rules/devrelay.md` → CLAUDE.md の順でチェック（後方互換）
- v3 以前のプロジェクトに v4 Agent が接続 → `'outdated'` 表示 → `ag` コマンドで v4 に更新可能
- `AGREEMENT_APPLY_PROMPT` はマルチファイル作成: `rules/devrelay.md` + `doc/changelog.md`（ヘッダー） + `rules/project.md`（ヘッダー）+ CLAUDE.md マーカー更新
- `w` コマンドは `doc/changelog.md` → `rules/project.md` → CLAUDE.md（最小限のみ）の順で更新

### テンプレート配信方式

- Agreement テンプレートは **Server 側** (`apps/server/src/services/agreement-template.ts`) で管理
- `ag` コマンド実行時、Server が `buildAgreementApplyPrompt()` でプロンプトを生成 → `payload.agreementPrompt` として Agent に配信
- Agent は `payload.agreementPrompt` があればそれを使用、なければローカルの `AGREEMENT_APPLY_PROMPT` にフォールバック
- テンプレート更新は **Server の再起動のみ**で全 Agent に即反映（Agent の再インストール不要）
- Agent 側の `output-collector.ts` のテンプレートはフォールバック用に残す
- WebUI Settings ページからカスタムテンプレートの編集が可能（UserSettings に保存）

### Machine ソフトデリート

- Machine 削除は **論理削除**（`deletedAt` カラム）で行う。物理削除は禁止。
- 削除時に `name` を `${name}__deleted_${timestamp}` にリネーム → `@@unique([userId, name])` 制約を回避
- 削除時に `token` も `deleted_${timestamp}_${token}` にリネーム → 再利用防止
- 関連データ（Session/Message/BuildLog/Project）は一切削除しない → 過去の会話履歴を保持
- 全 Machine クエリに `deletedAt: null` フィルタが必要（約20箇所）
- `findUnique` は `deletedAt` 条件を追加できないため `findFirst` に変更する（Prisma の制約）
- Conversations ページでは relation 経由で削除済み Machine の名前が引き続き表示される

### メッセージファイル BLOB 保存

- `MessageFile` モデル: PostgreSQL `bytea` 型でファイル本体を保存
- `direction`: `'input'`（ユーザー添付）/ `'output'`（AI 出力）
- Server がファイル中継時に MessageFile レコードを同時作成
- `GET /api/files/:id` でバイナリ配信（認証 + Session オーナーチェック）

### ドキュメントディレクトリ構成

```
rules/devrelay.md   ← Agreement ルール（全プロジェクト共通）
rules/project.md    ← 設計判断・注意事項（プロジェクト固有）
doc/changelog.md    ← 実装履歴
doc/                ← その他ドキュメント
CLAUDE.md           ← 軽量ハブ（2,000 トークン以内）
```

---

## Server → Agent 設定配信（pending リトライ）

WebUI から Agent の設定（`projectsDirs` 等）を変更した場合、Server は `server:config:update` を WebSocket 経由で Agent に送信する。
ただし WebSocket が半開き状態（TCP は生きているが実際にはメッセージが届かない）になることがあり、
単発の `ws.send()` だけでは配信が保証されない。

### 解決策: ping リトライ機構

1. `pushConfigUpdate()` で `pendingConfigUpdates` Map に登録（`{ config, retries }` 構造）
2. Agent の `agent:ping` 受信時に、ping ハンドラの `ws`（確実に生きている）を使ってリトライ送信
3. Agent は処理完了後に `agent:config:ack` を送信 → Server が pending を削除
4. 旧バージョン Agent は ack を返さないため、最大5回でリトライ打ち切り
5. Agent 再接続時は `server:connect:ack` で DB 最新値が届くため、pending は不要（即クリア）

**重要**: `sendToAgent(machineId, ...)` は `connectedAgents` Map 経由で WebSocket を取得するが、
ping ハンドラでは `ws.on('message')` のコールバックから直接取得した `ws` を使用する。
後者は Agent からメッセージを受信した実績がある WebSocket なので、送信も成功する可能性が高い。

---

## プランモード allowedTools

プランモード（`--permission-mode plan`）はデフォルトで全ての Bash コマンドをブロックする。
しかしログ確認やシステム状態の調査は読み取り専用であり、プラン立案に必要な情報収集のために許可すべき。

### 仕組み

- Claude Code の `--allowedTools` フラグでコマンドパターンを許可
- `--permission-mode plan` と `--allowedTools` を併用すると、指定パターンのみ許可される
- `Bash(pm2 logs)` は pm2 logs を許可するが pm2 restart はブロック（細粒度制御）

### Server DB 管理（#99）

許可ツールリストは UserSettings テーブルで管理し、WebUI から編集可能。

- **UserSettings キー**: `allowedTools:linux`, `allowedTools:windows`（JSON 文字列配列）
- **デフォルト定数**: `DEFAULT_ALLOWED_TOOLS_LINUX` / `DEFAULT_ALLOWED_TOOLS_WINDOWS`（`packages/shared/src/constants.ts`）
- **優先順位**: UserSettings の値 > コード定数（最終フォールバック）
- **Agent 配信**: `server:connect:ack` + `server:config:update` で Agent に配信
  - `managementInfo.os`（`'linux' | 'darwin' | 'win32'`）で Agent の OS を判定
  - Agent 側は `serverAllowedTools` メモリ変数で保持
- **WebUI**: Settings ページで Linux / Windows を横並びで表示（各 OS ごとに独立した Save / Reset ボタン）
- **ユーザー全体設定**: Machine 単位ではなく、ユーザー単位で統一管理

### --allowedTools フォーマット注意点

```
# 正しい: カンマ区切りで1つの --allowedTools に渡す + 引数許可に * 必須
--allowedTools "Bash(pm2 logs *),Bash(pm2 status *),Bash(git log *)"

# 間違い: ツールごとに --allowedTools を繰り返す
--allowedTools "Bash(pm2 logs *)" --allowedTools "Bash(pm2 status *)"

# 間違い: * なし → 完全一致のみ（引数付きコマンドがブロックされる）
--allowedTools "Bash(pm2 logs)"
# → `pm2 logs` は許可されるが `pm2 logs devrelay-agent --lines 10` はブロック
```

**ワイルドカード `*` の意味:**
- `Bash(pm2 logs)` → 完全一致のみ（`pm2 logs` だけ許可）
- `Bash(pm2 logs *)` → プレフィックスマッチ（`pm2 logs` + 任意の引数を許可）
- Claude Code はコマンドチェーン（`&&`, `||`）を検出してブロックするため、`*` があっても安全

### deploy-agent スクリプト

開発リポ（`/opt/devrelay/`）でビルドした Agent を、PM2 で稼働中のインストール済み Agent（`~/.devrelay/agent/`）にデプロイするスクリプト。

```bash
pnpm deploy-agent
# = pnpm build && cp -r agents/linux/dist/* ~/.devrelay/agent/agents/linux/dist/
```

PM2 は `~/.devrelay/agent/` のコードを実行するため、`/opt/devrelay/` でビルドしただけでは反映されない。
このスクリプトでコピー後、`pm2 restart devrelay-agent` で反映される。

---

## Agent リモート更新（#101）

Discord/Telegram から `u` / `update` コマンドで Agent のバージョン確認・更新を実行できる。

### フロー

1. 1回目 `u`: Server → Agent に `server:agent:version-check` 送信
2. Agent が `git fetch` + コミット比較 → `agent:version:info` で結果を返却
3. 更新がある場合、2回目 `u` で `server:agent:update` を送信
4. Agent が detached 子プロセスで `git pull + pnpm build + restart` を実行

### 設計判断

- **detached 子プロセス**: Agent 自身が再起動対象のため、親プロセスが終了してもスクリプトは継続する
- **開発リポジトリ検出**: `~/.devrelay/agent/` 配下でなければ開発リポとみなし更新拒否（`pnpm deploy-agent` を案内）
- **管理コマンド**: `generateManagementInfo()` で検出した restart コマンドを使用（PM2/systemd/nohup 自動判定）
- **Promise パターン**: `checkAgentVersion()` は 30 秒タイムアウトの Promise（git fetch に時間がかかる場合あり）
- **エラー通知**: `pendingUpdateNotify` Map でリクエスト元のチャットに通知（`sendMessage()` 使用）
- **2回連続確認**: `x`（clear）コマンドと同パターンの `pendingUpdate` Set

---

## コマンド定義の単一ソース・オブ・トゥルース

コマンドの定義は `packages/shared/src/constants.ts` の `SHORTCUTS` 定数に集約する。

### SHORTCUTS が参照される箇所
- `command-parser.ts` の `parseCommand()`: ショートカット → UserCommand 変換
- `natural-language-parser.ts` の `isTraditionalCommand()`: 入力がコマンドか AI プロンプトかの判定

### 新コマンド追加時の手順
1. `packages/shared/src/constants.ts` の `SHORTCUTS` にキーを追加
2. `apps/server/src/services/command-parser.ts` の `parseShortcut()` に case を追加
3. `apps/server/src/services/command-handler.ts` にハンドラを追加
4. `apps/server/src/services/command-parser.ts` の `getHelpText()` にヘルプ追加

**注意**: `isTraditionalCommand()` は `SHORTCUTS` を直接参照するため、個別の修正は不要。
動的パターン（`log\d+`, `sum\d+d?`, `ai:*`, `a <arg>` 等）のみ正規表現で個別チェックを行う。

---

## Dev Reports（AI 開発レポート生成）

会話履歴から AI を使って開発レポートを自動生成する機能。

### アーキテクチャ

- **DB モデル**: `DevReport`（レポート全体: タイトル・サマリー・日付範囲）+ `DevReportEntry`（各 exec のエントリ: 要約・変更ファイル・影響度）
- **ジェネレーター**: `apps/server/src/services/dev-report-generator.ts`（マルチプロバイダー対応）
- **独立プロバイダー設定**: `DEV_REPORT_PROVIDER` は他機能（ビルド要約・チャット AI）と独立して設定
- **API キー取得**: `getApiKeyForDevReport()` で Dev Report 用プロバイダーの API キーを取得
- **WebUI**: `DevReportsPage.tsx` でプロジェクト・日付選択 → 生成 → 一覧・詳細・ダウンロード

### API エンドポイント

| メソッド | パス | 説明 |
|---------|------|------|
| GET | `/api/dev-reports/projects` | レポート対象プロジェクト一覧 |
| GET | `/api/dev-reports` | レポート一覧 |
| GET | `/api/dev-reports/:id` | レポート詳細 |
| POST | `/api/dev-reports` | レポート生成 |
| GET | `/api/dev-reports/:id/download` | マークダウンダウンロード |
| DELETE | `/api/dev-reports/:id` | レポート削除 |

---

## nohup Agent の restart コマンド

nohup 起動の Agent は、restart コマンド実行時に旧プロセスを kill してから新プロセスを起動する。

### 背景

systemd/PM2 の restart は自動的に旧プロセスを停止するが、nohup には停止の仕組みがない。
`u` コマンドによる Agent 更新時に旧プロセスが残り、同一 machineId で複数インスタンスが
同時稼働して重複メッセージが発生する問題があった。

### 実装

```bash
# restart コマンド（management-info.ts）
NODE_BIN="<nodePath>"; [ ! -x "$NODE_BIN" ] && NODE_BIN=node; pgrep -u $(whoami) -f "\\.devrelay.*index\\.js" | grep -v "^$$\$" | xargs kill 2>/dev/null || true; sleep 1; cd <dir> && nohup "$NODE_BIN" <index.js> < /dev/null >> <logfile> 2>&1 &
```

- `pgrep -u $(whoami)`: 自分のユーザーの Agent プロセスのみ検索（他ユーザーに影響しない）
- `grep -v "^$$\$"`: 自身の PID を除外（`bash -c "..."` で実行時、cmdline にパターンが含まれるため自殺防止）
- `|| true`: プロセスが見つからなくてもエラーにならない
- `; sleep 1;`: kill の完了を待つ（`&&` ではなく `;` で kill 失敗時も続行）
- `NODE_BIN` フォールバック: `process.execPath` が存在しない場合は PATH 上の `node` を使用

### `u` コマンド更新スクリプトでの注意

`handleAgentUpdate()` は `spawn('bash', ['-c', script])` で更新スクリプトを起動する。
nohup の場合、`restartCmd.command`（management-info.ts 由来）をそのまま使うと、
bash プロセスの cmdline に `.devrelay.*index.js` が含まれるため `pgrep` が自身にマッチし自殺する。

**対策**: nohup installType の場合は `restartCmd.command` を使わず、connection.ts 内で
専用のリスタートコマンドを構築する（`grep -v "^$$\$"` + PATH 上の `node`）。

### Windows Agent のパス判定: `homedir()` vs `getConfigDir()`

Windows では `homedir()` (`C:\Users\<user>`) と `getConfigDir()` (`%APPDATA%\devrelay`) が異なる。
`homedir()` ベースのパスは Linux 固定になるため、Windows で以下の問題が発生する：

1. **`isInstalledAgent()`**: `homedir() + '.devrelay/agent'` → Windows で常に devRepo 判定 → `u` 拒否
2. **`logsDir`**: `homedir() + '.devrelay/logs'` → `update.log` が間違った場所に書き込まれる

**対策**: パス構築には常に `getConfigDir()` を使う。

```typescript
// ✅ 正しい（OS 分岐済みの getConfigDir() を使用）
const installedDir = join(getConfigDir(), 'agent');
const logsDir = join(getConfigDir(), 'logs');

// ❌ 誤り（Linux パス固定 → Windows で不一致）
const installedDir = join(homedir(), '.devrelay', 'agent');
const logsDir = join(homedir(), '.devrelay', 'logs');
```

### Windows 更新スクリプトの stop + restart

Windows の restart コマンドは `wscript.exe` で新プロセスを起動するだけで旧プロセスを停止しない。
更新スクリプトでは restart の前に stop コマンド（`Get-CimInstance Win32_Process` で kill）を実行すること。
Linux nohup では `pgrep | grep -v $$ | xargs kill` で旧プロセスを停止してからリスタートしている。

### Windows PowerShell スクリプト実行: VBS ラッパー経由

Node.js の `spawn('powershell', [...], { detached: true })` は Windows で `DETACHED_PROCESS` フラグを使い、
コンソールなしでプロセスを作成する。PowerShell 5.1 はコンソールなしだとサイレントに即終了する。

**対策**: Agent 起動で実績のある `wscript.exe` + VBS パターンで PowerShell を起動する。

```typescript
// ✅ 正しい（VBS ラッパー経由で PowerShell を起動）
const scriptPath = join(logsDir, 'update.ps1');
writeFileSync(scriptPath, scriptLines.join('\n'), 'utf-8');

const vbsContent = [
  'Set objShell = CreateObject("Wscript.Shell")',
  `objShell.Run "powershell -ExecutionPolicy Bypass -NoProfile -File ""${scriptPath}""", 0, False`,
].join('\r\n');
const vbsPath = join(logsDir, 'update.vbs');
writeFileSync(vbsPath, vbsContent, 'utf-8');

spawn('wscript.exe', [vbsPath], { detached: true, stdio: 'ignore' });

// ❌ 誤り（spawn で直接 PowerShell を起動 → DETACHED_PROCESS でサイレント終了）
spawn('powershell', ['-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
  detached: true, stdio: 'ignore',
});
```

注意:
- `-Command` ではなく `-File` を使うこと（二重引用符の競合回避）
- VBS `.Run` の第2引数 `0` = 非表示、第3引数 `False` = 完了を待たない
- `-NoProfile` でプロファイル読み込みによる遅延を回避

### bash 更新スクリプトのシェル演算子優先順位

`bash -c` で `nohup node ... & disown` を実行する際、`&&` と `&` の優先順位に注意。
bash では `&&` が `&` より高い優先順位を持つため:

```bash
# ❌ 誤り: (cd X && nohup node Y) & disown
# → cd && nohup node 全体がサブシェルで実行され、node がサブシェル内フォアグラウンドになる
# → サブシェル（bash）が node 終了まで残り続ける
cd "/path" && nohup node "/path/index.js" < /dev/null >> "/path/agent.log" 2>&1 & disown

# ✅ 正しい: cd と nohup を `;` で分離
# → nohup node ... & だけがバックグラウンド実行、disown 後に bash 即終了
cd "/path" ; nohup node "/path/index.js" < /dev/null >> "/path/agent.log" 2>&1 & disown
```

`cd` が失敗しても node は絶対パスなので影響なし。

---

## マシン名の自動更新と重複解決

Agent 接続時に DB のマシン名を自動更新する条件:
1. **仮名** (`agent-N`) → 正式名 (`hostname/username`)
2. **旧形式** (`hostname` のみ) → 新形式 (`hostname/username`)

### 重複マシン名の自動解決

同名の offline マシンが既に存在する場合、旧マシン名に `(old)` を付与してリネームし、新マシンに名前を譲る。
例: `tisa-MPro-M600/tisa` (offline) → `tisa-MPro-M600/tisa (old)` にリネーム → 新マシンが `tisa-MPro-M600/tisa` を使用。

online のマシンが重複している場合はリネームしない（意図しない上書きを防止）。

---

## AI 応答の完了メッセージ制御

Agent から Server への `agent:ai:output` メッセージで `isComplete=true` が複数回送信されると、DB に重複 Message が作成される。

### 防止策（二重ガード）
1. **ai-runner.ts**: `completionSent` フラグで `onOutput(true)` の二重呼び出しを防止（`error` + `close` イベント競合対策）
2. **connection.ts**: コールバック側でも `completionSent` ガードを追加（万が一のフォールスルー対策）
3. **resumeFailed**: フラグ設定後に `resolve + return` で早期リターン（retry 側のみが完了メッセージを送信）
4. **connection.ts に try/catch**: `sendPromptToAi` でエラーが発生してもセッションがハングしないよう、エラーを `agent:ai:output` でユーザーに通知

### クロスプラットフォーム同期の注意

`agents/linux/src/services/connection.ts` と `agents/linux/src/services/ai-runner.ts` に安定性修正を入れた場合、**必ず `agents/windows/` の同名ファイルにも同じ修正を適用すること**。Windows Agent はコードベースが別で、乖離するとバグが再発する（#143 で発覚）。

同期すべき主要ポイント:
- `completionSent` ガード（ai-runner.ts + connection.ts 両方）
- `try/catch` for `sendPromptToAi`（connection.ts）
- `usageData` / `allowedTools` / `isExec` / `execPrompt` の対応
- `server:ai:cancel` ハンドラ
- `resumeFailed` 時の早期 return

---

## MessageFile ベクトル検索

### 設計判断

| 判断 | 選択 | 理由 |
|------|------|------|
| 新規モデル vs 既存拡張 | MessageFile に直接 embedding 追加 | ファイルは既に MessageFile に全て保存済み。二重管理を避ける |
| アップロード方法 | 自動（既存フローにフック） | ユーザーの手間ゼロ。ファイル保存時に fire-and-forget で embedding 生成 |
| ベクトル DB | pgvector（PostgreSQL 拡張） | 既存 DB を流用、別サービス不要 |
| embedding モデル | OpenAI text-embedding-3-small (1536次元) | コスト効率と品質のバランス |
| 検索 API 認証 | マシントークン（Authorization: Bearer） | Agent（Claude Code スキル）からの直接呼び出し用 |
| Claude Code 連携 | スキル（SKILL.md + search.sh） | Agent 起動時に自動配置。「〜を参照して」で自動発火 |
| チャンク分割 | なし（全文 embedding、30K文字上限） | シンプルさ優先。大半のファイルは上限内 |

### embedding 処理フロー

```
MessageFile 作成 → fire-and-forget で processMessageFilesEmbedding()
  ├→ テキスト系: 抽出 → OpenAI embedding → pgvector に保存 → status = 'done'
  ├→ バイナリ: status = 'skipped'
  └→ API キーなし: textContent は保存、status = 'skipped'
```

### スキル自動配置

Agent 接続成功時に `~/.claude/skills/devrelay-docs/` を作成・更新:
- `SKILL.md`: スキル定義（Claude Code が自動検出）
- `scripts/search.sh`: config.yaml から認証情報を読み取り、サーバー API を呼び出す

## サービス追加の運用パターン

本番サーバーへの新サービス追加は `doc/service-setup-guide.md` の手順に従う。

### 開発ドメイン方式（推奨）

- 開発用の個人ドメイン（例: `murata1215.jp`）でワイルドカード DNS を設定
- `*.murata1215.jp` → サーバー IP の A レコード1つで全サブドメインが利用可能
- 新サービス追加時は Caddyfile にエントリ追加 + `sudo systemctl reload caddy` だけ
- 本番ドメイン取得後は Caddyfile のドメインを差し替えて移行

### サービス = Linux ユーザー

- 1サービス = 1 Linux ユーザー（例: pixshelf, pixdraft, clipped）
- 各ユーザーが独自の SSH 鍵、DevRelay Agent、Claude Code 認証を持つ
- コード配置先: `/opt/<サービス名>/`

---

## WebUI チャット設計判断

### チャット表示設定は localStorage
- サーバー API を使わず、`localStorage` で管理（キー: `devrelay-chat-display`）
- 即座に反映、軽量、サーバー負荷なし
- `storage` イベントで他タブと同期
- アバター画像も data URL で localStorage に保存（数十KB、容量問題なし）

### 履歴画像の認証方式
- `<img>` タグは Bearer ヘッダーを送れないため、`/api/files/:id?token=xxx` クエリパラメータ方式
- `getToken()` で localStorage からトークン取得
- 既存の `getDownloadUrl()` と同じパターン

### 添付ファイルの二段階表示
- **リアルタイム（送信直後）**: `content`（base64）→ blob URL で表示
- **履歴（API 取得）**: メタデータのみ（`id`, `filename`, `mimeType`）→ `/api/files/:id` で表示
- `ChatMessage.files` の型で `id?` / `content?` を両方オプショナルにして統一

### ChatPage 常時マウント
- 画面遷移時に ChatPage をアンマウントすると WebSocket 接続やメッセージ state が失われる
- `ProtectedContent` コンポーネントで ChatPage を常時マウントし、`display:none` で表示/非表示を制御
- `/chat` 以外のページでは ChatPage は DOM に存在するが非表示

### チャット履歴のクロスセッション取得
- セッション単位（`GET /api/sessions/:id/messages`）だと、サーバー再起動で新セッション作成後に旧メッセージに遡れない
- プロジェクト単位（`GET /api/projects/:projectId/messages`）で全セッション横断取得に変更
- `loadHistory()` / `loadOlderMessages()` は `projectId` ベースで API を呼ぶ
- コンテナが非スクロール（メッセージ少）な場合は `useEffect` で自動追加読み込み

### ピン止めタブのサーバー永続化
- `UserSettings.PINNED_TABS` キーでサーバーに保存
- 復元時: サーバー → localStorage フォールバック
- 異なるデバイスからアクセスしてもタブ状態が同期される

---

## 今後の課題

- LINE 対応
- Gemini CLI / Codex / Aider 対応
- ベクトル検索のチャンク分割対応（大規模ドキュメント向け）
- WebUI でのドキュメント横断検索インターフェース
- 複数ユーザー同時接続
- エラーハンドリング強化
