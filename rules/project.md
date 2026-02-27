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
| `packages/shared/src/constants.ts` | ショートカット定義 |
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

### ドキュメントディレクトリ構成

```
rules/devrelay.md   ← Agreement ルール（全プロジェクト共通）
rules/project.md    ← 設計判断・注意事項（プロジェクト固有）
doc/changelog.md    ← 実装履歴
doc/                ← その他ドキュメント
CLAUDE.md           ← 軽量ハブ（2,000 トークン以内）
```

---

## 今後の課題

- LINE 対応
- Gemini CLI / Codex / Aider 対応
- 共有ドキュメント機能（DevRelay Box）- pgvector + OpenAI Embedding で自動 RAG
- 複数ユーザー同時接続
- 進捗表示のUI改善
- エラーハンドリング強化
