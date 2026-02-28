# DevRelay プロジェクト固有ルール

> このファイルには、DevRelay の開発時に守るべき設計判断・注意事項を記載する。
> 変更履歴は `doc/changelog.md` に記載すること。

---

## サービス再起動禁止

DevRelay 自身のサーバーやエージェントを修正した場合：
- ビルド（`pnpm build`）は実行してOK
- **サービスの再起動は実行しない**（`systemctl restart` / `pm2 restart` 禁止）
- 「ビルド完了。以下のコマンドでサービスを再起動してください」と案内する

理由：自分自身を再起動すると WebSocket 接続が切れ、応答が途中で消失するため。

案内例：
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
- `context.userId` は Discord プラットフォーム ID。DB の `Session.userId` には `oldSession.userId` を使う

---

## Windows CLI Agent の構造

- `agents/linux/` が Linux + Windows 両対応（`process.platform === 'win32'` で分岐）
- パッケージ名: `@devrelay/agent`（`@devrelay/agent-linux` からリネーム）
- Windows config: `%APPDATA%\devrelay\config.yaml`
- Windows 自動起動: Startup フォルダ + VBS ランチャー（CMD+VBS 二段構成）
- Windows Claude ラッパー: `.cmd` バッチファイル（symlink ではなく）
- PowerShell インストーラー: `scripts/install-agent.ps1`

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

## インストーラーのトラブルシューティング知見

- **Linux nohup**: `< /dev/null` 必須（`curl|bash` で stdin が消費される）
- **Linux pgrep**: `\.devrelay.*index\.js` パターン（node パスに devrelay が含まれるケースに対応）
- **Linux node パス**: `$(which node)` で絶対パス取得
- **Windows プロセス検出**: `Get-CimInstance Win32_Process` を使う（`Get-Process` は VBS 経由起動で CommandLine が空）
- **Windows アンインストール**: `Stop-Process` 後に `Start-Sleep -Seconds 2` が必要
- **set -e + pgrep/grep**: `|| true` を必ず付ける
- **再インストール時の config.yaml**: token・serverUrl・machineName の3つ全てを更新

---

## 設定ファイル

### Agent 設定
- Linux: `~/.devrelay/config.yaml`
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
  - `managementInfo.os`（`'linux' | 'win32'`）で Agent の OS を判定
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

## 今後の課題

- LINE 対応
- Gemini CLI / Codex / Aider 対応
- 共有ドキュメント機能（DevRelay Box）- pgvector + OpenAI Embedding で自動 RAG
- 複数ユーザー同時接続
- 進捗表示のUI改善
- エラーハンドリング強化
