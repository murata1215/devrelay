// 会話履歴レール（右レール第3タブ）: apps/web/src/lib/conversation-rail-rules.ts の単体テスト。
// 外部 import ゼロの純関数を dist-test/ から直接 import する（thread-list-rules.test.mjs と同じ流儀）。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  readSidebarMode,
  resolveConversationStatus,
  markSeen,
  resolveEffectiveSeenAt,
  decideAutoSeen,
  deriveAgentLabel,
  formatConversationScope,
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

describe('resolveEffectiveSeenAt', () => {
  test('localOverride が無ければサーバー値をそのまま返す', () => {
    assert.equal(resolveEffectiveSeenAt('2026-10-18T00:00:00.000Z', undefined), '2026-10-18T00:00:00.000Z');
    assert.equal(resolveEffectiveSeenAt(null, undefined), null);
    assert.equal(resolveEffectiveSeenAt(undefined, undefined), undefined);
  });

  test('サーバー値が null でも localOverride があればそちらを使う', () => {
    assert.equal(resolveEffectiveSeenAt(null, '2026-10-18T00:00:00.000Z'), '2026-10-18T00:00:00.000Z');
  });

  test('サーバー値が undefined（キルスイッチ OFF 等）でも localOverride があればそちらを使う', () => {
    assert.equal(resolveEffectiveSeenAt(undefined, '2026-10-18T00:00:00.000Z'), '2026-10-18T00:00:00.000Z');
  });

  test('両方あれば新しい方を採用する（巻き戻さない）', () => {
    assert.equal(
      resolveEffectiveSeenAt('2026-10-18T00:00:00.000Z', '2026-10-18T01:00:00.000Z'),
      '2026-10-18T01:00:00.000Z'
    );
    assert.equal(
      resolveEffectiveSeenAt('2026-10-18T02:00:00.000Z', '2026-10-18T01:00:00.000Z'),
      '2026-10-18T02:00:00.000Z'
    );
  });

  test('日時パース不能な側は無視してもう一方を採用する', () => {
    assert.equal(resolveEffectiveSeenAt('not-a-date', '2026-10-18T01:00:00.000Z'), '2026-10-18T01:00:00.000Z');
    assert.equal(resolveEffectiveSeenAt('2026-10-18T00:00:00.000Z', 'not-a-date'), '2026-10-18T00:00:00.000Z');
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

describe('deriveAgentLabel', () => {
  test('machineName（alias/username の2セグメント）の先頭セグメントのみ返す', () => {
    assert.equal(deriveAgentLabel('ubuntu-prod/devrelay'), 'ubuntu-prod');
  });

  test('スラッシュが無ければそのまま返す（旧データ・異常値への fail-open）', () => {
    assert.equal(deriveAgentLabel('x220'), 'x220');
  });

  test('複数スラッシュがあっても最初のスラッシュで区切る', () => {
    assert.equal(deriveAgentLabel('host/user/extra'), 'host');
  });

  test('前後の空白を trim する', () => {
    assert.equal(deriveAgentLabel('  ubuntu-prod/devrelay  '), 'ubuntu-prod');
  });

  test('空文字・null・undefined は空文字', () => {
    assert.equal(deriveAgentLabel(''), '');
    assert.equal(deriveAgentLabel(null), '');
    assert.equal(deriveAgentLabel(undefined), '');
  });

  test('空白のみは空文字', () => {
    assert.equal(deriveAgentLabel('   '), '');
  });
});

describe('formatConversationScope', () => {
  test('両方あれば agent/project で連結する（ユーザー提示例 ubuntu-prod/devrelay と一致）', () => {
    assert.equal(formatConversationScope({ agentLabel: 'ubuntu-prod', projectLabel: 'devrelay' }), 'ubuntu-prod/devrelay');
  });

  test('エージェント名が空ならプロジェクト名のみ', () => {
    assert.equal(formatConversationScope({ agentLabel: '', projectLabel: 'pixtalk' }), 'pixtalk');
  });

  test('プロジェクト名が空ならエージェント名のみ', () => {
    assert.equal(formatConversationScope({ agentLabel: 'ubuntu-prod', projectLabel: '' }), 'ubuntu-prod');
  });

  test('両方空なら空文字（呼び出し側が thread.untitled 等へフォールバックする）', () => {
    assert.equal(formatConversationScope({ agentLabel: '', projectLabel: '' }), '');
  });

  test('前後の空白を trim してから連結する', () => {
    assert.equal(formatConversationScope({ agentLabel: ' ubuntu-prod ', projectLabel: ' devrelay ' }), 'ubuntu-prod/devrelay');
  });
});
