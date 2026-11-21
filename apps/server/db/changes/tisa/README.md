# apps/server/db/changes/tisa/ — TISA 系列（会社リポジトリ独自）の DB 変更

本家（murata1215/devrelay）の DB 変更は親フォルダ `apps/server/db/changes/` に `NNNN_*.sql`（4 桁連番）で置かれる。
会社リポジトリ独自の DB 変更は、本家の連番を使わずにこのフォルダに **`TISA<4桁>_snake_case.sql`** で置く。

- 本家と連番を共有すると、本家が同じ番号を採ったときにマージで衝突するため
- 台帳 "DbChange" の主キーはファイル名なので、`TISA0001_…` と本家の `0001_…` は同じ台帳に並べて記録できる
- `pnpm --filter @devrelay/server db:status`・起動時警告・`/health` は、本家の索引と `tisa/INDEX.tsv` の両方を見る
  （`src/services/db-change-tisa.ts`）

## 新しく作るとき

1. `schema.prisma` を変更する
2. `TISA<次の番号>_xxx.sql` を作る。中身は本家と同じ形式（親フォルダの `README.md`「各 SQL ファイルの共通フォーマット」）。
   ヘッダの 1 行目だけ `-- TISA0003 / YYYY-MM-DD / commit -` にし、適用コマンドは `apps/server/db/changes/tisa/…` を書く。
   末尾の台帳記録は `VALUES ('TISA0003_xxx.sql', 3, current_user)`
3. このフォルダの `INDEX.tsv` に 1 行足す（no 列は 4 桁の数字だけ。`TISA` は付けない）
4. 親フォルダの `SCHEMA.sha256` は **1 列目（指紋）だけ** 更新する。2 列目は本家の最大番号のファイル名のまま
   （本家のテストがそう決めている）:
   ```bash
   sha256sum apps/server/prisma/schema.prisma | cut -c1-16
   ```
5. 上記をすべて同じコミットに入れ、`cd apps/server && node --test tests/db-changes.test.mjs tests/db-changes-tisa.test.mjs` が通ることを確認する

詳細は `doc/db-changes-tisa.md`。
