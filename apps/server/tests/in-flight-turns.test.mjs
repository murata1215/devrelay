// サイクル3.1: 実行中 AI ターン台帳（apps/server/src/services/in-flight-turns.ts）の単体テスト。
// 外部 import ゼロの純粋なデータ構造をコンパイル済み dist から直接 import する
// （auto-update-reconcile.test.mjs と同じ流儀）。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { InFlightTurnRegistry } from '../dist/services/in-flight-turns.js';

const HOUR_MS = 60 * 60 * 1000;

describe('InFlightTurnRegistry: start/end', () => {
  test('start 後は isBusy=true、count=1', () => {
    const reg = new InFlightTurnRegistry();
    reg.start('m1', 's1', 1000);
    assert.equal(reg.isBusy('m1', 1000), true);
    assert.equal(reg.count('m1', 1000), 1);
  });

  test('end で解除され isBusy=false、count=0 に戻る', () => {
    const reg = new InFlightTurnRegistry();
    reg.start('m1', 's1', 1000);
    const removed = reg.end('m1', 's1');
    assert.equal(removed, true);
    assert.equal(reg.isBusy('m1', 1000), false);
    assert.equal(reg.count('m1', 1000), 0);
  });

  test('end: 居ない key に対しては false を返す（例外を投げない）', () => {
    const reg = new InFlightTurnRegistry();
    assert.equal(reg.end('m1', 'never-started'), false);
  });

  test('居ない machineId に対する isBusy/count は false/0', () => {
    const reg = new InFlightTurnRegistry();
    assert.equal(reg.isBusy('ghost', 1000), false);
    assert.equal(reg.count('ghost', 1000), 0);
  });
});

describe('InFlightTurnRegistry: 同一 sessionId の二重 start', () => {
  test('同一 key を 2 回 start しても count は 1（上書き、例外は投げない）', () => {
    const reg = new InFlightTurnRegistry();
    reg.start('m1', 's1', 1000);
    reg.start('m1', 's1', 2000);
    assert.equal(reg.count('m1', 2000), 1);
  });

  test('2 回目の start で開始時刻が更新される（TTL 判定が新しい時刻を基準にする）', () => {
    const reg = new InFlightTurnRegistry(1000); // TTL=1000ms
    reg.start('m1', 's1', 0);
    reg.start('m1', 's1', 900); // 更新
    // 900 + 1000 = 1900 まで有効。1850 時点ではまだ busy
    assert.equal(reg.isBusy('m1', 1850), true);
    // 2000 時点では TTL 超過
    assert.equal(reg.isBusy('m1', 2000), false);
  });
});

describe('InFlightTurnRegistry: clearMachine', () => {
  test('指定マシンの全エントリを消し、消した件数を返す', () => {
    const reg = new InFlightTurnRegistry();
    reg.start('m1', 's1', 1000);
    reg.start('m1', 's2', 1000);
    reg.start('m2', 's3', 1000);
    const removed = reg.clearMachine('m1');
    assert.equal(removed, 2);
    assert.equal(reg.isBusy('m1', 1000), false);
    assert.equal(reg.isBusy('m2', 1000), true); // 他マシンは影響を受けない
  });

  test('エントリが無いマシンに対しては 0 を返す', () => {
    const reg = new InFlightTurnRegistry();
    assert.equal(reg.clearMachine('ghost'), 0);
  });
});

describe('InFlightTurnRegistry: TTL 失効', () => {
  test('TTL 超過したエントリは isBusy=false・count=0（取りこぼし経路の保険）', () => {
    const reg = new InFlightTurnRegistry(HOUR_MS);
    reg.start('m1', 's1', 0);
    assert.equal(reg.isBusy('m1', HOUR_MS - 1), true);
    assert.equal(reg.isBusy('m1', HOUR_MS), false); // ちょうど TTL で失効
  });

  test('sweepStale はTTL超過分のみ削除し、削除件数を返す', () => {
    const reg = new InFlightTurnRegistry(1000);
    reg.start('m1', 's1', 0); // TTL 超過予定
    reg.start('m1', 's2', 5000); // まだ有効
    reg.start('m2', 's3', 0); // TTL 超過予定
    const removed = reg.sweepStale(5500);
    assert.equal(removed, 2);
    assert.equal(reg.count('m1', 5500), 1); // s2 は残る
    assert.equal(reg.isBusy('m2', 5500), false);
  });

  test('sweepStale 後に全エントリが消えたマシンは Map 自体からも消える（count は 0）', () => {
    const reg = new InFlightTurnRegistry(1000);
    reg.start('m1', 's1', 0);
    reg.sweepStale(5000);
    assert.equal(reg.count('m1', 5000), 0);
    assert.equal(reg.clearMachine('m1'), 0); // 既に空なので 0
  });
});

describe('InFlightTurnRegistry: 別マシンの独立性', () => {
  test('あるマシンの start/end は別マシンに影響しない', () => {
    const reg = new InFlightTurnRegistry();
    reg.start('m1', 's1', 1000);
    assert.equal(reg.isBusy('m2', 1000), false);
    reg.end('m1', 's1');
    assert.equal(reg.isBusy('m1', 1000), false);
  });

  test('count は複数ターンを正しく合算する', () => {
    const reg = new InFlightTurnRegistry();
    reg.start('m1', 's1', 1000);
    reg.start('m1', 's2', 1000);
    reg.start('m1', 's3', 1000);
    assert.equal(reg.count('m1', 1000), 3);
    reg.end('m1', 's2');
    assert.equal(reg.count('m1', 1000), 2);
  });
});
