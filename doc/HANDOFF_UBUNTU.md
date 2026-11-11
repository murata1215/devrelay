# 🐧 Ubuntu部隊 引き継ぎ指示書

## 📋 概要

DevRelayプロジェクトのサーバー＋Linux Agent部分の開発・テスト・デプロイを担当。
ソースコードは80%完成済み。残りは依存関係インストール、動作テスト、本番デプロイ。

---

## 🎯 担当範囲

1. **中央サーバー** (`apps/server/`)
2. **Linux Agent** (`agents/linux/`)
3. **共通パッケージ** (`packages/shared/`)
4. **インストーラ** (`scripts/install.sh`)

---

## 📦 セットアップ手順

### 1. リポジトリ取得

```bash
# ソースコードを展開（tar.gzから）
tar -xzvf devrelay-src.tar.gz
cd devrelay

# または新規作成の場合
mkdir devrelay && cd devrelay
# 各ファイルを配置
```

### 2. 依存関係インストール

```bash
# pnpmインストール（なければ）
npm install -g pnpm

# 依存関係インストール
pnpm install
```

### 3. 環境設定

```bash
# サーバー設定
cd apps/server
cp .env.example .env

# .envを編集
# - DISCORD_BOT_TOKEN: Discord Developer Portalで取得
# - DATABASE_URL: PostgreSQL接続文字列を設定
```

### 4. データベース初期化

新規 DB の構築のみ（稼働中の DB には流さないこと。`db:push` は pgvector の `embedding` 列を
DROP するため package.json から削除済み）:

```bash
cd apps/server
pnpm db:bootstrap:new-db-only
```

既存 DB への追加の DB 変更は `apps/server/db/changes/` を参照（`pnpm --filter @devrelay/server db:status`
で未適用を確認。詳細: `doc/db-changes.md`）。

### 5. 開発サーバー起動

```bash
# ターミナル1: サーバー
pnpm dev:server

# ターミナル2: Agent（テスト用）
cd agents/linux
pnpm dev
```

---

## 🔧 必要な作業

### 必須タスク

#### 1. Discord Bot作成・設定
```
1. https://discord.com/developers/applications にアクセス
2. New Application → 名前: DevRelay
3. Bot → Add Bot → Token取得
4. OAuth2 → URL Generator
   - Scopes: bot
   - Bot Permissions: Send Messages, Read Message History
5. 生成されたURLでBotをサーバーに招待
6. .envにトークン設定
```

#### 2. 動作テスト
```bash
# サーバー起動
pnpm dev:server

# Discord DMでBotにメッセージ送信
# "h" → ヘルプが返ってくればOK
# "m" → マシン一覧（最初は空）
```

#### 3. Agent接続テスト
```bash
# Agent設定
cd agents/linux
# ~/.devrelay/config.yaml を編集
# - serverUrl: ws://localhost:3000/ws/agent
# - token: （サーバーDBで生成したトークン）

# Agent起動
pnpm dev

# Discord で "m" → 接続したマシンが表示されればOK
```

#### 4. install.shテスト
```bash
# 別のUbuntuマシンで
curl -fsSL https://your-server/install.sh | bash
```

### 追加タスク（余裕があれば）

- [ ] Telegram Bot実装 (`apps/server/src/platforms/telegram.ts`)
- [ ] エラーハンドリング強化
- [ ] ログ出力改善
- [ ] systemdサービス動作確認
- [ ] VPSデプロイ（本番環境）

---

## 📁 重要ファイル

| ファイル | 説明 |
|---------|------|
| `apps/server/src/index.ts` | サーバーエントリポイント |
| `apps/server/src/platforms/discord.ts` | Discord Bot |
| `apps/server/src/services/agent-manager.ts` | Agent接続管理 |
| `apps/server/src/services/command-handler.ts` | コマンド実行 |
| `apps/server/prisma/schema.prisma` | DBスキーマ |
| `agents/linux/src/index.ts` | Agentエントリポイント |
| `agents/linux/src/services/connection.ts` | サーバー接続 |
| `agents/linux/src/services/ai-runner.ts` | AI CLI実行 |
| `packages/shared/src/types.ts` | 共通型定義 |

---

## 🧪 テストシナリオ

### シナリオ1: 基本フロー
```
1. サーバー起動
2. Agent起動（プロジェクト登録済み）
3. DiscordでBot宛にDM
4. "m" → マシン一覧表示
5. "1" → マシン選択
6. "p" → プロジェクト一覧
7. "1" → プロジェクト選択、Claude Code起動
8. "hello" → Claude Codeにプロンプト送信
9. 応答がDiscordに返る
10. "q" → 切断
```

### シナリオ2: 再接続
```
1. Agentを停止・再起動
2. サーバーで自動再接続を確認
3. Discordで "m" → オンライン状態を確認
```

---

## 🐛 想定される問題と対処

### WebSocket接続エラー
```
原因: ファイアウォール、URL間違い
対処: 
- serverUrlを確認（ws:// or wss://）
- ポート開放確認
- サーバーログ確認
```

### Discord Botが反応しない
```
原因: トークン間違い、権限不足
対処:
- トークン再確認
- Bot権限確認（Send Messages, Read Message History）
- IntentsにMessageContentが含まれているか
```

### Prismaエラー
```
原因: スキーマ変更後の DB 変更が未適用（`column ... does not exist` 等）
対処: `pnpm --filter @devrelay/server db:status` で未適用の変更を確認し、
      `apps/server/db/changes/` の該当 SQL を番号順に psql で適用する
      （`prisma db push` は稼働中 DB の embedding 列を削除するため使用しないこと）
```

---

## 📞 連絡事項

- Windows Agent部隊との連携ポイント: `packages/shared/` の型定義
- 型を変更する場合は両部隊で同期が必要
- WebSocketプロトコルの変更は要相談

---

## 📝 完了報告時に含めてほしい情報

1. 動作確認結果（スクリーンショット等）
2. 発見した問題・修正内容
3. 追加実装した機能
4. 本番デプロイ状況
5. 残タスク一覧
