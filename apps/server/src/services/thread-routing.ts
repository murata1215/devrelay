/**
 * スレッド管理 cycle1: スレッド一覧のソート・`//connect` 互換解決・チャット配送先セッションの解決・
 * `web:session_info` payload 構築を行う純関数群。外部 import ゼロ（node:test から dist/ を直接 import する）。
 *
 * S1〜S8（「1 project 1 active」前提の誤配送）の中核はここに集約する:
 * `getSessionIdByChatId()`（session-manager.ts の Map 走査）が「最初の1件」を返していたのが
 * 誤配送の実体だった。`resolveChatSessionId` は「候補が複数あるなら推測せず null を返す」ことで
 * これを構造的に防ぐ。
 */

/** スレッド一覧・`//connect` 候補解決で共通して使うセッションの最小情報。 */
export interface ThreadLike {
  id: string;
  status: string;
  startedAt: Date;
  lastActiveAt: Date | null;
}

/**
 * スレッドの並び替えキー（新しい順ソート用の時刻）を返す。
 * `lastActiveAt` があればそれを使い、無ければ `startedAt` にフォールバックする
 * （既存セッションは `lastActiveAt` が永久に NULL なので、これが無いと一覧の先頭に来ない）。
 */
export function threadSortKey(thread: ThreadLike): Date {
  return thread.lastActiveAt ?? thread.startedAt;
}

/**
 * スレッド配列を `threadSortKey` の降順（新しい順）にソートした新しい配列を返す（非破壊）。
 * 同時刻の場合は入力順を保つ（Array.prototype.sort は安定ソート、Node 12+ で保証）。
 */
export function sortThreadsDesc<T extends ThreadLike>(threads: T[]): T[] {
  return [...threads].sort((a, b) => threadSortKey(b).getTime() - threadSortKey(a).getTime());
}

/** `//connect` 互換解決の入力。 */
export interface DecideConnectTargetInput<T extends ThreadLike> {
  /** 接続先候補（呼び出し側で `status:'active'` 等の絞り込みを済ませたもの） */
  candidates: T[];
  /** ユーザー/クライアントが明示的に指定したセッション ID（あれば最優先） */
  explicitSessionId?: string | null;
}

/** `//connect` 互換解決の結果。 */
export type ConnectTarget<T extends ThreadLike> =
  | { action: 'reuse'; thread: T }
  | { action: 'createNew' };

/**
 * `//connect`（プロジェクトへの接続）で、既存スレッドを再利用するか新規作成するかを決定する。
 * 優先順位:
 * 1. `explicitSessionId` が指定され、それが `candidates` に含まれていればそれを再利用
 * 2. `candidates` が空なら新規作成
 * 3. それ以外は `threadSortKey` が最新のスレッドを再利用（`lastActiveAt` 全 NULL なら `startedAt` で判定）
 */
export function decideConnectTarget<T extends ThreadLike>(
  input: DecideConnectTargetInput<T>
): ConnectTarget<T> {
  if (input.explicitSessionId) {
    const explicit = input.candidates.find((c) => c.id === input.explicitSessionId);
    if (explicit) return { action: 'reuse', thread: explicit };
  }
  if (input.candidates.length === 0) return { action: 'createNew' };
  const sorted = sortThreadsDesc(input.candidates);
  return { action: 'reuse', thread: sorted[0] };
}

/** `resolveChatSessionId` の入力。 */
export interface ResolveChatSessionIdInput {
  /** `UserContext.currentSessionId`（chatId が今どのセッションを current にしているか）。最優先。 */
  contextSessionId: string | null | undefined;
  /**
   * `context.currentSessionId` が無い場合のフォールバック候補（例: 当該 chatId が
   * participant として登録されている Session の一覧）。
   */
  fallbackCandidates: string[];
}

/**
 * 「このチャット（chatId）に今メッセージを配送すべき sessionId はどれか」を解決する。
 *
 * 優先順位:
 * 1. `contextSessionId` があればそれを返す（現在の current session が常に正）
 * 2. 無い場合、`fallbackCandidates` がちょうど1件ならそれを返す
 *    （1 chatId が実際に1つのセッションにしか参加していないケースの後方互換）
 * 3. `fallbackCandidates` が0件または2件以上なら **null を返す（推測しない）**
 *
 * 旧実装（`getSessionIdByChatId()` の Map 走査）は複数候補がある場合でも
 * 「最初に見つかった1件」を返してしまっていた。1 chatId が複数プロジェクトタブとして
 * 複数セッションに参加するのは意図された挙動（web.ts）であり、そのケースで無条件に
 * 1件を選ぶことが S1〜S8 の誤配送（他プロジェクトタブへの出力漏れ）の実体だった。
 */
export function resolveChatSessionId(input: ResolveChatSessionIdInput): string | null {
  if (input.contextSessionId) return input.contextSessionId;
  if (input.fallbackCandidates.length === 1) return input.fallbackCandidates[0];
  return null;
}

/** `web:session_info` payload 構築の入力。 */
export interface BuildSessionInfoPayloadInput {
  projectId: string;
  sessionId: string;
  /** スレッドタイトル。null/undefined なら payload に `title` キー自体を含めない（後方互換） */
  title?: string | null;
  /** agent scope ID。null/undefined なら payload に `agentScopeId` キー自体を含めない（後方互換） */
  agentScopeId?: string | null;
}

/** `web:session_info` の payload 型（cycle1 時点。`packages/shared` の型は cycle3 で追従する）。 */
export interface SessionInfoPayload {
  projectId: string;
  sessionId: string;
  title?: string;
  agentScopeId?: string;
}

/**
 * `web:session_info` イベントの payload を構築する。
 *
 * `title`/`agentScopeId` が null/undefined の場合は **キー自体を省略する**
 * （値を `null` にして送るのではなく、プロパティを持たせない）。これにより
 * 既存スレッド（title=null, agentScopeId=null）での payload は
 * 現行実装 `{ projectId, sessionId }`（web.ts:136）と `assert.deepStrictEqual` で一致し、
 * 後方互換性がテストで固定される。
 */
export function buildSessionInfoPayload(input: BuildSessionInfoPayloadInput): SessionInfoPayload {
  const payload: SessionInfoPayload = { projectId: input.projectId, sessionId: input.sessionId };
  if (input.title) payload.title = input.title;
  if (input.agentScopeId) payload.agentScopeId = input.agentScopeId;
  return payload;
}
