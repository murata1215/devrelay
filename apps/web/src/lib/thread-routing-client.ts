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

/**
 * Lite シェル L3 B4: WS 受信メッセージ（`web:response` / `web:progress` 等。承認カードは含まない。
 * 承認カードは `shouldShowApprovalCard()`（別関数、fail-closed）が唯一の例外として別ポリシーを持つ）
 * を、今表示中のタブに表示してよいか判定する。`shouldRouteToTab` を土台にし、判定不能なときだけ
 * projectId 比較へフォールバックする 2 段構え。
 *
 * 規則（終端優先）:
 * 1. session ゲートが `drop`（両方 sessionId があって不一致）→ 非表示で終端。
 * 2. session ゲートが `match`（両方 sessionId があって一致）→ 表示で終端。**projectId は見ない**
 *    （クロスプロジェクト応答であっても sessionId が一致していれば信頼する）。
 * 3. session ゲートが判定不能（`no-payload-session` / `tab-session-unknown`）のときのみ、
 *    projectId 比較に落ちる。**両方あって不一致のときだけ**非表示。片方でも欠けていれば表示（fail-open）。
 *
 * 再接続時の progress 復元（`web.ts:86-89`）は `{output, elapsed, projectId}` で sessionId を
 * 持たないため、常にこの 3. の分岐（projectId 比較）を通る。fail-open だからこそ表示される。
 */
export interface DecideInboundDisplayInput {
  /** `web:response` / `web:progress` payload の sessionId。 */
  payloadSessionId?: string | null;
  /** 配送先タブが現在表示しているスレッドの sessionId。 */
  tabSessionId?: string | null;
  /** payload の projectId（sessionId 判定不能時のみ参照する）。 */
  payloadProjectId?: string | null;
  /** タブが現在表示しているプロジェクトの projectId（sessionId 判定不能時のみ参照する）。 */
  tabProjectId?: string | null;
}

/** `decideInboundDisplay` の判定結果。 */
export type InboundDisplayDecision =
  | { display: true; reason: 'session-match' | 'project-fallback-accept' }
  | { display: false; reason: 'session-mismatch' | 'project-mismatch' };

export function decideInboundDisplay(input: DecideInboundDisplayInput): InboundDisplayDecision {
  const sessionDecision = shouldRouteToTab({
    payloadSessionId: input.payloadSessionId,
    tabSessionId: input.tabSessionId,
  });

  if (sessionDecision.route === 'drop') {
    return { display: false, reason: 'session-mismatch' };
  }

  if (sessionDecision.reason === 'match') {
    return { display: true, reason: 'session-match' };
  }

  // ここに来るのは 'no-payload-session' / 'tab-session-unknown'（session 判定不能）のときのみ。
  if (input.payloadProjectId && input.tabProjectId && input.payloadProjectId !== input.tabProjectId) {
    return { display: false, reason: 'project-mismatch' };
  }
  return { display: true, reason: 'project-fallback-accept' };
}

/** `resolveOlderMessagesSource` の入力。 */
export interface ResolveOlderMessagesSourceInput {
  /** `loadHistory` が直前に実際に読み込んだ取得元（`Tab.historySessionId`）。
   *  string = スレッド単位で読んだ、null = プロジェクト横断で読んだ、undefined = まだ読んでいない。 */
  historySessionId?: string | null;
  /** タブが現在表示しているスレッドの sessionId（`historySessionId` が undefined のときのフォールバック用）。 */
  tabSessionId?: string | null;
  projectId: string;
}

/**
 * スクロールバック時（`loadOlderMessages`）の履歴取得元を解決する。
 *
 * バグ修正: 従来は常に `projectsApi.getMessages()`（プロジェクト横断）を使っており、
 * `loadHistory` がスレッド単位で表示した履歴に対して、上スクロールだけ別スレッドの
 * メッセージを混入させていた（スレッド表示中に上スクロール→別スレッドの内容が
 * 表示されるバグの直接原因）。表示中の履歴と**同じカーソル空間**を維持するため、
 * 直前の `loadHistory` が実際に使った取得元（`historySessionId`）を最優先で踏襲する。
 */
export function resolveOlderMessagesSource(input: ResolveOlderMessagesSourceInput): HistorySource {
  if (input.historySessionId === undefined) {
    // loadHistory 未実行（初回ロード前にスクロールが発火した等）→ 従来のフォールバックに委譲
    return resolveHistorySource({ sessionId: input.tabSessionId, projectId: input.projectId });
  }
  if (input.historySessionId === null) {
    // loadHistory が明示的にプロジェクト横断で読んだ → 表示も横断なので継続
    return { kind: 'project', id: input.projectId };
  }
  // loadHistory が実際にスレッド単位で読んだ → 表示中はそのスレッド
  return { kind: 'session', id: input.historySessionId };
}

/**
 * `before` カーソルに使える DB 由来のメッセージ ID を選ぶ。
 * クライアント生成 ID（`msg_<timestamp>_<n>` 形式、`nextMessageId()` 参照）はサーバの
 * `findUnique` で解決できず、サーバ側がカーソル条件を無視して最新 N 件を返してしまう
 * （時系列崩れ・重複の原因）ため、先頭から走査して最初の非クライアント生成 ID を返す。
 */
export function pickOlderCursorId(messages: { id: string }[]): string | null {
  for (const m of messages) {
    if (!m.id.startsWith('msg_')) return m.id;
  }
  return null;
}

/** `resolveOlderMessagesSource` / `resolveHistorySource` の結果同士が同じ取得元を指すか判定する。
 *  `loadOlderMessages` / `loadHistory` の応答適用時、フェッチ中にスレッドが切り替わっていないかの
 *  レースガードに使う。 */
export function isSameHistorySource(a: HistorySource, b: HistorySource): boolean {
  return a.kind === b.kind && a.id === b.id;
}
