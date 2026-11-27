/**
 * 再起動耐性サイクル（2026-11-25）: 会話が終わるまで待ってからサーバーを再起動する CLI。
 *
 * 実行方法: `pnpm --filter @devrelay/server restart:when-idle`
 * （`package.json` の `restart:when-idle` スクリプトが `node dist/scripts/restart-when-idle.js`
 * を実行。ビルド済み dist から動かすため、事前に `pnpm build` が必要）
 *
 * オプション:
 *   --status  待たずに現在の状況だけ表示して終了する（再起動しない）
 *   --force   待たずに今すぐ再起動する
 *
 * `POST /api/services/restart/server`（システム管理者トークンが要る）を経由せず、
 * `apps/server/.runtime/inflight.json`（`inflight-state-file.ts` が実行中の本体プロセスから
 * 定期的に書き出す）を直接読む。ローカルシェルから叩くツールなので、新しい認証の仕組みは
 * 増やさない（シェルに入れる＝既にそれだけの信頼がある、という既存の `db:status` と同じ前提）。
 *
 * 再起動コマンドは `DEVRELAY_SERVICE_RESTART_CMD`（既定 `pm2 restart devrelay-server`。
 * 会社サーバー等では `.env` の設定がそのまま使われる＝この CLI 自体は OS 間で変更不要）。
 * 再起動予告の配信・graceful shutdown は実行中のサーバープロセス自身の `SIGTERM` ハンドラ
 * （`index.ts` の `shutdown()`）が担うため、この CLI は「いつ叩くか」だけを決める。
 */

import 'dotenv/config';
import { exec } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { INFLIGHT_STATE_PATH } from '../services/inflight-state-file.js';
import { formatInflightEntryLine, type InflightSessionEntry } from '../services/inflight-detail-rules.js';

const DEFAULT_SERVICE_RESTART_CMD = 'pm2 restart devrelay-server';
const SERVICE_RESTART_CMD = process.env.DEVRELAY_SERVICE_RESTART_CMD || DEFAULT_SERVICE_RESTART_CMD;

/** 待ちの上限（ms）。超えたら諦めてログを出すだけで、勝手に強制再起動はしない。 */
const MAX_WAIT_MS = (() => {
  const parsed = Number.parseInt(process.env.DEVRELAY_RESTART_WAIT_MAX_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15 * 60 * 1000; // 既定15分
})();
/** ポーリング間隔（ms）。state file の書き出し間隔（5秒）より長くする必要はない。 */
const POLL_INTERVAL_MS = 5000;
/** state file がこれより古ければ「サーバーが動いていない/情報不明」として扱う（書き出し間隔の3倍）。 */
const STALE_THRESHOLD_MS = 15000;

interface InflightState {
  updatedAt: string;
  busy: boolean;
  busyReason: string | null;
  /** 追補（2026-11-28）: busy の根拠となっているマシン・スレッドの一覧。旧バージョンのファイル・
   *  `DEVRELAY_INFLIGHT_DETAIL=off` のときはキー自体が無い（従来表示にフォールバックする）。 */
  sessions?: InflightSessionEntry[];
}

/** state file を読む。無い・壊れている・古い場合は null（= 判定不能）。 */
function readState(): InflightState | null {
  try {
    if (!existsSync(INFLIGHT_STATE_PATH)) return null;
    const raw = readFileSync(INFLIGHT_STATE_PATH, 'utf8');
    const state = JSON.parse(raw) as InflightState;
    const ageMs = Date.now() - new Date(state.updatedAt).getTime();
    if (!Number.isFinite(ageMs) || ageMs > STALE_THRESHOLD_MS) return null;
    return state;
  } catch {
    return null;
  }
}

/**
 * 待機ループの「変化したときだけ再表示する」判定に使う、経過時間を含まない識別子。
 * （`describeBusyState()` の出力は経過時間を含むため、そのまま比較すると5秒ごとに毎回
 * 「変化した」扱いになってしまう。内訳自体が変わった場合だけ再表示したい）。
 */
function busySignature(state: InflightState): string {
  if (!state.busy) return 'idle';
  if (!state.sessions || state.sessions.length === 0) return `reason:${state.busyReason ?? ''}`;
  return state.sessions.map(s => `${s.machineName ?? ''}|${s.projectName ?? ''}|${s.label ?? ''}`).join(';');
}

/**
 * busy 状態の表示文字列を組み立てる。`sessions` が無い（旧ファイル・`off` レベル・件数ゼロ）
 * 場合は従来どおり件数ベースの一行表示にフォールバックする。
 */
function describeBusyState(state: InflightState): string {
  if (!state.busy) return '🟢 実行中の会話はありません。';
  if (!state.sessions || state.sessions.length === 0) {
    return `🟡 会話が実行中です: ${state.busyReason ?? '(詳細不明)'}`;
  }
  const lines = state.sessions.map((s, i) => `   ${i + 1}) ${formatInflightEntryLine(s)}`);
  return ['🟡 会話が実行中です:', ...lines].join('\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function runRestartCommand(): Promise<void> {
  console.log(`🔄 再起動コマンドを実行します: ${SERVICE_RESTART_CMD}`);
  return new Promise((resolve, reject) => {
    exec(SERVICE_RESTART_CMD, (err, stdout, stderr) => {
      if (stdout) console.log(stdout.trim());
      if (stderr) console.error(stderr.trim());
      if (err) {
        reject(err);
        return;
      }
      console.log('✅ 再起動コマンドの実行が完了しました（サーバーの起動完了は別途確認してください）。');
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const statusOnly = args.includes('--status');
  const force = args.includes('--force');

  if (statusOnly) {
    const state = readState();
    if (state === null) {
      console.log('ℹ️  状況不明です（サーバーが起動していない、または情報が古い可能性があります）。');
      return;
    }
    console.log(describeBusyState(state));
    return;
  }

  if (force) {
    await runRestartCommand();
    return;
  }

  const deadline = Date.now() + MAX_WAIT_MS;
  let waited = false;
  let lastPrinted: string | null = null;
  while (Date.now() < deadline) {
    const state = readState();
    if (state === null || !state.busy) {
      if (waited) console.log('🟢 会話が終わりました。再起動します。');
      await runRestartCommand();
      return;
    }
    if (!waited) {
      console.log(`⏳ 終わるまで待ちます（最大 ${Math.round(MAX_WAIT_MS / 60000)} 分、--force で今すぐ再起動できます）。`);
      waited = true;
    }
    // 内訳（誰の会話か）は待っている間に変わりうるため、変化したときだけ再表示する
    // （経過時間だけが進む5秒ごとの連打を避けるため、比較は busySignature（経過時間を含まない）で行う）。
    const signature = busySignature(state);
    if (signature !== lastPrinted) {
      console.log(describeBusyState(state));
      lastPrinted = signature;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  console.error(`⚠️  ${Math.round(MAX_WAIT_MS / 60000)} 分待ちましたが会話が終わりませんでした。再起動しませんでした。--force で強制するか、会話の終了を待ってから再実行してください。`);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error('❌ restart-when-idle の実行に失敗しました:', err);
  process.exitCode = 1;
});
