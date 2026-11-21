// クロスユーザー Team 招待候補（apps/web/src/lib/cross-team-invite-rules.ts）の単体テスト。
// 外部 import ゼロの純粋関数をコンパイル済み dist-test から直接 import する（push-device-rules.test.mjs と同じ流儀）。
//
// 2026-11-08 の実機バグの再現と固定: 旧実装（TeamPage.tsx に直書きされていた
// getInvitableCandidates()）は既存クロスメンバーの所有者も候補から除外しており、
// サーバー側で解禁した「再招待 = プロジェクト追加」が UI から到達できなかった。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { selectInvitableCandidates } from '../dist-test/lib/cross-team-invite-rules.js';

function candidate(overrides = {}) {
  return { userId: 'u-yahoo', name: 'KEISUKE MURATA', email: 'fwjg...@yahoo.co.jp', ...overrides };
}

describe('selectInvitableCandidates', () => {
  test('バグの再現固定: 旧ロジックでは唯一の組織メンバーが公開済みだと候補が消えていた（新ロジックは残す）', () => {
    const yahoo = candidate();
    const orgCandidates = [yahoo];

    // 旧ロジック（TeamPage.tsx の修正前の実装をそのまま再現）
    const ownerIds = new Set(['u-yahoo']); // 既にこのチームへ MyApplication を公開済み
    const pendingIds = new Set();
    const oldResult = orgCandidates.filter(c => !ownerIds.has(c.userId) && !pendingIds.has(c.userId));
    assert.equal(oldResult.length, 0, '旧ロジックでは候補が消えていた（バグの再現）');

    // 新ロジック
    const newResult = selectInvitableCandidates({
      orgCandidates,
      crossMemberOwnerIds: ['u-yahoo'],
      pendingInviteeIds: [],
    });
    assert.equal(newResult.length, 1, '新ロジックでは追加依頼の相手として残る');
    assert.equal(newResult[0].userId, 'u-yahoo');
    assert.equal(newResult[0].alreadyContributing, true);
  });

  test('承認待ちの宛先は除外する（再招待しても意味が無いため）', () => {
    const result = selectInvitableCandidates({
      orgCandidates: [candidate({ userId: 'u-pending' })],
      crossMemberOwnerIds: [],
      pendingInviteeIds: ['u-pending'],
    });
    assert.equal(result.length, 0);
  });

  test('新規の相手（公開済みでも承認待ちでもない）は alreadyContributing: false', () => {
    const result = selectInvitableCandidates({
      orgCandidates: [candidate({ userId: 'u-new' })],
      crossMemberOwnerIds: [],
      pendingInviteeIds: [],
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].alreadyContributing, false);
  });

  test('承認待ちかつ公開済み（同一ユーザーが別プロジェクトで pending を持つ）は除外が優先される', () => {
    const result = selectInvitableCandidates({
      orgCandidates: [candidate({ userId: 'u-both' })],
      crossMemberOwnerIds: ['u-both'],
      pendingInviteeIds: ['u-both'],
    });
    assert.equal(result.length, 0);
  });

  test('並び順は orgCandidates の入力順を保つ', () => {
    const result = selectInvitableCandidates({
      orgCandidates: [
        candidate({ userId: 'u-1' }),
        candidate({ userId: 'u-2' }),
        candidate({ userId: 'u-3' }),
      ],
      crossMemberOwnerIds: ['u-2'],
      pendingInviteeIds: [],
    });
    assert.deepEqual(result.map(c => c.userId), ['u-1', 'u-2', 'u-3']);
  });

  test('空入力は空配列を返す', () => {
    const result = selectInvitableCandidates({
      orgCandidates: [],
      crossMemberOwnerIds: [],
      pendingInviteeIds: [],
    });
    assert.deepEqual(result, []);
  });

  test('候補にない userId が crossMemberOwnerIds/pendingInviteeIds に混ざっていても無視する', () => {
    const result = selectInvitableCandidates({
      orgCandidates: [candidate({ userId: 'u-1' })],
      crossMemberOwnerIds: ['u-999'],
      pendingInviteeIds: ['u-888'],
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].alreadyContributing, false);
  });
});
