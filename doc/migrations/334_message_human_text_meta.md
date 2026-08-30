# core#334: `Message.humanTextMeta` 列の追加

人間入力テキスト（ゲート①MCP `approve_implementation.note` / ②チャット `e,<指示>` /
③MCP `submit_instruction.instruction`）の監査メタ情報を保存する列。

raw text 自体はこの列には持たない（既存の `Message.content` / `Session.approvalNote` に
無切り詰めで既に全文保存されているため、本列は「どこに raw text があるか」を辿るための
監査メタ（種別・実長・上限・fence 適用有無・raw text の所在）のみを持つ設計）。

## 適用SQL（psql で人間が実行）

```sql
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "humanTextMeta" TEXT;
```

## 検証SQL

```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'Message' AND column_name = 'humanTextMeta';
```

期待結果: `humanTextMeta | text | YES` の1行。

## 適用後の手順

```bash
cd /opt/devrelay/apps/server
npx prisma generate
```

その後、`pnpm build` は既に実装側で完了しているため、人間による `pm2 restart devrelay-server` で反映する。

## 列の値の形式（JSON文字列、例）

```json
{"kind":"execInstruction","origin":"human","rawLength":1234,"limit":4000,"fenced":true,"rawRef":"message.content"}
```

- `kind`: `'approvalNote' | 'execInstruction' | 'submitInstruction'`（enum不使用、文字列）
- `rawRef`: raw text の所在（`'message.content'` または `'session.approvalNote'`）
