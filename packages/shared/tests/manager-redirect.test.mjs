// packages/shared/src/manager-redirect.ts のテスト（コンパイル済み dist を直接 import、node:test）
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveNextTarget, buildManagerTokenUrl, isManagerRedirectEnabled } from '../dist/manager-redirect.js';

// --- resolveNextTarget ---

test('resolveNextTarget: "manager" 完全一致は manager を返す', () => {
  assert.equal(resolveNextTarget('manager'), 'manager');
});

test('resolveNextTarget: null は null', () => {
  assert.equal(resolveNextTarget(null), null);
});

test('resolveNextTarget: undefined は null', () => {
  assert.equal(resolveNextTarget(undefined), null);
});

test('resolveNextTarget: 空文字は null', () => {
  assert.equal(resolveNextTarget(''), null);
});

test('resolveNextTarget: "app" は null', () => {
  assert.equal(resolveNextTarget('app'), null);
});

test('resolveNextTarget: 大文字 "Manager" は null（大文字小文字を区別する）', () => {
  assert.equal(resolveNextTarget('Manager'), null);
});

test('resolveNextTarget: 前後空白付き "manager " は null', () => {
  assert.equal(resolveNextTarget('manager '), null);
});

test('resolveNextTarget: 攻撃形 "https://evil.example.com" は null', () => {
  assert.equal(resolveNextTarget('https://evil.example.com'), null);
});

test('resolveNextTarget: 攻撃形 "//evil.example.com" は null', () => {
  assert.equal(resolveNextTarget('//evil.example.com'), null);
});

test('resolveNextTarget: 攻撃形 "/settings" は null', () => {
  assert.equal(resolveNextTarget('/settings'), null);
});

test('resolveNextTarget: 攻撃形 "javascript:alert(1)" は null', () => {
  assert.equal(resolveNextTarget('javascript:alert(1)'), null);
});

// --- buildManagerTokenUrl ---

test('buildManagerTokenUrl: 正常形はフラグメントに token を載せる', () => {
  assert.equal(
    buildManagerTokenUrl('https://manager.devrelay.io', 'abc123'),
    'https://manager.devrelay.io/#token=abc123'
  );
});

test('buildManagerTokenUrl: 末尾スラッシュ1個を正規化する', () => {
  assert.equal(
    buildManagerTokenUrl('https://manager.devrelay.io/', 'abc123'),
    'https://manager.devrelay.io/#token=abc123'
  );
});

test('buildManagerTokenUrl: 末尾スラッシュ複数個を正規化する', () => {
  assert.equal(
    buildManagerTokenUrl('https://manager.devrelay.io///', 'abc123'),
    'https://manager.devrelay.io/#token=abc123'
  );
});

test('buildManagerTokenUrl: token が空文字なら null', () => {
  assert.equal(buildManagerTokenUrl('https://manager.devrelay.io', ''), null);
});

test('buildManagerTokenUrl: baseUrl が空文字なら null', () => {
  assert.equal(buildManagerTokenUrl('', 'abc123'), null);
});

test('buildManagerTokenUrl: javascript: スキームは null', () => {
  assert.equal(buildManagerTokenUrl('javascript:alert(1)', 'abc123'), null);
});

test('buildManagerTokenUrl: 特殊文字トークンは encodeURIComponent される', () => {
  assert.equal(
    buildManagerTokenUrl('https://manager.devrelay.io', 'a b&c=d'),
    'https://manager.devrelay.io/#token=a%20b%26c%3Dd'
  );
});

test('buildManagerTokenUrl: 出力に "?token=" が現れず "#token=" である', () => {
  const url = buildManagerTokenUrl('https://manager.devrelay.io', 'abc123');
  assert.ok(url.includes('#token='));
  assert.ok(!url.includes('?token='));
});

// --- isManagerRedirectEnabled ---

test('isManagerRedirectEnabled: "true" は true', () => {
  assert.equal(isManagerRedirectEnabled('true'), true);
});

test('isManagerRedirectEnabled: "false" は false', () => {
  assert.equal(isManagerRedirectEnabled('false'), false);
});

test('isManagerRedirectEnabled: undefined は false', () => {
  assert.equal(isManagerRedirectEnabled(undefined), false);
});

test('isManagerRedirectEnabled: "TRUE"（大文字）は false', () => {
  assert.equal(isManagerRedirectEnabled('TRUE'), false);
});

test('isManagerRedirectEnabled: "1" は false', () => {
  assert.equal(isManagerRedirectEnabled('1'), false);
});
