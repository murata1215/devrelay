// WebUI の共通 HTTP ヘルパー（apps/web/src/lib/request-headers-rules.ts）の単体テスト。
// 外部 import ゼロの純粋関数をコンパイル済み dist-test から直接 import する（push-device-rules.test.mjs と同じ流儀）。
//
// 2026-11-08 の実機バグの再現と固定: 旧実装（api.ts の request() に直書きされていた
// ヘッダ組み立て）は body の有無に関わらず常に Content-Type: application/json を付けており、
// body 無しの POST（例: POST /teams/:teamId/subscribe）が Fastify の
// FST_ERR_CTP_EMPTY_JSON_BODY で常に 400 になっていた（ハンドラは一度も実行されない）。
// 同じ条件の呼び出しが api.ts に 5 箇所あり、いずれも以前から壊れていた。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildRequestHeaders } from '../dist-test/lib/request-headers-rules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, '..');

function readWebSource(relPath) {
  return readFileSync(path.join(webRoot, relPath), 'utf8');
}

describe('buildRequestHeaders', () => {
  test('バグの再現固定: 旧ロジックは body が無くても Content-Type を付けていた（新ロジックは付けない）', () => {
    // 旧ロジック（api.ts の request() に直書きされていた実装をそのまま再現）
    function oldBuildHeaders(token, _hasBody) {
      const headers = { 'Content-Type': 'application/json' }; // body の有無を見ていない
      if (token) headers['Authorization'] = `Bearer ${token}`;
      return headers;
    }
    const oldHeaders = oldBuildHeaders('tok', false);
    assert.equal(oldHeaders['Content-Type'], 'application/json', '旧ロジックは body 無しでも Content-Type を付けていた（バグの再現）');

    // 新ロジック
    const newHeaders = buildRequestHeaders({ token: 'tok', hasBody: false });
    assert.equal(newHeaders['Content-Type'], undefined, '新ロジックは body 無しのとき Content-Type を付けない');
  });

  test('hasBody: true のときだけ Content-Type: application/json を付ける', () => {
    const withBody = buildRequestHeaders({ token: null, hasBody: true });
    assert.equal(withBody['Content-Type'], 'application/json');

    const withoutBody = buildRequestHeaders({ token: null, hasBody: false });
    assert.equal(withoutBody['Content-Type'], undefined);
  });

  test('token が非 null のときだけ Authorization を付ける', () => {
    const withToken = buildRequestHeaders({ token: 'abc123', hasBody: true });
    assert.equal(withToken['Authorization'], 'Bearer abc123');

    const withoutToken = buildRequestHeaders({ token: null, hasBody: true });
    assert.equal(withoutToken['Authorization'], undefined);
  });

  test('token と hasBody は互いに独立して判定する（4 通りの組み合わせ）', () => {
    const both = buildRequestHeaders({ token: 't', hasBody: true });
    assert.equal(both['Content-Type'], 'application/json');
    assert.equal(both['Authorization'], 'Bearer t');

    const tokenOnly = buildRequestHeaders({ token: 't', hasBody: false });
    assert.equal(tokenOnly['Content-Type'], undefined);
    assert.equal(tokenOnly['Authorization'], 'Bearer t');

    const bodyOnly = buildRequestHeaders({ token: null, hasBody: true });
    assert.equal(bodyOnly['Content-Type'], 'application/json');
    assert.equal(bodyOnly['Authorization'], undefined);

    const neither = buildRequestHeaders({ token: null, hasBody: false });
    assert.equal(neither['Content-Type'], undefined);
    assert.equal(neither['Authorization'], undefined);
  });
});

describe('request-headers-source-guard: api.ts の request() がヘッダ直書きに戻っていないことの静的ガード', () => {
  test('api.ts が buildRequestHeaders( を使っている（配線固定）', () => {
    const source = readWebSource('src/lib/api.ts');
    assert.match(source, /\bbuildRequestHeaders\s*\(/);
  });

  test("api.ts に 'Content-Type': 'application/json' の直書きが残っていない（今回のバグの再発防止）", () => {
    const source = readWebSource('src/lib/api.ts');
    assert.doesNotMatch(source, /'Content-Type':\s*'application\/json'/);
  });

  test('tsconfig.test.json の include に request-headers-rules.ts が載っている（載せ忘れるとスイートごと無言 skip される）', () => {
    const tsconfigTest = JSON.parse(readWebSource('tsconfig.test.json'));
    assert.ok(
      tsconfigTest.include.some((p) => p.includes('request-headers-rules.ts')),
      'tsconfig.test.json の include に src/lib/request-headers-rules.ts が無い'
    );
  });
});
