// 2026-09-30: 進捗ボックスへの「停止案内行」判定ロジック（apps/server/src/services/progress-cancel-hint.ts）
// の単体テスト。外部 import ゼロの純粋関数をコンパイル済み dist から直接 import する
// （progress-timeout.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldShowCancelHint, isCancelHintEnabled, CANCEL_HINT_MIN_ELAPSED_SEC } from '../dist/services/progress-cancel-hint.js';
import { chatMessages } from '@devrelay/shared';
import { isProgressMarkerLine, isContextInfoLine, isEphemeralProgressLine } from '../dist/services/progress-markers.js';

test('shouldShowCancelHint: web は経過時間に関わらず常に false', () => {
  assert.equal(shouldShowCancelHint({ platform: 'web', elapsedSeconds: 0, env: {} }), false);
  assert.equal(shouldShowCancelHint({ platform: 'web', elapsedSeconds: 3600, env: {} }), false);
});

test('shouldShowCancelHint: discord/telegram はしきい値未満なら false、以上なら true', () => {
  for (const platform of ['discord', 'telegram']) {
    assert.equal(shouldShowCancelHint({ platform, elapsedSeconds: CANCEL_HINT_MIN_ELAPSED_SEC - 1, env: {} }), false);
    assert.equal(shouldShowCancelHint({ platform, elapsedSeconds: CANCEL_HINT_MIN_ELAPSED_SEC, env: {} }), true);
    assert.equal(shouldShowCancelHint({ platform, elapsedSeconds: 720, env: {} }), true);
  }
});

test('shouldShowCancelHint: 初回フレーム（elapsed=0）は discord/telegram でも false（新規投稿を増やさない）', () => {
  assert.equal(shouldShowCancelHint({ platform: 'discord', elapsedSeconds: 0, env: {} }), false);
  assert.equal(shouldShowCancelHint({ platform: 'telegram', elapsedSeconds: 0, env: {} }), false);
});

test('isCancelHintEnabled: 既定 ON、DEVRELAY_PROGRESS_CANCEL_HINT=0 のみ無効', () => {
  assert.equal(isCancelHintEnabled({}), true);
  assert.equal(isCancelHintEnabled({ DEVRELAY_PROGRESS_CANCEL_HINT: '1' }), true);
  assert.equal(isCancelHintEnabled({ DEVRELAY_PROGRESS_CANCEL_HINT: 'unexpected' }), true);
  assert.equal(isCancelHintEnabled({ DEVRELAY_PROGRESS_CANCEL_HINT: '0' }), false);
});

test('shouldShowCancelHint: DEVRELAY_PROGRESS_CANCEL_HINT=0 のキルスイッチで discord/telegram も全て false', () => {
  const env = { DEVRELAY_PROGRESS_CANCEL_HINT: '0' };
  assert.equal(shouldShowCancelHint({ platform: 'discord', elapsedSeconds: 720, env }), false);
  assert.equal(shouldShowCancelHint({ platform: 'telegram', elapsedSeconds: 720, env }), false);
});

test('progress.cancelHint は ja/en 両方にあり、両方に `k` を含む', () => {
  const entry = chatMessages['progress.cancelHint'];
  assert.ok(entry, 'progress.cancelHint キーが存在すること');
  assert.match(entry.ja, /`k`/);
  assert.match(entry.en, /`k`/);
});

test('progress.cancelHint の本文は既存の進捗マーカー除去パターン（progress-markers.ts）に一致しない', () => {
  // MCP get_answer/get_plan のサニタイズ対象に誤って引っかからないことの回帰防止
  // （JSDoc 記載の「進捗テキストは Message.content に永続化されないため追従不要」の根拠を固定する）
  const entry = chatMessages['progress.cancelHint'];
  for (const text of [entry.ja, entry.en]) {
    assert.equal(isProgressMarkerLine(text), false);
    assert.equal(isContextInfoLine(text), false);
    assert.equal(isEphemeralProgressLine(text), false);
  }
});
