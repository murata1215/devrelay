// 社内オンプレ移設対応: services/testflight-manager.ts の isTestflightEnabled（キルスイッチ）の単体テスト。
// sites-health-checker.test.mjs の isSitesHealthEnabled と同じ「'0' が明示されたときのみ無効・既定 ON」流儀。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTestflightEnabled } from '../dist/services/testflight-manager.js';

test('isTestflightEnabled: 未設定は既定 ON', () => {
  assert.equal(isTestflightEnabled(undefined), true);
});

test('isTestflightEnabled: "0" のときのみ無効', () => {
  assert.equal(isTestflightEnabled('0'), false);
});

test('isTestflightEnabled: "0" 以外の値は有効のまま', () => {
  assert.equal(isTestflightEnabled('1'), true);
  assert.equal(isTestflightEnabled(''), true);
  assert.equal(isTestflightEnabled('false'), true);
});
