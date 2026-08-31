// #346: Devin CLI 診断表示用の純粋関数（formatDevinVersion/buildDevinCapabilityDetail/formatDevinFlagList）の単体テスト。
// 外部 import ゼロの純粋関数（agents/linux/src/services/devin-diagnostics.ts）を
// コンパイル済み dist から直接 import する（cli-failure.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDevinVersion, buildDevinCapabilityDetail, formatDevinFlagList } from '../dist/services/devin-diagnostics.js';

test('formatDevinVersion: 既に "devin " で始まる場合はそのまま（重複前置しない）', () => {
  assert.equal(formatDevinVersion('devin 3000.6.7 (260a97c8)'), 'devin 3000.6.7 (260a97c8)');
});

test('formatDevinVersion: "devin " が無ければ前置する', () => {
  assert.equal(formatDevinVersion('3000.6.7'), 'devin 3000.6.7');
});

test('formatDevinVersion: 空文字・空白のみは "devin unknown"（例外を投げない）', () => {
  assert.equal(formatDevinVersion(''), 'devin unknown');
  assert.equal(formatDevinVersion('   '), 'devin unknown');
});

test('buildDevinCapabilityDetail: probe 成功時の診断行（"devin devin" にならない）', () => {
  const detail = buildDevinCapabilityDetail({ version: 'devin 3000.6.7 (260a97c8)', helpBytes: 3652, ok: true });
  assert.equal(detail, 'devin 3000.6.7 (260a97c8) / help 3652 chars / probe=ok');
});

test('buildDevinCapabilityDetail: probe 失敗時は probe=failed', () => {
  const detail = buildDevinCapabilityDetail({ version: 'unknown', helpBytes: 0, ok: false });
  assert.equal(detail, 'devin unknown / help 0 chars / probe=failed');
});

test('formatDevinFlagList: 空配列は固定文字列、非空は空白区切り', () => {
  assert.equal(formatDevinFlagList([]), '(none)');
  assert.equal(formatDevinFlagList(['--export', '--model']), '--export --model');
});
