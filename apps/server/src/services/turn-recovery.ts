/**
 * 再起動耐性サイクル（2026-11-25）: 起動の先頭で「再起動前から実行中だったターン」を引き継ぐ。
 *
 * 既存の起動時メンテナンス（`index.ts`）には2つの構造的な欠陥があった:
 * 1. `teamexec_` / `crossquery_` / `raw_` で始まる active セッションを**無条件で** `ended` にする
 *    （#294 由来）。これは本来「HTTP リクエストの生存期間しか意味を持たない一時セッションの
 *    残骸掃除」が目的だったが、再起動の瞬間に本当に実行中だったクロス ask / MCP exec も
 *    同じ条件に引っかかり、ended にされてしまう（会話が「終了済み」として巻き戻る）。
 * 2. 再起動後に届いた途中出力は `progressTrackers` が無いため捨てられ（`appendSessionOutput`）、
 *    「実行中... N分経過」の表示も無応答タイムアウトの安全網も戻らなかった
 *    （`session-manager.ts` の `ensureTrackerForLateOutput()` で受け口は直したが、起動直後に
 *    能動的に復元すればより早く安全網が戻る）。
 *
 * ここでは「サーバー再起動前から実行中だったセッション」を DB だけから判定する
 * （この時点ではメモリ上の `inFlightTurns`/`progressTrackers` は空）。判定基準は
 * 「active セッションの直近メッセージが `role='user'`（まだ `role='ai'` の返信が無い）かつ
 * その経過時間が `PROGRESS_HARD_TIMEOUT`（既定150分、ソフト/ハードタイムアウトと同じ基準）以内」。
 *
 * `DEVRELAY_TURN_RECOVERY=0` で無効化できる（従来どおり①の無条件 ended・②の出力ロストに戻る
 * キルスイッチ）。
 */

import { prisma } from '../db/client.js';
import { inFlightTurns } from './in-flight-turns.js';
import { ensureTrackerForLateOutput, PROGRESS_HARD_TIMEOUT } from './session-manager.js';

/** `DEVRELAY_TURN_RECOVERY` の解釈。既定 ON（'0' のときだけ無効化）。 */
export function isTurnRecoveryEnabled(raw: string | undefined): boolean {
  return raw !== '0';
}

export interface InFlightCandidate {
  sessionId: string;
  machineId: string;
}

/**
 * 「再起動前から実行中だったと推定できる」active セッションを DB から探す。
 * `DEVRELAY_TURN_RECOVERY=0` のときは常に空配列（呼び出し側の除外ロジックも実質 no-op になる）。
 */
export async function findInFlightCandidates(): Promise<InFlightCandidate[]> {
  if (!isTurnRecoveryEnabled(process.env.DEVRELAY_TURN_RECOVERY)) return [];

  const since = new Date(Date.now() - PROGRESS_HARD_TIMEOUT);
  const rows = await prisma.$queryRaw<Array<{ id: string; machineId: string }>>`
    SELECT s.id, s."machineId" FROM "Session" s
    WHERE s.status = 'active'
    AND EXISTS (
      SELECT 1 FROM "Message" lm
      WHERE lm."sessionId" = s.id
      AND lm.role = 'user'
      AND lm."createdAt" = (SELECT MAX(m."createdAt") FROM "Message" m WHERE m."sessionId" = s.id)
      AND lm."createdAt" > ${since}
    )
  `;
  return rows.map(r => ({ sessionId: r.id, machineId: r.machineId }));
}

/**
 * 見つかった候補を実際に復元する: 実行中ターン台帳に再登録し、進捗トラッカーを再武装する。
 * `restoreSessionParticipants()` より後に呼ぶこと（参加者が無くても tracker 自体は作れるが、
 * 配信は参加者復元後の定期更新で初めて行われる）。
 */
export async function recoverInFlightTurns(candidates: InFlightCandidate[]): Promise<void> {
  if (candidates.length === 0) return;
  const now = Date.now();
  for (const { sessionId, machineId } of candidates) {
    inFlightTurns.start(machineId, sessionId, now);
    try {
      await ensureTrackerForLateOutput(sessionId);
    } catch (err) {
      console.error(`⚠️  Failed to re-arm progress tracker for recovered session ${sessionId}:`, err);
    }
  }
  console.log(`🔁 Recovered ${candidates.length} in-flight turn(s) from before restart`);
}
