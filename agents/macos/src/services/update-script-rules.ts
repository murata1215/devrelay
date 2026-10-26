/**
 * `u` 自己更新スクリプト（Linux/macOS の bash 版、`connection.ts` の `handleAgentUpdate`）を組み立てる
 * bash 断片を純粋関数として切り出したもの。
 *
 * 背景（2026-10-26 障害の真因）: 未コミットファイルを import するコミット（fd95657）を `u` した際、
 * 次の 2 つの穴が重なって Agent が停止し、チャットから会話できなくなった。
 *
 * 1. 旧 `runAndLog` は `cmd; echo "[$(date ...)] label exit=$?"` という形で、同じ echo 内の
 *    `$(date ...)` が `$?` より先に評価されるため、**常に date の終了コード（0）を記録していた**。
 *    tsc が失敗しても update.log には `agent build exit=0` と出ていた。
 * 2. ビルド結果を判定せず、`dist/index.js` の存在だけで再起動していた。tsc は型エラーでも
 *    JS を出力する（noEmitOnError なし）ため、壊れた dist で再起動 → `ERR_MODULE_NOT_FOUND` で即死。
 *
 * 修正: 終了コードは評価直後に `RC` へ退避してから記録する。ビルドは `BUILD_OK` で判定し、
 * 失敗時は再起動せず（旧 Agent はメモリ上の旧コードで動き続ける）、更新前のコミット `PREV_HEAD` に
 * 戻して再ビルドし dist を元に戻す（戻さないと次回の @reboot で壊れた dist が起動してしまう）。
 * 旧 Agent が生き残るので、サーバー側の更新タイムアウト通知（5 分）でユーザーにも失敗が伝わる。
 *
 * 外部 import ゼロに保つ（`crontab-fix-rules.ts` / `node-bin-path.ts` と同じ流儀）。
 * agents/linux と agents/macos で同一内容。
 */

/** bash の 1 ステップ（ラベルと実行コマンド） */
export interface UpdateStep {
  label: string;
  cmd: string;
}

/** タイムスタンプ付きで update.log に 1 行追記する bash コマンド */
export function buildLogCommand(logFile: string, msg: string): string {
  return `echo "[$(date '+%Y-%m-%d %H:%M:%S')] ${msg}" >> "${logFile}"`;
}

/**
 * コマンドを実行し、出力と終了コードを update.log に記録する。終了コードは `$RC` に残る。
 * `RC=$?` を `$(date ...)` を含む echo より前に置くのが要点（上記 1 の回帰防止）。
 */
export function buildRunAndLog(logFile: string, label: string, cmd: string): string {
  return `${buildLogCommand(logFile, label)}; ${cmd} >> "${logFile}" 2>&1; RC=$?; ${buildLogCommand(logFile, `${label} exit=$RC`)}`;
}

/**
 * ビルドステップを順に実行し、1 つでも失敗したら `BUILD_OK=0` にする（後続ステップは実行しない）。
 */
export function buildCheckedBuildSteps(logFile: string, steps: UpdateStep[]): string {
  const parts = ['BUILD_OK=1'];
  for (const step of steps) {
    parts.push(
      `if [ "$BUILD_OK" = "1" ]; then ${buildRunAndLog(logFile, step.label, step.cmd)}; if [ "$RC" != "0" ]; then BUILD_OK=0; fi; fi`,
    );
  }
  return parts.join('; ');
}

/** 更新前のコミットを `PREV_HEAD` に記録する（git reset より前に置く） */
export function buildRecordPrevHead(): string {
  return 'PREV_HEAD=$(git rev-parse HEAD 2>/dev/null || echo "")';
}

/**
 * ビルド失敗時に `PREV_HEAD` へ戻して再ビルドし、dist を旧 Agent のコードに戻す。
 * ビルド成功時（`BUILD_OK=1`）は何もしない。
 */
export function buildRollbackOnBuildFailure(logFile: string, rebuildSteps: UpdateStep[]): string {
  const rebuild = rebuildSteps.map((s) => buildRunAndLog(logFile, `rollback: ${s.label}`, s.cmd)).join('; ');
  return [
    `if [ "$BUILD_OK" != "1" ]; then`,
    `${buildLogCommand(logFile, '!! build failed, rolling back to $PREV_HEAD (agent kept alive)')};`,
    `if [ -n "$PREV_HEAD" ]; then ${buildRunAndLog(logFile, 'rollback: git reset', 'git reset --hard "$PREV_HEAD"')}; ${rebuild}; fi;`,
    `fi`,
  ].join(' ');
}

/**
 * ビルド成功かつ dist/index.js がある場合のみ再起動する。失敗時は旧 Agent を kill しない。
 */
export function buildRestartGate(logFile: string, distIndexPath: string, restartCmd: string): string {
  return `if [ "$BUILD_OK" = "1" ] && [ -f "${distIndexPath}" ]; then ${buildLogCommand(logFile, 'restarting...')}; sleep 2; ${restartCmd}; else ${buildLogCommand(logFile, '!! build failed, keeping current agent')}; fi`;
}
