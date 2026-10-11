# 高辻ナレッジ サイクル2 マイグレーション: 数値権限（0〜10）＋ 案件の壁（compartment）

`schema.prisma` に以下を追加した（すべて nullable / 既定値なしの列。既存行は NULL のまま残るため、
`prisma migrate dev` / `prisma db push` を使わずとも既存挙動には一切影響しない。D2/D3/D4）。

- `Session.level              Int?`    — この会話個別の機密度（0〜10）。null = Project の既定値を継承
- `Session.compartment        String?` — 案件名（正規化済み・完全一致）。null = Project の既定値を継承
- `Project.defaultLevel       Int?`    — この案件で始まる会話の既定値。null = level 0
- `Project.defaultCompartment String?` — 同上。null = 壁なし
- 新規テーブル `UserClearance`（人の権限。行が無ければ readLevel=0 / writeLevel=0 / compartments=[]）

`UserClearance.compartments` は本スキーマ初出の Postgres `text[]`（スカラーリスト）列。
Prisma の仕様で **`NOT NULL` が付かない**（`DEFAULT ARRAY[]::TEXT[]` のみ）ため、
手書き DDL でも `NOT NULL` を付けないこと（`prisma db push` が作る形と一致させる。
`prisma migrate diff --from-empty --to-schema-datamodel` で実測して確認済み）。

## 適用手順

```bash
# 罠: .env の DATABASE_URL にはパスワードに `$@` が含まれるため、
# `source .env` 経由だとシェル展開で壊れる。必ずシングルクォートのリテラルで export すること。
export DATABASE_URL='postgresql://devrelay_user:devrelay_user$@localhost:5432/devrelay'

psql "$DATABASE_URL" -c 'ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "level" INTEGER;'
psql "$DATABASE_URL" -c 'ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "compartment" TEXT;'
psql "$DATABASE_URL" -c 'ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "defaultLevel" INTEGER;'
psql "$DATABASE_URL" -c 'ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "defaultCompartment" TEXT;'
psql "$DATABASE_URL" <<'SQL'
CREATE TABLE IF NOT EXISTS "UserClearance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "readLevel" INTEGER NOT NULL DEFAULT 0,
    "writeLevel" INTEGER NOT NULL DEFAULT 0,
    "compartments" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "UserClearance_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "UserClearance_userId_key" ON "UserClearance"("userId");
SQL

# 列 4 本・テーブル・unique index の存在を確認
psql "$DATABASE_URL" -c "SELECT table_name, column_name FROM information_schema.columns WHERE (table_name='Session' AND column_name IN ('level','compartment')) OR (table_name='Project' AND column_name IN ('defaultLevel','defaultCompartment')) ORDER BY 1,2;"
psql "$DATABASE_URL" -c '\d "UserClearance"'
```

期待される出力: `information_schema` クエリが 4 行（Project.defaultCompartment / Project.defaultLevel /
Session.compartment / Session.level）、`\d "UserClearance"` が 8 列 + 2 インデックス
（`UserClearance_pkey` PRIMARY KEY、`UserClearance_userId_key` UNIQUE）。

## 適用後

`npx prisma generate` を実行し Prisma Client を再生成した上で `pnpm build` する。
DDL 適用済みのため、再起動案内時は「DB マイグレーション適用済み」を明記すること。
`bootstrap.sql` は pgvector 専用のため**変更不要**（新列・新テーブルは Prisma 管理＝社内新規 DB は
`pnpm db:bootstrap`（内部で `prisma db push`）だけで同じ形になる。実測で DDL 一致を確認済み）。

バックフィルは不要（既存行は全部 null = level 0・壁なしとして扱われる。D2/D3/D4 の「null 継承」の定義そのもの）。

## 反映手順（このサイクル全体、順序厳守）

1. `git pull`（このサイクルの commit を取得）
2. 上記 ALTER 4 本 + CREATE TABLE/INDEX を適用
3. カラム存在を SQL で検証（上記 SELECT で 4 行、`\d` で 8 列確認）
4. `pnpm build`
5. `pm2 restart devrelay-server`
6. Agent 側の変更は 0 行のため `u` は不要

## 互換性

- 旧サーバー × 新スキーマ（本手順のみ先行適用した場合）: 新列・新テーブルは誰も参照しないため無害
- 新サーバー × DDL 未適用: `UserClearance` / `Session.level` 等を参照するクエリが
  `column does not exist` で 500 になる（DDL 適用が build 反映より**先**であることが必須）
- agents / apps/web / packages/shared は本サイクルで 0 行変更（互換性の懸念なし）
- 既存の `search_knowledge`（追加パラメータなし）は自分の会話についてサイクル1 と同じ順位で返る
  （可視判定述語は「自分の会話」を常に含むため、既存の単一ユーザー条件と集合として一致する）
