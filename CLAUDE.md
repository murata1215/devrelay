<!-- DevRelay Agreement v3 -->
【重要】ユーザーに渡すファイルを作成する場合は、必ず `.devrelay-output/` ディレクトリに保存してください。このディレクトリに置かれたファイルは自動的にユーザーに送信されます。

【プランモード】
現在はプランモードです。コードの書き換えや新規ファイルの作成は行わず、以下のみを行ってください：
- 調査・分析
- 実装プランの立案
- 質問や確認

プランが完成したら、最後に必ず以下のように伝えてください：
「このプランでよければ `e` または `exec` を送信してください。実装を開始します。」

ユーザーが `exec` を送信するまで、コードの変更は行わないでください。

【プランの説明】
プランを立案したら、必ずテキストで概要を説明してください。
ファイルに書き込むだけでなく、ユーザーが Discord/Telegram で内容を確認できるようにしてください。

【ユーザーへの質問】
AskUserQuestion ツールは使用しないでください（DevRelay 経由では応答を返せないため）。
ユーザーに質問や確認が必要な場合は、テキストで質問を書いてください。
ユーザーは Discord/Telegram 経由でテキストで回答します。

【コーディングスタイル】
ソースコードを書く際は、詳細な日本語コメントを必ず残してください。
以下のルールに従ってください：

1. **関数・メソッド**: 必ず JSDoc 形式で目的・引数・戻り値を説明
2. **クラス**: クラスの責務と使用方法を説明
3. **複雑なロジック**: 処理の流れを段階的に説明
4. **条件分岐**: なぜその条件が必要かを説明
5. **重要な変数**: 変数の用途を説明
6. **TODO・FIXME**: 将来の改善点を明記

コメントがないコードは不完全です。他の開発者が読んで理解できるレベルのコメントを心がけてください。
<!-- /DevRelay Agreement -->

---

# DevRelay 開発記録

> **重要**: 機能追加・変更を行ったら、必ずこのファイルを更新すること。
> セッションが落ちても作業内容を引き継げるようにする。

---

## Claude Code への指示（DevRelay 自身の開発時）
DevRelay（このプロジェクト）のサーバーやエージェントを修正した場合：
- ビルド（`pnpm build`）は実行してOK
- **サービスの再起動は実行しない**（`systemctl restart` 禁止）
- 「ビルド完了。以下のコマンドでサービスを再起動してください」と案内する

理由：自分自身を再起動すると WebSocket 接続が切れ、応答が途中で消失するため。

案内例：
```
ビルド完了。以下のコマンドでサービスを再起動してください：
pm2 restart devrelay-server
pm2 restart devrelay-agent
```

---

## プロジェクト概要

DevRelay は、メッセージングアプリ（Discord、Telegram、LINE）から AI CLI ツール（Claude Code、Gemini CLI など）をリモート操作できるハブシステム。

```
[Discord/Telegram/LINE] ↔ [Center Server] ↔ [Agent] ↔ [Claude Code/Gemini CLI]
```

## 実装済み機能

### Phase 1: 基本機能 (2026-01-17)

#### 1. Discord Bot 連携
- Discord からのメッセージ受信・送信
- DM およびメンション対応
- コマンドパーサー（`m`, `p`, `q`, `h` など）

#### 2. Linux Agent
- WebSocket でサーバーに接続
- Claude Code の `-p` モードで非対話実行
- `--dangerously-skip-permissions` で権限プロンプトをスキップ

#### 3. セッション管理
- マシン・プロジェクト選択
- セッション開始・終了
- 会話履歴の管理（DevRelay 側で管理、プロンプトに含める）

#### 4. 双方向ファイル転送

##### Claude Code → Discord
- `.devrelay-output/` ディレクトリを監視
- プロンプトに自動で指示を追加：「ユーザーに渡すファイルは `.devrelay-output/` に保存してください」
- 実行完了後にディレクトリからファイルを収集し、Discord に添付

##### Discord → Claude Code
- Discord の添付ファイルをダウンロード
- `.devrelay-files/` ディレクトリに保存
- プロンプトにファイルパスを含めて Claude Code に渡す

#### 5. プロジェクト自動検出
- `CLAUDE.md` ファイルの存在でプロジェクトを自動検出
- 複数ディレクトリのスキャン対応（`projectsDirs` 配列）
- 最大5階層まで再帰検索

#### 6. リアルタイム進捗表示
- `--output-format stream-json --include-partial-messages --verbose` オプション使用
- Claude Code の出力をリアルタイムでパース
- Discord メッセージを8秒ごとに編集して進捗表示
- ツール使用時は「🔧 Readを使用中...」のように表示

#### 7. セキュアなプロセス管理
- プロンプトを stdin 経由で渡す（`ps aux` に表示されない）
- `devrelay-claude` シンボリックリンクでプロセス識別
- 環境変数による識別:
  - `DEVRELAY=1`
  - `DEVRELAY_SESSION_ID=xxx`
  - `DEVRELAY_PROJECT=/path/to/project`

### Phase 1.1: 追加機能 (2026-01-18)

#### 8. クイックコマンド追加
- `c` - 前回の接続先に再接続（Continue）
  - `lastProjectId` を DB（ChannelSession テーブル）に**チャンネルごとに保存**
  - オフラインのマシンには接続不可のエラー表示
- `x` - 会話履歴をクリア（Clear）
  - Agent に `server:conversation:clear` メッセージを送信
  - ファイルとメモリ両方をクリア

#### 9. 会話履歴の永続化
- メモリ管理から**ファイル保存**に変更
- 保存先: `プロジェクト/.devrelay/conversation.json`
- 保存内容:
  ```json
  {
    "projectPath": "/path/to/project",
    "lastUpdated": "2026-01-18T...",
    "history": [
      { "role": "user", "content": "...", "timestamp": "..." },
      { "role": "assistant", "content": "...", "timestamp": "..." }
    ]
  }
  ```
- 保存は無制限、Claude に送るのは直近20件のみ（トークン節約）
- Agent 起動時に自動ロード

#### 10. 進捗表示の改善
- プロンプト送信時に進捗メッセージを先に送信
- 8秒ごとにメッセージを編集して経過時間と出力を表示
- 完了時に進捗メッセージを最終結果で置き換え

#### 11. プロジェクト名変更 (DevBridge → DevRelay)
- 既存企業「Devbridge」（Cognizant傘下）との混同を避けるためリネーム
- 変更内容:
  - パッケージ名: `@devbridge/*` → `@devrelay/*`
  - 設定ディレクトリ: `~/.devbridge/` → `~/.devrelay/`
  - 環境変数: `DEVBRIDGE_*` → `DEVRELAY_*`
  - CLI コマンド: `devbridge` → `devrelay`
  - シンボリックリンク: `devbridge-claude` → `devrelay-claude`
  - 出力ディレクトリ: `.devbridge-output/` → `.devrelay-output/`
  - ファイルディレクトリ: `.devbridge-files/` → `.devrelay-files/`
- GitHub リポジトリも `devrelay` にリネーム済み

#### 12. チャンネルごとのセッション分離
- Discord のチャンネルごとに独立したセッションを持てるように変更
- 変更前: `${platform}:${userId}` でセッション管理（ユーザーごと）
- 変更後: `${platform}:${chatId}` でセッション管理（チャンネルごと）
- 使用例:
  - チャンネルA で `p` → AnimeChaosMap に接続
  - チャンネルB で `p` → devrelay に接続
  - 同時並行で作業可能
- `lastProjectId`（`c` コマンド用）も**チャンネルごとに DB 保存**
  - DB テーブル: `ChannelSession`（`platform` + `chatId` で一意）
  - Discord、Telegram、LINE 全て対応

#### 13. Systemd サービス化サポート

##### Agent 側
- `devrelay setup` 実行時にサービスインストールの選択肢を表示
- **ユーザーサービス（推奨）**: `~/.config/systemd/user/devrelay-agent.service`
  - sudo 不要
  - `systemctl --user start/stop/status devrelay-agent`
  - `loginctl enable-linger` で自動起動対応
- **システムサービス**: `/etc/systemd/system/devrelay-agent.service`
  - sudo 必要
  - `sudo systemctl start/stop/status devrelay-agent`
- セットアップ完了後に適切なコマンドを案内

##### Server 側
- `apps/server/scripts/setup-service.sh` でサービス化
- 実行方法: `cd apps/server && pnpm setup:service`
- ユーザーサービスとして `~/.config/systemd/user/devrelay-server.service` を作成

## アーキテクチャ

### ディレクトリ構造
```
devrelay/
├── apps/
│   ├── server/          # Center Server (Fastify + WebSocket)
│   └── web/             # WebUI (Vite + React)
├── agents/
│   ├── linux/           # Linux Agent
│   └── windows/         # Windows Agent (Electron タスクトレイアプリ)
├── packages/
│   └── shared/          # 共通型定義
└── CLAUDE.md
```

### 主要ファイル

#### Server
- `apps/server/src/platforms/discord.ts` - Discord Bot
- `apps/server/src/platforms/telegram.ts` - Telegram Bot
- `apps/server/src/services/agent-manager.ts` - Agent 通信管理
- `apps/server/src/services/session-manager.ts` - セッション管理
- `apps/server/src/services/command-handler.ts` - コマンド処理

#### Agent (Linux)
- `agents/linux/src/services/connection.ts` - サーバー接続・メッセージ処理
- `agents/linux/src/services/ai-runner.ts` - Claude Code 実行
- `agents/linux/src/services/output-collector.ts` - 出力ファイル収集
- `agents/linux/src/services/file-handler.ts` - 受信ファイル保存
- `agents/linux/src/services/conversation-store.ts` - 会話履歴の永続化

#### Agent (Windows)
- `agents/windows/src/electron/main.ts` - Electron メインプロセス、タスクトレイ、IPC
- `agents/windows/src/services/connection.ts` - サーバー接続（Linux版と同等）
- `agents/windows/src/services/config.ts` - 設定管理（%APPDATA%\devrelay\）
- `agents/windows/assets/settings.html` - 設定画面 UI
- `agents/windows/assets/preload.js` - IPC ブリッジ（CommonJS）

#### Shared
- `packages/shared/src/types.ts` - 共通型定義（FileAttachment など）

## 設定ファイル

### Agent 設定
- Linux: `~/.devrelay/config.yaml`
- Windows: `%APPDATA%\devrelay\config.yaml`

```yaml
machineName: ubuntu-dev
machineId: ""
serverUrl: wss://devrelay.io/ws/agent
token: machine_xxxxx
projectsDirs:      # 複数ディレクトリ対応
  - /home/user         # Linux
  - C:\Users\username  # Windows
aiTools:
  default: claude
  claude:
    command: claude
logLevel: debug

# プロキシ設定（オプション）
proxy:
  url: http://proxy.example.com:8080      # または socks5://proxy:1080
  # 認証が必要な場合（オプション）
  username: user
  password: pass
```

### プロキシ設定
Agent がプロキシ経由でサーバーに接続する場合は、`~/.devrelay/config.yaml`（Linux）または `%APPDATA%\devrelay\config.yaml`（Windows）に `proxy` セクションを追加します。

**サポートするプロキシタイプ**:
- HTTP/HTTPS: `http://proxy:8080`, `https://proxy:8080`
- SOCKS5: `socks5://proxy:1080`
- SOCKS4: `socks4://proxy:1080`

**認証付きプロキシ**:
```yaml
proxy:
  url: http://proxy.example.com:8080
  username: myuser
  password: mypassword
```

または URL に直接埋め込む形式も対応:
```yaml
proxy:
  url: http://myuser:mypassword@proxy.example.com:8080
```

### プロジェクト設定 (`~/.devrelay/projects.yaml`)
```yaml
projects:
  - name: devrelay
    path: /home/user/devrelay
    defaultAi: claude
```

## 起動方法

### 開発時（手動起動）
```bash
# Server
cd apps/server && pnpm start

# Linux Agent
cd agents/linux && pnpm start

# Windows Agent (Electron)
cd agents/windows && pnpm build && npx electron .
```

### 本番（PM2 でサービス起動）

#### Linux
```bash
# Server
pm2 start /opt/devrelay/apps/server/dist/index.js --name devrelay-server

# Agent
pm2 start /opt/devrelay/agents/linux/dist/index.js --name devrelay-agent

# 管理コマンド
pm2 status
pm2 restart devrelay-server devrelay-agent
pm2 logs devrelay-server
pm2 logs devrelay-agent

# 自動起動設定（サーバー再起動後にも復活）
pm2 save
pm2 startup
```

#### Windows
```powershell
# 開発時
cd agents/windows && pnpm build && npx electron .

# 配布用インストーラー作成
cd agents/windows && pnpm dist

# 自動起動は設定画面の「Start automatically when Windows starts」で有効化
```

### Phase 1.2: 追加機能（続き）

#### 14. Agent の自動再接続改善
- エクスポネンシャルバックオフを実装
- 再接続間隔: 1秒 → 2秒 → 4秒 → 8秒 → ... → 最大60秒
- ジッター（0-1秒のランダム遅延）で接続の集中を回避
- 最大15回のリトライ後に停止（サービス再起動を促すメッセージ表示）
- 接続成功時にリトライカウンターをリセット

#### 15. Telegram Bot 対応
- `node-telegram-bot-api` ライブラリ使用
- ポーリングモード（Webhook 不要）
- 実装機能:
  - メッセージ受信・送信
  - ファイル添付（ドキュメント・写真）
  - タイピングインジケーター
  - 進捗メッセージの編集
  - 長いメッセージの自動分割（4096文字制限対応）
- 環境変数: `TELEGRAM_BOT_TOKEN`
- Bot 作成: @BotFather で `/newbot` コマンド

#### 16. 自然言語コマンド対応
- OpenAI API を使って自然言語をコマンドに変換
- ユーザーごとに OpenAI API キーを設定可能
- **DB スキーマ**: `UserSettings` テーブル（汎用 Key-Value 形式）
  ```sql
  UserSettings: id, userId, key, value, encrypted, createdAt, updatedAt
  -- key 例: openai_api_key, natural_language_enabled, theme, language
  ```
- **暗号化**: API キーなどの機密情報は AES-256-CBC で暗号化して保存
- **対応コマンド**:
  - 「バグ直して」→ `m バグ直して`
  - 「AnimeChaosMapに接続」→ `p` → プロジェクト選択
  - 「前回の続き」→ `c`
  - 「履歴クリア」→ `x`
- **フォールバック**: API キーがない場合は従来のコマンド形式のみ
- **主要ファイル**:
  - `apps/server/src/services/user-settings.ts` - 設定の保存・取得・暗号化
  - `apps/server/src/services/natural-language-parser.ts` - OpenAI API 連携
  - `apps/server/src/services/command-parser.ts` - NLP 統合

#### 17. プランモード / 実行モード
- **目的**: Claude がいきなりコードを書き換えるのを防ぎ、プラン立案→承認→実装のフローを強制
- **動作**:
  1. 通常は「プランモード」で、Claude はコード変更をせず調査・プラン立案のみ
  2. プラン完了時、Claude は「このプランでよければ `e` または `exec` を送信してください」と促す
  3. ユーザーが `e` または `exec` を送信すると「実行モード」に切り替わり、コード変更を開始
- **会話履歴の管理**:
  - `exec` 送信時に履歴にマーカーを記録
  - 以降の Claude への送信は、`exec` マーカー以降の直近20件のみ（プラン会話は送らない）
  - これによりトークン消費を抑えつつ、実装に必要なコンテキストを維持
- **コマンド**: `e` または `exec`
- **会話履歴フォーマット**:
  ```json
  {
    "history": [
      { "role": "user", "content": "...", "timestamp": "..." },
      { "role": "assistant", "content": "...", "timestamp": "..." },
      { "role": "exec", "content": "--- EXEC: Implementation Started ---", "timestamp": "..." },
      { "role": "user", "content": "...", "timestamp": "..." }
    ]
  }
  ```
- **主要ファイル**:
  - `packages/shared/src/types.ts` - `exec` コマンド型、`server:conversation:exec` メッセージ型
  - `packages/shared/src/constants.ts` - `e`, `exec` ショートカット
  - `apps/server/src/services/command-handler.ts` - `handleExec()` 関数
  - `apps/server/src/services/agent-manager.ts` - `execConversation()` 関数
  - `agents/linux/src/services/conversation-store.ts` - `markExecPoint()`, exec マーカー対応の `getConversationContext()`
  - `agents/linux/src/services/connection.ts` - `handleConversationExec()`, プランモード指示の追加
  - `agents/linux/src/services/output-collector.ts` - `PLAN_MODE_INSTRUCTION`, `EXEC_MODE_INSTRUCTION`

#### 18. Agent アンインストールコマンド
- `devrelay uninstall` でクリーンアンインストール
- **削除内容**:
  - Systemd サービス（ユーザー/システム両方）の停止・無効化・削除
  - `~/.devrelay/` 設定ディレクトリの削除
  - 各プロジェクトの `.devrelay/` ディレクトリの削除（オプション）
- **主要ファイル**:
  - `agents/linux/src/cli/commands/uninstall.ts`

#### 19. セットアップ簡素化
- `devrelay setup` は**トークンのみ**を入力
- 以下は自動設定（後から `~/.devrelay/config.yaml` で変更可能）:
  - マシン名: ホスト名を使用
  - サーバーURL: `ws://localhost:3000/ws/agent`
  - プロジェクトディレクトリ: ホームディレクトリ
- ESM 対応: `__dirname` → `import.meta.url` を使用するよう修正

#### 20. サーバー起動時マシン状態リセット
- サーバー起動時に全マシンの status を `offline` にリセット
- サーバーがクラッシュした場合などに、DB上でオンラインのまま残る問題を解決
- `apps/server/src/index.ts` の `main()` 関数冒頭で `prisma.machine.updateMany()` を実行

#### 21. デフォルト serverUrl 変更
- `ws://localhost:3000/ws/agent` → `wss://devrelay.io/ws/agent`
- 外部マシンからも Agent を接続可能に
- `agents/linux/src/services/config.ts` で設定

#### 22. Setup 後のサービス自動起動
- `devrelay setup` 完了時にサービスを自動的に `start`
- ユーザーサービス/システムサービス両方に対応
- `agents/linux/src/cli/commands/setup.ts` で実装

#### 23. WebUI ポーリングエラー改善
- ポーリング中のエラーは無視（次のポーリングで回復）
- 初回ロード時のみエラー表示
- Agent 切断時の「Unknown error」表示を解消
- `apps/web/src/pages/MachinesPage.tsx` で実装

#### 24. Agent 切断時のエラーハンドリング
- `handleAgentDisconnect` で DB 更新エラーをキャッチ
- マシンが DB に存在しない場合でもサーバーがクラッシュしない
- `apps/server/src/services/agent-manager.ts` で実装

#### 25. WebUI サービス化サポート
- `apps/web/scripts/setup-service.sh` でサービス化
- 実行方法: `cd apps/web && pnpm setup:service`
- ユーザーサービスとして `~/.config/systemd/user/devrelay-web.service` を作成
- Vite 開発サーバー（HMR 付き）を systemd で管理
- **注意**: 本番では Caddy + 静的ファイル配信を推奨

#### 26. プラットフォームアカウント連携
- Discord/Telegram ユーザーと WebUI ユーザーをリンク
- **問題**: Discord から接続するとユーザーが自動作成されるが、WebUI で登録したマシンにアクセスできない
- **解決方法**: リンクコード方式
  1. Discord/Telegram で `link` コマンド → 6桁のコードを生成
  2. WebUI Settings ページでコードを入力 → アカウントをリンク
  3. 既存の Discord ユーザーのデータを WebUI ユーザーにマージ
- **コード仕様**:
  - 6桁英数字（紛らわしい文字 0,O,I,1 を除外）
  - 有効期限: 5分
  - 使用後は自動削除
- **DB スキーマ**:
  - `PlatformLinkCode` テーブル追加（一時コード保存）
  - `PlatformLink` テーブルに `platformName`, `linkedAt` フィールド追加
- **主要ファイル**:
  - `apps/server/prisma/schema.prisma` - DB スキーマ
  - `apps/server/src/services/platform-link.ts` - リンクコード生成・検証・マージ
  - `apps/server/src/routes/api.ts` - `/api/platforms/*` エンドポイント
  - `apps/server/src/services/command-handler.ts` - `link` コマンド、linked user 検証
  - `apps/web/src/pages/SettingsPage.tsx` - Connected Platforms UI
  - `apps/web/src/lib/api.ts` - platforms API クライアント

#### 27. Windows Agent (2026-01-18)
- Linux Agent をベースに Windows 対応版を実装
- **Electron タスクトレイアプリ**として常駐
- 設定ディレクトリ: `%APPDATA%\devrelay\`
- サーバーURL: `wss://devrelay.io/ws/agent`（固定）
- **タスクトレイ機能**:
  - 接続状態をアイコン色で表示（緑=接続中、グレー=切断）
  - 右クリックメニュー: Connect/Disconnect, Settings, Open Config Folder, Quit
  - 左クリック: 設定画面を開く
- **設定画面（3タブ）**:
  - **Connection**: トークン入力、自動起動ON/OFF（マシン名・サーバーURLは読み取り専用）
  - **Directories**: プロジェクトスキャン対象ディレクトリの追加/削除
  - **Projects**: 検出されたプロジェクト一覧、手動スキャン
- **自動起動**: `app.setLoginItemSettings()` でWindowsログイン項目に登録
  - 開発環境では `args` パラメータでアプリパスを渡す（`electron.exe` 単体起動を回避）
  - `getLoginItemSettings()` も同じ `args` を指定しないと状態を取得できない
  - `getLoginItemOptions()` ヘルパー関数で設定・取得時のオプションを統一
- **主要ファイル**:
  - `agents/windows/src/electron/main.ts` - Electron メインプロセス
  - `agents/windows/assets/settings.html` - 設定画面 UI
  - `agents/windows/assets/preload.js` - IPC ブリッジ（CommonJS必須）
- 詳細は `agents/windows/DEVELOPMENT.md` 参照

```powershell
# 開発時
cd agents/windows && pnpm build && npx electron .

# 配布用ビルド
cd agents/windows && pnpm dist  # release/ にインストーラー生成
```

#### 28. AI プロンプト送信時の自動再接続
- **問題**: サーバー再起動後、セッションが切断され、AI プロンプト送信時に「接続されていません」エラー
- **解決**: 未接続状態で AI プロンプトを送信した際、`lastProjectId` があれば自動的に再接続
- **動作フロー**:
  1. ユーザーが AI プロンプト（例: 「バグ直して」）を送信
  2. 未接続を検出 → `lastProjectId` を DB から取得
  3. `handleContinue()` を内部実行して再接続
  4. 成功時: 再接続メッセージを**先に送信**してから AI 処理を開始
  5. 失敗時（オフライン等）: エラーメッセージを返す
- **メッセージ順序**:
  ```
  1. 🔄 前回の接続先（ubuntu-dev / devrelay）に再接続しました
  2. 🤖 AI Status: running
  3. [Claude Code の応答...]
  ```
- **主要ファイル**:
  - `apps/server/src/services/command-handler.ts` - `handleAiPrompt()` に自動再接続ロジック追加

#### 29. Proxy 対応 (2026-01-19)
- Agent がプロキシ経由でサーバーに接続可能に
- **サポートするプロキシタイプ**:
  - HTTP/HTTPS プロキシ: `https-proxy-agent` ライブラリ使用
  - SOCKS4/SOCKS5 プロキシ: `socks-proxy-agent` ライブラリ使用
- **設定方法**: `~/.devrelay/config.yaml` に `proxy` セクションを追加
- **認証対応**: `username`/`password` フィールドまたは URL 埋め込み形式
- **主要ファイル**:
  - `packages/shared/src/types.ts` - `ProxyConfig` 型定義
  - `agents/linux/src/services/config.ts` - プロキシ設定読み込み
  - `agents/linux/src/services/connection.ts` - `createProxyAgent()` 関数、プロキシ経由接続
  - `agents/windows/src/services/config.ts` - プロキシ設定読み込み
  - `agents/windows/src/services/connection.ts` - `createProxyAgent()` 関数、プロキシ経由接続

#### 30. DevRelay Agreement 機能 (2026-01-19)
- プロジェクト接続時に CLAUDE.md の DevRelay Agreement 対応状況を表示
- **目的**: プランモード / ファイル出力指示が CLAUDE.md に含まれているか確認
- **動作**:
  1. プロジェクト接続時に CLAUDE.md をチェック
  2. `<!-- DevRelay Agreement v1 -->` マーカーの有無を確認
  3. 接続メッセージに対応状況を表示:
     - 対応済み: `✅ DevRelay Agreement 対応済み`
     - 未対応: `⚠️ DevRelay Agreement 未対応 - \`a\` または \`agreement\` で対応できます`
- **コマンド**: `a` または `agreement` で CLAUDE.md に Agreement を追加
  - Claude Code が自動的に CLAUDE.md を確認・更新
- **Agreement 内容**:
  - `.devrelay-output/` ディレクトリへのファイル出力指示
  - プランモード / 実行モードの切り替え指示
- **主要ファイル**:
  - `packages/shared/src/types.ts` - `AgreementApplyPayload` 型、`agreement` コマンド追加
  - `packages/shared/src/constants.ts` - `a`, `agreement` ショートカット
  - `agents/*/src/services/output-collector.ts` - `DEVRELAY_AGREEMENT_MARKER`, `AGREEMENT_APPLY_PROMPT`
  - `agents/*/src/services/connection.ts` - `checkAgreementStatus()`, `handleAgreementApply()`
  - `apps/server/src/services/command-handler.ts` - `handleAgreement()`
  - `apps/server/src/services/agent-manager.ts` - `applyAgreement()`

#### 31. Windows Agent 改善 (2026-01-19)
- **自動起動パスのクォート対応**
  - スペースを含むパス（例: `D:\My Programs\...`）でも自動起動が動作するように修正
  - `getLoginItemOptions()` でパスをダブルクォートで囲む
- **ディレクトリ追加時の自動スキャン**
  - Directories タブでディレクトリ追加後、即座にプロジェクトスキャンを実行
  - 手動で「Scan」ボタンを押す必要がなくなった
- **リアルタイム進捗表示の修正**
  - Windows での stdout バッファリング問題を解決
  - `spawn` の `shell: true` オプションでリアルタイム出力を実現
  - これにより Discord/Telegram でリアルタイムに進捗が表示されるように
- **主要ファイル**:
  - `agents/windows/src/electron/main.ts` - `getLoginItemOptions()` パスクォート、`add-projects-dir` 自動スキャン
  - `agents/windows/src/services/ai-runner.ts` - `shell: true` 追加

#### 32. Windows Agent スリープ防止機能 (2026-01-19, 修正 2026-01-20)
- **問題**: Windows の Modern Standby (S0 Low Power Idle) により、画面オフ後にシステムがスリープ状態に入り、WebSocket 接続が切断される
- **解決**: Windows API `PowerCreateRequest` / `PowerSetRequest` を使用してスリープを防止
  - 注: `SetThreadExecutionState` は Modern Standby には効果がないため、`PowerSetRequest` API を採用
- **動作**:
  - 接続時に `PowerSetRequest(PowerRequestSystemRequired)` でスリープを防止
  - 切断時に `PowerClearRequest` + `CloseHandle` で電源要求を解除
  - **画面オフは許可**（システムスリープのみ防止）
  - `powercfg /requests` コマンドの SYSTEM セクションに「DevRelay Agent: Maintaining server connection」と表示される
- **設定方法**:
  - 設定画面 > Connection タブ > 「Prevent sleep while connected」チェックボックス
  - または `%APPDATA%\devrelay\config.yaml` に `preventSleep: true` を追加
- **実装**:
  - `koffi` パッケージで Windows API (kernel32.dll) を呼び出し
  - ネイティブモジュール不要（pure JavaScript FFI）
  - `POWER_REQUEST_TYPE` 定数: `PowerRequestDisplayRequired=0`, `PowerRequestSystemRequired=1`
- **主要ファイル**:
  - `agents/windows/src/services/sleep-preventer.ts` - `enableSleepPrevention()`, `disableSleepPrevention()`
  - `agents/windows/src/services/config.ts` - `preventSleep` 設定
  - `agents/windows/src/services/connection.ts` - 接続/切断時のスリープ防止制御
  - `agents/windows/assets/settings.html` - 設定画面 UI

#### 33. セッション情報表示コマンド (2026-01-21)
- `se` または `session` コマンドで現在のセッション情報を表示
- **表示内容**:
  - マシン名、プロジェクト名、AI ツール
  - セッションステータス（アクティブ/アイドル）
  - 会話履歴の件数
  - セッション継続時間
  - 最終メッセージからの経過時間
- **未接続時**:
  - 前回の接続先情報（`lastProjectId` がある場合）
  - `c` コマンドで再接続可能であることを案内
- **主要ファイル**:
  - `packages/shared/src/types.ts` - `UserCommand` 型に `{ type: 'session' }` を追加
  - `packages/shared/src/constants.ts` - `SHORTCUTS` に `se`, `session` を追加
  - `apps/server/src/services/command-parser.ts` - `parseShortcut()` と `getHelpText()` を更新
  - `apps/server/src/services/command-handler.ts` - `handleSession()` 関数を実装

#### 34. Heartbeat 機能（Agent 生存確認）(2026-01-21)
- **問題**: Agent がクラッシュ/切断しても DB 上は `online` のまま残り続ける
- **解決**: アプリケーションレベルの ping/pong と定期監視で正確なオンライン状態を維持
- **動作**:
  1. Agent は 30 秒ごとに `agent:ping` メッセージを送信
  2. Server は `server:pong` を返信し、`lastSeenAt` を更新
  3. Server は 60 秒ごとに全マシンをチェック
  4. `lastSeenAt` が 60 秒以上前の Agent を自動的に `offline` に更新
- **追加機能**:
  - Agent 側でも pong タイムアウト検出（45秒以上 pong がなければ再接続）
  - 接続時に即座に ping を送信（初回 lastSeenAt 更新）
- **machineId 修正** (2026-01-21):
  - Agent の設定ファイル (`config.yaml`) の `machineId` と DB 上の `machineId` が不一致の場合があった
  - サーバーが `server:connect:ack` で正しい `machineId` を返すように修正
  - Agent は受け取った `machineId` を使って ping を送信
  - `ServerConnectAckPayload` に `machineId?: string` フィールドを追加
- **主要ファイル**:
  - `packages/shared/src/types.ts` - `AgentPingPayload`, `ServerPongPayload`, `ServerConnectAckPayload` 型
  - `agents/linux/src/services/connection.ts` - `startAppPing()`, `stopAppPing()` 関数、`currentMachineId` 管理
  - `agents/windows/src/services/connection.ts` - 同上
  - `apps/server/src/services/agent-manager.ts` - `handleAgentPing()`, `startHeartbeatMonitor()`, `stopHeartbeatMonitor()`, 認証時に `machineId` を返す
  - `apps/server/src/index.ts` - サーバー起動時に heartbeat monitor を開始

#### 35. WebUI サービス再起動機能 (2026-01-22)
- WebUI 設定ページに「Service Management」セクションを追加
- **機能**:
  - サーバーと Agent の再起動ボタン
  - サービスステータス表示（active/inactive）
  - 確認ダイアログ付き（サーバー再起動後は自動リロード）
- **API エンドポイント**:
  - `GET /api/services/status` - サービスステータス取得
  - `POST /api/services/restart/server` - サーバー再起動
  - `POST /api/services/restart/agent` - Agent 再起動
- **実装**: `pm2 restart` コマンドを使用
- **主要ファイル**:
  - `apps/server/src/routes/api.ts` - サービス管理 API エンドポイント
  - `apps/web/src/lib/api.ts` - services API クライアント
  - `apps/web/src/pages/SettingsPage.tsx` - Service Management UI

#### 36. WebUI モバイル対応 (2026-01-22)
- スマートフォンでも操作しやすいレスポンシブデザインに改善
- **Layout.tsx**:
  - ハンバーガーメニューを追加（モバイル時）
  - デスクトップ: 横並びナビゲーション
  - モバイル: ドロップダウンメニュー
- **SettingsPage.tsx**:
  - フォームを縦並び/横並びで切り替え
  - ボタン幅を自動調整
- **ProjectsPage.tsx**:
  - テーブル表示（デスクトップ）とカード表示（モバイル）を切り替え
- **DashboardPage.tsx / MachinesPage.tsx**:
  - グリッドレイアウトをモバイル対応に調整
- **主要ファイル**:
  - `apps/web/src/components/Layout.tsx` - ハンバーガーメニュー実装
  - `apps/web/src/pages/*.tsx` - 各ページのレスポンシブ対応

#### 37. セッション表示改善 (2026-01-22)
- `s` / `session` コマンドの表示をシンプルな1行形式に変更
- **改善点**:
  - 冗長な情報を削除し、1行で表示
  - DB のセッションではなく、メモリ内のアクティブセッション（`getActiveSessions()`）を使用
  - 同じマシン+プロジェクトの重複を排除
  - オンラインだがセッションなしのマシンは `(idle)` と表示
- **表示例**:
  ```
  📍 ubuntu-dev / devrelay (5分30秒)
  • windows-hp-dev / devrelay (3分15秒)
  ```
- **主要ファイル**:
  - `apps/server/src/services/command-handler.ts` - `handleSession()` 関数を改善

#### 38. セッション管理改善 - Claude Code --resume 対応 (2026-01-22)
- Claude Code の `--resume` オプションを使用してセッション継続
- `--permission-mode plan` でプランモード、`--dangerously-skip-permissions` で実行モードを切り替え
- **機能**:
  - プロジェクトごとに Claude Code のセッション ID を保存（`.devrelay/claude-session-id`）
  - 2回目以降のプロンプトで `--resume <session_id>` を使用してコンテキスト継続
  - `x` コマンドでセッション ID もクリア（新規セッション開始）
- **主要ファイル**:
  - `agents/*/src/services/session-store.ts` - セッション ID の保存/読み込み
  - `agents/*/src/services/ai-runner.ts` - `--resume`, `--permission-mode` 対応
  - `agents/*/src/services/connection.ts` - モード切り替え対応

#### 39. コンテキスト使用量表示 (2026-01-22)
- プロンプト送信時に前回のコンテキスト使用量を Discord/Telegram の先頭に表示
- **動作**:
  1. Claude Code の `result` メッセージから `modelUsage` の `inputTokens` + `cacheReadInputTokens` を取得
  2. `contextWindow`（200K）との比率を計算
  3. `.devrelay/context-usage.json` に保存
  4. 次回プロンプト送信時に先頭に表示
- **表示例**:
  ```
  📊 Context: 131K / 200K tokens (66%)

  [Claude の応答...]
  ```
- **警告**:
  - 70% 超で警告メッセージを表示
  - `x` コマンドで履歴をクリアすることを推奨
- **主要ファイル**:
  - `agents/*/src/services/output-parser.ts` - usage 情報抽出、コンテキスト表示フォーマット
  - `agents/*/src/services/session-store.ts` - `loadContextUsage()`, `saveContextUsage()` 追加
  - `agents/*/src/services/connection.ts` - プロンプト送信時に前回のコンテキストを先に送信
  - `apps/server/src/services/session-manager.ts` - `contextInfo` を最終メッセージの先頭に追加

#### 40. プランモード/実行モードの改善 (2026-01-22)
- **問題1**: 一度 `exec` を送信すると、以降のすべてのプロンプトが実行モードで実行され続ける
- **問題2**: `exec` 送信後、ユーザーが手動でプロンプトを送信しないと実装が開始されない
- **解決策1**: exec マーカーの**直後のプロンプトのみ**実行モードで実行。その後はプランモードに戻る
- **解決策2**: `exec` 送信時に自動的に「プランに従って実装を開始してください。」で AI を実行
- **動作フロー**:
  1. ユーザー: プロンプト送信 → プランモード（`--permission-mode plan`）
  2. Claude: プラン作成
  3. ユーザー: `e` / `exec` 送信
  4. → 自動的に実行モード（`--dangerously-skip-permissions`）で実装開始
  5. Claude: 実装完了
  6. ユーザー: 次のプロンプト → プランモードに戻る
- **主要ファイル**:
  - `agents/*/src/services/connection.ts` - `handleConversationExec()` で自動実行、`handleAiPrompt()` でモード判定修正

#### 41. サーバー再起動後のセッション復元 (2026-01-22)
- **問題**: サーバー再起動後、`q` で切断してから `c` で再接続しないと会話ができない
- **原因**: `sessionParticipants` マップがメモリ内のみで管理されていた
- **解決策**:
  1. `ChannelSession` テーブルに `currentSessionId` と `currentMachineId` フィールドを追加
  2. セッション開始時にこれらを DB に保存
  3. サーバー起動時に `restoreSessionParticipants()` で復元
  4. `getUserContext()` で `currentSessionId` と `currentMachineId` を復元
- **動作**: サーバー再起動後も `q` なしで会話継続可能
- **主要ファイル**:
  - `apps/server/prisma/schema.prisma` - `ChannelSession` スキーマ変更
  - `apps/server/src/services/session-manager.ts` - `restoreSessionParticipants()` 追加
  - `apps/server/src/services/command-handler.ts` - `getUserContext()`, `updateUserContext()` 修正
  - `apps/server/src/index.ts` - サーバー起動時に復元処理を呼び出し

#### 42. メンション前会話の復元修正 (2026-01-22)
- **問題**: `--resume` 使用時にメンション前の会話（missedMessages）がコンテキストとして拾われない
- **原因**: `claudeResumeSessionId` がある場合、会話履歴をプロンプトに含めないようにしていた
- **解決策**: `missedMessages` がある場合は、`--resume` 使用時でも履歴を含めるように修正
- **主要ファイル**:
  - `agents/*/src/services/connection.ts` - `handleAiPrompt()` の履歴包含条件を修正

#### 43. Windows Agent 機能追加 - Linux Agent との機能パリティ (2026-01-23)
- **目的**: Linux Agent で実装済みの機能を Windows Agent にも追加
- **追加機能**:
  1. **Missed Messages 対応** - Discord でメンション前のメッセージをコンテキストとして拾える
     - `handleAiPrompt` で `missedMessages` パラメータを処理し、履歴に追加
  2. **Storage Context 対応** - 永続的なプロンプトコンテキスト管理
     - `loadStorageContext()` - ストレージコンテキストの読み込み
     - `saveStorageContext()` - ストレージコンテキストの保存
     - `clearStorageContext()` - ストレージコンテキストのクリア
     - `handleStorageSave()` - サーバーからの保存リクエスト処理
     - `handleStorageClear()` - サーバーからのクリアリクエスト処理
- **主要ファイル**:
  - `agents/windows/src/services/connection.ts` - 全機能の実装

#### 44. 会話履歴エクスポート機能 (2026-01-24)
- WebUI から会話履歴を日別に ZIP でダウンロード可能に
- **機能**:
  - Projects ページでプロジェクト名クリック → 日付一覧モーダル表示
  - 日付クリック → その日の会話履歴を ZIP でダウンロード
- **ZIP 内容**:
  - `conversation.md` - 会話履歴（Markdown形式）
  - `images/` - その日に添付された画像
- **ファイル名フォーマット**:
  - 添付ファイルに日時プレフィックスを追加: `YYYYMMDD_HHmmss_filename.png`
  - これにより日付でファイルを特定可能
- **API エンドポイント**:
  - `GET /api/projects/:projectId/history/dates` - 日付一覧取得
  - `GET /api/projects/:projectId/history/:date/download` - ZIP ダウンロード
- **主要ファイル**:
  - `apps/server/src/routes/api.ts` - History Export API エンドポイント
  - `apps/server/src/services/agent-manager.ts` - Agent へのリクエスト送信
  - `agents/linux/src/services/connection.ts` - handleHistoryDates, handleHistoryExport
  - `agents/linux/src/services/file-handler.ts` - 日時プレフィックス付きファイル保存
  - `agents/windows/src/services/connection.ts` - 同上（Windows版）
  - `agents/windows/src/services/file-handler.ts` - 同上（Windows版）
  - `apps/web/src/pages/ProjectsPage.tsx` - History Export モーダル UI
  - `packages/shared/src/types.ts` - HistoryDatesRequestPayload, HistoryExportPayload 型

#### 45. エラーハンドリング改善とログ強化 (2026-02-05)
- **"Prompt is too long" エラー検知と通知**
  - Claude Code の stderr から "Prompt is too long" エラーを検知
  - ユーザーに「⚠️ プロンプトが長すぎます。`x` コマンドで会話履歴をクリアしてください。」と通知
  - **主要ファイル**: `agents/*/src/services/ai-runner.ts`
- **プロンプトサイズ詳細ログ出力**
  - プロンプト送信時に各コンポーネントのサイズをログ出力
    - Mode instruction, User prompt, Work state, Storage context, Output instruction, History context
    - 合計サイズと推定トークン数（`📦 TOTAL: xxx chars (~xxx tokens)`）
  - **主要ファイル**: `agents/*/src/services/connection.ts`
- **devrelay-claude シンボリックリンク自動作成**
  - `devrelay setup` 実行時に `~/.devrelay/bin/devrelay-claude` シンボリックリンクを自動作成
  - `which claude` で実際の claude パスを取得してリンク
  - **主要ファイル**: `agents/linux/src/cli/commands/setup.ts`
- **ExitPlanMode ツール使用禁止の警告**
  - PLAN_MODE_INSTRUCTION に警告を追加
  - Claude が `ExitPlanMode` ツールを使ってプランモードを解除することを防止
  - 「`ExitPlanMode` ツールは使用しないでください。DevRelay のプランモード解除はユーザーが `e` / `exec` を送信することで行います。」
  - **主要ファイル**: `agents/*/src/services/output-collector.ts`
- **Windows Agent 日本語統一**
  - PLAN_MODE_INSTRUCTION, EXEC_MODE_INSTRUCTION を英語から日本語に変更
  - Linux Agent と同じ指示内容に統一
  - **主要ファイル**: `agents/windows/src/services/output-collector.ts`
- **Windows Agent ファイルログ出力**
  - `electron-log` パッケージを使用
  - ログ出力先: `%APPDATA%\devrelay\logs\agent.log`
  - 1MB でローテーション（古いログは自動削除）
  - `config.yaml` の `logLevel` 設定に対応
  - **主要ファイル**:
    - `agents/windows/src/services/logger.ts` (新規)
    - `agents/windows/src/electron/main.ts`
    - `agents/windows/src/services/connection.ts`
    - `agents/windows/src/services/ai-runner.ts`
    - `agents/windows/package.json` (`electron-log` 依存追加)

#### 46. 会話履歴件数表示 (2026-02-05)
- プロンプト送信時に会話履歴件数を Discord/Telegram の先頭に表示
- **表示例**: `📝 History: 47 messages`
- **実装**: `contextInfo` として検出され、最終メッセージの先頭に追加
- **主要ファイル**:
  - `agents/linux/src/services/connection.ts` - 履歴件数表示ロジック追加
  - `agents/windows/src/services/connection.ts` - 同上

#### 47. 会話履歴アーカイブ機能 (2026-02-06)
- `x` コマンドで履歴クリア時、削除せずにアーカイブ保存
- **目的**: 過去の会話を後から振り返れるようにする
- **保存先**: `.devrelay/conversation-archive/conversation_YYYYMMDD_HHmmss.json`
- **保存形式**:
  ```json
  {
    "archivedAt": "2026-02-06T11:45:30.123Z",
    "messageCount": 127,
    "firstMessageAt": "2026-01-30T01:18:12.842Z",
    "lastMessageAt": "2026-02-06T02:50:58.479Z",
    "projectPath": "/home/user/devrelay",
    "history": [...]
  }
  ```
- **動作**: 履歴が1件以上ある場合のみアーカイブ。空の場合はスキップ
- **主要ファイル**:
  - `agents/linux/src/services/conversation-store.ts` - `archiveConversation()` 関数追加
  - `agents/linux/src/services/connection.ts` - `handleConversationClear()` でアーカイブ呼び出し
  - `agents/windows/src/services/conversation-store.ts` - 同上
  - `agents/windows/src/services/connection.ts` - 同上

#### 48. Agent再接続時のセッション復元 (2026-02-12)
- **問題**: Agentのみ再起動するとDiscordからのメッセージに応答しなくなる
- **原因**: Agent切断時に `clearSessionsForMachine()` で `sessionParticipants` が削除されるが、Agent再接続時に復元されない
- **解決策**: `handleAgentConnect()` 内で `restoreSessionParticipantsForMachine()` を呼び出し、ChannelSessionからセッションを復元
- **動作フロー**:
  1. Agent切断 → `sessionParticipants` 削除、Session status を `ended` に
  2. Agent再接続 → `restoreSessionParticipantsForMachine()` で ChannelSession から復元
  3. `ended` のセッションを `active` に戻す
  4. ユーザーは `q` → `c` なしでそのまま会話継続可能
- **主要ファイル**:
  - `apps/server/src/services/session-manager.ts` - `restoreSessionParticipantsForMachine()` 追加
  - `apps/server/src/services/agent-manager.ts` - `handleAgentConnect()` にセッション復元呼び出し追加

#### 49. x コマンドの2回連続確認 (2026-02-13)
- **問題**: `e`（exec）と `x`（クリア）を押し間違えると、会話履歴が即座にクリアされる
- **解決策**: `x` コマンドを2回連続で送信しないとクリアされない確認機能を追加
- **動作**:
  1. 1回目の `x`: `⚠️ 会話履歴をクリアしますか？ もう一度 x を送信してください。` と表示
  2. 2回目の `x`: 実際にクリア処理を実行（アーカイブ → クリア）
  3. `x` 以外のコマンドを送信すると、確認状態がリセットされる
- **実装**: `pendingClear` Set（chatKey ベース）で確認状態を管理
- **主要ファイル**:
  - `apps/server/src/services/command-handler.ts` - `pendingClear` Set、`handleClear()` の確認ロジック

#### 50. exec コマンドにカスタムプロンプト対応 (2026-02-13)
- **目的**: `exec, コミットしてプッシュして` のように、exec と同時に指示を渡せるようにする
- **問題**: プラン→exec→次のプロンプト、の3ステップが煩雑。特にコミット・プッシュのような単純な操作では非効率
- **解決策**: `e,` / `exec,` の後にカンマ＋テキストがあれば、そのテキストをカスタムプロンプトとして実行モードで直接実行
- **動作**:
  - `exec` → 従来通り「プランに従って実装を開始してください。」で自動実行
  - `exec, コミットしてプッシュして` → 実行モードで「コミットしてプッシュして」を直接実行
  - `e, テスト実行して` → 実行モードで「テスト実行して」を直接実行
- **実装フロー**:
  1. コマンドパーサーが `e,`/`exec,` パターンを検出 → `{ type: 'exec', prompt: '...' }` を返す
  2. `handleExec()` が `customPrompt` を `execConversation()` に渡す
  3. `ConversationExecPayload` に `prompt` フィールドを追加して Agent に送信
  4. Agent の `handleConversationExec()` でカスタムプロンプトがあればそれを使用
- **主要ファイル**:
  - `packages/shared/src/types.ts` - `ConversationExecPayload` と `UserCommand` に `prompt?` 追加
  - `apps/server/src/services/natural-language-parser.ts` - `isTraditionalCommand()` に `e,`/`exec,` パターン追加
  - `apps/server/src/services/command-parser.ts` - `parseCommand()` に `e,`/`exec,` パース処理追加
  - `apps/server/src/services/command-handler.ts` - `handleExec()` に `customPrompt` パラメータ追加
  - `apps/server/src/services/agent-manager.ts` - `execConversation()` に `prompt` パラメータ追加
  - `agents/linux/src/services/connection.ts` - `handleConversationExec()` でカスタムプロンプト対応
  - `agents/windows/src/services/connection.ts` - 同上

#### 51. Machines ページ テーブル形式化 + 名前順ソート (2026-02-13)
- **問題1**: カードグリッド形式で一覧性が悪い
- **問題2**: 5秒ポーリングのたびにAPIレスポンスの順序が変わり、マシンの並びがシャッフルされる
- **解決策**:
  1. デスクトップ: テーブル（明細一覧）形式に変更（Name, Status, Projects, Last Seen, 削除ボタン）
  2. モバイル: カード形式を維持（レスポンシブ対応）
  3. 名前順（`localeCompare` 昇順）でソート → ポーリングしても順番が安定
- **主要ファイル**:
  - `apps/web/src/pages/MachinesPage.tsx` - テーブル形式化、名前順ソート追加

#### 52. ヘルプテキスト更新 (2026-02-13)
- `h` コマンドのヘルプテキストを最新機能に合わせて更新
- **変更内容**:
  - `e` / `exec` の説明を改善、`e, <指示>` でプランスキップ＆直接実行の説明を追加
  - `x` コマンドに「2回連続で実行」の注記を追加
- **主要ファイル**:
  - `apps/server/src/services/command-parser.ts` - `getHelpText()` 関数を更新

#### 53. 出力ファイル履歴保存機能 (2026-02-15)
- `.devrelay-output/` のクリア前に、既存ファイルを `.devrelay-output-history/` にコピーして保存
- **目的**: 出力ファイルがプロンプト実行ごとにクリアされて消えてしまう問題を解決
- **動作**:
  1. 新しいプロンプト実行前に `clearOutputDir()` が呼ばれる
  2. `.devrelay-output/` 内にファイルがあれば `.devrelay-output-history/` にコピー
  3. ファイル名に日時プレフィックスを付与: `YYYYMMDD_HHmmss_filename`
  4. その後 `.devrelay-output/` を削除→再作成
- **例**:
  - `.devrelay-output/plan.md` → `.devrelay-output-history/20260215_120000_plan.md`
- **主要ファイル**:
  - `agents/linux/src/services/output-collector.ts` - `clearOutputDir()` 修正、`archiveOutputFiles()` 追加
  - `agents/windows/src/services/output-collector.ts` - 同上

#### 54. w コマンド（wrap up）(2026-02-15)
- `w` コマンドで CLAUDE.md/README.md 更新＋コミット＋プッシュをワンショットで実行
- **目的**: 作業完了時の定型操作（ドキュメント更新→コミット→プッシュ）を1文字で実行
- **動作**: `w` を送信すると内部的に `exec` コマンドとして以下のプロンプトを実行：
  - 「CLAUDE.mdとREADME.mdを今回の変更内容で更新してください。更新後、変更内容を簡潔にまとめたコミットメッセージでコミットしてプッシュしてください。」
- **主要ファイル**:
  - `packages/shared/src/constants.ts` - `SHORTCUTS` に `w` 追加
  - `apps/server/src/services/command-parser.ts` - `parseCommand()` に `w` 処理追加、`getHelpText()` 更新
  - `apps/server/src/services/natural-language-parser.ts` - `isTraditionalCommand()` に `w` 追加

#### 55. ドメイン移行・インフラ整備 (2026-02-19)
- `ribbon-re.jp` → `devrelay.io` へのドメイン移行
- Apache2 → Caddy へのリバースプロキシ移行
- SQLite → PostgreSQL へのDB移行
- PM2 でのプロセス管理に統一
- WebUI (`app.devrelay.io`) に `/api/*`, `/ws/*` のリバースプロキシ追加
- **変更ファイル**:
  - `agents/*/src/services/config.ts` - serverUrl を `wss://devrelay.io/ws/agent` に変更
  - `agents/*/src/cli/commands/setup.ts` - ダッシュボード URL 変更
  - `agents/windows/package.json` - appId を `io.devrelay.agent` に変更
  - `apps/web/src/lib/api.ts` - API_BASE を `/api`（相対パス）に変更
  - `apps/web/vite.config.ts` - allowedHosts 変更
  - `apps/server/.env.example` - PostgreSQL 接続文字列に変更
  - `apps/server/src/routes/api.ts` - サービス管理を PM2 コマンドに変更
  - `/etc/caddy/Caddyfile` - `app.devrelay.io` に API/WS プロキシ追加

#### 56. ランディングページ + README 英語化 (2026-02-19)
- `devrelay.io` にアクセスしたときにランディングページを表示
- **ランディングページ**: `apps/landing/index.html`
  - ダークテーマ、ASCII アート風タイトル（各文字が異なるアクセントカラー）
  - Hero + Architecture 図 + Features + Demo + CTA
  - 単一 HTML ファイル（外部依存なし）
- **Caddyfile 変更**: `devrelay.io` のルーティングを変更
  - `/api/*`, `/ws/*`, `/health` → `localhost:3005`（バックエンド）
  - それ以外 → `apps/landing/` の静的ファイル配信
- **README 英語化**:
  - `README.md` → 英語版に書き換え
  - `README_JA.md` → 日本語版として新規作成（旧 README.md の内容を移動）
  - 相互リンク付き（`README_JA.md` は ISO 639-1 言語コードに準拠）
  - systemd の記述を PM2 に更新
- **主要ファイル**:
  - `apps/landing/index.html` - 新規作成
  - `/etc/caddy/Caddyfile` - ルーティング変更（`.devrelay-output/Caddyfile` 経由で適用）
  - `README.md` - 英語版に書き換え
  - `README_JA.md` - 新規作成（日本語版）

#### 57. トークンにサーバーURL埋め込み (2026-02-19)
- **目的**: セルフホスト環境でトークンを貼るだけで正しいサーバーに自動接続
- **トークンフォーマット**:
  - 新形式: `drl_<serverUrl_base64url>_<random64hex>`
  - 旧形式: `machine_<random64hex>`（後方互換のためサポート継続）
- **動作**:
  1. WebUI でマシン追加時、サーバーの Host ヘッダーから WebSocket URL を構築
  2. URL を Base64URL エンコードしてトークンに埋め込み
  3. Agent の `devrelay setup` でトークン入力時に URL を自動抽出
  4. 旧形式トークンの場合はデフォルト URL（`wss://devrelay.io/ws/agent`）を使用
- **Base64URL**: 標準 Base64 の `+` → `-`, `/` → `_`, パディング `=` を除去
- **主要ファイル**:
  - `packages/shared/src/token.ts` - `encodeToken()`, `decodeTokenUrl()`, `isNewFormatToken()`, `isLegacyToken()`
  - `packages/shared/src/index.ts` - token.ts エクスポート追加
  - `apps/server/src/routes/api.ts` - トークン生成を新フォーマットに変更
  - `agents/linux/src/cli/commands/setup.ts` - トークンからURL自動抽出
  - `agents/windows/src/cli/commands/setup.ts` - 同上

#### 58. devrelay-claude シンボリックリンクのフォールバック (2026-02-19)
- **問題**: `devrelay setup` 後に Claude Code をインストールすると、シンボリックリンクが存在せず ENOENT エラー
- **解決**: `resolveClaudePath()` 関数で段階的に解決
  1. `~/.devrelay/bin/devrelay-claude` が存在すればそのまま使用
  2. 存在しなければ `which claude` でフォールバック
  3. 見つかったらシンボリックリンクも自動作成（次回以降は高速に）
  4. claude が見つからない場合は明確なエラーメッセージ
- **主要ファイル**:
  - `agents/linux/src/services/ai-runner.ts` - `resolveClaudePath()` 関数追加

#### 59. Heartbeat DB バッチ更新 + machineName デフォルト変更 (2026-02-21)
- **Heartbeat DB バッチ更新**:
  - Agent の ping ごとに DB 更新していたのを、メモリ内 Map で管理し 60 秒ごとにバッチ書き込みに変更
  - `lastSeenMap` で最終確認時刻を保持、heartbeat monitor のループでまとめて flush
  - DB 負荷を大幅に削減（100 Agent で 200 writes/min → 100 writes/min）
- **machineName デフォルト変更**:
  - `os.hostname()` → `${os.hostname()}/{os.userInfo().username}` に変更
  - 1 Agent = 1 User モデルに対応（同一マシン上の複数ユーザーを区別）
- **主要ファイル**:
  - `apps/server/src/services/agent-manager.ts` - `lastSeenMap`、`handleAgentPing()` バッチ化、`startHeartbeatMonitor()` flush 追加
  - `agents/linux/src/services/config.ts` - machineName デフォルト変更
  - `agents/linux/src/cli/commands/setup.ts` - machineName デフォルト変更
  - `agents/windows/src/services/config.ts` - machineName デフォルト変更

#### 60. Agent ワンライナーインストール (2026-02-21)
- `curl | bash` 形式のワンライナーで Agent をインストール可能に
- **スクリプト**: `scripts/install-agent.sh`
  - 引数: `--token`（必須）、`--server`（オプション）
  - 処理: 依存チェック → clone → pnpm install → build → config.yaml 生成 → systemd サービス登録・起動
- **WebUI**: トークンモーダルにワンライナー表示を追加
  - トークン埋め込み済みのコマンドをコピー可能
- **使い方**:
  ```bash
  curl -fsSL https://raw.githubusercontent.com/murata1215/devrelay/main/scripts/install-agent.sh | bash -s -- --token YOUR_TOKEN
  ```
- **主要ファイル**:
  - `scripts/install-agent.sh` - ワンライナーインストールスクリプト（新規）
  - `apps/web/src/pages/MachinesPage.tsx` - トークンモーダルにワンライナー表示追加

#### 61. Machine→Agent 表記変更 + machineName スラッシュ区切り (2026-02-21)
- **machineName フォーマット変更**:
  - `hostname-username` → `hostname/username` に変更
  - ホスト名にハイフンがよく使われるため（例: `ubuntu-dev`）、スラッシュ区切りで明確に区別
  - 例: `ubuntu-dev/pixblog`、`ubuntu-prod/pixdraft`
- **WebUI 表記変更**（表示ラベルのみ、DB・API・変数名は変更なし）:
  - ナビゲーション: `Machines` → `Agents`
  - MachinesPage: タイトル・ボタン・モーダル全て `Machine` → `Agent`
  - DashboardPage: 統計カード `Machines` → `Agents`
- **Discord/Telegram メッセージ**:
  - `マシン` → `エージェント`（ユーザー向けメッセージ）
  - `Machine:` → `Agent:`（ステータス表示）
  - ヘルプテキスト: `マシン一覧` → `エージェント一覧`
- **変更しないもの**: ファイル名、URL パス (`/machines`)、API パス、DB モデル名、TypeScript 型名、変数名
- **主要ファイル**:
  - `agents/linux/src/services/config.ts` - machineName スラッシュ区切り
  - `agents/linux/src/cli/commands/setup.ts` - 同上 + ヘルプテキスト更新
  - `agents/windows/src/services/config.ts` - 同上
  - `scripts/install-agent.sh` - 同上 + 表記更新
  - `apps/web/src/components/Layout.tsx` - ナビ「Agents」
  - `apps/web/src/pages/MachinesPage.tsx` - 全ラベル「Agent」
  - `apps/web/src/pages/DashboardPage.tsx` - 統計カード「Agents」
  - `apps/server/src/services/command-handler.ts` - 日本語メッセージ「エージェント」
  - `apps/server/src/services/command-parser.ts` - ヘルプテキスト「エージェント一覧」

#### 62. ワンライナーインストール改善 (2026-02-21)
- **install-agent.sh の複数改善**:
  - **serverUrl 自動抽出**: `drl_` 形式トークンから Base64URL デコードでサーバーURL を自動取得
  - **projectsDirs に `/opt` 追加**: デフォルトスキャン対象にホームディレクトリと `/opt` を含める
  - **systemd 失敗時の nohup 自動起動**: D-Bus 未対応環境でも Agent を自動でバックグラウンド起動
  - **crontab @reboot 自動登録**: systemd 不可環境で OS 再起動後も自動起動
  - **メッセージ改善**: 黄色警告を削除、「nohup + crontab で起動します」とポジティブ表示
- **agents/linux/src/services/config.ts**: デフォルト projectsDirs に `/opt` を追加
- **主要ファイル**:
  - `scripts/install-agent.sh` - ワンライナーインストーラー全般改善
  - `agents/linux/src/services/config.ts` - デフォルト projectsDirs 変更

#### 63. Agent 追加 UX 改善 - 名前入力スキップ + 自動命名 (2026-02-21)
- **目的**: Agent 追加時の名前入力ステップを省略し、Agent 接続時に自動で hostname/username を設定
- **新フロー**:
  1. WebUI で「+ Add Agent」クリック → 即座にトークン＋ワンライナー表示（名前入力なし）
  2. サーバーが仮名（`agent-1`, `agent-2`, ...）を自動生成して DB に登録
  3. ユーザーがワンライナーを実行して Agent をインストール
  4. Agent 接続時、DB の名前が仮名（`agent-` で始まる）なら Agent の `machineName`（hostname/username）で上書き
  5. 手動設定した名前は上書きしない（ユーザー設定を尊重）
- **仮名の自動生成**: 同一ユーザーの `agent-N` を検索し、最大 N+1 で連番採番
- **重複防止**: 同名の Agent が既にある場合は仮名を維持
- **主要ファイル**:
  - `apps/web/src/pages/MachinesPage.tsx` - 名前入力モーダル削除、即座にトークン表示
  - `apps/web/src/lib/api.ts` - `machines.create()` の name パラメータを任意に
  - `apps/server/src/routes/api.ts` - POST /api/machines に仮名自動生成を追加
  - `apps/server/src/services/agent-manager.ts` - `handleAgentConnect()` に仮名→正式名の自動更新を追加

#### 64. Agent 再起動後のセッション継続修正 (2026-02-21)
- **問題**: Agent を `pm2 restart` で再起動すると、Discord からのメッセージに応答が返らなくなる
- **根本原因（4つの問題）**:
  1. **Race Condition**: 旧 WebSocket の `close` イベントが新接続の後に遅延発火し、`clearSessionsForMachine()` で復元済みセッションを破壊
  2. **sessionInfoMap 消失**: Agent 再起動後、サーバーが `server:session:start` を送らず直接 `server:ai:prompt` を送るため、Agent 側で `sessionInfoMap` が空で処理不能
  3. **userId 不整合**: セッション再開始コードで `context.userId`（Discord プラットフォーム ID）を `createSession()` に渡しており、DB の `User.id`（CUID 形式）との外部キー制約違反
  4. **二重セッション作成**: 自動再接続（`handleProjectConnect`）後に `isAgentRestarted()` フラグがクリアされず、`handleAiPrompt()` で再度セッション作成
- **修正内容**:
  - `handleAgentDisconnect()`: 切断された WebSocket が現在の接続と同一か判定し、stale 接続の切断をスキップ
  - `handleAgentConnect()`: `needsSessionRestart` Set に machineId を記録
  - `handleAiPrompt()` / `handleExec()`: Agent 再接続フラグがある場合、新セッション作成 + `server:session:start` 再送してからプロンプト送信
  - `createSession()` に渡す userId を `oldSession.userId` に修正
  - `handleProjectConnect()` で `clearAgentRestarted()` を呼び二重作成を防止
- **主要ファイル**:
  - `apps/server/src/services/agent-manager.ts` - stale 接続判定、`needsSessionRestart` Set、`isAgentRestarted()` / `clearAgentRestarted()` API
  - `apps/server/src/services/command-handler.ts` - セッション再開始ロジック、userId 修正、フラグクリア

#### 65. ワンライナーインストーラー依存チェック改善 (2026-02-21)
- **問題**: 依存ツール不足時に1つ目で `exit 1` して止まるため、全ての不足を把握できない
- **改善内容**:
  - 全依存（Node.js 20+, git, pnpm）をまとめてチェックし、不足分を全て表示してから終了
  - 各ツールにインストール方法のワンライナーを案内
    - Node.js: `curl -fsSL https://fnm.vercel.app/install | bash && fnm install 20`
    - git: `sudo apt install git` または `sudo yum install git`
    - pnpm: `npm install -g pnpm`
  - pnpm の自動インストール（`npm install -g pnpm` / `corepack`）を廃止 → 事前チェックに変更
- **主要ファイル**:
  - `scripts/install-agent.sh` - Step 1 依存チェック全面改善、Step 3 自動インストール削除

#### 66. Windows CLI Agent - クロスプラットフォーム化 (2026-02-21)
- **目的**: Linux Agent (`agents/linux/`) を Windows でも動作するクロスプラットフォームコードベースに拡張
- **方針**: 新しいディレクトリを作らず、既存 `agents/linux/` に `process.platform === 'win32'` 分岐を追加
- **パッケージリネーム**: `@devrelay/agent-linux` → `@devrelay/agent`
- **主な変更**:
  - **config.ts**: Windows は `%APPDATA%\devrelay`、Linux は `~/.devrelay`。`getBinDir()` 追加
  - **ai-runner.ts**: `resolveClaudePath()` が Windows `.cmd` ラッパー / Linux シンボリックリンクを自動作成。`shell: true`（Windows）、PATH区切り `;`/`:` 分岐
  - **index.ts**: `ensureDevrelaySymlinks()` が Windows `.cmd` / Linux symlink を切り替え
  - **setup.ts**: Windows はタスクスケジューラ (`schtasks`)、Linux は systemd。`.cmd` バッチファイルラッパー作成
  - **uninstall.ts**: Windows はタスクスケジューラ削除 + `taskkill`、Linux は systemd 停止
  - **status.ts**: Windows は `schtasks /Query` + `tasklist`、Linux は `systemctl`
  - **logs.ts**: Windows は `PowerShell Get-Content -Tail -Wait`、Linux は `tail -f`
  - **cli/index.ts**: `config` コマンドが `getConfigDir()` 使用、Windows デフォルトエディタ `notepad`
- **PowerShell ワンライナーインストーラー**: `scripts/install-agent.ps1`
  - `$env:DEVRELAY_TOKEN="..."; irm https://raw.githubusercontent.com/.../install-agent.ps1 | iex`
  - 依存チェック（Node.js 20+, git, pnpm）、`%APPDATA%\devrelay\agent\` にクローン・ビルド
  - `drl_` トークンから Base64URL デコードでサーバーURL 自動抽出
  - タスクスケジューラ登録 + バックグラウンド起動
- **WebUI**: トークンモーダルに Linux / Windows タブ切り替え追加
  - Linux タブ: `curl | bash` ワンライナー
  - Windows タブ: PowerShell ワンライナー
- **主要ファイル**:
  - `agents/linux/src/services/config.ts` - OS 別パス、`getConfigDir()`, `getBinDir()`, `getDefaultProjectsDirs()`
  - `agents/linux/src/services/agent-state.ts` - `getConfigDir()` インポートに変更
  - `agents/linux/src/services/ai-runner.ts` - `resolveClaudePath()` クロスプラットフォーム化
  - `agents/linux/src/index.ts` - `ensureDevrelaySymlinks()` クロスプラットフォーム化
  - `agents/linux/src/cli/commands/setup.ts` - タスクスケジューラ対応
  - `agents/linux/src/cli/commands/uninstall.ts` - Windows クリーンアップ
  - `agents/linux/src/cli/commands/status.ts` - Windows ステータス確認
  - `agents/linux/src/cli/commands/logs.ts` - Windows ログ表示
  - `agents/linux/src/cli/index.ts` - `getConfigDir()` 使用
  - `agents/linux/package.json` - `@devrelay/agent-linux` → `@devrelay/agent`
  - `package.json`（ルート）- filter 名更新
  - `scripts/install-agent.sh` - filter 名更新
  - `scripts/install-agent.ps1` - 新規 PowerShell インストーラー
  - `apps/web/src/pages/MachinesPage.tsx` - OS タブ切り替え

#### 67. PowerShell インストーラー ExecutionPolicy 自動設定 + pnpm 自動インストール (2026-02-21)
- **問題**: Windows デフォルトの ExecutionPolicy `Restricted` では `npm.ps1`/`pnpm.ps1` 等の PowerShell ラッパースクリプトがブロックされる
  - `irm ... | iex` 自体は文字列評価なので動作するが、スクリプト内で呼ぶ `npm`/`pnpm` コマンドが失敗
- **解決策1: ExecutionPolicy 自動設定**:
  - インストーラー冒頭で `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser -Force` を自動実行
  - 現在のポリシーが `Restricted` または `Undefined` の場合のみ変更
  - `-Scope CurrentUser` なので管理者権限不要
  - `iex` 内から実行可能なので、ユーザーの手動操作は不要
- **解決策2: pnpm 自動インストール**:
  - pnpm が未インストールの場合、`cmd /c "npm install -g pnpm"` で自動インストール
  - `cmd /c` 経由で `npm.cmd` を直接呼ぶことで `.ps1` ラッパー問題も回避
  - Node.js がある場合のみ試行、失敗時は従来通りエラー表示
- **主要ファイル**:
  - `scripts/install-agent.ps1` - ExecutionPolicy 自動設定（冒頭）、pnpm 自動インストール（Step 1）

#### 68. Agent 設定モーダル + アンインストール用ワンライナー (2026-02-21)
- **目的**: Agent 作成直後しか表示されなかったトークンモーダルを、既存 Agent からも開けるようにする
- **Agent 設定モーダル**:
  - Agent 一覧でAgent 名をクリック → API でトークン取得 → 設定モーダル表示
  - Token 表示 + Copy
  - Quick Install（Linux/Windows タブ切り替え）+ Copy
  - Uninstall（`<details>` で折りたたみ、OS タブ連動）+ Copy
- **トークン取得 API**:
  - `GET /api/machines/:id/token` エンドポイント追加
  - ユーザーが所有するマシンのトークンのみ返す
- **アンインストールコマンド**:
  - Linux: `sudo systemctl stop devrelay-agent; ... rm -rf ~/.devrelay`
  - Windows: `Get-Process node ... | Stop-Process -Force; Remove-Item ... -Recurse -Force`
- **共通コンポーネント化**: `OsTabButtons`, `CommandBlock` を作成直後モーダルと設定モーダルで共有
- **主要ファイル**:
  - `apps/server/src/routes/api.ts` - `GET /api/machines/:id/token` エンドポイント
  - `apps/web/src/lib/api.ts` - `machines.getToken()` メソッド追加
  - `apps/web/src/pages/MachinesPage.tsx` - Agent 設定モーダル、アンインストールコマンド、共通コンポーネント

#### 69. ワンライナーインストーラー プロキシ対応 (2026-02-21)
- **目的**: プロキシ環境でもワンライナーだけで Agent セットアップを完了できるようにする
- **対話プロンプト方式**: インストール途中で「プロキシを使用しますか？」と聞き、必要なら URL を入力させる
- **Linux (`scripts/install-agent.sh`)**:
  - `--proxy URL` 引数追加（指定済みならプロンプトスキップ）
  - 依存チェック後に対話プロンプト: `read ... < /dev/tty` で `curl | bash` でも入力可能
  - config.yaml の新規作成・既存更新の両方で `proxy:` セクション対応
  - 完了メッセージにプロキシ URL 表示
- **Windows (`scripts/install-agent.ps1`)**:
  - `$env:DEVRELAY_PROXY` 環境変数で事前指定可能（指定済みならプロンプトスキップ）
  - 依存チェック後に `Read-Host` で対話プロンプト（`irm | iex` 中でもコンソールから読み取れる）
  - config.yaml の新規作成・既存更新の両方で `proxy:` セクション対応
  - 完了メッセージにプロキシ URL 表示、`$env:DEVRELAY_PROXY` クリーンアップ
- **プロキシ環境変数の自動設定**:
  - プロキシ URL 入力後、`HTTP_PROXY` / `HTTPS_PROXY` 環境変数を自動セット
  - `git clone`, `pnpm install`, Electron バイナリダウンロード等が全てプロキシ経由に
  - 問題: config.yaml にのみ書き込み、環境変数未設定だと `pnpm install` がプロキシを通さず ECONNRESET で失敗していた
- **pnpm 自動インストール後の PATH リフレッシュ**:
  - `npm install -g pnpm` 成功後に `$env:Path` をレジストリから再読み込み
  - 問題: PowerShell が PATH をキャッシュするため、インストール直後の `Get-Command pnpm` が失敗していた
- **WebUI (`apps/web/src/pages/MachinesPage.tsx`)**:
  - 作成直後モーダル・設定モーダルのヒントテキストにプロキシ対応の案内追加
- **使用例**:
  ```bash
  # Linux: 対話的（インストール中にプロンプトが表示される）
  curl -fsSL ... | bash -s -- --token YOUR_TOKEN

  # Linux: 非対話（CI/CD 向け、プロンプトスキップ）
  curl -fsSL ... | bash -s -- --token YOUR_TOKEN --proxy http://proxy:8080

  # Windows: 対話的
  $env:DEVRELAY_TOKEN="YOUR_TOKEN"; irm ... | iex

  # Windows: 非対話
  $env:DEVRELAY_TOKEN="YOUR_TOKEN"; $env:DEVRELAY_PROXY="http://proxy:8080"; irm ... | iex
  ```
- **`--ignore-scripts` によるビルド改善**:
  - `pnpm install` に `--ignore-scripts` フラグを追加（Linux / Windows 共通）
  - Electron postinstall（GitHub からバイナリダウンロード）をスキップ
  - CLI Agent は Electron を一切使わないため、postinstall スキップによる影響なし
  - 企業ネットワークでの `ECONNRESET` → `ELIFECYCLE` → `tsc` 不在の連鎖障害を回避
- **再インストール時の既存プロセス自動停止**:
  - インストーラーの Step 6（Agent 起動）で、既存の Agent プロセスを自動停止してから新プロセスを起動
  - Windows: `Get-Process node | Where-Object { $_.CommandLine -like '*devrelay*' } | Stop-Process`
  - Linux（nohup パス）: `pgrep -f "node.*devrelay.*index.js"` → `kill`
  - systemd パスは `systemctl --user restart` で元々対応済み
- **主要ファイル**:
  - `scripts/install-agent.sh` - `--proxy` 引数パース、対話プロンプト、config.yaml プロキシ書き込み、`--ignore-scripts`、既存プロセス停止
  - `scripts/install-agent.ps1` - `$env:DEVRELAY_PROXY` 読み取り、対話プロンプト、config.yaml プロキシ書き込み、`--ignore-scripts`、既存プロセス停止
  - `apps/web/src/pages/MachinesPage.tsx` - プロキシヒントテキスト追加

#### 70. Linux インストーラー Node.js + pnpm 自動インストール (2026-02-21)
- **目的**: Node.js 未インストールの Linux マシンでもワンライナーだけで Agent セットアップを完了できるようにする
- **問題**: 従来は「fnm でインストールしてください」と案内して終了していたが、fnm 自体が `unzip` を要求し、最小構成 Linux には `unzip` もないためインストールに辿り着けない
- **解決策: Node.js 公式バイナリ直接ダウンロード**:
  - `~/.devrelay/node/` に Node.js 20 LTS（v20.20.0）バイナリを展開
  - アーキテクチャ自動検出: `uname -m` → x64 / arm64 / armv7l
  - `curl` + `tar` のみ使用（`sudo` 不要、`unzip` 不要）
  - PATH の先頭に `~/.devrelay/node/bin` を追加
- **pnpm 自動インストール**: `npm install -g pnpm`（npm は Node.js に同梱）
- **git のみハード依存**: git だけは従来通り必須前提条件として残す
- **依存チェックフローの変更**:
  - 変更前: Node.js なし → エラー表示 → 終了、pnpm なし → エラー表示 → 終了
  - 変更後: Node.js なし → 自動ダウンロード → 続行、pnpm なし → `npm install -g pnpm` → 続行
- **主要ファイル**:
  - `scripts/install-agent.sh` - Step 1 の依存チェックを自動インストールに全面改修

#### 71. AI実行エラーのハンドリング改善 (2026-02-21)
- **問題**: Claude Code 未インストールの Agent にプロンプトを送ると、`resolveClaudePath()` の例外がキャッチされず Node.js プロセスがクラッシュ → Agent が OFFLINE になる
- **解決策1: try/catch 追加**:
  - `handleAiPrompt()` 内の `sendPromptToAi()` + リトライ処理全体を `try/catch` で囲む
  - `catch` ブロックでエラーメッセージを `agent:ai:output`（`isComplete: true`）で Discord/Telegram に送信
  - Agent プロセスはクラッシュせず ONLINE のまま維持される
- **解決策2: エラーメッセージ更新**:
  - `resolveClaudePath()` のインストール案内を `npm install -g @anthropic-ai/claude-code` → `curl -fsSL https://claude.ai/install.sh | bash` に変更（公式ワンライナー）
- **表示例**（Discord/Telegram）:
  ```
  ❌ エラー: Claude Code が見つかりません。以下を確認してください:
    1. Claude Code をインストール: curl -fsSL https://claude.ai/install.sh | bash
    2. インストール後、Agent を再起動してください
  ```
- **主要ファイル**:
  - `agents/linux/src/services/connection.ts` - `handleAiPrompt()` に try/catch 追加
  - `agents/linux/src/services/ai-runner.ts` - `resolveClaudePath()` エラーメッセージ変更
- **インストーラー追加修正**:
  - **nohup stdin fix**: `curl|bash` で nohup 起動時に `< /dev/null` を追加（バックグラウンドプロセスが stdin を消費してスクリプト後半が実行されない問題を修正）
  - **pgrep パターン修正**: `node.*devrelay.*index.js` → `\.devrelay.*index\.js` に変更（`~/.devrelay/node/bin/node agents/linux/dist/index.js` のように node パスに devrelay が含まれる場合にマッチしなかった問題を修正）
  - **kill || true**: `set -e` 環境下で kill 失敗時にスクリプトが停止しないように `|| true` を追加
- **主要ファイル（追加修正）**:
  - `scripts/install-agent.sh` - nohup stdin fix、pgrep パターン修正、kill || true

## 今後の課題

- [ ] LINE 対応
- [ ] Gemini CLI / Codex / Aider 対応
- [x] Windows Agent (2026-01-18 実装完了)
- [x] Windows CLI Agent + PowerShell ワンライナー (2026-02-21 実装完了)
- [ ] 要約機能（Anthropic API 使用）
- [ ] 複数ユーザー同時接続
- [ ] 進捗表示のUI改善（プログレスバーなど）
- [ ] エラーハンドリング強化
- [ ] WebUI（ユーザー設定画面）
- [x] WebUI 本番対応: Caddy + 静的ファイル配信
- [x] ランディングページ (devrelay.io)
