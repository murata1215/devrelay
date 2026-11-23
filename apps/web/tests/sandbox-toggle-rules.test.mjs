// サイクルSB-1b: decideSandboxToggle() の単体テスト。
// 押せる／押せないの判定（ok / offline / unsupported / 非対応だが ON）を固定する。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decideSandboxToggle } from '../dist-test/lib/sandbox-toggle-rules.js';

describe('decideSandboxToggle', () => {
  test('supported=true・sandboxEnabled=false（ok） → 押せる・chat.sandboxOff', () => {
    const decision = decideSandboxToggle({ sandboxEnabled: false, supported: true, reason: 'ok' });
    assert.deepEqual(decision, { clickable: true, titleKey: 'chat.sandboxOff' });
  });

  test('supported=true・sandboxEnabled=true（ok） → 押せる・chat.sandboxOn', () => {
    const decision = decideSandboxToggle({ sandboxEnabled: true, supported: true, reason: 'ok' });
    assert.deepEqual(decision, { clickable: true, titleKey: 'chat.sandboxOn' });
  });

  test('supported=false・reason=offline・sandboxEnabled=false → 押せない・chat.sandboxOffline', () => {
    const decision = decideSandboxToggle({ sandboxEnabled: false, supported: false, reason: 'offline' });
    assert.deepEqual(decision, { clickable: false, titleKey: 'chat.sandboxOffline' });
  });

  test('supported=false・reason=unsupported・sandboxEnabled=false → 押せない・chat.sandboxUnsupported', () => {
    const decision = decideSandboxToggle({ sandboxEnabled: false, supported: false, reason: 'unsupported' });
    assert.deepEqual(decision, { clickable: false, titleKey: 'chat.sandboxUnsupported' });
  });

  test('supported=false だが sandboxEnabled=true（非対応になった後も ON） → 押せる・chat.sandboxOn（行き止まりを作らない）', () => {
    for (const reason of ['offline', 'unsupported']) {
      const decision = decideSandboxToggle({ sandboxEnabled: true, supported: false, reason });
      assert.deepEqual(decision, { clickable: true, titleKey: 'chat.sandboxOn' });
    }
  });
});
