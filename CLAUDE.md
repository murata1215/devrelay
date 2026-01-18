# DevRelay 開発記録

> **重要**: 機能追加・変更を行ったら、必ずこのファイルを更新すること。
> セッションが落ちても作業内容を引き継げるようにする。

---

## Claude Code への指示

【重要】ユーザーに渡すファイルを作成する場合は、必ず `.devrelay-output/` ディレクトリに保存してください。このディレクトリに置かれたファイルは自動的にユーザーに送信されます。

【プランモード】
現在はプランモードです。コードの書き換えや新規ファイルの作成は行わず、以下のみを行ってください：
- 調査・分析
- 実装プランの立案
- 質問や確認

プランが完成したら、最後に必ず以下のように伝えてください：
「このプランでよければ `e` または `exec` を送信してください。実装を開始します。」

ユーザーが `exec` を送信するまで、コードの変更は行わないでください。

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
  - `lastProjectId` を DB（PlatformLink テーブル）に保存
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
- `lastProjectId`（`c` コマンド用）はユーザーごとに DB 保存（従来通り）

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
│   └── windows/         # Windows Agent (開発中)
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

#### Agent
- `agents/linux/src/services/connection.ts` - サーバー接続・メッセージ処理
- `agents/linux/src/services/ai-runner.ts` - Claude Code 実行
- `agents/linux/src/services/output-collector.ts` - 出力ファイル収集
- `agents/linux/src/services/file-handler.ts` - 受信ファイル保存
- `agents/linux/src/services/conversation-store.ts` - 会話履歴の永続化

#### Shared
- `packages/shared/src/types.ts` - 共通型定義（FileAttachment など）

## 設定ファイル

### Agent 設定 (`~/.devrelay/config.yaml`)
```yaml
machineName: ubuntu-dev
machineId: ""
serverUrl: ws://localhost:3000/ws/agent
token: machine_xxxxx
projectsDirs:      # 複数ディレクトリ対応
  - /home/user
  - /var/www
aiTools:
  default: claude
  claude:
    command: claude
logLevel: debug
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

# Agent
cd agents/linux && pnpm start
```

### 本番（サービス起動）
```bash
# Server
cd apps/server && pnpm setup:service   # 初回のみ
systemctl --user start devrelay-server

# WebUI（開発サーバー）
cd apps/web && pnpm setup:service   # 初回のみ
systemctl --user start devrelay-web

# Agent
cd agents/linux && node dist/cli/index.js setup  # 初回のみ（サービス化を選択）
systemctl --user start devrelay-agent

# 管理コマンド
systemctl --user status devrelay-server devrelay-web devrelay-agent
systemctl --user restart devrelay-server devrelay-web devrelay-agent
journalctl --user -u devrelay-server -f
journalctl --user -u devrelay-web -f
journalctl --user -u devrelay-agent -f
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
- `ws://localhost:3000/ws/agent` → `wss://ribbon-re.jp/devrelay-api/ws/agent`
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
- **注意**: 本番では nginx + 静的ファイル配信を推奨

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

## 今後の課題

- [ ] LINE 対応
- [ ] Gemini CLI / Codex / Aider 対応
- [ ] Windows Agent
- [ ] 要約機能（Anthropic API 使用）
- [ ] 複数ユーザー同時接続
- [ ] 進捗表示のUI改善（プログレスバーなど）
- [ ] エラーハンドリング強化
- [ ] WebUI（ユーザー設定画面）
- [ ] WebUI 本番対応: nginx + 静的ファイル配信（`pnpm build` → nginx で配信）
