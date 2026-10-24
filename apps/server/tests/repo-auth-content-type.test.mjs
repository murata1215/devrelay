// インストーラのサーバー配布PAT取得が IIS 経由で 415 になる不具合の修正サイクル。
//
// IIS(ARR) 等のリバースプロキシは Content-Type ヘッダ無しの POST にもボディ framing ヘッダ
// （Content-Length/Transfer-Encoding）を付けて転送することがあり、Fastify がそれを
// 「Content-Type 未指定だがボディはある」と判定して 415（FST_ERR_CTP_INVALID_MEDIA_TYPE）を
// 返していた（実測確認済み）。本テストは実 Fastify インスタンスに対して
// `applyRepoAuthContentTypeParser()` を適用したスコープでは 415/400 にならないこと、
// かつ **そのスコープの外（別プラグイン）には一切影響しないこと** を確認する。
//
// 使うトークンはダミー固定値のみ（実マシントークン・実 PAT は一切書かない）。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { applyRepoAuthContentTypeParser } from '../dist/routes/repo-auth-content-type.js';

const DUMMY_BEARER = 'Bearer drl_dummy_for_test_only';

/**
 * テスト用の最小 Fastify アプリを作る。
 *
 * `/api/agent/repo-auth` 相当のルートは `applyRepoAuthContentTypeParser` 適用済みの
 * プラグインスコープに登録し、認証ヘッダの有無だけで 401/200 を返す（prisma 等の実認証には触れない）。
 * 比較対象として、別スコープに素の JSON ルート `/api/other` を登録し、こちらは
 * 本サイクルの変更の影響を受けず従来どおり 415 を返すことを確認する（スコープ漏れの回帰検知）。
 */
function buildApp() {
  const app = Fastify();

  // repo-auth 相当: fastify-plugin でラップしない素の async function として登録する
  // （agentRepoAuthRoutes と同じ登録方法。これにより専用スコープが作られる）
  async function repoAuthPlugin(scopedApp) {
    applyRepoAuthContentTypeParser(scopedApp);
    scopedApp.post('/api/agent/repo-auth', async (request, reply) => {
      const authHeader = request.headers.authorization;
      if (authHeader !== DUMMY_BEARER) {
        return reply.status(401).send({ error: 'unauthorized' });
      }
      return reply.status(200).send({ repoUrl: null, authHeader: null });
    });
  }

  // 比較対象: 通常の JSON ルート（本サイクルの変更を適用しない）
  async function otherPlugin(scopedApp) {
    scopedApp.post('/api/other', async (_request, reply) => {
      return reply.status(200).send({ ok: true });
    });
  }

  return Promise.all([app.register(repoAuthPlugin), app.register(otherPlugin)]).then(() => app);
}

describe('repo-auth-content-type: /api/agent/repo-auth スコープは 415/400 を起こさない', () => {
  test('Content-Type なし・ボディなし → 401（415 ではない）', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/agent/repo-auth' });
    assert.notEqual(res.statusCode, 415);
    assert.equal(res.statusCode, 401);
    await app.close();
  });

  test('Content-Type なし + Content-Length 付きボディ（IIS 再現） → 401（415 ではない）', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/repo-auth',
      headers: { 'content-length': '2' },
      payload: '{}',
    });
    assert.notEqual(res.statusCode, 415);
    assert.equal(res.statusCode, 401);
    await app.close();
  });

  test('Content-Type なし + Transfer-Encoding: chunked → 415 にならない', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/repo-auth',
      headers: { 'transfer-encoding': 'chunked' },
      payload: '{}',
    });
    assert.notEqual(res.statusCode, 415);
    await app.close();
  });

  test('application/json + {} ボディ + 正しい Authorization → 200', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/repo-auth',
      headers: { 'content-type': 'application/json', authorization: DUMMY_BEARER },
      payload: '{}',
    });
    assert.equal(res.statusCode, 200);
    await app.close();
  });

  test('application/json + 空ボディ → 415/400 にならない（FST_ERR_CTP_EMPTY_JSON_BODY 回避）', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/repo-auth',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });
    assert.notEqual(res.statusCode, 415);
    assert.notEqual(res.statusCode, 400);
    await app.close();
  });

  for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'application/octet-stream']) {
    test(`Content-Type: ${ct} → 415 にならない`, async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/agent/repo-auth',
        headers: { 'content-type': ct },
        payload: 'x',
      });
      assert.notEqual(res.statusCode, 415);
      await app.close();
    });
  }
});

describe('repo-auth-content-type: スコープ漏れの回帰防止（別ルートは従来どおり 415）', () => {
  // text/plain は Fastify の既定パーサーに最初から登録されている（contentTypeParser.js）ため、
  // ここで使うと「変更していなくても元々 415 にならない」ケースになり回帰検知にならない。
  // application/octet-stream のような未登録 Content-Type を使う。
  test('別プラグインスコープの JSON ルートは application/octet-stream で依然 415', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/other',
      headers: { 'content-type': 'application/octet-stream' },
      payload: 'x',
    });
    assert.equal(res.statusCode, 415);
    await app.close();
  });
});
