// 再起動耐性サイクル 追補（2026-11-28）: inflight-state-file.ts の静的ガード。
// writeOnce() は DB（getGlobalBusyState/getGlobalBusyDetails）を実際に叩く I/O 関数のため、
// ここでは「ファイル権限を 600 に揃えているか」「label を detail レベルどおりに出し分けているか」
// をソースコードから固定する（review-wiring.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const source = readFileSync(path.join(serverRoot, 'src/services/inflight-state-file.ts'), 'utf8');

test('inflight.json は所有者のみ読み書き（0o600）で書き、既存ファイルにも chmod で揃える', () => {
  assert.match(source, /FILE_MODE = 0o600/);
  assert.match(source, /writeFileSync\(INFLIGHT_STATE_PATH, JSON\.stringify\(\{[\s\S]*?\}\), \{ mode: FILE_MODE \}\)/);
  assert.match(source, /chmodSync\(INFLIGHT_STATE_PATH, FILE_MODE\)/);
});

test(`detailLevel='off' のときは busy でも sessions キー自体を書かない`, () => {
  assert.match(source, /detailLevel !== 'off'/);
});

test(`detailLevel='id' のときは label を書かない（見出し＝会話の内容を隠す）`, () => {
  assert.match(source, /detailLevel === 'label' \? d\.label : null/);
});

test('getGlobalBusyState の判定結果（busy かどうか）はそのまま使い、busy 詳細の取得失敗は無視して続行する', () => {
  assert.match(source, /const busyState = await getGlobalBusyState\(\);/);
  assert.match(source, /const busy = busyState !== null;/);
  assert.match(source, /catch \(err\) \{\s*console\.warn\('⚠️  busy 詳細の取得に失敗しました/);
});
