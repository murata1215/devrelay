# DB 変更履歴の一元化（サイクルM1）

DevRelay の DB スキーマ変更は**人間が `psql` で手動適用する運用**です。
`prisma migrate dev` / `migrate deploy` / `db push` は**永久禁止**です
（`db push` は schema.prisma に書けない pgvector の `embedding` 列を DROP するため。
`apps/server/prisma/bootstrap.sql` 冒頭の警告参照）。

本ドキュメントは「DB 変更の履歴」と「どこから適用が必要か」を一元管理する運用の説明書です。
過去の詳細な設計判断・調査結果は `doc/db-change-ledger-plan.md`（実装時のプラン原本）を参照。

## 1. フォルダと命名

DB 変更は **`apps/server/db/changes/`** に 1 変更 = 1 SQL ファイルで置きます。

```
apps/server/db/changes/
  README.md                      命名・冪等性・適用ロール等のルール（このフォルダ固有）
  INDEX.tsv                      索引（1 行 1 変更）
  SCHEMA.sha256                  schema.prisma の指紋 1 行（書き忘れ検知用）
  0001_machine_disable_ask.sql
  …
  0032_db_change_ledger.sql
  zz1_verify.sql                 読み取り専用の突合（SELECT のみ）
  zz2_mark_baseline_applied.sql  既に全部適用済みの DB に「適用済み」を一括記録
```

- ファイル名は `NNNN_snake_case_slug.sql`（4 桁ゼロ埋め・時系列昇順・**append-only**）。
- `apps/server/prisma/migrations/`（Prisma 生成、20 件）は**凍結済み**。新規 DB 変更はここには置かない。
- pgvector の embedding 列・索引は `apps/server/prisma/bootstrap.sql` の担当（新規 DB 構築専用）。

### 新規の DB 変更を作るとき

1. `schema.prisma` を変更する
2. `apps/server/db/changes/NNNN_xxx.sql` を新規作成する（既存ファイルの番号の次を使う。
   テンプレートは `apps/server/db/changes/README.md` の「各 SQL ファイルの共通フォーマット」参照）
3. `INDEX.tsv` に 1 行追記する（`commit` 列は `-` のまま。後から埋める必要はない）
4. `SCHEMA.sha256` を更新する:
   ```bash
   sha256sum apps/server/prisma/schema.prisma | cut -c1-16
   ```
   出力した 16 桁と、今作った SQL ファイル名を `<sha16> <file名>` の 1 行で書く
5. **上記 4 点（schema.prisma・SQL ファイル・INDEX.tsv・SCHEMA.sha256）を同じコミットに入れる**
6. `npx prisma generate && pnpm build` → `cd apps/server && node --test tests/db-changes.test.mjs` が green であることを確認
7. DDL が不要な schema.prisma の変更（コメント・`@default` のみ等）は SQL ファイルを作らず、
   `INDEX.tsv` に `file` 列 `-` の行だけ追記する

`tests/db-changes.test.mjs` が、schema.prisma を変更したのに `SCHEMA.sha256` の更新を忘れると
落ちるようになっています（指紋照合）。**ただしこれが捕まえるのは「schema.prisma を触ったのに
記録していない」ケースのみです**。embedding 列・索引の DESC/部分条件・FK の ON DELETE 挙動など
schema.prisma を変えずに打てる DDL は捕まえません（§7 残課題の `pnpm db:drift` 参照）。

## 2. 「どこから適用が必要か」の 2 つの確認方法

### (a) git だけで分かる方法（補助）

```bash
cd /opt/devrelay
git rev-parse HEAD > /tmp/devrelay-before   # ← pull の前に取る
git pull
git diff --name-only --diff-filter=AM "$(cat /tmp/devrelay-before)" HEAD -- apps/server/db/changes/
# 何も出なければ DB 変更なし。出たファイルを番号順に適用する。
```

取り忘れた場合のフォールバック（reflog 依存）:
```bash
git diff --name-only --diff-filter=AM 'HEAD@{1}' HEAD -- apps/server/db/changes/
```

`--diff-filter=AM` は新規追加（A）だけでなく変更（M）も拾います。append-only ルール上
**既存ファイルが M で出ること自体が異常**です（内容を書き換えてはいけない）。

### (b) DB 側の台帳から分かる方法（正本）

```bash
pnpm --filter @devrelay/server db:status
```

これは**読み取り専用**です（SELECT のみ、DDL も INSERT も行いません）。出力例:

```
DB 変更履歴: apps/server/db/changes/（索引 INDEX.tsv）
接続: devrelay_user@devrelay
台帳 "DbChange": あり（記録 31 件）
索引: 32 行（SQL ファイル 31 / DDL 不要 1）

未適用 1 件:
  no    date        file                       summary
  0032  2026-11-12  0032_db_change_ledger.sql  DB 変更台帳 "DbChange" を新設

番号の小さい順に 1 つずつ流してください:
  psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f apps/server/db/changes/0032_db_change_ledger.sql
```

台帳が無い場合:
```
台帳 "DbChange": 存在しません（全 32 件を未適用として扱います）
→ DB が既に最新なら: zz1_verify.sql で突合 → MISSING が 0 行なら zz2_mark_baseline_applied.sql
→ DB が古いなら: 0001 から番号順に psql で流す
→ 新規 DB の構築はこのフォルダの担当外（README.md 参照）
```

すべて適用済みなら `未適用: なし ✅` の 1 行だけが出ます。

## 3. 適用コマンド（人間が実行する）

```bash
cd /opt/devrelay
export DATABASE_URL="$(sed -n 's/^DATABASE_URL="\{0,1\}\(.*[^"]\)"\{0,1\}$/\1/p' .env | tail -1)"
test -n "$DATABASE_URL" && echo OK   # ← 空のまま psql に渡すと既定 DB に繋がるので必ず確認
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f apps/server/db/changes/NNNN_xxx.sql
```

- **必ずアプリと同じロール（本番は `devrelay_user`）で実行する。`postgres` 等の superuser では流さない**
  （2026-11-11 の `CrossAskReset` 所有者ずれ事故の再発防止。各 SQL ファイルのヘッダに入っている
  3 段の誤爆ガードが、superuser での実行・所有者不一致を検出すると `RAISE EXCEPTION` で中断する）。
- `psql -1`（単一トランザクション）が既定。`CREATE INDEX CONCURRENTLY` 等が必要な将来の変更は
  ファイル先頭に `-- no-single-transaction` マーカーを置き `-1` を外す（`README.md` 参照）。
- 適用後は `cd apps/server && npx prisma generate && pnpm build`、その後人間が
  `pm2 restart devrelay-server`（`--update-env` は使わない）。

## 4. 起動時警告

`apps/server/src/index.ts` が `app.listen()` の前に未適用の DB 変更を検査し、fail-open で
警告を出します（起動は止めません）。3 状態を区別します:

| 状態 | 意味 | 文言の例 |
|---|---|---|
| 台帳なし | `"DbChange"` テーブルが無い（一度も導入していない） | `⚠️ DB 変更台帳 "DbChange" がありません` |
| 権限不足 | `"DbChange"` を読めない（所有者ずれの疑い） | `⚠️ "DbChange" を読めません（権限不足）` |
| 接続不能 | DB に繋がらない | `⚠️ DB に接続できないため DB 変更履歴を検査できませんでした` |
| 未適用あり | 索引にあるが台帳に無い変更がある | 件数・ファイル名・要約の一覧 |

`GET /health` にも `dbChanges: { state, pending }` が出ます（pm2 logs を誰も見ない会社サーバー等、
HTTP 経由で取れる出口として用意）。

キルスイッチ: `DEVRELAY_DB_CHANGE_WARN`（既定 `1`。`0` で検査自体を無効化）。

## 5. 新規 DB の構築（このフォルダの担当外）

新規 DB は `apps/server/db/changes/` の遡及ファイルを頭から流すのではなく、従来どおり
**`pnpm db:bootstrap:new-db-only`**（`prisma db push` + `bootstrap.sql`。空 DB に対して安全）で作ります。
`apps/server/db/changes/` の各ファイルはヘッダのガード①（`public."Machine"` の存在確認）で
空 DB への適用を構造的に拒否します。

新規構築後、`pnpm --filter @devrelay/server db:status` を実行すると「台帳なし」と出ます。
その場合:
1. `psql "$DATABASE_URL" -f apps/server/db/changes/zz1_verify.sql` で MISSING が 0 行であることを確認
2. `psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f apps/server/db/changes/0032_db_change_ledger.sql`
3. `psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f apps/server/db/changes/zz2_mark_baseline_applied.sql`
4. `pnpm --filter @devrelay/server db:status` → `未適用: なし ✅` を確認

**`zz2_mark_baseline_applied.sql` は「0001〜0031 が既に適用済みであることを確認できた DB」専用です。**
未適用の DB に流すと、未適用の変更が永久に「適用済み」として隠れます（最も静かで最も高い失敗）。
ファイル自身に突合ゲート（代表列・代表テーブルの実在チェック）が入っており、欠落を検出すると
`RAISE EXCEPTION` で中断しますが、これは最後の砦であり、**必ず先に `zz1_verify.sql` を見ること**。

## 6. 既知 drift（M1 では直さない）

`npx prisma migrate diff --from-url $DATABASE_URL --to-schema-datamodel prisma/schema.prisma --script`
（shadow DB 不要）で検出される、本番 DB と `schema.prisma` の既知の差分:

| drift | 実 DB | schema.prisma | 判定 |
|---|---|---|---|
| `MessageFile`/`AgentDocument`/`KnowledgeChunk`.`embedding vector(1536)` | あり | 書けない | **意図的**（`bootstrap.sql` 管理。Prisma は DROP したがる＝`db push` 禁止の根拠） |
| `idx_messagefile_embedding` / `idx_knowledgechunk_embedding` | あり | 書けない | **意図的**（`bootstrap.sql`） |
| `Notification_userId_createdAt_idx` | `("userId","createdAt" DESC)` | DESC なし | 手調整。実害なし |
| `Notification_userId_isRead_idx` | 部分索引 `WHERE isRead=false` | 部分条件なし | 手調整。実害なし |
| `Notification_projectId_fkey` | `ON DELETE RESTRICT` | `SetNull`（optional 列の既定） | 軽微な実害あり（通知が残る Project の削除が失敗しうる）。M1 対象外 |
| `PersonalAccessToken_userId_fkey` | `CASCADE` | `CASCADE` | `ON UPDATE` 差のみ。実害なし |

## 7. 残課題（M1 では実装しない）

- **`pnpm db:drift`**: 上記の `prisma migrate diff` 出力を、コミット済みの「既知 drift 許容リスト」と
  突合する双方向検査。`SCHEMA.sha256` の指紋照合が捕まえられない「schema.prisma を変えずに打った DDL」
  （embedding 列・DESC 索引・部分索引・FK の ON DELETE 挙動等）を捕まえる本命。
- 台帳 `"DbChange"` に `checksum` 列を持たせ、適用後のファイル編集を検知する仕組み。
- `Notification_projectId_fkey` の `ON DELETE RESTRICT` → `SetNull`（上表の唯一の実害ある drift）の解消。

## 8. 遡及（0001〜0031）について

`schema.prisma` を変えた過去 30 コミットの差分から、手動適用前提だった DDL を 1 コミット = 1
ファイルの原則で起こしたものです（1 コミットに複数サイクルが同居する場合は 1 ファイルに
まとめてヘッダで内訳を列挙。既存の `prisma/migrations/` が日付別に分かれている場合はそれに
合わせて分割）。全列・全索引・テーブル所有者が本番 DB の実際の構造と一致することを
`zz1_verify.sql`（読み取り専用）で確認済みです。詳細な一覧・検証結果は
`doc/db-change-ledger-plan.md` §4 を参照してください。
