/**
 * 再起動耐性サイクル（2026-11-25）: 実行中ターンの状況を `apps/server/.runtime/inflight.json` に
 * 定期的に書き出す。
 *
 * `scripts/restart-when-idle` CLI（人間が手で `pm2 restart` / サービス再起動する前に叩く）が
 * HTTP 経由（システム管理者トークンが要る）ではなくこのファイルを直接読むことで、認証の
 * 仕組みを増やさずに「いま誰が会話中か」を見られるようにする。判定ロジックは増やさず、
 * 既存の `getGlobalBusyState()`（会話中ガードと同じ関数）をそのまま書き出すだけ。
 *
 * 追補（2026-11-28）: 実機で「誰も会話していないはずなのに busy と出る」という誤解が起きた
 * （正体は別マシンの会話だった）。`DEVRELAY_INFLIGHT_DETAIL` が `off` でなければ、busy の根拠と
 * なっているマシン名・プロジェクト名・スレッド見出し（`sessions` キー）も書き出す。
 * `label`（スレッド見出し＝会話の内容）は `off`/`id` レベルでは一切書かない（ファイル権限を
 * 600 に絞っているとはいえ、載せる情報の濃さを選べるようにするため）。
 */

import { writeFileSync, unlinkSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { getGlobalBusyState } from './auto-updater.js';
import { getGlobalBusyDetails } from './inflight-busy-detail.js';
import { formatBusyReason } from './update-busy-rules.js';
import { RUNTIME_DIR } from './shutdown-marker.js';
import { resolveInflightDetailLevel, type InflightSessionEntry } from './inflight-detail-rules.js';

export const INFLIGHT_STATE_PATH = path.join(RUNTIME_DIR, 'inflight.json');

/** `DEVRELAY_INFLIGHT_STATE_FILE` の解釈。既定 ON（'0' のときだけ無効化）。 */
export function isInflightStateFileEnabled(raw: string | undefined): boolean {
  return raw !== '0';
}

/** 書き出し間隔（ms）。CLI 側のポーリング間隔より十分短くしておく。 */
const WRITE_INTERVAL_MS = 5000;
/**
 * このファイルのパーミッション（所有者のみ読み書き）。`sessions` にスレッド見出しを含みうる
 * ため、他の OS ユーザーに読ませない。旧バージョン（644 で作成）からの移行者のために、
 * 書き込みのたびに明示的に `chmodSync` で揃える（`writeFileSync` の `mode` は新規作成時にしか
 * 効かないため）。
 */
const FILE_MODE = 0o600;

let timer: NodeJS.Timeout | null = null;

async function writeOnce(): Promise<void> {
  try {
    const busyState = await getGlobalBusyState();
    const busy = busyState !== null;
    const detailLevel = resolveInflightDetailLevel(process.env.DEVRELAY_INFLIGHT_DETAIL);

    let sessions: InflightSessionEntry[] | undefined;
    if (busy && detailLevel !== 'off') {
      try {
        const details = await getGlobalBusyDetails();
        sessions = details.map(d => ({
          ...d,
          // 'id' レベルでは見出し（会話の内容）をファイルに一切書かない。
          label: detailLevel === 'label' ? d.label : null,
        }));
      } catch (err) {
        console.warn('⚠️  busy 詳細の取得に失敗しました（件数のみ記録します）:', err);
      }
    }

    mkdirSync(RUNTIME_DIR, { recursive: true });
    writeFileSync(INFLIGHT_STATE_PATH, JSON.stringify({
      updatedAt: new Date().toISOString(),
      busy,
      busyReason: formatBusyReason(busyState),
      ...(sessions !== undefined ? { sessions } : {}),
    }), { mode: FILE_MODE });
    chmodSync(INFLIGHT_STATE_PATH, FILE_MODE);
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
