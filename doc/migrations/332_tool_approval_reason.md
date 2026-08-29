# #332 マイグレーション: ToolApproval.reason 列の追加

`schema.prisma` の `model ToolApproval` に `reason String?` を追加した（plan strictReadonly で
deny された理由等を記録するための監査列）。`prisma migrate dev` は使わず、以下を人間が手動で適用する。

## 適用手順

```bash
# 罠: .env の DATABASE_URL にはパスワードに `$@` が含まれるため、
# `source .env` 経由だとシェル展開で壊れる。必ずシングルクォートのリテラルで export すること。
export DATABASE_URL='postgresql://devrelay_user:devrelay_user$@localhost:5432/devrelay'

psql "$DATABASE_URL" -c 'ALTER TABLE "ToolApproval" ADD COLUMN IF NOT EXISTS "reason" TEXT;'

# 列が実際に追加されたことを確認
psql "$DATABASE_URL" -c "SELECT column_name FROM information_schema.columns WHERE table_name='ToolApproval' AND column_name='reason';"
```

期待される出力: `reason` が1行返る。

## 適用後

サーバー側は `npx prisma generate` 済みでビルドも通っているため、DDL 適用後は
`pm2 restart devrelay-server` のみで反映される（コード側の再ビルドは不要）。
