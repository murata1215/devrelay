// `services/agent-token-url.ts` の単体テスト。
//
// Agent トークンに埋め込む WS URL を `Host` ヘッダー起点で組み立てていたため、
// リバースプロキシ配下（IIS + ARR は既定が preserveHostHeader=false）やサブパス配信で
// `wss://localhost:3000/ws/agent` のような接続不能なトークンが発行される問題があった。
// `PUBLIC_URL` 優先に変更した挙動と、未設定時の後方互換を固定する。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildAgentWsUrl } from '../dist/services/agent-token-url.js';

/** ヘッダーだけを持つリクエスト相当のオブジェクトを作る。 */
const req = (headers = {}) => ({ headers });

test('PUBLIC_URL がサブパス付きなら、そのパスを保ったまま /ws/agent を付ける', () => {
  assert.equal(
    buildAgentWsUrl(req({ host: 'localhost:3000' }), {
      PUBLIC_URL: 'https://service.example.co.jp/tsinternal/devrelay',
    }),
    'wss://service.example.co.jp/tsinternal/devrelay/ws/agent'
  );
});

test('PUBLIC_URL の末尾スラッシュの有無で結果が変わらない（スラッシュが重複しない）', () => {
  const withSlash = buildAgentWsUrl(req(), {
    PUBLIC_URL: 'https://service.example.co.jp/tsinternal/devrelay/',
  });
  const withoutSlash = buildAgentWsUrl(req(), {
    PUBLIC_URL: 'https://service.example.co.jp/tsinternal/devrelay',
  });
  assert.equal(withSlash, withoutSlash);
  assert.equal(withSlash, 'wss://service.example.co.jp/tsinternal/devrelay/ws/agent');
});

test('PUBLIC_URL がルート配信なら従来どおりの URL になる（既存環境の非退行）', () => {
  assert.equal(
    buildAgentWsUrl(req({ host: 'app.devrelay.io' }), { PUBLIC_URL: 'https://app.devrelay.io' }),
    'wss://app.devrelay.io/ws/agent'
  );
});

test('PUBLIC_URL が http なら ws になる', () => {
  assert.equal(
    buildAgentWsUrl(req(), { PUBLIC_URL: 'http://10.0.0.5:8080/devrelay' }),
    'ws://10.0.0.5:8080/devrelay/ws/agent'
  );
});

test('PUBLIC_URL のクエリ・フラグメントは落とす', () => {
  assert.equal(
    buildAgentWsUrl(req(), { PUBLIC_URL: 'https://example.com/devrelay?a=1#frag' }),
    'wss://example.com/devrelay/ws/agent'
  );
});

test('リバースプロキシが Host を localhost:3000 に書き換えていても PUBLIC_URL が勝つ（本件の再発防止）', () => {
  // IIS + ARR の既定（preserveHostHeader=false）で実際に起きた状況
  assert.equal(
    buildAgentWsUrl(
      req({ host: 'localhost:3000', 'x-forwarded-proto': 'https' }),
      { PUBLIC_URL: 'https://service.example.co.jp/tsinternal/devrelay' }
    ),
    'wss://service.example.co.jp/tsinternal/devrelay/ws/agent'
  );
});

test('PUBLIC_URL 未設定なら Host ヘッダーから組み立てる（後方互換）', () => {
  assert.equal(
    buildAgentWsUrl(req({ host: 'myhost:3000' }), {}),
    'ws://myhost:3000/ws/agent'
  );
});

test('PUBLIC_URL 未設定でも x-forwarded-proto が https なら wss になる', () => {
  assert.equal(
    buildAgentWsUrl(req({ host: 'myhost', 'x-forwarded-proto': 'https' }), {}),
    'wss://myhost/ws/agent'
  );
});

test('PUBLIC_URL 未設定で devrelay.io を含むホストなら wss になる（既存の特例を維持）', () => {
  assert.equal(
    buildAgentWsUrl(req({ host: 'app.devrelay.io' }), {}),
    'wss://app.devrelay.io/ws/agent'
  );
});

test('PUBLIC_URL 未設定で Host も無ければ localhost:3000 にフォールバックする', () => {
  assert.equal(buildAgentWsUrl(req(), {}), 'ws://localhost:3000/ws/agent');
});

test('PUBLIC_URL が空文字・空白のみなら未設定と同じ扱いになる', () => {
  assert.equal(buildAgentWsUrl(req({ host: 'myhost' }), { PUBLIC_URL: '' }), 'ws://myhost/ws/agent');
  assert.equal(
    buildAgentWsUrl(req({ host: 'myhost' }), { PUBLIC_URL: '   ' }),
    'ws://myhost/ws/agent'
  );
});

test('PUBLIC_URL が URL として壊れていれば Host ヘッダーにフォールバックする（fail-soft）', () => {
  assert.equal(
    buildAgentWsUrl(req({ host: 'myhost:3000' }), { PUBLIC_URL: 'not-a-url' }),
    'ws://myhost:3000/ws/agent'
  );
});
