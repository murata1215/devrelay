# TISA 系列の DB 変更（会社リポジトリ独自）

本家の DB 変更の運用は `doc/db-changes.md`（サイクルM1）。このファイルは会社リポジトリ側の追加ルールだけを書く。

## なぜ別系列か

本家は DB 変更を `apps/server/db/changes/NNNN_*.sql` の 4 桁連番で管理している。会社側の変更に同じ連番を使うと、
本家が同じ番号を採ったときに（本家から pull するたびに）ファイル名と索引が衝突する。そこで会社側の変更は
`apps/server/db/changes/tisa/TISA<4桁>_*.sql` に置き、索引も `tisa/INDEX.tsv` に分ける。

台帳 "DbChange" の主キーはファイル名（`name`）なので、本家の行と TISA の行は同じ台帳に並べて記録できる
（`no` 列はそれぞれの系列の番号。本家の 1 と TISA の 1 が両方あってよい）。

## 一覧

| no | ファイル | 内容 |
|---|---|---|
| 0001 | `TISA0001_session_handover.sql` | Session に handover* 6 列（スレッド引継ぎ `n`） |
| 0002 | `TISA0002_usage_cost_aggregation.sql` | Organization.usageSignageToken・Session.usageCase・UserUsageGroup（Usage） |

正本はフォルダ内の `INDEX.tsv`。

## 本家から pull したときの手順

1. pull（merge）の前に `git rev-parse HEAD > /tmp/devrelay-before` を取る
2. `git merge origin/main`
3. 衝突しやすいのは `apps/server/db/changes/SCHEMA.sha256`（1 行）と `apps/server/prisma/schema.prisma`。
   両方の変更を残し、`SCHEMA.sha256` は次のように書き直す:
   - 1 列目: マージ後の `sha256sum apps/server/prisma/schema.prisma | cut -c1-16`
   - 2 列目: 本家の `INDEX.tsv` の最大番号のファイル名
4. `pnpm build` → `cd apps/server && node --test tests/db-changes.test.mjs tests/db-changes-tisa.test.mjs`
5. `pnpm --filter @devrelay/server db:status` で未適用を確認し、表示された順（本家 → TISA）に psql で適用する
6. サーバーを再起動する

## Windows（この会社サーバー）での psql

`.env` の `DATABASE_URL` には Prisma 用の `?schema=public&connection_limit=…` が付いている。psql はこれを受け付けないので、
`?` 以降を外して渡す。文字化けを避けるため `PGCLIENTENCODING=UTF8` を付ける。

```bash
export DATABASE_URL="$(sed -n 's/^DATABASE_URL="\{0,1\}\(.*[^"]\)"\{0,1\}$/\1/p' apps/server/.env | tail -1 | sed 's/?.*$//')"
export PGCLIENTENCODING=UTF8
"/c/Program Files/PostgreSQL/18/bin/psql" "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f apps/server/db/changes/tisa/TISA0003_xxx.sql
```

## 本家に同じ変更が入ったとき

会社側の機能が本家にも取り込まれ、本家が同じ列を `NNNN_*.sql` で追加した場合、その SQL は `IF NOT EXISTS` なので
何も変えずに台帳に記録されるだけになる。TISA 側のファイル・索引行は消さない（append-only）。
