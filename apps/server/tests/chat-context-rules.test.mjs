// 外部 import ゼロの純粋関数（apps/server/src/services/chat-context-rules.ts）を
// コンパイル済み dist から直接 import する（既存 cross-query-guard.test.mjs と同じ流儀）。
// Phase 0-2: 共有チャンネルで発言者が変わったときの UserContext 再解決ルール

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isChatCtxPerUserEnabled,
  reconcileUserContext,
} from '../dist/services/chat-context-rules.js';

// ---- isChatCtxPerUserEnabled ----

test('isChatCtxPerUserEnabled: 既定（未設定）は true', () => {
  assert.equal(isChatCtxPerUserEnabled(undefined), true);
});

test("isChatCtxPerUserEnabled: '0' のときだけ false", () => {
  assert.equal(isChatCtxPerUserEnabled('0'), false);
});

test("isChatCtxPerUserEnabled: '1' や他の文字列は true", () => {
  assert.equal(isChatCtxPerUserEnabled('1'), true);
  assert.equal(isChatCtxPerUserEnabled('false'), true);
});

// ---- reconcileUserContext ----

test('reconcileUserContext: existing が無ければ null（新規作成は呼び出し側の責務）', () => {
  assert.equal(reconcileUserContext(undefined, 'user-b'), null);
});

test('reconcileUserContext: 同じ userId なら null（変更不要）', () => {
  const existing = {
    userId: 'user-a',
    platform: 'discord',
    chatId: 'chan-1',
    currentMachineId: 'machine-1',
    currentSessionId: 'session-1',
    lastRemoteProjectId: 'proj-remote',
    lastRemoteProjectName: 'Remote Project',
  };
  assert.equal(reconcileUserContext(existing, 'user-a'), null);
});

test('reconcileUserContext: userId が変わると接続状態が全てリセットされる', () => {
  const existing = {
    userId: 'user-a',
    platform: 'discord',
    chatId: 'chan-1',
    lastListType: 'project',
    lastListItems: ['p1', 'p2'],
    currentMachineId: 'machine-1',
    currentMachineName: 'My Machine',
    currentSessionId: 'session-1',
    currentProjectName: 'My Project',
    lastProjectId: 'proj-1',
    lastRemoteProjectId: 'proj-remote',
    lastRemoteProjectName: 'Remote Project',
    language: 'ja',
  };
  const reconciled = reconcileUserContext(existing, 'user-b');
  assert.ok(reconciled);
  assert.equal(reconciled.userId, 'user-b');
  // platform / chatId は不変
  assert.equal(reconciled.platform, 'discord');
  assert.equal(reconciled.chatId, 'chan-1');
  // 前の発言者固有の状態は一切引き継がない
  assert.equal(reconciled.lastListType, undefined);
  assert.equal(reconciled.lastListItems, undefined);
  assert.equal(reconciled.currentMachineId, undefined);
  assert.equal(reconciled.currentMachineName, undefined);
  assert.equal(reconciled.currentSessionId, undefined);
  assert.equal(reconciled.currentProjectName, undefined);
  assert.equal(reconciled.lastProjectId, undefined);
  assert.equal(reconciled.lastRemoteProjectId, undefined);
  assert.equal(reconciled.lastRemoteProjectName, undefined);
  // language は呼び出し側が再解決するまでの暫定値として保持される
  assert.equal(reconciled.language, 'ja');
});

test('reconcileUserContext: Web の chatId には userId が埋め込まれるため実運用では同一ユーザーのまま呼ばれる想定だが、関数自体はどの platform でも同じ規則で動く', () => {
  const existing = {
    userId: 'user-a',
    platform: 'web',
    chatId: 'web:user-a:tab-1',
    currentMachineId: 'machine-1',
  };
  const reconciled = reconcileUserContext(existing, 'user-b');
  assert.ok(reconciled);
  assert.equal(reconciled.currentMachineId, undefined);
});
