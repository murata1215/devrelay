# 共有ドキュメント機能（DevRelay Box）仕様書

## 概要
プロジェクト横断で知識を共有する機能。例: pixshelf で作った手順書を pixdraft でも参照して同じ作業をしたい。
ユーザーが「さっきの手順書をみてやって」と指示するだけで、DevRelay が自動的に関連ドキュメントを検索・取得してプロンプトに含める。

## 環境
- PostgreSQL + pgvector 0.6.0（インストール済み）
- OpenAI API Key（`.env` に `OPENAI_API_KEY` あり）
- Embedding: `text-embedding-3-small`（1536次元）

---

## アーキテクチャ

### 保存フロー
```
[pixshelf] ユーザー: 「手順書を作って共有ドキュメントに保存して」
  → Claude: .devrelay-shared-docs/手順書.md に保存
  → Agent: ファイル検出 → agent:docs:save メッセージで Server に送信
  → Server: DB 保存 + OpenAI Embedding 生成 + pgvector 格納
  → Discord: 「📄 共有ドキュメントに保存しました: 手順書.md」
```

### 検索・取得フロー
```
[pixdraft] ユーザー: 「さっきの pixshelf の手順書をみてやって」
  → Server: handleAiPrompt() でプロンプトの embedding 生成
  → Server: pgvector で cosine similarity 検索（top 3, threshold > 0.5）
  → Server: 関連ドキュメントを server:ai:prompt の payload に追加
  → Agent: プロンプト構築時に共有ドキュメントをコンテキストとして注入
  → Discord: 「📄 関連ドキュメント1件をコンテキストに追加しました」
  → Claude: 手順書を参照して作業実行
```

---

## 実装内容

### 1. DB スキーマ（Prisma + raw SQL）

**`apps/server/prisma/schema.prisma`** に追加:
```prisma
model SharedDocument {
  id          String   @id @default(cuid())
  userId      String
  title       String
  content     String
  projectName String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  user        User     @relation(fields: [userId], references: [id])

  @@index([userId])
}
```

**マイグレーション SQL で vector カラム追加**:
```sql
ALTER TABLE "SharedDocument" ADD COLUMN "embedding" vector(1536);
CREATE INDEX ON "SharedDocument" USING hnsw ("embedding" vector_cosine_ops);
```

### 2. Server: ドキュメントサービス

**新規: `apps/server/src/services/document-service.ts`**
- `saveDocument(userId, title, content, projectName)` → DB保存 + Embedding生成 + vector格納
- `searchDocuments(userId, query, limit=3, threshold=0.5)` → query のembedding生成 + pgvector検索
- `generateEmbedding(text)` → OpenAI `text-embedding-3-small` API呼び出し
- `.env` の `OPENAI_API_KEY` を使用（per-userではなくサーバーレベル）

### 3. Server: プロンプト送信時の自動検索

**修正: `apps/server/src/services/command-handler.ts`**
- `handleAiPrompt()` 内で `sendPromptToAgent()` の前に:
  1. `searchDocuments(userId, userPrompt)` で関連ドキュメント検索
  2. 結果を `server:ai:prompt` の payload に `sharedDocs` として追加
  3. Discord/Telegram に「📄 関連ドキュメントN件をコンテキストに追加しました」を表示

### 4. Server: ドキュメント保存ハンドラ

**修正: `apps/server/src/services/agent-manager.ts`**
- `agent:docs:save` メッセージハンドラ追加
- Agent からのドキュメントを受け取り → `saveDocument()` 呼び出し
- 保存結果を `server:docs:saved` で Agent に返信
- Discord/Telegram に「📄 共有ドキュメントに保存しました: タイトル」を通知

### 5. Agent: 共有ドキュメント収集

**修正: `agents/linux/src/services/output-collector.ts`**
- `SHARED_DOCS_DIR_NAME = '.devrelay-shared-docs'` 定数追加
- `SHARED_DOCS_INSTRUCTION` を追加（プロンプトに含める指示文）
- `collectSharedDocs(projectPath)` → `.devrelay-shared-docs/` からファイル収集
- `clearSharedDocsDir(projectPath)` → 収集後にクリア

### 6. Agent: プロンプト構築に共有ドキュメント注入

**修正: `agents/linux/src/services/connection.ts`**
- **保存**: Claude 完了後、`.devrelay-shared-docs/` のファイルを検出 → `agent:docs:save` で送信
- **取得**: `handleAiPrompt()` で payload の `sharedDocs` をプロンプトに注入:
  ```
  --- 関連する共有ドキュメント ---
  [タイトル: ユーザー切り替え手順書.md]
  [作成元: pixshelf]
  [作成日時: 2026-02-22]

  (ドキュメント内容)
  --- End 関連する共有ドキュメント ---
  ```

### 7. 共有型定義

**修正: `packages/shared/src/types.ts`**
```typescript
// 共有ドキュメント保存ペイロード
export interface SharedDocSavePayload {
  machineId: string;
  sessionId: string;
  title: string;
  content: string;
  projectName?: string;
}

// 検索結果（プロンプト注入用）
export interface SharedDocResult {
  title: string;
  content: string;
  projectName?: string;
  similarity: number;
  createdAt: string;
}

// AiPromptPayload に追加
export interface AiPromptPayload {
  sessionId: string;
  prompt: string;
  userId: string;
  files?: FileAttachment[];
  missedMessages?: MissedMessage[];
  sharedDocs?: SharedDocResult[];  // 自動検索された関連共有ドキュメント
}
```

**メッセージ型追加**:
- `AgentToServerMessage`: `agent:docs:save` + `SharedDocSavePayload`
- `ServerToAgentMessage`: `server:docs:saved` + `{ success: boolean; title: string }`

### 8. プロンプト指示文

**SHARED_DOCS_INSTRUCTION**（output-collector.ts に追加）:
```
共有ドキュメントに保存する場合は `.devrelay-shared-docs/` ディレクトリにファイルを保存してください。
保存されたファイルは自動的にベクトル化され、他のプロジェクトからも参照できるようになります。
```

---

## 修正ファイル一覧

| ファイル | 変更種別 | 内容 |
|---------|---------|------|
| `apps/server/prisma/schema.prisma` | 修正 | SharedDocument モデル追加 |
| `apps/server/prisma/migrations/*/` | 新規 | マイグレーション + vector カラム |
| `apps/server/src/services/document-service.ts` | **新規** | Embedding 生成 + pgvector 検索 |
| `apps/server/src/services/command-handler.ts` | 修正 | handleAiPrompt で自動検索 |
| `apps/server/src/services/agent-manager.ts` | 修正 | agent:docs:save ハンドラ追加 |
| `apps/server/src/services/session-manager.ts` | 修正 | 共有ドキュメント通知の送信 |
| `agents/linux/src/services/output-collector.ts` | 修正 | shared-docs ディレクトリ管理 |
| `agents/linux/src/services/connection.ts` | 修正 | 保存送信 + プロンプト注入 |
| `packages/shared/src/types.ts` | 修正 | 新しい型定義追加 |

---

## 検証方法

1. **保存テスト**: pixshelf で「テストドキュメントを共有ドキュメントに保存して」→ DB にレコード + embedding が格納されるか確認
2. **検索テスト**: pixdraft で「さっきの pixshelf のテストドキュメントをみて」→ 関連ドキュメントがプロンプトに注入されるか確認
3. **閾値テスト**: 関係ない指示（「Hello」など）→ ドキュメントが注入されないか確認
4. **Discord 通知**: 保存時・取得時のメッセージが表示されるか確認
