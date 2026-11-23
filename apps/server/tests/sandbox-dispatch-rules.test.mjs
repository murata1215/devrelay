// サイクルSB-1b: sandbox-dispatch-rules.ts の単体テスト。
// 外部 import ゼロの純粋関数をコンパイル済み dist から直接 import する
// （既存 cross-ask-isolation-rules.test.mjs と同じ流儀）。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decideSandboxDispatch } from '../dist/services/sandbox-dispatch-rules.js';

describe('decideSandboxDispatch: sandboxEnabled と capabilityDeclared の 4 通り', () => {
  test('ON × 申告済み → 許可', () => {
    const decision = decideSandboxDispatch({ sandboxEnabled: true, capabilityDeclared: true });
    assert.deepEqual(decision, { allowed: true });
  });

  test('ON × 未申告 → 拒否（capability_not_declared）', () => {
    const decision = decideSandboxDispatch({ sandboxEnabled: true, capabilityDeclared: false });
    assert.deepEqual(decision, { allowed: false, reason: 'capability_not_declared' });
  });

  test('OFF × 申告済み → 許可（影響なし）', () => {
    const decision = decideSandboxDispatch({ sandboxEnabled: false, capabilityDeclared: true });
    assert.deepEqual(decision, { allowed: true });
  });

  test('OFF × 未申告 → 許可（Sandbox OFF のプロジェクトは capability を一切問わない）', () => {
    const decision = decideSandboxDispatch({ sandboxEnabled: false, capabilityDeclared: false });
    assert.deepEqual(decision, { allowed: true });
  });
});
