/**
 * Lite シェル L4 B0: 送信直後の「自分の発言」を `messages`（REST/WS 由来の確定ログ）の外側で
 * 保持し、レンダー時に合成表示するための純ロジック。外部 import ゼロ（`lite-message-log.ts` と
 * 同じ流儀）。
 *
 * **背景（R1/R2、プラン参照）**: `apps/server/src/platforms/web.ts` の `web:user_message` broadcast
 * は送信者自身の chatId を除外するため、Lite タブは自分の発言を WS 経由で二度と受け取らない。
 * かつ `lite-message-log.ts` の `mergeHistory('replace' | 'refresh')` は history が空のとき
 * live 専用エントリを消してしまう。そのため「送信直後の自分の発言」を `messages` の state に
 * 直接 push する方式は使えない（消える）。
 *
 * **設計方針**: 送信時に作った `OutboxEntry` を `messages` とは別の state に保持し、
 * `composeDisplayMessages()` で**レンダーのたびに純粋に**合成する（state へ書き戻さない）。
 * これにより React 18 StrictMode の二重呼び出しに対しても安全（副作用が無いため冪等）。
 * REST 履歴が確定した user メッセージ（`messageId` 付き）を含むようになった時点で、
 * 貪欲な 1:1 マッチングによりそのエントリは表示から外れる（＝サーバー確定へ差し替わったように見える）。
 *
 * `nowMs` は呼び出し側が注入する（モジュール内で `Date.now()` を呼ばない、`clientId` の生成も
 * 呼び出し側の責務）。
 */

/** `lite-message-log.ts` の `LiteMessage` と構造的に互換な最小型。ここでは import しない
 * （外部 import ゼロの不変条件のため、構造的に互換な最小型をこのモジュールに独自定義する）。 */
export interface LiteMessageLike {
  role: 'user' | 'system' | 'ai';
  content: string;
  timestampMs: number;
  messageId?: string;
}

/**
 * 送信中・未確定の自分の発言 1 件分。
 *
 * - `clientId`: 呼び出し側が `crypto.randomUUID()` 等で生成する一意な ID（`removeOutbox` の
 *   キーおよび `composeDisplayMessages` が合成する表示用エントリの `messageId` に使う）。
 * - `knownMessageIds`: 送信を開始した時点で `messages` に既に存在していた user メッセージの
 *   `messageId` 集合のスナップショット。これに含まれる `messageId` を持つ既存メッセージとは
 *   マッチさせない（過去の同一文面の送信履歴と誤って照合し、消し損ねる/誤って消すことを防ぐ）。
 */
export interface OutboxEntry {
  readonly clientId: string;
  readonly sessionId: string;
  readonly content: string;
  readonly createdAtMs: number;
  readonly knownMessageIds: readonly string[];
}

/** 保持する未確定エントリの上限件数。無限増殖を防ぐ（通常は 1〜2 件程度で消化される想定）。 */
export const OUTBOX_MAX_ENTRIES = 8;

/** outbox に新しいエントリを追加する（非破壊。上限超過分は古い方から切り詰める）。 */
export function appendOutbox(
  outbox: readonly OutboxEntry[],
  entry: OutboxEntry
): readonly OutboxEntry[] {
  const next = [...outbox, entry];
  if (next.length > OUTBOX_MAX_ENTRIES) {
    return next.slice(next.length - OUTBOX_MAX_ENTRIES);
  }
  return next;
}

/** `clientId` が一致するエントリを outbox から取り除く（非破壊）。送信失敗時のロールバックや、
 * 履歴取得完了後の明示的な後始末に使う（呼ばなくても `composeDisplayMessages` は正しく動く）。 */
export function removeOutbox(
  outbox: readonly OutboxEntry[],
  clientId: string
): readonly OutboxEntry[] {
  return outbox.filter((e) => e.clientId !== clientId);
}

/**
 * `messages`（確定ログ）と `outbox`（未確定の自分の発言）をレンダー時に合成する。
 *
 * 手順:
 * 1. `sessionId` に一致する outbox エントリのみを対象にする（画面遷移で消さない。戻ってくれば
 *    再度対象になる。`sessionId` が null/undefined なら対象ゼロ）。
 * 2. 対象エントリを送信順に走査し、`messages` のうち `role === 'user'` かつ `messageId` を持ち、
 *    かつその `messageId` が `entry.knownMessageIds` に**含まれず**、かつ `content` が完全一致する
 *    最初の未使用行と貪欲に 1:1 マッチングする（同一文面の連投にも対応）。
 * 3. マッチしたエントリは表示から外れる（サーバー確定側に反映されたとみなす）。
 * 4. マッチしなかったエントリのみ `messages` の**末尾に追記**する（クライアント時計とサーバー時計を
 *    跨いだ比較・再ソートは一切行わない）。
 *
 * 対象エントリが 0 件なら `messages` と同一参照をそのまま返す（不要な再レンダーを防ぐ）。
 */
export function composeDisplayMessages(
  messages: readonly LiteMessageLike[],
  outbox: readonly OutboxEntry[],
  sessionId: string | null
): readonly LiteMessageLike[] {
  if (outbox.length === 0) return messages;

  const relevant = sessionId ? outbox.filter((e) => e.sessionId === sessionId) : [];
  if (relevant.length === 0) return messages;

  const usedIndices = new Set<number>();
  const pending: OutboxEntry[] = [];

  for (const entry of relevant) {
    let matchedIndex = -1;
    for (let i = 0; i < messages.length; i++) {
      if (usedIndices.has(i)) continue;
      const m = messages[i];
      if (m.role !== 'user') continue;
      if (!m.messageId) continue;
      if (entry.knownMessageIds.includes(m.messageId)) continue;
      if (m.content !== entry.content) continue;
      matchedIndex = i;
      break;
    }
    if (matchedIndex >= 0) {
      usedIndices.add(matchedIndex);
    } else {
      pending.push(entry);
    }
  }

  if (pending.length === 0) return messages;

  const pendingMessages: LiteMessageLike[] = pending.map((entry) => ({
    role: 'user',
    content: entry.content,
    timestampMs: entry.createdAtMs,
    messageId: entry.clientId,
  }));

  return [...messages, ...pendingMessages];
}
