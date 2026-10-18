// 会話履歴レール（右レール第3タブ）: apps/web/src/lib/conversation-rail-rules.ts の単体テスト。
// 外部 import ゼロの純関数を dist-test/ から直接 import する（thread-list-rules.test.mjs と同じ流儀）。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  readSidebarMode,
  resolveConversationStatus,
  readSeenMap,
  serializeSeenMap,
  seedSeenMap,
  markSeen,
  pruneSeenMap,
  decideAutoSeen,
  CONVERSATION_SEEN_MAX,
} from '../dist-test/lib/conversation-rail-rules.js';

describe('readSidebarMode', () => {
  test("'agents'/'servers'/'conversations' はそのまま返す", () => {
    assert.equal(readSidebarMode('agents'), 'agents');
    assert.equal(readSidebarMode('servers'), 'servers');
    assert.equal(readSidebarMode('conversations'), 'conversations');
  });

  test('null・未知の文字列・空文字は servers にフォールバック', () => {
    assert.equal(readSidebarMode(null), 'servers');
    assert.equal(readSidebarMode('unknown'), 'servers');
    assert.equal(readSidebarMode(''), 'servers');
  });
});

describe('resolveConversationStatus', () => {
  const base = { lastActiveAt: '2026-10-18T00:00:00.000Z' };

  test('running=true は未読条件が成立していても running を優先', () => {
    assert.equal(resolveConversationStatus({
      ...base, running: true, lastAiAt: '2026-10-18T01:00:00.000Z', seenAt: null,
    }), 'running');
  });

  test('localRunning=true だけでも running', () => {
    assert.equal(resolveConversationStatus({
      ...base, localRunning: true, lastAiAt: null,
    }), 'running');
  });

  test('lastAiAt が null（AI応答まだ無し）→ seen', () => {
    assert.equal(resolveConversationStatus({ ...base, lastAiAt: null }), 'seen');
  });

  test('seenAt が無い（未読）かつ lastAiAt あり → unread', () => {
    assert.equal(resolveConversationStatus({
      ...base, lastAiAt: '2026-10-18T01:00:00.000Z', seenAt: null,
    }), 'unread');
  });

  test('lastAiAt === seenAt（等値）→ seen', () => {
    const t = '2026-10-18T01:00:00.000Z';
    assert.equal(resolveConversationStatus({ ...base, lastAiAt: t, seenAt: t }), 'seen');
  });

  test('lastAiAt < seenAt（既に見た後の時刻）→ seen', () => {
    assert.equal(resolveConversationStatus({
      ...base,
      lastAiAt: '2026-10-18T01:00:00.000Z',
      seenAt: '2026-10-18T02:00:00.000Z',
    }), 'seen');
  });

  test('lastAiAt > seenAt（新しい応答あり）→ unread', () => {
    assert.equal(resolveConversationStatus({
      ...base,
      lastAiAt: '2026-10-18T03:00:00.000Z',
      seenAt: '2026-10-18T02:00:00.000Z',
    }), 'unread');
  });

  test('ISO がパース不能 → seen（fail-safe: 見逃しを選ぶ）', () => {
    assert.equal(resolveConversationStatus({
      ...base,
      lastAiAt: 'not-a-date',
      seenAt: '2026-10-18T02:00:00.000Z',
    }), 'seen');
  });

  test('lastAiAt キー自体が無い（旧サーバー応答）→ lastActiveAt にフォールバック', () => {
    // seenAt 無し＝未読
    assert.equal(resolveConversationStatus({ lastActiveAt: '2026-10-18T05:00:00.000Z' }), 'unread');
    // seenAt が lastActiveAt より新しい＝既読
    assert.equal(resolveConversationStatus({
      lastActiveAt: '2026-10-18T05:00:00.000Z',
      seenAt: '2026-10-18T06:00:00.000Z',
    }), 'seen');
  });
});

describe('readSeenMap / serializeSeenMap', () => {
  test('null は initialized:false', () => {
    assert.deepEqual(readSeenMap(null), { initialized: false, seen: {} });
  });

  test('不正 JSON は initialized:false', () => {
    assert.deepEqual(readSeenMap('{not json'), { initialized: false, seen: {} });
  });

  test('v 不一致は initialized:false', () => {
    assert.deepEqual(readSeenMap(JSON.stringify({ v: 999, seen: { s1: 'x' } })), { initialized: false, seen: {} });
  });

  test('seen が object でない場合は initialized:false', () => {
    assert.deepEqual(readSeenMap(JSON.stringify({ v: 1, seen: 'not-an-object' })), { initialized: false, seen: {} });
  });

  test('正常なデータは initialized:true で復元される', () => {
    const result = readSeenMap(JSON.stringify({ v: 1, seen: { s1: '2026-10-18T00:00:00.000Z' } }));
    assert.deepEqual(result, { initialized: true, seen: { s1: '2026-10-18T00:00:00.000Z' } });
  });

  test('seen の値が文字列でないエントリは読み捨てる', () => {
    const result = readSeenMap(JSON.stringify({ v: 1, seen: { s1: '2026-10-18T00:00:00.000Z', s2: 12345 } }));
    assert.deepEqual(result, { initialized: true, seen: { s1: '2026-10-18T00:00:00.000Z' } });
  });

  test('serializeSeenMap → readSeenMap の往復は恒等', () => {
    const original = { s1: '2026-10-18T00:00:00.000Z', s2: '2026-10-17T00:00:00.000Z' };
    const roundTripped = readSeenMap(serializeSeenMap(original));
    assert.deepEqual(roundTripped, { initialized: true, seen: original });
  });
});

describe('seedSeenMap', () => {
  test('未初期化のとき、lastAiAt がある行だけ全件シードする', () => {
    const state = { initialized: false, seen: {} };
    const items = [
      { sessionId: 's1', lastAiAt: '2026-10-18T00:00:00.000Z' },
      { sessionId: 's2', lastAiAt: null },
      { sessionId: 's3' }, // lastAiAt 自体が無い
    ];
    assert.deepEqual(seedSeenMap(state, items), { s1: '2026-10-18T00:00:00.000Z' });
  });

  test('初期化済みなら恒等（既存 seen を書き換えない）', () => {
    const existing = { s1: '2026-10-18T00:00:00.000Z' };
    const state = { initialized: true, seen: existing };
    const items = [{ sessionId: 's2', lastAiAt: '2026-10-18T01:00:00.000Z' }];
    assert.equal(seedSeenMap(state, items), existing); // 同一参照（新規オブジェクトを作らない）
  });
});

describe('markSeen', () => {
  test('新規 sessionId を追加する', () => {
    const result = markSeen({}, 's1', '2026-10-18T00:00:00.000Z');
    assert.deepEqual(result, { s1: '2026-10-18T00:00:00.000Z' });
  });

  test('既存より新しい値のみ更新する', () => {
    const seen = { s1: '2026-10-18T00:00:00.000Z' };
    const result = markSeen(seen, 's1', '2026-10-18T01:00:00.000Z');
    assert.deepEqual(result, { s1: '2026-10-18T01:00:00.000Z' });
  });

  test('既存より古い値は無視する（巻き戻さない）', () => {
    const seen = { s1: '2026-10-18T01:00:00.000Z' };
    const result = markSeen(seen, 's1', '2026-10-18T00:00:00.000Z');
    assert.deepEqual(result, seen);
    assert.equal(result, seen); // 恒等（新規オブジェクトを作らない）
  });

  test('atIso が null/undefined のときは恒等', () => {
    const seen = { s1: '2026-10-18T00:00:00.000Z' };
    assert.equal(markSeen(seen, 's1', null), seen);
    assert.equal(markSeen(seen, 's1', undefined), seen);
  });
});

describe('pruneSeenMap', () => {
  test('上限以下なら恒等', () => {
    const seen = { s1: 'a', s2: 'b' };
    assert.equal(pruneSeenMap(seen, 10), seen);
  });

  test('超過時に古い順（キー挿入順の先頭）から落とす', () => {
    const seen = { s1: 'a', s2: 'b', s3: 'c' };
    const result = pruneSeenMap(seen, 2);
    assert.deepEqual(result, { s2: 'b', s3: 'c' });
  });

  test('CONVERSATION_SEEN_MAX は 200', () => {
    assert.equal(CONVERSATION_SEEN_MAX, 200);
  });
});

describe('decideAutoSeen', () => {
  test('active かつ visible のときだけ true', () => {
    assert.equal(decideAutoSeen({ sessionId: 's1', activeSessionId: 's1', visible: true }), true);
  });

  test('非アクティブなら false', () => {
    assert.equal(decideAutoSeen({ sessionId: 's1', activeSessionId: 's2', visible: true }), false);
  });

  test('不可視なら false', () => {
    assert.equal(decideAutoSeen({ sessionId: 's1', activeSessionId: 's1', visible: false }), false);
  });

  test('activeSessionId が null なら false', () => {
    assert.equal(decideAutoSeen({ sessionId: 's1', activeSessionId: null, visible: true }), false);
  });
});
