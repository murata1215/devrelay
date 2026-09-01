/**
 * 自動更新（`u`）の直前試行結果を確定させる判定ロジック（#351）。
 *
 * 背景: `reconcileLastAttempt()`（`auto-updater.ts`）は従来 `status === 'pending'` の
 * ときにしか照合しておらず（早期 return）、一度 `timeout:...` のようなステータスに
 * 落ちると、その後どれだけ健全な状態（`localCommit === lastAttemptCommit` かつ
 * `runningCodeStale === false`）になっても照合が走らず `lastAutoUpdateStatus` が
 * 永久に `timeout:...` のまま残ってしまっていた。
 *
 * 実例（DESKTOP-1JR1NLL/c-shiraki, 2026-09-01）: `runningCodeStale` は既に `false`
 * （＝直近の手動インストーラー再実行で正常化済み）で成功の証拠が揃っているのに、
 * `lastAutoUpdateStatus` は前回試行時に記録された `timeout:...` のまま残り、
 * `autoUpdateAttempts` もリセットされず `MAX_ATTEMPTS_PER_COMMIT`（2）に近い状態が
 * 維持されていた。同一コミットであと 1 回自動更新が失敗すれば
 * `evaluateAutoUpdateGates()` の disable ゲートが発火し、自動更新から永久に
 * 外れてしまう（人が気づいて手動 `u` を送るまで stale dist のまま放置される）。
 *
 * この判定関数は「成功の証拠が揃っているなら、過去のステータスが何であれ
 * success に確定させる」よう早期 return を緩める。`evaluateAutoUpdateGates()`
 * （別軸のゲート判定）は一切変更しない。
 *
 * 外部 import ゼロに保ち、コンパイル済み dist を直接 `node --test` から import して
 * 単体検証できるようにする（agent-update-decision.ts / cross-query-guard.ts と同じ流儀）。
 */

export interface ReconcileInput {
  /** Agent が version-check で自己申告した実行中コミット */
  localCommit: string;
  /** 直近の自動更新試行で狙ったコミット（未試行なら null） */
  lastAttemptCommit: string | null;
  /** 直前に記録された lastAutoUpdateStatus（'pending' / 'success' / 'timeout:...' 等） */
  status: string | null;
  /** 実行中エントリファイルの mtime がローカルコミットより古いか（#302 の三値分岐） */
  runningCodeStale: boolean | undefined;
  /** 直近の自動更新試行日時（pending 滞留の timeout 判定に使う） */
  lastAttemptAt: Date | null;
  /** 判定基準時刻（ミリ秒） */
  nowMs: number;
  /** pending が timeout とみなされるまでの猶予（ミリ秒） */
  pendingTimeoutMs: number;
}

export type ReconcileOutcome =
  | { action: 'none' }
  | { action: 'success' }
  | { action: 'success:unverified' }
  | { action: 'timeout'; detail: string };

/**
 * 前回の自動更新試行の結果を確定する。
 *
 * 判定順（この順序を変えないこと）:
 * 1. `lastAttemptCommit` が無ければ 'none'（判定材料なし＝まだ一度も自動更新を試みていない）
 * 2. commit 一致 && `runningCodeStale === false` → 'success'
 *    （**`status` を条件にしない** のが #351 の修正点。`pending` でも `timeout:...` でも、
 *    成功の証拠が揃っているなら success として確定させる）
 * 3. commit 一致 && `runningCodeStale === undefined` →
 *    `status === 'pending'` のときだけ 'success:unverified'、それ以外は 'none'
 *    （旧 Agent はビルド鮮度を自己申告できない。timeout を根拠なく success に書き換えない＝fail-safe）
 * 4. `status !== 'pending'` → 'none'（既に決着済み。timeout を二重に記録しない）
 * 5. `lastAttemptAt` から `pendingTimeoutMs` 超過 → 'timeout'（従来どおり）
 * 6. それ以外 → 'none'
 */
export function decideReconcileOutcome(input: ReconcileInput): ReconcileOutcome {
  if (!input.lastAttemptCommit) {
    return { action: 'none' };
  }

  const commitMatches = input.localCommit === input.lastAttemptCommit;

  if (commitMatches) {
    if (input.runningCodeStale === false) {
      return { action: 'success' };
    }
    if (input.runningCodeStale === undefined) {
      return input.status === 'pending' ? { action: 'success:unverified' } : { action: 'none' };
    }
    // runningCodeStale === true はここを通らず下の pending/timeout 経路へ
  }

  if (input.status !== 'pending') {
    return { action: 'none' };
  }

  const detail = input.runningCodeStale ? 'running code is stale (rebuild did not take effect)' : 'commit unchanged';
  if (input.lastAttemptAt && input.nowMs - input.lastAttemptAt.getTime() > input.pendingTimeoutMs) {
    return { action: 'timeout', detail };
  }

  return { action: 'none' };
}
