// 再起動耐性サイクル（2026-11-25）: apps/server/src/services/turn-recovery.ts の単体テスト。
// `isTurnRecoveryEnabled()`（キルスイッチ判定）のみを検証する。`findInFlightCandidates()`/
// `recoverInFlightTurns()` は DB・progressTrackers に依存するため、ここでは呼ばない
// （実機検証は devlog 参照）。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isTurnRecoveryEnabled } from '../dist/services/turn-recovery.js';

describe('isTurnRecoveryEnabled', () => {
  test('未設定（undefined）は有効（既定 ON）', () => {
    assert.equal(isTurnRecoveryEnabled(undefined), true);
  });
  test(`'0' のときだけ無効`, () => {
    assert.equal(isTurnRecoveryEnabled('0'), false);
  });
  test('その他の文字列は有効扱い', () => {
    assert.equal(isTurnRecoveryEnabled('yes'), true);
  });
});
