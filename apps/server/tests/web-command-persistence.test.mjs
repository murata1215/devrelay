// WebUI のコマンド応答が消える問題の根治（2026-10-18）:
// services/web-command-persistence.ts の判定純関数の単体テスト。
// testflight-killswitch.test.mjs / progress-cancel-hint.test.mjs と同じ流儀
// （外部 import ゼロの純関数を dist から直接 import する）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isWebCommandPersistEnabled,
  shouldPersistWebCommandTurn,
  shouldPersistWebResponse,
  buildWebUserMessageRow,
  buildWebResponseMessageRow,
} from '../dist/services/web-command-persistence.js';

test('isWebCommandPersistEnabled: 未設定は既定 ON', () => {
  assert.equal(isWebCommandPersistEnabled(undefined), true);
});

test('isWebCommandPersistEnabled: "0" のときのみ無効', () => {
  assert.equal(isWebCommandPersistEnabled('0'), false);
});

test('isWebCommandPersistEnabled: "0" 以外の値は有効のまま', () => {
  assert.equal(isWebCommandPersistEnabled('1'), true);
  assert.equal(isWebCommandPersistEnabled(''), true);
  assert.equal(isWebCommandPersistEnabled('false'), true);
});

test('shouldPersistWebCommandTurn: testflight/status/log/model:set は保存対象', () => {
  for (const commandType of ['testflight', 'status', 'log', 'model:set']) {
    const result = shouldPersistWebCommandTurn({ enabled: true, commandType, sessionId: 's1', userText: 'hello' });
    assert.deepEqual(result, { persist: true, reason: 'ok' });
  }
});

test('shouldPersistWebCommandTurn: AI ターン系（自前保存済み）は self-persisting で除外', () => {
  for (const commandType of ['exec', 'agreement', 'ai:prompt', 'ask:member', 'teamexec:member']) {
    const result = shouldPersistWebCommandTurn({ enabled: true, commandType, sessionId: 's1', userText: 'hello' });
    assert.deepEqual(result, { persist: false, reason: 'self-persisting' });
  }
});

test('shouldPersistWebCommandTurn: login 系・clear・quit は excluded で除外', () => {
  for (const commandType of ['login', 'login:code', 'login:cancel', 'clear', 'quit']) {
    const result = shouldPersistWebCommandTurn({ enabled: true, commandType, sessionId: 's1', userText: 'hello' });
    assert.deepEqual(result, { persist: false, reason: 'excluded' });
  }
});

test('shouldPersistWebCommandTurn: sessionId が無い場合は no-session', () => {
  const result = shouldPersistWebCommandTurn({ enabled: true, commandType: 'status', sessionId: null, userText: 'hello' });
  assert.deepEqual(result, { persist: false, reason: 'no-session' });
});

test('shouldPersistWebCommandTurn: テキストが空白のみの場合は empty-text', () => {
  const result = shouldPersistWebCommandTurn({ enabled: true, commandType: 'status', sessionId: 's1', userText: '   ' });
  assert.deepEqual(result, { persist: false, reason: 'empty-text' });
});

test('shouldPersistWebCommandTurn: キルスイッチ OFF は disabled（他の条件を満たしていても優先）', () => {
  const result = shouldPersistWebCommandTurn({ enabled: false, commandType: 'status', sessionId: 's1', userText: 'hello' });
  assert.deepEqual(result, { persist: false, reason: 'disabled' });
});

test('shouldPersistWebResponse: 非空文字列は true、未定義・null・空白のみは false', () => {
  assert.equal(shouldPersistWebResponse('ok'), true);
  assert.equal(shouldPersistWebResponse(''), false);
  assert.equal(shouldPersistWebResponse('   '), false);
  assert.equal(shouldPersistWebResponse(undefined), false);
  assert.equal(shouldPersistWebResponse(null), false);
});

test('buildWebUserMessageRow: role=user, platform=web, createdAt は receivedAt をそのまま使う', () => {
  const receivedAt = new Date('2026-10-18T09:34:00.000Z');
  const row = buildWebUserMessageRow({ sessionId: 's1', content: 'testflight uso8m', receivedAt });
  assert.deepEqual(row, {
    sessionId: 's1',
    role: 'user',
    content: 'testflight uso8m',
    platform: 'web',
    createdAt: receivedAt,
  });
});

test('buildWebResponseMessageRow: role=system, createdAt は user 行（receivedAt）より必ず後になる', () => {
  const receivedAt = new Date('2026-10-18T09:34:00.000Z');
  const completedAt = new Date('2026-10-18T09:34:05.000Z');
  const row = buildWebResponseMessageRow({ sessionId: 's1', content: '✅ uso8m を作成しました', receivedAt, completedAt });
  assert.equal(row.role, 'system');
  assert.equal(row.platform, 'web');
  assert.ok(row.createdAt.getTime() > receivedAt.getTime());
  assert.equal(row.createdAt.getTime(), completedAt.getTime());
});

test('buildWebResponseMessageRow: completedAt が receivedAt より前（時計の巻き戻り）でも user 行より後になる', () => {
  const receivedAt = new Date('2026-10-18T09:34:00.000Z');
  const completedAt = new Date('2026-10-18T09:33:59.000Z'); // receivedAt より前
  const row = buildWebResponseMessageRow({ sessionId: 's1', content: 'response', receivedAt, completedAt });
  assert.ok(row.createdAt.getTime() > receivedAt.getTime());
});
