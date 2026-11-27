/**
 * 再起動耐性サイクル（2026-11-25）: 停止処理の自己診断（`apps/server/.runtime/shutdown.json`）。
 *
 * pm2 の `kill_timeout`（既定 1600ms）・NSSM の停止猶予（既定 1500ms）のどちらも、
 * 「予告配信 → `app.close()` → bot 破棄 → Prisma 切断」を全部終えるには短すぎる可能性がある。
 * ここでは設定を伸ばすようユーザーに頼むのではなく、停止処理の予算（`DEVRELAY_SHUTDOWN_GRACE_MS`）
 * 自体をそれらの既定値に収める方針を取る（`index.ts` の `shutdown()` 参照）。
 *
 * それでも「本当に収まっているか」は環境によって変わりうるため、停止開始時にマーカーファイルを
 * 書き、片付けが完走したら消す。次の起動時にマーカーが残っていれば「前回の停止は途中で
 * 強制終了された」証拠として起動ログに警告を出す（fail-open: 読み書きできない環境でも起動は続行する）。
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** `apps/server/.runtime/`。dist/services/ と src/services/ のどちらから実行しても同じ相対位置。 */
export const RUNTIME_DIR = path.resolve(__dirname, '../../.runtime');
export const SHUTDOWN_MARKER_PATH = path.join(RUNTIME_DIR, 'shutdown.json');

/** `DEVRELAY_SHUTDOWN_MARKER` の解釈。既定 ON（'0' のときだけ無効化）。 */
export function isShutdownMarkerEnabled(raw: string | undefined): boolean {
  return raw !== '0';
}

interface ShutdownMarker {
  signal: string;
  pid: number;
  startedAt: string;
}

/** 停止処理の開始時に呼ぶ。書き込みに失敗しても無視する（fail-open）。 */
export function writeShutdownMarker(signal: string): void {
  if (!isShutdownMarkerEnabled(process.env.DEVRELAY_SHUTDOWN_MARKER)) return;
  try {
    mkdirSync(RUNTIME_DIR, { recursive: true });
    const marker: ShutdownMarker = { signal, pid: process.pid, startedAt: new Date().toISOString() };
    writeFileSync(SHUTDOWN_MARKER_PATH, JSON.stringify(marker), 'utf8');
  } catch (err) {
    console.warn('⚠️  shutdown marker の書き込みに失敗しました（無視して続行）:', err);
  }
}

/** 停止処理が完走した直後（`process.exit()` の直前）に呼ぶ。削除に失敗しても無視する。 */
export function clearShutdownMarker(): void {
  if (!isShutdownMarkerEnabled(process.env.DEVRELAY_SHUTDOWN_MARKER)) return;
  try {
    if (existsSync(SHUTDOWN_MARKER_PATH)) unlinkSync(SHUTDOWN_MARKER_PATH);
  } catch (err) {
    console.warn('⚠️  shutdown marker の削除に失敗しました（無視して続行）:', err);
  }
}

/**
 * 起動時に呼ぶ。マーカーが残っていれば「前回の停止は途中で強制終了された」ことを示す
 * 警告文字列を返す（無ければ null）。読み取り失敗時は null を返す（fail-open。
 * 警告を出せないだけで起動は妨げない）。
 *
 * 2026-11-25 時点の設計では、停止処理の予算（`DEVRELAY_SHUTDOWN_GRACE_MS`、既定1.2秒）を
 * pm2/NSSM の既定の停止猶予に収めることを基本方針にしているため、通常はこの警告は出ない
 * はず（出た場合は `DEVRELAY_SHUTDOWN_GRACE_MS` を環境に合わせて調整するか、サービス
 * マネージャ側の停止猶予自体を伸ばすことを検討する）。
 */
export function checkPreviousShutdown(): string | null {
  if (!isShutdownMarkerEnabled(process.env.DEVRELAY_SHUTDOWN_MARKER)) return null;
  try {
    if (!existsSync(SHUTDOWN_MARKER_PATH)) return null;
    const raw = readFileSync(SHUTDOWN_MARKER_PATH, 'utf8');
    const marker = JSON.parse(raw) as ShutdownMarker;
    // 読めた以上は必ず消す（次回起動で同じ警告を繰り返さないため）
    try { unlinkSync(SHUTDOWN_MARKER_PATH); } catch { /* ignore */ }

    return `⚠️  前回の停止（signal=${marker.signal}, pid=${marker.pid}, at=${marker.startedAt}）は正常完了のマーカーが消えていません。` +
      `停止処理が途中で強制終了された可能性があります（DEVRELAY_SHUTDOWN_GRACE_MS を確認、` +
      `または pm2 の kill_timeout / NSSM の AppStopMethod* を伸ばすことを検討してください）。`;
  } catch (err) {
    console.warn('⚠️  shutdown marker の読み取りに失敗しました（無視して続行）:', err);
    return null;
  }
}
