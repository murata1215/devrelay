/**
 * 再起動耐性サイクル（2026-11-25）: 実行中ターンの状況を `apps/server/.runtime/inflight.json` に
 * 定期的に書き出す。
 *
 * `scripts/restart-when-idle` CLI（人間が手で `pm2 restart` / サービス再起動する前に叩く）が
 * HTTP 経由（システム管理者トークンが要る）ではなくこのファイルを直接読むことで、認証の
 * 仕組みを増やさずに「いま誰が会話中か」を見られるようにする。判定ロジックは増やさず、
 * 既存の `getGlobalBusyState()`（会話中ガードと同じ関数）をそのまま書き出すだけ。
 */

import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getGlobalBusyState } from './auto-updater.js';
import { formatBusyReason } from './update-busy-rules.js';
import { RUNTIME_DIR } from './shutdown-marker.js';

export const INFLIGHT_STATE_PATH = path.join(RUNTIME_DIR, 'inflight.json');

/** `DEVRELAY_INFLIGHT_STATE_FILE` の解釈。既定 ON（'0' のときだけ無効化）。 */
export function isInflightStateFileEnabled(raw: string | undefined): boolean {
  return raw !== '0';
}

/** 書き出し間隔（ms）。CLI 側のポーリング間隔より十分短くしておく。 */
const WRITE_INTERVAL_MS = 5000;

let timer: NodeJS.Timeout | null = null;

async function writeOnce(): Promise<void> {
  try {
    const busyState = await getGlobalBusyState();
    mkdirSync(RUNTIME_DIR, { recursive: true });
    writeFileSync(INFLIGHT_STATE_PATH, JSON.stringify({
      updatedAt: new Date().toISOString(),
      busy: busyState !== null,
      busyReason: formatBusyReason(busyState),
    }), 'utf8');
  } catch (err) {
    console.warn('⚠️  inflight state file の書き込みに失敗しました（無視して続行）:', err);
  }
}

/** 起動時に呼ぶ。即時1回書き出し、以降 `WRITE_INTERVAL_MS` 間隔で更新する。 */
export function startInflightStateFile(): void {
  if (!isInflightStateFileEnabled(process.env.DEVRELAY_INFLIGHT_STATE_FILE)) return;
  if (timer) return;
  void writeOnce();
  timer = setInterval(() => void writeOnce(), WRITE_INTERVAL_MS);
  timer.unref();
}

/** 停止処理から呼ぶ。「古い情報を見て CLI が誤判定する」のを避けるためファイルを消す。 */
export function stopInflightStateFile(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  try {
    if (existsSync(INFLIGHT_STATE_PATH)) unlinkSync(INFLIGHT_STATE_PATH);
  } catch {
    // ignore
  }
}
