// チャットのスクロール保持ルール: apps/web/src/lib/chat-scroll-rules.ts の単体テスト。
// 外部 import ゼロの純関数を dist-test/ から直接 import する（conversation-rail-rules.test.mjs と同じ流儀）。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAtBottom,
  decideHistoryRefresh,
  resolveRestoredScrollTop,
  CHAT_AT_BOTTOM_THRESHOLD_PX,
} from '../dist-test/lib/chat-scroll-rules.js';

describe('isAtBottom', () => {
  test('scrollTop が scrollHeight-clientHeight と一致（完全な下端）は true', () => {
    assert.equal(isAtBottom({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 }), true);
  });

  test('しきい値未満の差は true（下端扱い）', () => {
    const gap = CHAT_AT_BOTTOM_THRESHOLD_PX - 1;
    assert.equal(isAtBottom({ scrollTop: 900 - gap, scrollHeight: 1000, clientHeight: 100 }), true);
  });

  test('しきい値ちょうどの差は false（境界は下端扱いしない）', () => {
    const gap = CHAT_AT_BOTTOM_THRESHOLD_PX;
    assert.equal(isAtBottom({ scrollTop: 900 - gap, scrollHeight: 1000, clientHeight: 100 }), false);
  });

  test('上方に離れている場合は false', () => {
    assert.equal(isAtBottom({ scrollTop: 0, scrollHeight: 1000, clientHeight: 100 }), false);
  });

  test('scrollHeight <= clientHeight（非スクロール）は常に true', () => {
    assert.equal(isAtBottom({ scrollTop: 0, scrollHeight: 80, clientHeight: 100 }), true);
    assert.equal(isAtBottom({ scrollTop: 0, scrollHeight: 100, clientHeight: 100 }), true);
  });

  test('カスタムしきい値を渡せる', () => {
    assert.equal(isAtBottom({ scrollTop: 800, scrollHeight: 1000, clientHeight: 100 }, 150), true);
    assert.equal(isAtBottom({ scrollTop: 800, scrollHeight: 1000, clientHeight: 100 }, 50), false);
  });
});

describe('decideHistoryRefresh', () => {
  test('アクティブタブが無ければ常に skip', () => {
    assert.deepEqual(
      decideHistoryRefresh({ trigger: 'visible', hasActiveTab: false, atBottom: false, wsConnected: true }),
      { kind: 'skip' },
    );
    assert.deepEqual(
      decideHistoryRefresh({ trigger: 'reconnect', hasActiveTab: false, atBottom: true, wsConnected: false }),
      { kind: 'skip' },
    );
  });

  test('atBottom が null（計測不能）なら refresh + stick-bottom（安全側の既定）', () => {
    assert.deepEqual(
      decideHistoryRefresh({ trigger: 'visible', hasActiveTab: true, atBottom: null, wsConnected: true }),
      { kind: 'refresh', scroll: 'stick-bottom' },
    );
  });

  test('atBottom が true なら trigger に関わらず refresh + stick-bottom', () => {
    assert.deepEqual(
      decideHistoryRefresh({ trigger: 'visible', hasActiveTab: true, atBottom: true, wsConnected: true }),
      { kind: 'refresh', scroll: 'stick-bottom' },
    );
    assert.deepEqual(
      decideHistoryRefresh({ trigger: 'reconnect', hasActiveTab: true, atBottom: true, wsConnected: false }),
      { kind: 'refresh', scroll: 'stick-bottom' },
    );
  });

  test('visible かつ WS 生存かつ上スクロール中 → skip（本バグの核心: 何もしなければ位置が保持される）', () => {
    assert.deepEqual(
      decideHistoryRefresh({ trigger: 'visible', hasActiveTab: true, atBottom: false, wsConnected: true }),
      { kind: 'skip' },
    );
  });

  test('visible かつ WS 切断中かつ上スクロール中 → refresh + keep-position（fail-safe で鮮度優先）', () => {
    assert.deepEqual(
      decideHistoryRefresh({ trigger: 'visible', hasActiveTab: true, atBottom: false, wsConnected: false }),
      { kind: 'refresh', scroll: 'keep-position' },
    );
  });

  test('reconnect かつ上スクロール中 → refresh は必須だが位置は保持（wsConnected の値は無関係）', () => {
    assert.deepEqual(
      decideHistoryRefresh({ trigger: 'reconnect', hasActiveTab: true, atBottom: false, wsConnected: true }),
      { kind: 'refresh', scroll: 'keep-position' },
    );
    assert.deepEqual(
      decideHistoryRefresh({ trigger: 'reconnect', hasActiveTab: true, atBottom: false, wsConnected: false }),
      { kind: 'refresh', scroll: 'keep-position' },
    );
  });
});

describe('resolveRestoredScrollTop', () => {
  test('高さが変わらなければ scrollTop もそのまま', () => {
    assert.equal(
      resolveRestoredScrollTop({ prevScrollTop: 500, prevScrollHeight: 2000, nextScrollHeight: 2000 }),
      500,
    );
  });

  test('コンテンツが縮んだ分だけ scrollTop を減らす', () => {
    assert.equal(
      resolveRestoredScrollTop({ prevScrollTop: 500, prevScrollHeight: 2000, nextScrollHeight: 1800 }),
      300,
    );
  });

  test('コンテンツが伸びた分だけ scrollTop を増やす', () => {
    assert.equal(
      resolveRestoredScrollTop({ prevScrollTop: 500, prevScrollHeight: 2000, nextScrollHeight: 2200 }),
      700,
    );
  });

  test('負の値になる場合は 0 にクランプする', () => {
    assert.equal(
      resolveRestoredScrollTop({ prevScrollTop: 100, prevScrollHeight: 2000, nextScrollHeight: 500 }),
      0,
    );
  });
});
