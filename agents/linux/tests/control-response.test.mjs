// #343: SDK の Query.request() が resolve する control_response の「封筒」から中身を取り出す
// unwrapControlResponse() の単体テスト。外部 import ゼロの純粋関数（agents/linux/src/services/
// control-response.ts）をコンパイル済み dist から直接 import する（plan-permission.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unwrapControlResponse } from '../dist/services/control-response.js';

test('封筒形 {subtype,request_id,response:{...}} は response の中身を返す', () => {
  const raw = { subtype: 'success', request_id: 'x', response: { manualUrl: 'u' } };
  assert.deepEqual(unwrapControlResponse(raw), { manualUrl: 'u' });
});

test('中身直返し形（response キーを持たないオブジェクト）はそのまま返す', () => {
  const raw = { manualUrl: 'u' };
  assert.deepEqual(unwrapControlResponse(raw), { manualUrl: 'u' });
});

test('response が null の場合は外側のオブジェクトをそのまま返す', () => {
  const raw = { subtype: 'success', request_id: 'x', response: null };
  assert.deepEqual(unwrapControlResponse(raw), raw);
});

test('response がオブジェクトでない（文字列）場合は外側のオブジェクトをそのまま返す', () => {
  const raw = { subtype: 'success', request_id: 'x', response: 'not-an-object' };
  assert.deepEqual(unwrapControlResponse(raw), raw);
});

test('response キー自体が存在しない場合は外側のオブジェクトをそのまま返す', () => {
  const raw = { subtype: 'success', request_id: 'x' };
  assert.deepEqual(unwrapControlResponse(raw), raw);
});

test('null / undefined / 文字列 / 数値 はいずれも空オブジェクトを返し、例外を投げない', () => {
  assert.deepEqual(unwrapControlResponse(null), {});
  assert.deepEqual(unwrapControlResponse(undefined), {});
  assert.deepEqual(unwrapControlResponse('plain string'), {});
  assert.deepEqual(unwrapControlResponse(42), {});
});
