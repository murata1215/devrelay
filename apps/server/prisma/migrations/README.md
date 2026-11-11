# このフォルダは凍結済み（サイクルM1、2026-11-12）

ここは Prisma が生成した 20 件の履歴です。`prisma migrate dev` / `migrate deploy` は使わない運用
（DB スキーマ変更は人間が `psql` で手動適用）のため、**以後の DB 変更はここに新規ディレクトリを
作らず `../../db/changes/`（`apps/server/db/changes/`）に置いてください**。

- 既存 20 件は削除・改変しない（履歴として残す）
- 直近3件（2026-11-02 / 11-05 / 11-08）は人間が書いた SQL を `migration_lock.toml` と同じ形式の
  ディレクトリに置いただけで、`applied_steps_count=0` のまま `_prisma_migrations` に手動で
  applied マークされている（Prisma CLI が実行したものではない）
- 以後の DB 変更の索引・適用手順は `apps/server/db/changes/README.md` と `doc/db-changes.md` を参照
