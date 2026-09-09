/**
 * スレッド管理 サイクル3（WebUI）: `web:response` / `web:progress` のクライアント側配送判定 と
 * 履歴取得元（プロジェクト横断 or スレッド単位）の解決を行う純関数群。
 * 外部 import ゼロ（node:test から dist-test/ を直接 import する。
 * apps/server の thread-routing.ts と同じ流儀）。
 *
 * fail-open が絶対条件: payload と tab の**両方**に sessionId があって不一致の場合のみ drop する。
 * どちらか一方でも欠けている場合は accept する。理由:
 * - `//connect` 応答・`web:user_message` は現時点で payload に sessionId を持たない（server 側の
 *   別サイクルの改修対象、サイクル3の対象外）
 * - 旧 server dist（未反映のマシン）は sessionId を送らない
 * - タブ復元直後は `web:session_info` 受信前で tab 側の sessionId が未確定
 * これらすべてで drop してしまうと出力が消える退行になるため、判断がつかない場合は必ず accept する。
 */

/** `shouldRouteToTab` の判定結果。 */
export type RouteDecision =
  | { route: 'accept'; reason: 'match' | 'no-payload-session' | 'tab-session-unknown' }
  | { route: 'drop'; reason: 'session-mismatch' };

/** `shouldRouteToTab` の入力。 */
export interface ShouldRouteToTabInput {
  /** `web:response` / `web:progress` payload の sessionId（サイクル1で付与済み） */
  payloadSessionId?: string | null;
  /** 配送先タブが現在表示しているスレッドの sessionId */
  tabSessionId?: string | null;
}

/**
 * projectId で特定済みのタブに対し、そのメッセージ/進捗を実際に表示してよいか判定する。
 * （projectId によるタブ特定自体は呼び出し側の既存ロジックに委ねる。ここでは
 * 「同じ project タブ内で、別スレッドの出力が今表示中のスレッドに混入しないか」を判定する）
 */
export function shouldRouteToTab(input: ShouldRouteToTabInput): RouteDecision {
  if (!input.payloadSessionId) return { route: 'accept', reason: 'no-payload-session' };
  if (!input.tabSessionId) return { route: 'accept', reason: 'tab-session-unknown' };
  if (input.payloadSessionId === input.tabSessionId) return { route: 'accept', reason: 'match' };
  return { route: 'drop', reason: 'session-mismatch' };
}

/** `resolveHistorySource` の入力。 */
export interface ResolveHistorySourceInput {
  /** タブが現在表示しているスレッドの sessionId（無ければプロジェクト横断にフォールバック） */
  sessionId?: string | null;
  projectId: string;
}

/** 履歴取得元の解決結果。`kind: 'session'` なら `/api/sessions/:id/messages`、`'project'` なら旧来の `/api/projects/:id/messages` を使う。 */
export type HistorySource =
  | { kind: 'session'; id: string }
  | { kind: 'project'; id: string };

/**
 * 履歴取得元を解決する（後方互換フォールバック付き）。
 * `sessionId` があればスレッド単位の履歴（`/api/sessions/:id/messages`）に切り替え、
 * 無ければ従来のプロジェクト横断履歴（`/api/projects/:id/messages`）を使う
 * （`web:session_info` 受信前・旧タブ復元直後など sessionId が未確定な間の互換性を保つ）。
 */
export function resolveHistorySource(input: ResolveHistorySourceInput): HistorySource {
  if (input.sessionId) return { kind: 'session', id: input.sessionId };
  return { kind: 'project', id: input.projectId };
}
