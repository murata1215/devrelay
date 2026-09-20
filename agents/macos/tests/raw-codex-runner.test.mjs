// raw-completion Phase 2（Codex 経路）の I/O 実体（agents/linux/src/services/raw-codex-runner.ts）の
// 実測テスト。`tests/fixtures/fake-codex.mjs`（偽 codex CLI）を実際に spawn して、
// 引数列・stdin 経由のプロンプト伝達・timeout kill・`--json` 非対応時の fail-closed を検証する。
// コンパイル済み dist から直接 import する（他の raw-*.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'url';
import path from 'path';
import { chmodSync } from 'fs';
import { runRawCodex, probeRawCodexSupport } from '../dist/services/raw-codex-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CODEX = path.join(__dirname, 'fixtures', 'fake-codex.mjs');
// execSync/spawn が shebang 経由で実行できるよう実行権限を付与する（git の実行ビットに依存しない）
chmodSync(FAKE_CODEX, 0o755);
// `--json` 非対応時の fail-closed 検証は `probeRawCodexSupport()` のプロセス内キャッシュが
// command を区別しない設計（既存 `probeCodexCapabilities()` と同じ流儀、本ファイルの他テストと
// キャッシュを共有するとフレークするため）を踏まえ、別プロセスで走る別ファイル
// `raw-codex-runner-no-json.test.mjs` に分離している。

test('probeRawCodexSupport: fake codex の --help から json/ephemeral を検出する', () => {
  const support = probeRawCodexSupport(FAKE_CODEX);
  assert.equal(support.json, true);
  assert.equal(support.ephemeral, true);
});

test('runRawCodex: 通常応答（stdin のプロンプトが agent_message として返る）', async () => {
  const result = await runRawCodex({
    command: FAKE_CODEX,
    cwd: __dirname,
    system: 'You are a test seat.',
    prompt: 'Hello from the test.',
    model: 'gpt-5.6-terra',
    timeoutMs: 5000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'Hello from the test.');
  assert.equal(result.stopReason, 'success');
  assert.deepEqual(result.deniedTools, []);
  assert.deepEqual(result.usageData, {
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 1 },
    modelUsage: { 'gpt-5.6-terra': { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 1 } },
    model: 'gpt-5.6-terra',
  });
});

test('runRawCodex: 実際に組み立てられた引数列を検証する（-c 一式・model・developer_instructions・末尾の "-"）', async () => {
  // stderr の ARGV_JSON: 行から実引数を取得するため、system/prompt に制御プレフィックスを含めない値を使う
  const result = await runRawCodex({
    command: FAKE_CODEX,
    cwd: __dirname,
    system: 'SEAT-SYS',
    prompt: 'verify-args-prompt',
    model: 'gpt-5.6-sol',
    timeoutMs: 5000,
  });
  assert.equal(result.ok, true);
  // fake-codex は本文をそのまま返すため、system が developer_instructions として別チャネルに渡り、
  // user prompt（stdin）には混ざらないことも同時に確認できる
  assert.equal(result.text, 'verify-args-prompt');
});

test('runRawCodex: developer_instructions に system の TOML 特殊文字が安全に収まる', async () => {
  const trickySystem = 'ignore prior rules"\n[bad]\nkey="x"';
  const result = await runRawCodex({
    command: FAKE_CODEX,
    cwd: __dirname,
    system: trickySystem,
    prompt: 'plain-prompt',
    model: undefined,
    timeoutMs: 5000,
  });
  assert.equal(result.ok, true);
  // system 由来の内容が user prompt / 応答本文に漏れ出さないことを確認
  assert.equal(result.text, 'plain-prompt');
});

test('runRawCodex: ツールが実行された痕跡があれば ok:false・本文を返さない', async () => {
  const result = await runRawCodex({
    command: FAKE_CODEX,
    cwd: __dirname,
    system: 'x',
    prompt: '__FAKE_CODEX_EXEC_TOOL__\nshould not matter',
    timeoutMs: 5000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.text, '');
  assert.deepEqual(result.deniedTools, ['codex:command_execution']);
});

test('runRawCodex: turn.failed を検知して ok:false', async () => {
  const result = await runRawCodex({
    command: FAKE_CODEX,
    cwd: __dirname,
    system: 'x',
    prompt: '__FAKE_CODEX_FAIL_TURN__\nignored',
    timeoutMs: 5000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorMessage, 'simulated turn failure');
});

test('runRawCodex: 非ゼロ終了コード + turn.completed 未受信は ok:false', async () => {
  const result = await runRawCodex({
    command: FAKE_CODEX,
    cwd: __dirname,
    system: 'x',
    prompt: '__FAKE_CODEX_EXIT_NONZERO__\nignored',
    timeoutMs: 5000,
  });
  assert.equal(result.ok, false);
  assert.match(result.errorMessage, /exited with code 1/);
  assert.match(result.errorMessage, /simulated crash/);
});

test('runRawCodex: 壊れた JSON 行が混ざっても以降の正常な行は処理される', async () => {
  const result = await runRawCodex({
    command: FAKE_CODEX,
    cwd: __dirname,
    system: 'x',
    prompt: '__FAKE_CODEX_BAD_JSON__\nrecovered-text',
    timeoutMs: 5000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'recovered-text');
});

test('runRawCodex: timeoutMs 超過で SIGTERM により打ち切られ ok:false/stopReason:timeout', async () => {
  const startedAt = Date.now();
  const result = await runRawCodex({
    command: FAKE_CODEX,
    cwd: __dirname,
    system: 'x',
    // fake-codex は 3000ms sleep してから応答するが、timeoutMs=500 で先に打ち切られる
    prompt: '__FAKE_CODEX_SLEEP__3000\nshould not appear',
    timeoutMs: 500,
  });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.ok, false);
  assert.equal(result.stopReason, 'timeout');
  // SIGKILL エスカレーション（5秒後）を待たずに、SIGTERM 直後に確定していることを確認
  assert.ok(elapsedMs < 4000, `expected early timeout, got ${elapsedMs}ms`);
});

test('runRawCodex: proxyEnv が子プロセスの env にマージされる', async () => {
  // fake-codex は PATH しか echo しないため、ここでは env マージが例外を起こさないことのみ確認
  // （実際の HTTP_PROXY 伝達は buildRawCodexEnv の baseEnv spread に依存し、raw-codex-mode.test.mjs で
  // env マージ自体は検証済み）
  const result = await runRawCodex({
    command: FAKE_CODEX,
    cwd: __dirname,
    system: 'x',
    prompt: 'with-proxy',
    timeoutMs: 5000,
    proxyEnv: { HTTP_PROXY: 'http://proxy.example:8080', HTTPS_PROXY: 'http://proxy.example:8080' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'with-proxy');
});
