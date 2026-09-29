// 社内オンプレ移設対応: services/proxy-dispatcher.ts の純粋関数（env パーサ）の単体テスト。
// setGlobalDispatcher の副作用そのものはここではテストしない（sites-health-checker.test.mjs と
// 同じ流儀で、環境変数解釈のロジックだけを純粋関数として切り出してテストする）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProxyUrl, resolveNoProxyList } from '../dist/services/proxy-dispatcher.js';

test('resolveProxyUrl: 環境変数が何も無ければ null', () => {
  assert.equal(resolveProxyUrl({}), null);
});

test('resolveProxyUrl: HTTPS_PROXY を最優先で使う', () => {
  assert.equal(
    resolveProxyUrl({ HTTPS_PROXY: 'http://a:8080', HTTP_PROXY: 'http://b:8080' }),
    'http://a:8080'
  );
});

test('resolveProxyUrl: HTTPS_PROXY が無ければ https_proxy を使う', () => {
  assert.equal(resolveProxyUrl({ https_proxy: 'http://c:8080' }), 'http://c:8080');
});

test('resolveProxyUrl: HTTPS 系が無ければ HTTP_PROXY / http_proxy にフォールバック', () => {
  assert.equal(resolveProxyUrl({ HTTP_PROXY: 'http://d:8080' }), 'http://d:8080');
  assert.equal(resolveProxyUrl({ http_proxy: 'http://e:8080' }), 'http://e:8080');
});

test('resolveProxyUrl: 空文字は未設定扱い', () => {
  assert.equal(resolveProxyUrl({ HTTPS_PROXY: '' }), null);
  assert.equal(resolveProxyUrl({ HTTPS_PROXY: '   ' }), null);
});

test('resolveProxyUrl: 前後の空白を除去する', () => {
  assert.equal(resolveProxyUrl({ HTTPS_PROXY: '  http://f:8080  ' }), 'http://f:8080');
});

test('resolveNoProxyList: 未設定なら空配列', () => {
  assert.deepEqual(resolveNoProxyList({}), []);
});

test('resolveNoProxyList: カンマ区切りをトリムして配列にする', () => {
  assert.deepEqual(
    resolveNoProxyList({ NO_PROXY: 'localhost, 127.0.0.1 ,internal.corp' }),
    ['localhost', '127.0.0.1', 'internal.corp']
  );
});

test('resolveNoProxyList: 小文字 no_proxy にもフォールバックする', () => {
  assert.deepEqual(resolveNoProxyList({ no_proxy: 'a,b' }), ['a', 'b']);
});
