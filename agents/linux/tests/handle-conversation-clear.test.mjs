// スレッド管理 cycle2: handleConversationClear（connection.ts）の統合テスト。
// conversation-store.ts / session-store.ts の scope 対応は別テストで検証済みのため、
// ここでは「呼び出し側のハンドラ自体」が正しく scope を解決し、
// (a) 不正な agentScopeId でも Agent プロセスを落とさない（try/catch の効果）
// (b) scoped クリア時に既定スレッド（.devrelay/ 直下）が一切変更されない
// (c) agentScopeId 未指定時は従来どおり既定スレッドがクリアされる（後方互換）
// ことを検証する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleConversationClear } from '../dist/services/connection.js';
import { saveConversation, loadConversation } from '../dist/services/conversation-store.js';
import { saveClaudeSessionId, loadClaudeSessionId } from '../dist/services/session-store.js';

async function withTempProject(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'devrelay-handle-clear-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('handleConversationClear: 不正な agentScopeId を渡しても throw / unhandled rejection にならない', async () => {
  await withTempProject(async (projectPath) => {
    // '../escape' はトラバーサル、'bad/scope' はスラッシュを含み ^[A-Za-z0-9_-]{1,128}$ に一致しない
    await assert.doesNotReject(
      handleConversationClear({ sessionId: 'sess-invalid', projectPath, agentScopeId: '../escape' })
    );
    await assert.doesNotReject(
      handleConversationClear({ sessionId: 'sess-invalid-2', projectPath, agentScopeId: 'bad/scope' })
    );
  });
});

test('handleConversationClear: agentScopeId 指定時は既定スレッド（.devrelay/ 直下）が一切変更されない', async () => {
  await withTempProject(async (projectPath) => {
    // 既定スレッド側に会話とセッション ID を作っておく
    await saveConversation(projectPath, [{ role: 'user', content: 'default thread', timestamp: new Date().toISOString() }]);
    await saveClaudeSessionId(projectPath, 'claude-session-default');

    const defaultConversationPath = join(projectPath, '.devrelay', 'conversation.json');
    const before = await readFile(defaultConversationPath, 'utf-8');

    // scoped スレッドをクリア（既定スレッドとは無関係のはず）
    await handleConversationClear({ sessionId: 'sess-scoped', projectPath, agentScopeId: 'scope-isolated' });

    const after = await readFile(defaultConversationPath, 'utf-8');
    assert.equal(after, before, '既定スレッドの conversation.json が変更されてはならない');

    const defaultClaudeSessionId = await loadClaudeSessionId(projectPath);
    assert.equal(defaultClaudeSessionId, 'claude-session-default', '既定スレッドの claude session id がクリアされてはならない');

    // scoped 側のディレクトリだけが作られている
    assert.ok(existsSync(join(projectPath, '.devrelay', 'sessions', 'scope-isolated')));
  });
});

test('handleConversationClear: agentScopeId 未指定時は従来どおり既定スレッドがクリアされる（後方互換）', async () => {
  await withTempProject(async (projectPath) => {
    await saveConversation(projectPath, [{ role: 'user', content: 'to be cleared', timestamp: new Date().toISOString() }]);
    await saveClaudeSessionId(projectPath, 'claude-session-to-clear');

    await handleConversationClear({ sessionId: 'sess-default', projectPath });

    const history = await loadConversation(projectPath);
    assert.equal(history.length, 0, '既定スレッドの会話履歴がクリアされているはず');

    const claudeSessionId = await loadClaudeSessionId(projectPath);
    assert.equal(claudeSessionId, null, '既定スレッドの claude session id がクリアされているはず');
  });
});

test('handleConversationClear: agentScopeId 指定時にそのスレッド自身は正しくクリアされる', async () => {
  await withTempProject(async (projectPath) => {
    const scopeId = 'scope-target';
    await saveConversation(projectPath, [{ role: 'user', content: 'scoped content', timestamp: new Date().toISOString() }], scopeId);
    await saveClaudeSessionId(projectPath, 'claude-session-scoped', undefined, scopeId);

    await handleConversationClear({ sessionId: 'sess-target', projectPath, agentScopeId: scopeId });

    const history = await loadConversation(projectPath, scopeId);
    assert.equal(history.length, 0);

    const claudeSessionId = await loadClaudeSessionId(projectPath, scopeId);
    assert.equal(claudeSessionId, null);
  });
});
