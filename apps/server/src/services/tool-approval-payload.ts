/**
 * ツール承認カード payload 構築ヘルパー（スレッド管理 サイクル4）。
 * 外部 import ゼロの純関数のみ。`thread-routing.ts` の `buildSessionInfoPayload` と同じ流儀
 * （node:test から dist/ を直接 import する）。
 *
 * 背景（doc/devlog/2026-09-10_013311.md 引き継ぎ#1）:
 * ツール承認カードの payload が `sessionId` を持っていなかったため、同一プロジェクトに
 * 2 本のスレッドが開いていると、片方の承認カードがもう片方を表示中のタブにも出てしまう
 * （承認自体は `requestId` で届くため誤動作＝誤承認は発生しない。表示だけの穴）。
 *
 * `packages/shared` の `ToolApprovalPromptPayload` は本サイクルのスコープ外（apps/server + doc
 * のみ）のため変更しない。ここでは `sessionId` を追加したローカル拡張型を定義し、
 * TypeScript の構造的型付けにより既存の `ServerToWebMessage`（`payload: ToolApprovalPromptPayload`）
 * にも変数経由でそのまま代入可能にする（超過プロパティチェックは object literal のみに適用され、
 * 変数の代入では働かないため、shared 側の型変更なしに `sessionId` を運べる）。
 * `apps/web` 側で実際に `sessionId` を見て表示をゲートする対応は次サイクルの申し送り。
 */

/** ツール承認 UI 表示用 payload（`sessionId` 追加版）。 */
export interface ToolApprovalPromptPayloadWithSession {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  /** このカードがどのスレッド（Session）向けかを示す。表示側でのタブ絞り込みに使う。 */
  sessionId: string;
  title?: string;
  description?: string;
  projectId?: string;
  /** AskUserQuestion の場合 true */
  isQuestion?: boolean;
  /** teamexec/crossquery セッションの場合の発信元プロジェクト ID */
  originProjectId?: string;
}

/** `buildToolApprovalPromptPayload` の入力。 */
export interface BuildToolApprovalPromptPayloadInput {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  sessionId: string;
  title?: string | null;
  description?: string | null;
  projectId?: string | null;
  isQuestion?: boolean | null;
  originProjectId?: string | null;
}

/**
 * ツール承認カードの payload を構築する。
 *
 * `title`/`description`/`projectId`/`isQuestion`/`originProjectId` は値が falsy（null/undefined/false/空文字）
 * の場合、**キー自体を省略する**（`buildSessionInfoPayload` と同じ後方互換の流儀）。
 * これにより、既存の呼び出し元がこれらを渡さないケース（例: 保留中カード復元経路は
 * title/description を保持していない）でも、送信される JSON の形は現行実装と一致する
 * （`JSON.stringify` は値が `undefined` のキーを省略するため、値を渡さない場合と
 * キー自体を持たせない場合とで実際にワイヤに乗る JSON は同一になる）。
 */
export function buildToolApprovalPromptPayload(
  input: BuildToolApprovalPromptPayloadInput
): ToolApprovalPromptPayloadWithSession {
  const payload: ToolApprovalPromptPayloadWithSession = {
    requestId: input.requestId,
    toolName: input.toolName,
    toolInput: input.toolInput,
    sessionId: input.sessionId,
  };
  if (input.title) payload.title = input.title;
  if (input.description) payload.description = input.description;
  if (input.projectId) payload.projectId = input.projectId;
  if (input.isQuestion) payload.isQuestion = input.isQuestion;
  if (input.originProjectId) payload.originProjectId = input.originProjectId;
  return payload;
}
