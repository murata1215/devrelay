// 読取PATのサーバー配布サイクル: connection.ts の配線（wiring）に対する静的ガード
// （node:fs のみ、dist/ には依存しない。apps/server の knowledge-wiring.test.mjs と同じ手口）。
//
// これが無いと、将来のリファクタで以下が黙って外れても気づけない:
// - `server:repo:auth` の case 漏れ（サーバー応答が永遠に resolve されずタイムアウトし続ける）
// - handleVersionCheck()/handleAgentUpdate() のどちらかで refreshRepoAuthFromServer() 呼び出しが
//   消える（ローテーション直後の pre-flight が常に失効 PAT に当たる）
// - writeFileAtomic() を経由しない直接書き込みへの変更（部分書き込みが読まれる事故の再発）
// - authHeader/PAT の値を console.* にそのまま出す事故

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentRoot = path.resolve(__dirname, '..');
const source = readFileSync(path.join(agentRoot, 'src', 'services', 'connection.ts'), 'utf8');

describe('connection.ts: server:repo:auth の受信配線', () => {
  test("case 'server:repo:auth' がある", () => {
    assert.match(source, /case 'server:repo:auth':/);
  });

  test('resolveRepoAuthRequest を呼んでいる', () => {
    assert.match(source, /resolveRepoAuthRequest\(/);
  });
});

describe('connection.ts: refreshRepoAuthFromServer の呼び出し箇所（version-check と update の両方）', () => {
  test('handleVersionCheck が refreshRepoAuthFromServer を呼んでいる', () => {
    const idx = source.indexOf('async function handleVersionCheck()');
    assert.ok(idx !== -1, 'handleVersionCheck が見つかること');
    const nextFnIdx = source.indexOf('async function handleAgentUpdate()');
    const body = source.slice(idx, nextFnIdx > idx ? nextFnIdx : idx + 2000);
    assert.match(body, /refreshRepoAuthFromServer\(/);
  });

  test('handleAgentUpdate が refreshRepoAuthFromServer を呼んでいる', () => {
    const idx = source.indexOf('async function handleAgentUpdate()');
    assert.ok(idx !== -1, 'handleAgentUpdate が見つかること');
    const body = source.slice(idx, idx + 4000);
    assert.match(body, /refreshRepoAuthFromServer\(/);
  });
});

describe('connection.ts: .git/config への書き込みは writeFileAtomic 経由', () => {
  test('refreshRepoAuthFromServer 内で writeFileAtomic を使っている', () => {
    const idx = source.indexOf('async function refreshRepoAuthFromServer');
    assert.ok(idx !== -1, 'refreshRepoAuthFromServer が見つかること');
    const nextFnIdx = source.indexOf('\nfunction getExecEnv', idx);
    const body = source.slice(idx, nextFnIdx > idx ? nextFnIdx : idx + 3000);
    assert.match(body, /writeFileAtomic\(/);
    // writeFileSync で直接書いていない（アトミック書き込みを迂回していない）
    assert.ok(!body.includes('writeFileSync('), 'writeFileSync による直接書き込みを迂回していないこと');
  });
});

describe('connection.ts: authHeader/PAT を console.* にそのまま出していない', () => {
  test('console.* の呼び出しに response.authHeader 等の値参照が無い', () => {
    const consoleCalls = source.match(/console\.\w+\([^;]*?\);/gs) || [];
    for (const call of consoleCalls) {
      if (!/authHeader/.test(call)) continue;
      assert.fail(`console 呼び出しに authHeader への参照が含まれていないこと: ${call.slice(0, 120)}`);
    }
  });
});
