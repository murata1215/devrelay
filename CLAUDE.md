<!-- DevRelay Agreement v6 -->
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
- **ソースコード（.ts ファイル等）を変更して `pnpm build` を実際に実行した場合のみ**「ビルド完了。以下のコマンドで再起動してください」と案内する
- ドキュメント（.md）のみの変更ではビルド・再起動案内は不要

## DB スキーマ変更時の必須手順
1. `schema.prisma` を変更
2. `cd apps/server && npx prisma migrate dev` を試行 → 失敗時は `npx prisma db execute --stdin` で直接 SQL 適用
3. **カラム存在を SQL で検証**: `npx prisma db execute --stdin <<< "SELECT column_name FROM information_schema.columns WHERE table_name='テーブル名' AND column_name='カラム名';"`
4. `npx prisma generate` で Prisma Client 再生成
5. `pnpm build` でビルド
6. 再起動案内時に「DB マイグレーション適用済み」を明記する

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
| Project | プロジェクト（displayName でリネーム可能） |
| Session | 作業セッション |
| Message | 会話メッセージ |
| BuildLog | ビルド履歴 |
| MessageFile | メッセージ添付ファイル（bytea BLOB + pgvector embedding） |
| UserSettings | ユーザー設定（API キー等） |
| ChannelSession | チャンネルごとのセッション |
| PlatformLink | プラットフォーム連携 |
| Team | 名前付きチーム（クロスプロジェクトクエリ用グループ） |
| TeamMember | チーム内プロジェクト（Team → Project 参照） |
| ToolApproval | ツール承認履歴（exec モードの canUseTool 記録） |

## 詳細ドキュメント
- 変更履歴: `doc/changelog.md`
- 設計・アーキテクチャ: `rules/project.md`
- マイグレーションガイド: `doc/devrelay-claudemd-migration.md`
