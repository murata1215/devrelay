# Usage（コスト集計）サイクル マイグレーション

`schema.prisma` に以下を追加した（すべて nullable の列と新規テーブル。既存行は NULL のまま＝
「タグなし」「案件なし」「サイネージ無効」として扱われるため、バックフィルは不要）。

- `Organization.usageSignageToken String? @unique` — ログイン不要のサイネージ URL の鍵（null = 無効）
- `Session.usageCase String?` — スレッドの案件名（コスト集計専用。ナレッジの `compartment` とは別物で閲覧制限に使わない）
- 新規テーブル `UserUsageGroup`（人のグループ。`userId` unique、FK なし。行が無ければタグなし）

## 適用手順（Windows / このマシン）

```powershell
cd apps/server
@'
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "usageSignageToken" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Organization_usageSignageToken_key" ON "Organization"("usageSignageToken");
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "usageCase" TEXT;
CREATE TABLE IF NOT EXISTS "UserUsageGroup" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "groupName" TEXT NOT NULL,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "UserUsageGroup_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "UserUsageGroup_userId_key" ON "UserUsageGroup"("userId");
'@ | npx prisma db execute --stdin --schema prisma/schema.prisma
```

Linux（psql）でも同じ SQL をそのまま流せばよい。

## 確認

```sql
SELECT table_name, column_name FROM information_schema.columns
WHERE (table_name='Organization' AND column_name='usageSignageToken')
   OR (table_name='Session' AND column_name='usageCase')
   OR (table_name='UserUsageGroup')
ORDER BY 1,2;
```

期待: Organization.usageSignageToken / Session.usageCase / UserUsageGroup の 6 列。

## 適用後

`npx prisma generate` → `pnpm build`。新規 DB は `pnpm db:bootstrap`（`prisma db push`）で同じ形になる。
