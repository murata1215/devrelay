// Enter 送信ロック（2026-11-21）のテスト。node:test から dist-test/ を直接 import する。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decideEnterAction, parseEnterLock, serializeEnterLock, ENTER_LOCK_STORAGE_KEY } from '../dist-test/lib/enter-send-rules.js';

const key = (over = {}) => ({ key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false, ...over });

describe('decideEnterAction: ロックなし（従来どおり）', () => {
  test('Enter で送信', () => assert.equal(decideEnterAction(key(), false), 'send'));
  test('Shift+Enter は改行', () => assert.equal(decideEnterAction(key({ shiftKey: true }), false), 'default'));
  test('Ctrl+Enter / ⌘+Enter も送信', () => {
    assert.equal(decideEnterAction(key({ ctrlKey: true }), false), 'send');
    assert.equal(decideEnterAction(key({ metaKey: true }), false), 'send');
  });
});

describe('decideEnterAction: ロック中', () => {
  test('Enter は改行（送らない）', () => assert.equal(decideEnterAction(key(), true), 'default'));
  test('Shift+Enter も改行', () => assert.equal(decideEnterAction(key({ shiftKey: true }), true), 'default'));
  test('Ctrl+Enter / ⌘+Enter で送信', () => {
    assert.equal(decideEnterAction(key({ ctrlKey: true }), true), 'send');
    assert.equal(decideEnterAction(key({ metaKey: true }), true), 'send');
  });
});

describe('decideEnterAction: IME 変換中・他のキー', () => {
  test('変換確定の Enter はロック有無に関わらず送らない', () => {
    for (const locked of [false, true]) {
      assert.equal(decideEnterAction(key({ isComposing: true }), locked), 'default');
      assert.equal(decideEnterAction(key({ keyCode: 229 }), locked), 'default');
      assert.equal(decideEnterAction(key({ isComposing: true, ctrlKey: true }), locked), 'default');
    }
  });
  test('Enter 以外は何もしない', () => {
    assert.equal(decideEnterAction(key({ key: 'a' }), false), 'default');
    assert.equal(decideEnterAction(key({ key: 'a', ctrlKey: true }), true), 'default');
  });
});

describe('保存値', () => {
  test("'1' のときだけロック（未設定・その他は従来どおり）", () => {
    assert.equal(parseEnterLock('1'), true);
    assert.equal(parseEnterLock('0'), false);
    assert.equal(parseEnterLock(null), false);
    assert.equal(parseEnterLock(undefined), false);
    assert.equal(parseEnterLock('true'), false);
  });
  test('serialize と parse が往復する', () => {
    assert.equal(parseEnterLock(serializeEnterLock(true)), true);
    assert.equal(parseEnterLock(serializeEnterLock(false)), false);
    assert.equal(ENTER_LOCK_STORAGE_KEY, 'devrelay-enter-lock');
  });
});
