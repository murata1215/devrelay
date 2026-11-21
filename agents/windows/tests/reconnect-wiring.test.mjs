// エージェント再接続根治サイクル（2026-11-14）: `connection.ts` の再接続ロジックに対する静的ガード
// （node:fs のみ、dist/ には依存しない。plan-gate-wiring.test.mjs と同じ手口）。
//
// 自宅PC（fwjg2507-FMVD34003）が pong タイムアウト切断後、DNS エラーの再接続を約13回繰り返した
// 末に3日間沈黙した事故（原因A: 接続タイムアウト無し、原因B: 安定判定が毎回リセットされる、
// 原因C: maxAttempts 到達で無言終了）の根治がこれ以上の将来のリファクタで黙って外れないようにする。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentRoot = path.resolve(__dirname, '..');
const source = readFileSync(path.join(agentRoot, 'src', 'services', 'connection.ts'), 'utf8');

function extractFunction(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start !== -1, `${signature} が見つかること`);
  // 単純な中括弧カウントで関数本体の終わりを探す
  let depth = 0;
  let i = src.indexOf('{', start);
  const bodyStart = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(start, i + 1);
}

describe('connectToServer(): 原因A（接続タイムアウト）', () => {
  test('wsOptions に handshakeTimeout: CONNECT_TIMEOUT_MS を渡している', () => {
    assert.match(source, /handshakeTimeout:\s*CONNECT_TIMEOUT_MS/);
  });

  test('自前の接続監視タイマーが CONNECTING 判定 + terminate() を持つ', () => {
    const idx = source.indexOf('connectWatchdogTimer = setTimeout(');
    assert.ok(idx !== -1, 'connectWatchdogTimer の setTimeout が見つかること');
    const body = source.slice(idx, idx + 500);
    assert.match(body, /readyState === WebSocket\.CONNECTING/);
    assert.match(body, /\.terminate\(\)/);
  });

  test('CONNECT_WATCHDOG_MS ベースの遅延で張られている', () => {
    const idx = source.indexOf('connectWatchdogTimer = setTimeout(');
    const body = source.slice(idx, idx + 600);
    assert.match(body, /\},\s*CONNECT_WATCHDOG_MS\)/);
  });

  test('clearConnectWatchdog が open/close/error/disconnect の少なくとも4箇所で呼ばれている', () => {
    const count = source.split('clearConnectWatchdog()').length - 1;
    assert.ok(count >= 4, `clearConnectWatchdog() の呼び出しが4箇所未満: ${count}`);
  });
});

describe('connectToServer(): 原因B（安定判定）', () => {
  test('reconnectAttempts のリセットは open 側の安定タイマー内にある（scheduleReconnect 側ではない）', () => {
    const openIdx = source.indexOf(".on('open'");
    assert.ok(openIdx !== -1, "〈ws|thisWs〉.on('open' が見つかること");
    const openToMessage = source.slice(openIdx, source.indexOf("on('message'", openIdx));
    assert.match(openToMessage, /stableConnectionTimer = setTimeout\(/);
    assert.match(openToMessage, /reconnectAttempts = 0;/);
  });

  test('scheduleReconnect() 本文に旧「接続からの経過時間」判定（connectionDuration）が残っていない', () => {
    const body = extractFunction(source, 'function scheduleReconnect(');
    assert.doesNotMatch(body, /connectionDuration/, 'scheduleReconnect に旧安定判定が残っている');
    assert.doesNotMatch(body, /reconnectAttempts = 0/, 'scheduleReconnect 内でリセットしていない（open 側に一元化されているべき）');
  });
});

describe('scheduleReconnect(): 原因C（無期限リトライ）', () => {
  const body = extractFunction(source, 'function scheduleReconnect(');

  test('maxAttempts の destructure・比較が削除されている（コメントでの言及は許容）', () => {
    assert.doesNotMatch(body, /\{\s*baseDelay,\s*maxDelay,\s*maxAttempts/, 'DEFAULTS.reconnect から maxAttempts を destructure している');
    assert.doesNotMatch(body, /reconnectAttempts\s*>=\s*maxAttempts/, 'reconnectAttempts >= maxAttempts の打ち切り判定が残っている');
  });

  test('"Giving up" で打ち切るログが削除されている', () => {
    assert.doesNotMatch(body, /Giving up/);
  });

  test('遅延計算が computeReconnectDelay() に委譲されている', () => {
    assert.match(body, /computeReconnectDelay\(\{/);
  });

  test('ログの attempt 表示に /${maxAttempts} のような上限表示が残っていない', () => {
    const idx = body.indexOf('Reconnecting in');
    assert.ok(idx !== -1);
    const line = body.slice(idx, body.indexOf('\n', idx));
    assert.doesNotMatch(line, /\/\$\{maxAttempts\}/);
  });

  test('プロトコルバージョン不足による意図した停止は維持されている（回帰防止）', () => {
    assert.match(body, /protocolUpdateRequired/);
  });
});

describe('最後の砦: 常駐監視（supervisor）', () => {
  test('startReconnectSupervisor が多重起動ガードを持つ', () => {
    const body = extractFunction(source, 'function startReconnectSupervisor(');
    assert.match(body, /if \(supervisorTimer\) return;/);
  });

  test('supervisor は shuttingDown / protocolUpdateRequired を見て早期 return する', () => {
    const body = extractFunction(source, 'function startReconnectSupervisor(');
    assert.match(body, /if \(shuttingDown \|\| protocolUpdateRequired\) return;/);
  });

  test('disconnect() が shuttingDown = true にしてから supervisor を止める', () => {
    const body = extractFunction(source, 'export function disconnect(');
    assert.match(body, /shuttingDown = true;/);
    assert.match(body, /stopReconnectSupervisor\(\);/);
  });
});
