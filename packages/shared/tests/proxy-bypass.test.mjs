// `proxy-bypass.ts` の単体テスト。
//
// 社内に DevRelay Server を立て AI API だけ社内プロキシ経由にする構成で、
// `proxy.url` を設定すると Server への WebSocket 接続までプロキシ経由になり
// 接続不能になっていた。`noProxy` によるバイパス判定の挙動を固定する。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeNoProxy,
  shouldBypassProxy,
  toNoProxyEnvValue,
} from '../dist/proxy-bypass.js';

test('noProxy 未設定ならバイパスしない（既存挙動の非退行）', () => {
  assert.equal(shouldBypassProxy('wss://service.internal.example.co.jp/ws/agent'), false);
  assert.equal(shouldBypassProxy('wss://service.internal.example.co.jp/ws/agent', []), false);
  assert.equal(shouldBypassProxy('wss://service.internal.example.co.jp/ws/agent', ''), false);
  assert.equal(shouldBypassProxy('wss://service.internal.example.co.jp/ws/agent', null), false);
});

test('ホスト完全一致でバイパスする', () => {
  assert.equal(
    shouldBypassProxy('wss://service.internal.example.co.jp/tsinternal/devrelay/ws/agent', [
      'service.internal.example.co.jp',
    ]),
    true
  );
});

test('ドメインサフィックス一致でバイパスする（先頭ドットあり・なしは同義）', () => {
  const target = 'wss://service.internal.example.co.jp/ws/agent';
  assert.equal(shouldBypassProxy(target, ['.internal.example.co.jp']), true);
  assert.equal(shouldBypassProxy(target, ['internal.example.co.jp']), true);
  // サフィックスはドット境界で区切る（部分文字列一致では引っかけない）
  assert.equal(shouldBypassProxy('wss://notinternal.example.co.jp/ws', ['internal.example.co.jp']), false);
});

test('別ドメインはバイパスしない（AI API はプロキシ経由のまま）', () => {
  assert.equal(
    shouldBypassProxy('https://api.anthropic.com/v1/messages', ['.internal.example.co.jp']),
    false
  );
});

test('`*` は全バイパス', () => {
  assert.equal(shouldBypassProxy('https://api.anthropic.com/v1/messages', ['*']), true);
});

test('カンマ区切り・空白区切りの文字列も受け付ける', () => {
  assert.equal(
    shouldBypassProxy('wss://myhost/ws/agent', 'localhost, 127.0.0.1, myhost'),
    true
  );
  assert.equal(shouldBypassProxy('wss://myhost/ws/agent', 'localhost 127.0.0.1 myhost'), true);
  assert.equal(shouldBypassProxy('wss://other/ws/agent', 'localhost,127.0.0.1,myhost'), false);
});

test('大文字小文字を区別しない', () => {
  assert.equal(
    shouldBypassProxy('wss://Service.Internal.Example.co.jp/ws', ['SERVICE.internal.EXAMPLE.co.jp']),
    true
  );
});

test('エントリにポート指定があればポートも一致を要求する', () => {
  assert.equal(shouldBypassProxy('ws://myhost:3000/ws/agent', ['myhost:3000']), true);
  assert.equal(shouldBypassProxy('ws://myhost:3001/ws/agent', ['myhost:3000']), false);
  // スキームの既定ポートで比較する（wss → 443 / ws → 80）
  assert.equal(shouldBypassProxy('wss://myhost/ws/agent', ['myhost:443']), true);
  assert.equal(shouldBypassProxy('ws://myhost/ws/agent', ['myhost:80']), true);
  assert.equal(shouldBypassProxy('wss://myhost/ws/agent', ['myhost:80']), false);
});

test('エントリにポート指定が無ければポートを問わない', () => {
  assert.equal(shouldBypassProxy('ws://myhost:3000/ws/agent', ['myhost']), true);
  assert.equal(shouldBypassProxy('wss://myhost/ws/agent', ['myhost']), true);
});

test('URL でなく host[:port] 形式の接続先も判定できる', () => {
  assert.equal(shouldBypassProxy('myhost:3000', ['myhost']), true);
  assert.equal(shouldBypassProxy('myhost', ['myhost']), true);
});

test('IPv4 リテラルとループバックを扱える', () => {
  assert.equal(shouldBypassProxy('ws://127.0.0.1:3000/ws/agent', ['127.0.0.1']), true);
  assert.equal(shouldBypassProxy('ws://localhost:3000/ws/agent', ['localhost']), true);
  assert.equal(shouldBypassProxy('ws://10.214.8.200:3000/ws/agent', ['10.214.8.200']), true);
  assert.equal(shouldBypassProxy('ws://10.214.8.201:3000/ws/agent', ['10.214.8.200']), false);
});

test('IPv6 リテラルを扱える（角括弧あり・なし）', () => {
  assert.equal(shouldBypassProxy('ws://[::1]:3000/ws/agent', ['::1']), true);
  assert.equal(shouldBypassProxy('[::1]:3000', ['::1']), true);
  assert.equal(shouldBypassProxy('ws://[::1]:3000/ws/agent', ['[::1]:3000']), true);
  assert.equal(shouldBypassProxy('ws://[::1]:3001/ws/agent', ['[::1]:3000']), false);
});

test('normalizeNoProxy は前後空白と空要素を落として小文字化する', () => {
  assert.deepEqual(normalizeNoProxy('  A.example.com , , B.example.com  '), [
    'a.example.com',
    'b.example.com',
  ]);
  assert.deepEqual(normalizeNoProxy(['  X.test ', '']), ['x.test']);
  assert.deepEqual(normalizeNoProxy(undefined), []);
});

test('toNoProxyEnvValue は子プロセス用のカンマ区切り値を返す', () => {
  assert.equal(
    toNoProxyEnvValue(['service.internal.example.co.jp', 'localhost']),
    'service.internal.example.co.jp,localhost'
  );
  assert.equal(toNoProxyEnvValue(undefined), '');
});

test('壊れた接続先文字列でも例外を投げない（fail-soft）', () => {
  assert.equal(shouldBypassProxy('', ['myhost']), false);
  assert.equal(shouldBypassProxy('http://', ['myhost']), false);
  assert.equal(shouldBypassProxy('not a url', ['myhost']), false);
});
