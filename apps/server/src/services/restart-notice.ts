/**
 * 再起動耐性サイクル（2026-11-25）: サーバー再起動の予告を、まだ正常稼働しているうちに
 * 全 WebUI クライアント・全 Agent へ best-effort で配信する。
 *
 * これまでの `POST /api/services/restart/server` は何の予告もせずに再起動コマンドを叩き、
 * `shutdown()`（index.ts）も停止信号を受けてから死ぬだけで誰にも知らせなかった。
 * 予告を「停止信号を受けてから」ではなく「まだ元気なうちに」送ることで、配信そのものは
 * 正常なプロセス内で完了する（＝ pm2/nssm の停止猶予やプロセスの寿命と無関係になる）。
 * 届かなくても実害はない（Agent・WebUI は既存の無期限リトライで自力復帰する）ため、
 * 失敗はログのみで握りつぶす。
 *
 * `DEVRELAY_RESTART_NOTICE_WAIT_MS` の既定 800ms は「予告を送ってから実際に再起動コマンドを
 * 叩くまでの待ち」。WebSocket の送信自体は同期的にバッファへ積まれるため、OS のネットワーク
 * スタックに渡るまでの猶予として十分な値（実測の必要は薄いが、TCP の送信バッファに積まれてから
 * 実際に書き出されるまでの遅延を吸収する）。
 */

import { getConnectedAgents, sendToAgent } from './agent-manager.js';
import { broadcastWebRawMessage } from '../platforms/web.js';

/** `DEVRELAY_RESTART_NOTICE_WAIT_MS` の既定値・clamp 範囲（ms） */
const DEFAULT_NOTICE_WAIT_MS = 800;
const MIN_NOTICE_WAIT_MS = 0;
const MAX_NOTICE_WAIT_MS = 5000;

/**
 * `DEVRELAY_RESTART_NOTICE_WAIT_MS` を解決する（clamp・NaN フォールバックつき）。
 */
export function resolveRestartNoticeWaitMs(raw: string | undefined): number {
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_NOTICE_WAIT_MS;
  return Math.min(MAX_NOTICE_WAIT_MS, Math.max(MIN_NOTICE_WAIT_MS, parsed));
}

/**
 * 予告の有効判定（既定 ON。'0' のときだけ無効化する既存キルスイッチの流儀）。
 */
export function isRestartNoticeEnabled(raw: string | undefined): boolean {
  return raw !== '0';
}

/**
 * 全 WebUI クライアント・全 Agent へ再起動予告をブロードキャストする。
 * 戻り値は配信先数（ログ用。0 件でも異常ではない＝誰も繋いでいないだけ）。
 * `DEVRELAY_RESTART_NOTICE=0` のときは何もせず `{ web: 0, agents: 0 }` を返す。
 */
export function broadcastRestartingNotice(noticeMs: number): { web: number; agents: number } {
  if (!isRestartNoticeEnabled(process.env.DEVRELAY_RESTART_NOTICE)) {
    return { web: 0, agents: 0 };
  }

  let web = 0;
  try {
    web = broadcastWebRawMessage({ type: 'web:server:restarting', payload: { noticeMs } });
  } catch (err) {
    console.error('⚠️  Failed to broadcast restart notice to web clients:', err);
  }

  let agents = 0;
  try {
    for (const machineId of getConnectedAgents().keys()) {
      sendToAgent(machineId, { type: 'server:restarting', payload: { noticeMs } });
      agents++;
    }
  } catch (err) {
    console.error('⚠️  Failed to broadcast restart notice to agents:', err);
  }

  return { web, agents };
}
