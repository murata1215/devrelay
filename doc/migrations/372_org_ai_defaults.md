# #372 マイグレーション: 組織 AI デフォルト設定用カラムの追加

`schema.prisma` の `model Organization` に `aiModelDefaults String?`、
`model OrganizationMember` に `canOverrideAiSettings Boolean @default(false)` を追加した
（組織ごとの AI モデル既定値 + メンバー個別のロック解除フラグ）。`prisma migrate dev` は使わず、
以下を人間が手動で適用する（このマシンでは 2026-09-07 に `npx prisma db execute --stdin` 経由で適用済み）。

## 適用手順

```bash
# 罠: .env の DATABASE_URL にはパスワードに `$@` が含まれるため、
# `source .env` 経由だとシェル展開で壊れる。必ずシングルクォートのリテラルで export すること。
export DATABASE_URL='postgresql://devrelay_user:devrelay_user$@localhost:5432/devrelay'

psql "$DATABASE_URL" -c 'ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "aiModelDefaults" TEXT;'
psql "$DATABASE_URL" -c 'ALTER TABLE "OrganizationMember" ADD COLUMN IF NOT EXISTS "canOverrideAiSettings" BOOLEAN NOT NULL DEFAULT false;'

# 列が実際に追加されたことを確認
psql "$DATABASE_URL" -c "SELECT column_name FROM information_schema.columns WHERE table_name='Organization' AND column_name='aiModelDefaults';"
psql "$DATABASE_URL" -c "SELECT column_name FROM information_schema.columns WHERE table_name='OrganizationMember' AND column_name='canOverrideAiSettings';"
```

期待される出力: それぞれ1行ずつ返る。

## 適用後

`npx prisma generate` を実行し Prisma Client を再生成した上で `pnpm build` する。
DDL 適用済みのため、再起動案内時は「DB マイグレーション適用済み」を明記すること。
`pm2 restart devrelay-server` で反映される（コード側の再ビルドは `pnpm build` 実行済みなら不要）。
