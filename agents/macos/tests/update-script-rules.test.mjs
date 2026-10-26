// 2026-10-26 障害（未コミットファイル依存のコミットを `u` → tsc 失敗なのに exit=0 と記録 → 壊れた dist で
// 再起動して Agent 停止）の回帰防止。update-script-rules.ts が生成する bash 断片を実際に bash で実行して
// 検証する（crontab-fix-rules.test.mjs と同じく本番と同一のシェルで確かめる流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCheckedBuildSteps,
  buildRestartGate,
  buildRollbackOnBuildFailure,
  buildRunAndLog,
} from '../dist/services/update-script-rules.js';

/** 一時ディレクトリで bash スクリプトを実行し、update.log の内容と stdout を返す */
function runBash(build) {
  const dir = mkdtempSync(join(tmpdir(), 'update-script-rules-'));
  try {
    const logFile = join(dir, 'update.log');
    writeFileSync(logFile, '');
    const stdout = execFileSync('bash', ['-c', build(logFile, dir)], { encoding: 'utf-8' });
    return { log: readFileSync(logFile, 'utf-8'), stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('buildRunAndLog: 【回帰】失敗したコマンドの終了コードを正しく記録する（旧実装は常に exit=0）', () => {
  const { log, stdout } = runBash((logFile) => `${buildRunAndLog(logFile, 'agent build', 'exit_3() { return 3; }; exit_3')}; echo "RC=$RC"`);
  assert.match(log, /agent build exit=3/);
  assert.equal(stdout.trim(), 'RC=3');
});

test('buildRunAndLog: 成功したコマンドは exit=0 を記録し、出力も update.log に入る', () => {
  const { log } = runBash((logFile) => buildRunAndLog(logFile, 'shared build', 'echo hello'));
  assert.match(log, /hello/);
  assert.match(log, /shared build exit=0/);
});

test('buildCheckedBuildSteps: 全ステップ成功なら BUILD_OK=1', () => {
  const { stdout } = runBash((logFile) => `${buildCheckedBuildSteps(logFile, [
    { label: 'a', cmd: 'true' },
    { label: 'b', cmd: 'true' },
  ])}; echo "BUILD_OK=$BUILD_OK"`);
  assert.equal(stdout.trim(), 'BUILD_OK=1');
});

test('buildCheckedBuildSteps: 途中で失敗したら BUILD_OK=0 になり、後続ステップは実行しない', () => {
  const { stdout, log } = runBash((logFile, dir) => `${buildCheckedBuildSteps(logFile, [
    { label: 'shared build', cmd: 'false' },
    { label: 'agent build', cmd: `touch "${dir}/ran"` },
  ])}; echo "BUILD_OK=$BUILD_OK"; [ -f "${dir}/ran" ] && echo ran || echo skipped`);
  assert.deepEqual(stdout.trim().split('\n'), ['BUILD_OK=0', 'skipped']);
  assert.match(log, /shared build exit=1/);
  assert.doesNotMatch(log, /agent build/);
});

test('buildRestartGate: ビルド失敗時は（dist があっても）再起動しない', () => {
  const { stdout, log } = runBash((logFile, dir) => {
    writeFileSync(join(dir, 'index.js'), '');
    return `BUILD_OK=0; ${buildRestartGate(logFile, join(dir, 'index.js'), 'echo RESTARTED')}`;
  });
  assert.equal(stdout.trim(), '');
  assert.match(log, /build failed, keeping current agent/);
});

test('buildRestartGate: ビルド成功かつ dist があれば再起動する', () => {
  const { stdout } = runBash((logFile, dir) => {
    writeFileSync(join(dir, 'index.js'), '');
    return `BUILD_OK=1; ${buildRestartGate(logFile, join(dir, 'index.js'), 'echo RESTARTED')}`;
  });
  assert.equal(stdout.trim(), 'RESTARTED');
});

test('buildRestartGate: ビルド成功でも dist/index.js が無ければ再起動しない（#329 Part B のゲート維持）', () => {
  const { stdout } = runBash((logFile, dir) => `BUILD_OK=1; ${buildRestartGate(logFile, join(dir, 'missing.js'), 'echo RESTARTED')}`);
  assert.equal(stdout.trim(), '');
});

test('buildRollbackOnBuildFailure: ビルド成功時は何もしない', () => {
  const { stdout, log } = runBash((logFile) => `BUILD_OK=1; PREV_HEAD=abc; ${buildRollbackOnBuildFailure(logFile, [{ label: 'agent build', cmd: 'echo REBUILT' }])}`);
  assert.equal(stdout.trim(), '');
  assert.doesNotMatch(log, /rollback/);
});

test('buildRollbackOnBuildFailure: ビルド失敗時は PREV_HEAD に戻して再ビルドする', () => {
  const { log } = runBash((logFile, dir) => {
    const git = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8' }).trim();
    git(['init', '-q']);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'old']);
    const prev = git(['rev-parse', 'HEAD']);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'broken']);
    return `cd "${dir}"; BUILD_OK=0; PREV_HEAD=${prev}; ${buildRollbackOnBuildFailure(logFile, [
      { label: 'agent build', cmd: 'git log -1 --format=%s' },
    ])}`;
  });
  assert.match(log, /build failed, rolling back to [0-9a-f]{40}/);
  assert.match(log, /rollback: git reset exit=0/);
  // 再ビルドは戻した後のコミット（old）上で実行されている
  assert.match(log, /rollback: agent build\nold\n/);
  assert.match(log, /rollback: agent build exit=0/);
});

test('buildRollbackOnBuildFailure: PREV_HEAD が取れていなければ git reset しない', () => {
  const { log } = runBash((logFile) => `BUILD_OK=0; PREV_HEAD=""; ${buildRollbackOnBuildFailure(logFile, [{ label: 'agent build', cmd: 'true' }])}`);
  assert.match(log, /build failed/);
  assert.doesNotMatch(log, /rollback: git reset/);
});
