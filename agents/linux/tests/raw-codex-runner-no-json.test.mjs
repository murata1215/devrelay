// raw-codex-runner.test.mjs から分離: `--json` 非対応の Codex CLI に対する fail-closed 検証。
// `probeRawCodexSupport()` はプロセス内で 1 回だけ `--help` をプローブしキャッシュする設計
// （既存 `probeCodexCapabilities()` と同じ流儀、command を区別しない）。同一プロセス内で
// json 対応版・非対応版の両方を検証すると先勝ちキャッシュでフレークするため、
// このファイル（node --test は別プロセスで実行する）に分離して独立性を確保する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'url';
import path from 'path';
import { chmodSync } from 'fs';
import { runRawCodex, probeRawCodexSupport } from '../dist/services/raw-codex-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CODEX_NO_JSON = path.join(__dirname, 'fixtures', 'fake-codex-no-json.mjs');
chmodSync(FAKE_CODEX_NO_JSON, 0o755);

test('probeRawCodexSupport: --json 非対応の --help から json:false を検出する', () => {
  const support = probeRawCodexSupport(FAKE_CODEX_NO_JSON);
  assert.equal(support.json, false);
});

test('runRawCodex: --json 非対応バージョンは spawn せず fail-closed（プレーンテキストへ劣化しない）', async () => {
  const result = await runRawCodex({
    command: FAKE_CODEX_NO_JSON,
    cwd: __dirname,
    system: 'x',
    prompt: 'should never run',
    timeoutMs: 5000,
  });
  assert.equal(result.ok, false);
  assert.match(result.errorMessage, /--json is not supported/);
  assert.equal(result.text, '');
});
