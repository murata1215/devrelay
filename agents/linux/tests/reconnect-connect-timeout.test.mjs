// エージェント再接続根治サイクル（2026-11-14）: 自前の接続監視タイマーが
// 「ws v8 の terminate() は CONNECTING 中でも error → close を必ず発火する」という前提に
// 依存しているため、その前提自体を ws ライブラリに対して live で実証する。
// サーバー不要・1秒未満で完走する（node:net の「accept するが何も返さない TCP サーバー」のみ使用）。
//
// connection.ts 側の静的な配線は reconnect-wiring.test.mjs（node:fs の文字列検証）でカバーしており、
// ここでは「terminate() が本当に close イベントに戻ってくるか」という ws ライブラリの実挙動のみを見る。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import WebSocket from 'ws';

/**
 * accept するが一切データを返さない TCP サーバーを立てる（WebSocket ハンドシェイクが
 * 永久に CONNECTING のまま止まる状況をローカルで再現する）。
 * 受理済みソケットを記録しておき、close() で明示的に破棄する（放置すると accept 済み
 * ソケットがイベントループを掴んだままになり node --test が完走しない）。
 */
function createSilentServer() {
  return new Promise((resolve) => {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      // 何もしない（accept だけして放置）
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `ws://127.0.0.1:${server.address().port}`,
        close: () => {
          for (const socket of sockets) socket.destroy();
          server.close();
        },
      });
    });
  });
}

test('① handshakeTimeout: CONNECTING のまま止まった接続は error + close を発火する', async () => {
  const silent = await createSilentServer();
  try {
    const ws = new WebSocket(silent.url, { handshakeTimeout: 300 });
    const events = [];
    const closed = new Promise((resolve) => {
      ws.on('error', (err) => events.push(`error:${err.message}`));
      ws.on('close', () => {
        events.push('close');
        resolve();
      });
    });
    await closed;
    assert.ok(events.includes('close'), `close イベントが来なかった: ${JSON.stringify(events)}`);
    assert.ok(
      events.some((e) => e.startsWith('error:')),
      `error イベントが来なかった（handshakeTimeout が機能していない）: ${JSON.stringify(events)}`,
    );
  } finally {
    silent.close();
  }
});

test('② 自前監視タイマー相当: handshakeTimeout 無しで CONNECTING 中に terminate() すると close が来る', async () => {
  const silent = await createSilentServer();
  try {
    // handshakeTimeout を指定しない（= connection.ts の自前監視タイマーが唯一の保険になる状況を再現）
    const ws = new WebSocket(silent.url);
    assert.equal(ws.readyState, WebSocket.CONNECTING);

    const closed = new Promise((resolve) => {
      ws.on('close', resolve);
      ws.on('error', () => {}); // terminate() も error を発火させるため拾っておく（未処理例外防止）
    });

    // connection.ts の connectWatchdogTimer コールバックと同じ条件分岐
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(ws.readyState, WebSocket.CONNECTING, 'まだ CONNECTING のままであること（テストの前提）');
    ws.terminate();

    await closed; // タイムアウトせずに resolve すれば、close → scheduleReconnect の経路に戻れることの実証
  } finally {
    silent.close();
  }
});
