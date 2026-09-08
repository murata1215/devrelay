# #376 マイグレーション: 会話セッション境界（MCP submission 単位）用カラムの追加

`schema.prisma` の `model Session` に以下 4 カラムを追加した（すべて nullable / 既定値なし。
既存行は NULL のまま残るため、`prisma migrate dev` を使わずとも既存挙動には一切影響しない）。

- `planTurnId       String?` — plan ターン送信時に採番した correlation ID
- `planAiSessionId  String?` — plan ターン完了時に確定した AI ツール側セッション ID（exec の resume 元）
- `planAiTool       String?` — 上記が属するツール種別（`'claude'` | `'devin'` | `'codex'` 等）
- `approvedAt       DateTime?` — 承認 claim。`null` = 未承認。atomic に claim/解放する

## 適用手順

```bash
# 罠: .env の DATABASE_URL にはパスワードに `$@` が含まれるため、
# `source .env` 経由だとシェル展開で壊れる。必ずシングルクォートのリテラルで export すること。
export DATABASE_URL='postgresql://devrelay_user:devrelay_user$@localhost:5432/devrelay'

psql "$DATABASE_URL" -c 'ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "planTurnId" TEXT;'
psql "$DATABASE_URL" -c 'ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "planAiSessionId" TEXT;'
psql "$DATABASE_URL" -c 'ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "planAiTool" TEXT;'
psql "$DATABASE_URL" -c 'ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "approvedAt" TIMESTAMP(3);'

# 4 列すべてが実際に追加されたことを確認
psql "$DATABASE_URL" -c "SELECT column_name FROM information_schema.columns WHERE table_name='Session' AND column_name IN ('planTurnId','planAiSessionId','planAiTool','approvedAt');"
```

期待される出力: 4 行返る（`planTurnId` / `planAiSessionId` / `planAiTool` / `approvedAt`）。

## 適用後

`npx prisma generate` を実行し Prisma Client を再生成した上で `pnpm build` する。
DDL 適用済みのため、再起動案内時は「DB マイグレーション適用済み」を明記すること。

## 反映手順（このサイクル全体、順序厳守）

1. `git pull`（このサイクルの commit を取得）
2. 上記 ALTER 4 本を適用
3. カラム存在を SQL で検証（上記 SELECT で 4 行確認）
4. `pnpm build`
5. `pm2 restart devrelay-server`
6. 全 OS の Agent を更新（各マシンのチャットで `u`。Linux → macOS → Windows の順。
   Windows は `session-scope.ts` / `path-mutex.ts` / `atomic-write.ts` の新規移植があるため必須）
7. 実機 E2E（同一プロジェクトへの 2 submission 並行 → 別スコープに分かれ、A の approve で
   A の plan のみ exec されることを確認）は本サイクルでは未実施。上記反映後に別サイクルで行う

## 互換性

- 旧 Agent × 新サーバー: Agent が `agentScopeId` / `resumeSessionId` / `turnId` を無視するため従来動作
  （ただし `planAiSessionId` が保存されないため `approve_implementation` は
  「plan のセッション ID が記録されていません。agent が未更新か plan が未完了です。agent 更新後に再 submit してください」
  で拒否される＝安全側）
- 新 Agent × 旧サーバー: payload にフィールドが無いため従来動作
- 対話経路（WebUI/Discord/Telegram/LINE）は `agentScopeId` を送らないため、resume 挙動・ファイル配置は無変更
