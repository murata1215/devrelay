<!-- DevRelay Agreement v4 -->
See `rules/devrelay.md` for DevRelay rules.
<!-- /DevRelay Agreement -->

---

# DevRelay

Discord/Telegram/LINE から Claude Code/Gemini CLI をリモート操作するハブシステム。

## ルール参照
- `rules/devrelay.md` - DevRelay 共通ルール（Agreement）
- `rules/project.md` - プロジェクト固有の設計判断

## 技術スタック

| レイヤー | 技術 |
|---------|------|
| Monorepo | pnpm workspaces |
| Server | Fastify + WebSocket + Prisma |
| DB | PostgreSQL |
| Agent | Node.js CLI (Linux + Windows) |
| WebUI | Vite + React |
| Proxy | Caddy |
| Process | PM2 |

## ビルド & デプロイ

```bash
pnpm build
# 再起動はユーザーが実行:
pm2 restart devrelay-server devrelay-agent
```

## DevRelay 自身の開発時の注意
- ビルド（pnpm build）は実行OK
- サービスの再起動は実行しない
- 「ビルド完了。以下のコマンドで再起動してください」と案内する

## 環境変数（apps/server/.env）

| 変数 | 説明 |
|------|------|
| DATABASE_URL | PostgreSQL 接続 |
| DISCORD_BOT_TOKEN | Discord Bot |
| TELEGRAM_BOT_TOKEN | Telegram Bot |
| ENCRYPTION_KEY | API キー暗号化 |

## DB テーブル（概要）

| テーブル | 用途 |
|---------|------|
| User | ユーザー |
| Machine | Agent マシン（deletedAt でソフトデリート） |
| Project | プロジェクト |
| Session | 作業セッション |
| Message | 会話メッセージ |
| BuildLog | ビルド履歴 |
| MessageFile | メッセージ添付ファイル（bytea BLOB） |
| UserSettings | ユーザー設定（API キー等） |
| ChannelSession | チャンネルごとのセッション |
| PlatformLink | プラットフォーム連携 |

## 詳細ドキュメント
- 変更履歴: `doc/changelog.md`
- 設計・アーキテクチャ: `rules/project.md`
- マイグレーションガイド: `doc/devrelay-claudemd-migration.md`
