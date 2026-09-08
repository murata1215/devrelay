# #377 マイグレーション: SDK maxTurns 打ち切りの可視化用カラムの追加

`schema.prisma` の `model BuildLog` に以下 1 カラムを追加した（nullable / 既定値なし。
既存行は NULL のまま残るため、`prisma migrate dev` を使わずとも既存挙動には一切影響しない）。

- `stopReason  String?` — AI 実行の終了理由。`'success'` | `'max_turns'` | `'error'` | `'aborted'`。
  未指定（旧 agent または Claude SDK 以外の経路）はサーバー側で `'success'` として正規化される。

## 適用手順

```bash
# 罠: .env の DATABASE_URL にはパスワードに `$@` が含まれるため、
# `source .env` 経由だとシェル展開で壊れる。必ずシングルクォートのリテラルで export すること。
export DATABASE_URL='postgresql://devrelay_user:devrelay_user$@localhost:5432/devrelay'

psql "$DATABASE_URL" -c 'ALTER TABLE "BuildLog" ADD COLUMN IF NOT EXISTS "stopReason" TEXT;'

# 追加されたことを確認
psql "$DATABASE_URL" -c "SELECT column_name FROM information_schema.columns WHERE table_name='BuildLog' AND column_name='stopReason';"
```

期待される出力: 1 行返る（`stopReason`）。

## 適用後

`npx prisma generate` を実行し Prisma Client を再生成した上で `pnpm build` する
（`apps/server` の build スクリプトは `tsc` のみで `prisma generate` を含まないため、
**明示的に実行する必要がある**）。DDL 適用済みのため、再起動案内時は「DB マイグレーション適用済み」を明記すること。

> **⚠️ ALTER を飛ばして `pm2 restart` すると `get_build_status` / Projects のビルド一覧 / BuildLog 作成が
> `column "stopReason" does not exist` で同時に壊れる**（Prisma は `select` を省略した `findMany`/`create` 等で
> 全スカラ列を対象にするため、schema.prisma の型と実 DB スキーマの不一致がクエリ全体を落とす）。

## 反映手順（このサイクル全体、順序厳守）

1. `git pull`（このサイクルの commit を取得）
2. 上記 ALTER 1 本を適用
3. カラム存在を SQL で検証（上記 SELECT で 1 行確認）
4. `npx prisma generate && pnpm build`
5. `pm2 restart devrelay-server`
6. 全 Linux / macOS Agent を更新（各マシンのチャットで `u`。Windows は `maxTurns` を持たない CLI 経路のためスコープ外・対象外）
7. （任意）上限を変更したい場合のみ `crontab -e` で Agent 起動行（`@reboot ...`）の `export` に
   `DEVRELAY_SDK_MAX_TURNS=200` 等を追記し、OS 再起動または Agent プロセス再起動。
   `.env` や `config.yaml` からは渡せない（Agent は crontab の `export` のみを env 経由手段として使う）。
   **`DEVRELAY_SDK_MAX_TURNS=200` に設定すれば、本サイクルで既定値を 200→400 に上げた変更を即座にロールバックできる。**

## 互換性

- 旧 Agent（`stopReason` 未送信）× 新サーバー: `payload.stopReason` が `undefined` のため
  `normalizeStopReason()` が `'success'` として扱う（従来どおり "正常完了" 表示）
- 新 Agent × 旧サーバー: payload に `stopReason` はあるが受信側で無視されるだけ（従来動作）
- Windows Agent: `maxTurns` オプション自体を持たない CLI spawn 経路のため本サイクルの変更対象外。
  `stopReason` は常に未送信 → サーバー側で `'success'` 扱い（従来どおり）
- `error_max_budget_usd` は本サイクルでは `resumeFailed` 経路（is_error && resumeSessionId）に引き続き乗る
  （`max_turns` のみを除外対象にした）。予算上限系の resume 誤判定是正は次サイクル候補
