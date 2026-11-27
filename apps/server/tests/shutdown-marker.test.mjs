// 再起動耐性サイクル（2026-11-25）: apps/server/src/services/shutdown-marker.ts の単体テスト。
// 実際の `apps/server/.runtime/shutdown.json` を使う（他サービスの `.runtime/*` 書き込みと
// パス・ファイル名が被らない前提。テスト前後で確実に後始末する）。

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, unlinkSync } from 'node:fs';
import {
  SHUTDOWN_MARKER_PATH,
  isShutdownMarkerEnabled,
  writeShutdownMarker,
  clearShutdownMarker,
  checkPreviousShutdown,
} from '../dist/services/shutdown-marker.js';

function removeMarkerIfExists() {
  if (existsSync(SHUTDOWN_MARKER_PATH)) unlinkSync(SHUTDOWN_MARKER_PATH);
}

beforeEach(removeMarkerIfExists);
afterEach(removeMarkerIfExists);

describe('isShutdownMarkerEnabled', () => {
  test('未設定（undefined）は有効（既定 ON）', () => {
    assert.equal(isShutdownMarkerEnabled(undefined), true);
  });
  test(`'0' のときだけ無効`, () => {
    assert.equal(isShutdownMarkerEnabled('0'), false);
  });
});

describe('writeShutdownMarker / clearShutdownMarker / checkPreviousShutdown', () => {
  test('write 後は checkPreviousShutdown が警告を返し、マーカーは消える', () => {
    writeShutdownMarker('SIGTERM');
    assert.equal(existsSync(SHUTDOWN_MARKER_PATH), true);
    const warning = checkPreviousShutdown();
    assert.match(warning, /SIGTERM/);
    assert.match(warning, /強制終了/);
    // checkPreviousShutdown 自体が読んだら消す（次回起動で繰り返し警告しないため）
    assert.equal(existsSync(SHUTDOWN_MARKER_PATH), false);
  });

  test('write → clear の正常完了シーケンスでは checkPreviousShutdown は null', () => {
    writeShutdownMarker('SIGTERM');
    clearShutdownMarker();
    assert.equal(checkPreviousShutdown(), null);
  });

  test('マーカーが無ければ checkPreviousShutdown は null', () => {
    assert.equal(checkPreviousShutdown(), null);
  });

  test(`DEVRELAY_SHUTDOWN_MARKER='0' のときは write しても checkPreviousShutdown は null`, () => {
    const prev = process.env.DEVRELAY_SHUTDOWN_MARKER;
    process.env.DEVRELAY_SHUTDOWN_MARKER = '0';
    try {
      writeShutdownMarker('SIGTERM');
      assert.equal(existsSync(SHUTDOWN_MARKER_PATH), false); // キルスイッチ OFF なら書かない
      assert.equal(checkPreviousShutdown(), null);
    } finally {
      if (prev === undefined) delete process.env.DEVRELAY_SHUTDOWN_MARKER;
      else process.env.DEVRELAY_SHUTDOWN_MARKER = prev;
    }
  });
});
