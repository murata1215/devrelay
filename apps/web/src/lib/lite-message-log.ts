/**
 * Lite シェル L3: REST 履歴（`sessions.getMessages`）と WS ライブ受信（`web:response` /
 * `web:user_message`）が競合しても同じメッセージを二重表示しないための純ロジック。
 * 外部 import ゼロ（`thread-routing-client.ts` / `thread-list-rules.ts` と同じ流儀）。
 *
 * **classic と同一規則**（独自の重複排除規則を発明しない）。`ChatPage.tsx` の
 * `addMessageToTab()`（:2352-2372、ライブ受信時の重複排除）と `loadHistory()` の
 * `mode === 'refresh'` 分岐（:2233-2261、REST 再取得時の WS ライブ分マージ）を、
 * 純関数として書き写したもの（ロジックの一言一句を一致させる。改変していない）。
 *
 * classic は REST 由来メッセージの `role: 'ai'` を `'system'` に正規化してから
 * `ChatMessage[]`（WS ライブ分と同じ配列）に格納する（`ChatPage.tsx:2201`）。
 * このモジュールは正規化後の値のみを扱う（呼び出し側 `LitePage.tsx` が変換の境界を持つ）。
 *
 * `messageId` は AI 応答（`web:response`）には現時点で付かないことがある
 * （`session-manager.ts:413` が `sendWebMessage(..., undefined, sessionId)` で
 * messageId 引数を渡していない）。そのため「直近 5 件・role+content 一致・30 秒以内」の
 * 内容ベース重複排除が REST+WS 競合の主役になる（messageId 一致はあくまで最優先の近道）。
 *
 * `nowMs` は呼び出し側が注入する（モジュール内で `Date.now()` を呼ばない）。
 * テストの決定性のためであり、classic の `Date.now()` 直呼びとは意図的に異なる。
 */

/** classic の `ChatMessage.role` と同じ値域。実際に append されるのは `'user'` / `'system'` のみ
 * （`'ai'` は REST 正規化前の一時的な値であり、呼び出し側の境界で `'system'` に変換される）。 */
export type LiteMessageRole = 'user' | 'system' | 'ai';

/** ログ 1 件分。`id` は持たない（独自 ID を発明しない。dedupe は `messageId` と
 * `role`+`content`+`timestampMs` の組のみで行う）。 */
export interface LiteMessage {
  role: LiteMessageRole;
  content: string;
  /** エポックミリ秒。REST 由来は `createdAt` の parse 値、WS 由来は受信時点の `nowMs`。 */
  timestampMs: number;
  /** DB 上のメッセージ ID。REST は常に持つ。WS ライブ受信（特に AI 応答）は無いことがある。 */
  messageId?: string;
}

/** `appendMessage` に渡す新着メッセージ記述子（`timestampMs` は `nowMs` から決まるため持たない）。 */
export interface IncomingLiteMessage {
  role: LiteMessageRole;
  content: string;
  messageId?: string;
}

const RECENT_WINDOW = 5;
const APPEND_DEDUPE_WINDOW_MS = 30000;
const REFRESH_CONTENT_WINDOW_MS = 60000;
const MAX_LOG_SIZE = 50;

function byTimestampAsc(a: LiteMessage, b: LiteMessage): number {
  return a.timestampMs - b.timestampMs;
}

/**
 * WS 受信メッセージをログへ追加する（classic `addMessageToTab()` の重複排除部分の写し）。
 *
 * 規則:
 * 1. ログが空なら重複排除を一切かけずに追加する（classic の `tab.messages.length > 0` ガードと同じ）。
 * 2. `incoming.messageId` があれば**ログ全体**を走査し、一致する行があれば追加せず既存の `log`
 *    参照をそのまま返す（新しい配列を作らない＝呼び出し側が参照比較で「変化なし」を検出できる）。
 * 3. それ以外は**直近 5 件**のみを見て、`role` と `content` が一致し、かつ
 *    `abs(nowMs - 既存行.timestampMs) < 30000` なら重複とみなし追加しない。
 * 4. 追加後の件数が 50 件を超えたら古い方から切り詰める。
 */
export function appendMessage(
  log: readonly LiteMessage[],
  incoming: IncomingLiteMessage,
  nowMs: number
): readonly LiteMessage[] {
  const newMessage: LiteMessage = {
    role: incoming.role,
    content: incoming.content,
    timestampMs: nowMs,
    messageId: incoming.messageId,
  };

  if (log.length === 0) {
    return [newMessage];
  }

  if (incoming.messageId) {
    const idDup = log.some((m) => m.messageId === incoming.messageId);
    if (idDup) return log;
  }

  const recent = log.slice(-RECENT_WINDOW);
  const contentDup = recent.some(
    (m) =>
      m.role === incoming.role &&
      m.content === incoming.content &&
      Math.abs(nowMs - m.timestampMs) < APPEND_DEDUPE_WINDOW_MS
  );
  if (contentDup) return log;

  const next = [...log, newMessage];
  if (next.length > MAX_LOG_SIZE) {
    return next.slice(next.length - MAX_LOG_SIZE);
  }
  return next;
}

/**
 * REST 履歴の取得結果をログへマージする（classic `loadHistory()` の 2 分岐の写し）。
 *
 * - `'replace'`（スレッド切替時）: 既存ログを一切見ず、`history` を `timestampMs` 昇順に
 *   ソートしたものへ丸ごと置換する（classic :2221-2231「他モードのマージ/重複排除を一切通さず」）。
 * - `'refresh'`（同一スレッドの再取得。再接続直後の `onReconnect` 等）:
 *   `history` を正とし、既存ログのうち `history` に無い行だけを残して合流する（classic :2233-2261）。
 *   - `messageId` が `history` の ID 集合に含まれる行は除外（history 側に既にある）
 *   - `history` の最古（`timestampMs` 最小。`history` が空なら `nowMs`）より古い行は stale として除外
 *     （classic `oldestApiTime = chatMessages[0]?.timestamp.getTime() ?? Date.now()` と同じ意味論。
 *     history が空応答なら「今より古いものは全部 stale」になり、事実上ほぼ全除去される。
 *     classic と挙動をそろえるためあえて変更していない）
 *   - 残った行のうち `history` の**いずれか**と `role`+`content` が一致し `timestampMs` の差が
 *     60000ms 未満のものも重複として除外（クライアント生成分と DB 分で `messageId` が違う場合の保険）
 *   - 生き残った行 + `history` を結合し `timestampMs` 昇順で安定ソートする
 *     （同時刻タイでは `history` を先に並べているため history 側が前に来る）
 */
export function mergeHistory(
  log: readonly LiteMessage[],
  history: readonly LiteMessage[],
  mode: 'replace' | 'refresh',
  nowMs: number
): readonly LiteMessage[] {
  if (mode === 'replace') {
    return [...history].sort(byTimestampAsc);
  }

  const idSet = new Set(history.filter((m) => m.messageId).map((m) => m.messageId as string));
  const oldestHistoryMs = history.length > 0 ? Math.min(...history.map((m) => m.timestampMs)) : nowMs;

  const liveOnly = log.filter((live) => {
    if (live.messageId && idSet.has(live.messageId)) return false;
    if (live.timestampMs < oldestHistoryMs) return false;
    const contentDup = history.some(
      (h) => h.role === live.role && h.content === live.content && Math.abs(h.timestampMs - live.timestampMs) < REFRESH_CONTENT_WINDOW_MS
    );
    return !contentDup;
  });

  return [...history, ...liveOnly].sort(byTimestampAsc);
}
