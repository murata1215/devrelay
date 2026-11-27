/**
 * 再起動耐性サイクル（2026-11-25）: サーバー WebSocket が非 OPEN のときに送信できなかった
 * メッセージをどう扱うかの純粋判定（外部 import ゼロ、`update-guard-rules.ts` と同じ流儀）。
 *
 * 背景: 従来の `sendMessage()`（connection.ts）は `ws.readyState !== OPEN` のとき
 * メッセージを**黙って破棄**していた（else 節なし）。サーバー再起動中に AI がターンを完了すると、
 * その完了報告（`agent:ai:output` の `isComplete: true`）がちょうどこの瞬間に送られ、
 * キューも再送も無いまま永久に失われていた。これが「サーバー再起動で会話中の応答が消える」の
 * 技術的な根因。
 *
 * ここでの方針: 全部を無条件に溜めるのではなく、メッセージの種別で「失ってはいけないもの」
 * （完了報告・ツール承認要求・ガード通知）と「失っても実害が小さいもの」（途中出力・ping・
 * 専用経路で送り直す接続系）を区別する。後者を優先して間引くことで、長時間の切断でも
 * メモリを無制限に消費しない。
 */

/** outbox への積み方。`'drop'` は outbox に積まず従来どおり即時に捨てる。 */
export type OutboxDecision = 'queue-must' | 'queue-best-effort' | 'drop';

/** `decideOutboxAction()` の入力（型の広さを絞った最小限の形。AgentMessage 全体に依存しない）。 */
export interface OutboxDecisionInput {
  type: string;
  /** `agent:ai:output` の場合のみ意味を持つ（isComplete=true かどうかで must/best-effort が分かれる） */
  isComplete?: boolean;
}

/**
 * メッセージ種別ごとの outbox 方針を決める。
 * - `agent:ai:output`（isComplete:true、= 完了報告の本体）: 必ず残す
 * - `agent:tool:approval:request`（承認待ち）: 必ず残す（届かないと人間が永久に気づけない）
 * - `agent:ai:output`（isComplete:false、= 途中出力）: best-effort（溢れたら真っ先に捨てる対象）
 * - `agent:ping` / `agent:connect` 等の即時性のみの専用メッセージ: outbox に積まない
 *   （`agent:ping` は次の ping で上書きされる情報であり再送の意味が無い。`agent:connect` は
 *   再接続時に専用の経路で必ず送り直されるため積む必要が無い）
 * - その他（履歴応答・ファイル内容応答・バージョン情報等）: best-effort
 */
export function decideOutboxAction(input: OutboxDecisionInput): OutboxDecision {
  if (input.type === 'agent:ai:output') {
    return input.isComplete ? 'queue-must' : 'queue-best-effort';
  }
  if (input.type === 'agent:tool:approval:request') return 'queue-must';
  if (input.type === 'agent:ping' || input.type === 'agent:connect') return 'drop';
  return 'queue-best-effort';
}

/** outbox に積む 1 エントリ（JSON 文字列化済み。サイズは `Buffer.byteLength` 等で呼び出し側が算出）。 */
export interface OutboxEntry {
  /** 送信する JSON 文字列（`ws.send()` にそのまま渡す）。 */
  json: string;
  /** バイト数（UTF-8）。呼び出し側が `Buffer.byteLength(json, 'utf8')` 等で算出して渡す。 */
  sizeBytes: number;
  /** `decideOutboxAction()` が `'queue-must'` を返したエントリか。 */
  mustKeep: boolean;
}

/**
 * outbox の上限超過時に間引く（古い順）。優先順位:
 * 1. best-effort（`mustKeep: false`）を古い順に捨てる
 * 2. それでも超過していれば must-keep も古い順に捨てる（メモリ無制限成長を防ぐ最後の手段。
 *    既定の上限であればここに到達することは想定していない）
 *
 * 件数・バイト数のどちらか一方でも超えていれば間引きを続ける。入力配列は変更しない
 * （新しい配列を返す。呼び出し側の再代入を前提にする）。
 */
export function trimOutbox(
  entries: OutboxEntry[],
  limits: { maxEntries: number; maxBytes: number }
): { kept: OutboxEntry[]; droppedMust: number; droppedBestEffort: number } {
  let kept = entries.slice();
  let droppedMust = 0;
  let droppedBestEffort = 0;

  const totalBytes = () => kept.reduce((sum, e) => sum + e.sizeBytes, 0);
  const overLimit = () => kept.length > limits.maxEntries || totalBytes() > limits.maxBytes;

  // 1. best-effort を古い順に削る
  while (overLimit()) {
    const idx = kept.findIndex(e => !e.mustKeep);
    if (idx === -1) break;
    kept.splice(idx, 1);
    droppedBestEffort++;
  }

  // 2. まだ超過していれば must-keep も古い順に削る（最後の手段）
  while (overLimit() && kept.length > 0) {
    kept.splice(0, 1);
    droppedMust++;
  }

  return { kept, droppedMust, droppedBestEffort };
}
