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

### ChannelSession の stale レコード防止

Web クライアントが WS 切断した際は、`ChannelSession` テーブルからもレコードを削除すること。
DB に残った stale レコードはサーバー再起動時に復元され、メッセージが大量の無効 chatId にブロードキャストされる原因となる。

### testflight PostgreSQL 識別子のクォート

`testflight-manager.ts` で PostgreSQL のユーザー名・DB 名を使う場合は必ずダブルクォートで囲むこと。
ハイフン含みの名前（例: `tf-2048`）がクォートなしだと SQL 構文エラーになる。

### Stale セッションの自動クリーンアップ

サーバー起動時（pm2 restart 時）に以下を自動実行する：
- 24時間以上活動がない active セッション → `ended` に更新 + ChannelSession 削除
- 30分以上経過した pending ツール承認 → `timeout` に更新

`restoreSessionParticipants()` より前に実行し、stale 参加者の復元を防止する。

### ツール承認/質問カードの復元

`getPendingToolApprovalsForSession()` はメモリ Map ベースで動作する（DB round-trip なし）。
復元は2箇所でトリガーされる：
1. **WS 接続直後**: 同一タブのリロード時（`getSessionIdByChatId` でセッションが見つかる場合）
2. **`//connect` 後**: 新タブ時（セッション参加者登録後に復元）

タイムアウトは12時間（`TOOL_APPROVAL_TIMEOUT`）。承認忘れ ≠ 拒否のため長めに設定。

### Devin CLI 統合（spawn パターン）

Devin for Terminal は Gemini/Codex/Aider と同じ spawn パターンで統合する。
- 実行: `devin -p -c --permission-mode auto|dangerous --prompt-file <tmp>`
- プロンプト: `--prompt-file` 一時ファイル経由（stdin パイプは panic するため使用不可）
- セッション継続: `-c` フラグで同一 cwd の最新セッションを自動引き継ぎ（ID 管理不要）
- パーミッション: plan モード → `auto`（読み取り専用）、exec モード → `dangerous`（全承認）。`plan` は Devin 未対応
- PATH: コマンドのディレクトリを自動追加（サービス実行時の PATH 不足を回避）
- 有効化: Agent 起動時に自動検出（`detectAndUpdateAiTools()`）、または手動設定
- Server / WebUI / DB は変更不要（`Session.aiTool` は String 型、`AI_TOOL_NAMES` で動的表示）
- Cloud API (v3 REST) は将来対応（ローカル CLI 優先）

### AI ツール自動検出（detectAndUpdateAiTools）

Agent 起動時に `which`/`where` で全既知 AI ツールを検出し、config.yaml に自動追加する。
- **追加のみ、削除しない**: CLI が一時的に PATH にない環境（Docker、SSH 等）で設定が消えないように
- **既存設定を上書きしない**: ユーザーがカスタムパス（`/usr/local/bin/claude-nightly` 等）を設定していたら維持
- **config.yaml に永続化**: 検出結果を保存し、次回起動時の再検出コストを削減
- 対象ツール: claude, gemini, codex, aider, devin（`KNOWN_AI_TOOLS` 配列で管理）

### AskUserQuestion 無効化（disableAsk）

`Machine.disableAsk` が true の場合、SDK `disallowedTools: ['AskUserQuestion']` でツール自体をモデルのコンテキストから除去する。
`canUseTool` での deny ではなく SDK レベルで除去するため、Claude は質問しようとすること自体がなくなる（無駄なターンなし）。

skipPermissions と同じパターン: DB カラム + API + WS リアルタイムプッシュ + WebUI トグル + exec フォールバック同期。

### loadOlderMessages の連鎖発火防止

`loadHistory` 完了後、React の DOM 更新で `scrollTop=0` → `handleScroll` → `loadOlderMessages` が連鎖発火する問題がある。
`initialLoadCompleteRef` フラグで初回 loadHistory + auto-scroll 完了（2秒後）まで `loadOlderMessages` をブロックすること。

### SW skipWaiting ハンドラ

`sw.ts` に `SKIP_WAITING` メッセージハンドラを必ず含めること。
これがないと `vite-plugin-pwa` の `registerType: 'autoUpdate'` が機能せず、新しいビルドが全タブを閉じるまで反映されない。

### WebUI `//connect` 応答と clearProgressOnTab

`//connect` の応答（`web:response`）は AI の完了ではないため、`clearProgressOnTab` で `completed = true` にしてはならない。
`suppressConnectRef.current` が `true` の場合は早期 return すること。

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
| `agents/linux/src/services/approval-logger.ts` | ツール承認 JSONL ログ（ローテーション付き） |

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
- **参加者マイグレーション**: 新セッション作成時、旧セッションの全参加者を新セッションに引き継ぐ（#155 で追加）。送信者のみ引き継ぐと他ブラウザに AI レスポンスが届かない
- `handleProjectConnect()` でフラグクリア（自動再接続時の二重作成防止）
- **レースコンディション注意**: ブラウザが Agent より先に再接続すると `clearAgentRestarted` → `needsSessionRestart.add` の順になり、フラグが残る。参加者マイグレーションでこのケースに対応
- `handleAgentDisconnect()` で stale WebSocket 判定（Race Condition 防止）
- `sendToAgent()` で CLOSED な WebSocket を検出時に自動クリーンアップ（stale 参照の自己修復）
- `handleAgentConnect()` で旧 WebSocket が残っていれば `terminate()` で即座に破棄（`close()` はハンドシェイク待ちで stuck するため不可）
- Agent 側の `connectToServer()` で旧 WS を `removeAllListeners()` + `terminate()` でクリーンアップしてから新 WS を作成
- Agent 側の close ハンドラで `thisWs` 参照をキャプチャし、既に新 WS に置き換えられていたら再接続をスキップ
- `context.userId` は Discord プラットフォーム ID。DB の `Session.userId` には `oldSession.userId` を使う
- **サーバー起動時の ChannelSession 保持**: マシンがオフラインでも `currentMachineId`/`currentSessionId` をクリアしない。サーバー起動時は全マシンが offline のため、クリアすると全セッション情報が消失する。Agent 再接続時に `restoreSessionParticipantsForMachine()` で復元される
- **Agent 更新完了通知**: `pendingUpdateNotify` Map で更新リクエスト元を記録し、Agent 再接続時に `handleAgentConnect()` で完了メッセージを送信
- **Web 参加者の stale 防止**: WS 切断時に `removeWebParticipantFromAllSessions()` で全セッションから即座に除去。再接続時は `//connect` で再登録される。旧実装では Web クライアントは `handleProjectConnect()` で旧セッションから除去されず、stale 参加者が蓄積してメッセージ重複の原因となっていた（#202 で修正）
- **pendingMessages の即座クリア**: WS 切断時に `pendingMessages.delete(chatId)` で即座にクリア。旧実装の 60 秒待機は stale キューのフラッシュによるメッセージ重複を引き起こしていた

---

## Phaser テンプレート対戦基盤

- `testflight --phaser` で生成されるテンプレートにターン制対戦インフラが内蔵
- **GameAdapter パターン**: ゲーム固有ロジック（初期状態、手の適用、CPU AI、表示用状態）をアダプタとして抽象化
- **Vite プラグイン方式**: `configureServer` フックで dev サーバーに WS + 管理画面を追加（追加プロセス不要）
- **WS は noServer モード必須**: `WebSocketServer({ server: httpServer })` は Vite HMR と `upgrade` イベントが衝突する。`noServer: true` + 手動 `handleUpgrade` でパス `/ws` のみゲーム WS に振り分け（#203 で修正）
- **管理画面**: `/stats` でダッシュボード HTML、`/api/stats` で JSON API。Vite の `server.middlewares` で追加
- **マッチメイキング**: FIFO キュー、10秒タイムアウト → CPU フォールバック
- **DB**: Prisma で Player（連勝追跡）+ Match モデル、`prisma db push` でデプロイ時に自動適用
- **デプロイフロー**: `testflight-manager.ts` の `deployPhaserTemplate()` に `prisma db push` ステップ追加

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

## Agreement v6 アーキテクチャ

- Agreement ルール本体は `rules/devrelay.md` に配置（CLAUDE.md には軽量マーカーのみ）
- `getAgreementStatusType()` は `rules/devrelay.md` → CLAUDE.md の順でチェック（後方互換）
- v5 以前のプロジェクトに v6 Agent が接続 → `'outdated'` 表示 → `ag` コマンドで v6 に更新可能
- `AGREEMENT_APPLY_PROMPT` はマルチファイル作成: `rules/devrelay.md` + `doc/changelog.md`（ヘッダー） + `rules/project.md`（ヘッダー）+ `doc/issues.md`（Issue 管理）+ CLAUDE.md マーカー更新
- `w` コマンドは `doc/changelog.md` → `rules/project.md` → CLAUDE.md（最小限のみ）→ `doc/issues.md`（Issue ステータス更新）の順で更新

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

## WebUI サーバー概念（タブグルーピング）

- 「サーバー」= ユーザー定義のプロジェクトグループ（「開発系」「本番系」等）
- データ構造: `ChatServer { id, name, projectIds }` を `UserSettings` の `chat_servers` キーに JSON 保存
- 左サイドバーが `[Agents] [Servers]` 切り替え（排他表示、上に行を増やさない設計）
- Agents モードでプロジェクト追加時、アクティブサーバーがあれば `projectIds` に自動登録
- タブバーは `activeServerId` で `visibleTabs` にフィルタ（null = 「すべて」表示）
- タブ → サーバーへのドラッグ&ドロップ: `dataTransfer.setData('text/x-devrelay-project', projectId)` で実装
- サーバー内プロジェクト名は `tabCustomNames` → `projectNameMap` → `pid` の順でフォールバック

---

## Agent プロキシ環境変数注入

- Agent の `config.yaml` に `proxy.url` がある場合、Claude Code / Gemini CLI 起動時の `spawn` env に `HTTP_PROXY` / `HTTPS_PROXY` / `http_proxy` / `https_proxy` を自動注入
- Agent 自身の WebSocket 接続は `connection.ts` で `HttpsProxyAgent` / `SocksProxyAgent` を使用（既存）
- AI プロセスは `process.env` を継承するが、Windows の VBS→CMD→node 起動経路では OS 環境変数がないケースがある
- Linux/macOS Agent (`agents/linux`, `agents/macos`) の両方で対応

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
  - **macOS 注意**: `pushAllowedToolsToAgents()` は `win32` 以外を全て Linux 扱い（`handleAgentConnect` と同じロジック）。`darwin` を個別に判定してはいけない
- **プランモードでのスキル**: Skill ツールはプランモードでブロックされる。`PLAN_MODE_INSTRUCTION` で Bash 経由の直接実行を指示
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

### Doc Folder ファイル同期
- DocPanel にアップロードしたファイルは DB（AgentDocument）に保存 + Agent ローカル（`~/.devrelay/docs/`）にも同期
- WebSocket メッセージ `server:doc:sync`（base64 ファイル送信）/ `server:doc:delete` で同期
- ファイル名にパストラバーサル（`/`, `\`, `..`）が含まれる場合は拒否
- bodyLimit: Fastify デフォルト 1MB → ドキュメント API は 50MB に引き上げ
- Embedding: text-embedding-3-small の 8192 トークン制限 → MAX_TEXT_LENGTH 6000（CJK は約 1.5 倍トークン消費）

### --resume スタートアップタイムアウト
- `--resume` で古い/巨大なセッションを再開すると Claude Code プロセスがハングすることがある
- 60 秒以内に stdout 出力がなければ `resumeFailed = true` → SIGTERM → `--resume` なしでリトライ
- 既存の `resumeFailed` メカニズム（exit code 1）と統合

### Git リモートブランチ動的検出
- `u` コマンドで `origin/main` がハードコードされていると、デフォルトブランチが異なるリポジトリでエラー
- `detectRemoteBranch()`: `git symbolic-ref refs/remotes/origin/HEAD` → `origin/main` → `origin/master` の順で検出
- bash/PowerShell 更新スクリプト内でも同様にインラインで動的検出

---

## チーム管理 + クロスプロジェクトクエリ

### データモデル
- `Team`: ユーザーが作成する名前付きグループ（`@@unique([userId, name])`）
- `TeamMember`: Team に属するプロジェクト（`@@unique([teamId, projectId])`、`onDelete: Cascade`）
- 旧 `ProjectMember` モデル（プロジェクト→プロジェクトの1対多）は #160 で廃止

### API 構成
- **WebUI 向け**: `GET/POST/DELETE /api/teams`、`POST/DELETE /api/teams/:teamId/members`
- **Agent 向け**: `GET /api/agent/members`（チームメイト一覧）、`POST /api/agent/ask-member`（質問送信）、`POST /api/agent/teamexec-member`（実行依頼送信）
- **Discord/Telegram**: `ask <project>: <question>` / `teamexec <project>: <instruction>` / `te <project>: <instruction>` コマンド

### クロスプロジェクトクエリの流れ（ask）
1. 質問送信 → `executeCrossProjectQuery()` で一時セッション作成（`crossquery_` プレフィックス）
2. ターゲットプロジェクトの Agent に `server:session:start` + 質問プロンプト送信
3. Agent が Claude Code を起動してコードを分析・回答
4. `handleAiOutput(isComplete=true)` → `pendingCrossQueries` Map の Promise を resolve
5. 回答を HTTP レスポンスとして返却（タイムアウト: 5分）

### クロスプロジェクト実行依頼の流れ（teamexec）
1. 実行指示送信 → `executeCrossProjectExec()` で一時セッション作成（`teamexec_` プレフィックス）
2. `startSession()` → 500ms 遅延 → `execConversation()` で exec マーカー付きセッションを起動
3. `execConversation()` 内部で `handleConversationExec()` → exec マーカー追加 + `handleAiPrompt()` 自動呼び出し
4. Agent は `--dangerously-skip-permissions` でコード変更を含む実行を行う
5. `handleAiOutput(isComplete=true)` → `pendingCrossQueries` Map の Promise を resolve
6. 回答を HTTP レスポンスとして返却
7. HTTP 切断検知: `request.raw.on('close')` → `cancelPendingCrossQuery()` でセッションクリーンアップ

### タイムアウト階層（#214）

| レイヤー | ask (質問) | teamexec (実行依頼) | 備考 |
|---------|-----------|-------------------|------|
| curl `--max-time` | 600秒（10分） | 3600秒（60分） | ask.sh 内 |
| SKILL.md Bash timeout | 720000（12分） | 3660000（61分） | curl より長く設定必須 |
| サーバー Promise | 43200000ms（12時間） | 43200000ms（12時間） | 最終防衛線 |

**重要**: curl が先にタイムアウトするとサーバーの Promise だけが残り、セッションが active のまま stuck する。
そのため `request.raw.on('close')` で HTTP 切断を検知し、`cancelPendingCrossQuery()` でクリーンアップする。

### Project displayName（#212）

`Project.displayName` カラムで表示名をユーザーが変更可能（null なら `name` = ディレクトリ名を使用）。
Machine.displayName と同じパターン。内部は全て projectId で動作するため表示層のみの変更。
ask.sh のメンバー検索は `displayName` と元の `name` の両方で部分一致検索する。

### Agent スキル
- `devrelay-ask-member`: エージェント起動時に `~/.claude/skills/` に自動配置
- `ask.sh --project X --question "..."` で質問（プランモード）、`ask.sh --exec --project X --question "..."` で実行依頼（exec モード）
- 質問/依頼する側のみスキルが必要。受ける側はサーバーが直接 Claude Code を起動
- **JSON 構築には `jq -n --arg` を使用**（shell エスケープは脆弱なため禁止）
- **SKILL.md に Bash timeout 指示が必須**（ask: 720000ms、teamexec: 3660000ms — curl timeout より長く設定）

### 送信元プロジェクト表示（#199）
- `Message.sourceProjectName` カラムでクロスクエリの送信元を記録
- REST API 経由: `auth.machineId` から DB でプロジェクト名を特定（1マシン1プロジェクトならプロジェクト名、複数ならマシン displayName）
- Discord/Telegram 経由: `context.currentProjectName` を使用
- WebUI チャット: ユーザー名横にバッジ、Conversations: 🔗 バッジに送信元名追加

### Google ID Token 検証（#199）
- `POST /api/auth/google/token`: Flutter `google_sign_in` の `idToken` を検証してセッション発行
- Google `tokeninfo` エンドポイント + `aud` チェック（外部ライブラリ不要）
- Flutter 側 `serverClientId` に Web 用 `GOOGLE_CLIENT_ID` を指定すれば追加対応不要

### 注意事項
- `authenticate` ミドルウェアは `request.user` を設定。`request.userId` ではない
- Team API エンドポイントは `(request as any).user.id` でユーザー ID を取得

---

## 今後の課題

- LINE 対応
- Gemini CLI / Codex / Aider 対応
- ベクトル検索のチャンク分割対応（大規模ドキュメント向け）
- WebUI でのドキュメント横断検索インターフェース
- 複数ユーザー同時接続
- エラーハンドリング強化

---

## Agent SDK 移行 (#178)

### 設計判断

1. **Claude のみ SDK 移行**: `@anthropic-ai/claude-agent-sdk` の `query()` で実行。Gemini/Codex/Aider は従来の `spawn` パスを維持
2. **`canUseTool` コールバックによるパーミッション制御**: exec モードでは SDK の `canUseTool` が全ツール実行前に呼ばれ、WebSocket 経由でユーザー承認を求める。30分以上の非同期待機にも耐える（実証済み）
3. **「以降すべて許可」モード**: `approveAllMode` フラグ（Agent 側メモリ）で管理。セッション単位で有効、Agent 再起動でリセット
4. **承認カード 2秒後自動非表示**: 許可/拒否確定後に 2秒で承認カードをチャットエリアから削除。右パネルの Approval History には永続表示
5. **参加者フォールバック**: `getSessionParticipants()` で Web 参加者が見つからない場合、全 Web クライアントにフォールバックブロードキャスト（サーバー再起動後の参加者復元不整合を回避）
6. **machineId**: Agent からの承認リクエストでは `currentMachineId`（Server から受信した DB ID）を優先使用。`currentConfig.machineId` は config.yaml 由来で空文字列の場合があるためフォールバックのみ
7. **`approveAllMode` リセット**: `handleSessionStart()` で `resetApproveAllMode()` を呼び出し、新セッション開始時に自動的にリセット。これにより「以降すべて許可」は現在のセッション限定で有効

### ツール承認履歴の永続化 (#179-#180)

- **DB**: `ToolApproval` テーブルに全承認イベント（pending/allow/deny/auto/timeout）を記録
- **API**: `GET /api/projects/:projectId/approvals` （カーソルベースページネーション、デフォルト100件）
- **WebUI**: タブ切替時に API から履歴ロード。WebSocket リアルタイム通知とマージ。ブラウザ更新でも履歴が消えない
- **Agent JSONL ログ**: `~/.devrelay/approvals/current.jsonl` に追記。Agent 起動時に `archive/` にローテーション（削除なし）
- **自動承認通知**: `agent:tool:approval:auto` → `web:tool:approval:auto` で WebUI に中継。🔓 紫色アイコンで表示

### ツール個別許可 (#185)

Claude Code のパーミッションシステムと同等の機能。承認カードの「📌 常に許可」ボタンで永続ルールを作成。

- **ルール形式**: Plan Mode の `allowedTools` と同じパターン（`Bash(git *)`, `Edit`, `Read` 等）
- **ルール生成**: `generateToolRule()` — Bash はコマンド先頭語をプレフィックスマッチ、他ツールはツール名のみ
- **永続化**: UserSettings `execAllowedTools` キー（JSON 文字列配列）
- **配信**: `server:connect:ack` / `server:config:update` の `execAllowedTools` フィールド
- **Agent 側**: `canUseTool` の先頭で `isToolExecAllowed()` チェック → マッチ時に自動承認 + `agent:tool:approval:auto` 通知
- **チェック優先順**: exec allowed rules → approveAllMode → ユーザーに聞く
- **全プラットフォーム**: WebUI / Discord / Telegram に「📌 常に許可」ボタン追加
- **Settings ページ**: 「Allowed Tools (Exec Mode)」セクション（チップ/タグ形式、× で個別削除）
- **API**: `GET/PUT /api/settings/exec-allowed-tools`

## プロトコルバージョン管理 (#186)

Agent/Server 間の互換性管理。古い Agent を検出し会話を制限する仕組み。

- **PROTOCOL_VERSION**: `packages/shared/src/types.ts` に定義（Agent がビルド時に焼き込む整数値）
- **MIN_PROTOCOL_VERSION**: `apps/server/src/services/agent-manager.ts` に定義
- **ソフトリジェクション**: 接続は許可（オンライン表示）、`sendPromptToAgent` でブロック
  - 古い Agent は `u` コマンドで更新可能（接続が維持されるため）
  - `outdatedAgents` Set で管理、disconnect 時にクリア
- **バージョンアップ手順**: shared の `PROTOCOL_VERSION` インクリメント → server の `MIN_PROTOCOL_VERSION` を上げる

## AskUserQuestion 対応 (#191)

Claude Code の `AskUserQuestion` ツールを DevRelay 経由で中継する仕組み。

- **deny-with-answer パターン**: `canUseTool` で `AskUserQuestion` をインターセプト → ユーザーに質問送信 → 回答を `{ behavior: 'deny', message: 'User answered: ...' }` で Claude に返す
  - `deny` で返す理由: `allow` だと CLI が TUI ダイアログ表示しようとして headless 環境でハングする
  - Claude は `message` を tool_result として読み取り、回答を理解して続行する
- **既存パイプライン流用**: `ToolApprovalRequestPayload` に `isQuestion?: boolean` フラグ追加、`ToolApprovalResponsePayload` に `answers?: Record<string, string>` 追加
- **plan/exec 両モード対応**: plan モードでも `canUseTool` を設定し AskUserQuestion のみインターセプト
- **approveAllMode スキップ**: 質問は常にユーザーに聞く（自動承認しない）
- **WebUI QuestionCard**: 選択肢ボタン + 「その他...」自由テキスト入力。ダークモードでもライトと同じ配色（明るい背景 + 黒文字）
- **AskUserQuestion の input 構造**: `{ questions: [{ question, header, multiSelect, options: [{ label, description }] }] }`

## Agent ログローテーション (#189)

- **方式**: copyTruncate（nohup stdout リダイレクトと互換、fd を壊さない）
- **タイミング**: 起動時 + 24時間ごとに `agent.log` をチェック
- **ローテーション**: 最終更新が昨日以前 → `agent_YYYYMMDD.log` にコピー → truncate
- **保持期間**: 7日超の `agent_*.log` を自動削除
- **実装**: `agents/linux/src/services/log-rotator.ts`（macOS も同一）

## Agent ごとの全許可モード (#194)

- **Machine.skipPermissions**: DB カラム（Boolean, default false）
- **配信**: `server:connect:ack` / `server:config:update` の `skipPermissions` フィールド
- **Agent 側**: `canUseTool` の先頭（sessionApproved / approveAllMode の前）でチェック
- **AskUserQuestion 除外**: 質問は常にユーザーに聞く（skipPermissions の対象外）
- **WebUI**: Agent Settings モーダルにトグルスイッチ、`PUT /api/machines/:id/skip-permissions` API
- **リアルタイム反映**: WebUI で ON/OFF → `pushConfigUpdate()` → Agent に即時配信

## プロジェクト概要 Ask (#211)

チーム管理ページからエージェントにプロジェクト概要を問い合わせる機能。

- **DB**: `Project.description String?` カラム（概要テキスト保存用）
- **API**: `POST /api/projects/:projectId/ask-description` → `executeCrossProjectQuery()` で「概要を教えて」→ 回答を `Project.description` に保存
- **WebUI**: チーム名横「Ask 📋」ボタン → 全オンラインメンバーに並列リクエスト → メンバー行下に表示
- **設計判断**: 概要は DB に永続化。次回表示時は API から取得、Ask ボタンで再取得可能。60秒タイムアウト

## クロスプロジェクトループ防止 (#211)

同一マシンから同一ターゲットへの自己送信ループを防止。

- **検出**: `ask-member`/`teamexec-member` で同一マシン → 同一ターゲットの直近5分以内のセッション数をカウント
- **閾値**: 3回以上で HTTP 429 拒否
- **表示**: `/api/agent/members` に `isSameMachine` フラグ、ask.sh で `[自マシン]` マーク
- **設計判断**: 送信自体はブロックしない（nim → devrelay のような正当な同一マシン間通信を許可）。閾値で異常検知

## クロスプロジェクト承認中継 (#210)

teamexec/crossquery で発信元タブにも承認カードを表示する仕組み。

- **参加者コピー**: `document-api.ts` の teamexec/ask-member エンドポイントで、発信元マシンのアクティブセッション参加者を一時セッションに `addParticipant()` でコピー
- **originProjectId**: `handleToolApprovalRequest()` で `teamexec_`/`crossquery_` セッション検出 → 発信元プロジェクト ID を取得 → ペイロードに追加
- **WebUI フィルタ**: `.filter(a => ... || a.originProjectId === activeTabId)` で発信元タブにも承認カード表示
- **設計判断**: ターゲット側にも引き続き表示（Web 全クライアントフォールバック）。どちら側からでも承認/拒否可能

## crontab PATH 修正 (#210)

crontab `@reboot` エントリで環境変数が子プロセスに継承されない問題の修正。

- **原因**: `PATH=... cd ...` だと PATH が cd にしか適用されず、`node` の `process.env.PATH` に含まれない
- **修正**: `export PATH=...; cd ...`（export + セミコロン追加）
- **install-agent.sh**: 新規デプロイ時に正しい形式で登録
- **Agent update**: `handleAgentUpdate()` の buildSteps に sed 修正ステップ追加。`u` コマンドで既存 crontab も自動修正

## プロジェクト検出マーカー (#192)

`looksLikeProject()` で以下のマーカーを検出:
1. `CLAUDE.md` ファイル（従来）
2. `.xcodeproj` ディレクトリ（iOS/macOS 開発用に追加）
