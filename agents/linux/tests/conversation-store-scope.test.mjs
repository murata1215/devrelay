// core#336 / スレッド管理 cycle2: conversation-store.ts の agentScopeId スコープ分離の単体テスト。
// saveConversation / appendToConversation / markExecPoint / archiveConversation が
// スコープ配下に書かれ、未指定時は従来パスに書かれることを検証する。
// cycle2 で archiveConversation もスコープ対応になったため、cycle1 時点の
// 「アーカイブは常にプロジェクト単位のまま」という回帰テストは scoped 版に置き換える
// （doc/thread-management-spec.md §4）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  saveConversation,
  appendToConversation,
  markExecPoint,
  archiveConversation,
  loadConversation,
} from '../dist/services/conversation-store.js';

async function withTempProject(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'devrelay-conversation-store-scope-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('conversation-store: agentScopeId 未指定時は .devrelay/conversation.json に書かれる', async () => {
  await withTempProject(async (projectPath) => {
    await saveConversation(projectPath, [{ role: 'user', content: 'hi', timestamp: new Date().toISOString() }]);
    assert.ok(existsSync(join(projectPath, '.devrelay', 'conversation.json')));
    assert.equal(existsSync(join(projectPath, '.devrelay', 'sessions')), false);
  });
});

test('conversation-store: agentScopeId 指定時は .devrelay/sessions/<id>/conversation.json に書かれる', async () => {
  await withTempProject(async (projectPath) => {
    const scopeId = 'submission123';
    await saveConversation(projectPath, [{ role: 'user', content: 'hi', timestamp: new Date().toISOString() }], scopeId);
    assert.ok(existsSync(join(projectPath, '.devrelay', 'sessions', scopeId, 'conversation.json')));
    assert.equal(existsSync(join(projectPath, '.devrelay', 'conversation.json')), false);
  });
});

test('conversation-store: appendToConversation はスコープ配下に追記する', async () => {
  await withTempProject(async (projectPath) => {
    const scopeId = 'scope-append';
    await appendToConversation(projectPath, [], 'user', 'hello', scopeId);
    const history = await loadConversation(projectPath, scopeId);
    assert.equal(history.length, 1);
    assert.equal(history[0].content, 'hello');

    // スコープを指定しない読み込みでは見えない（分離できている）
    const unscoped = await loadConversation(projectPath);
    assert.equal(unscoped.length, 0);
  });
});

test('conversation-store: markExecPoint はスコープ配下に exec マーカーを追記する', async () => {
  await withTempProject(async (projectPath) => {
    const scopeId = 'scope-exec';
    await appendToConversation(projectPath, [], 'user', 'before exec', scopeId);
    const updated = await markExecPoint(projectPath, [], scopeId);
    assert.equal(updated[updated.length - 1].role, 'exec');

    const reloaded = await loadConversation(projectPath, scopeId);
    assert.equal(reloaded[reloaded.length - 1].role, 'exec');
  });
});

test('archiveConversation: agentScopeId 未指定時は従来どおり <projectPath>/.devrelay/conversation-archive/ に保存される（後方互換）', async () => {
  await withTempProject(async (projectPath) => {
    const history = [{ role: 'user', content: 'archive me', timestamp: new Date().toISOString() }];
    await archiveConversation(projectPath, history);

    const archiveDir = join(projectPath, '.devrelay', 'conversation-archive');
    assert.ok(existsSync(archiveDir));
    const files = await readdir(archiveDir);
    assert.equal(files.length, 1);
    assert.ok(files[0].startsWith('conversation_'));

    // scoped なアーカイブは作られない
    assert.equal(existsSync(join(projectPath, '.devrelay', 'sessions')), false);
  });
});

test('archiveConversation: agentScopeId 指定時は <projectPath>/.devrelay/sessions/<id>/conversation-archive/ に保存される（スレッド管理 cycle2）', async () => {
  await withTempProject(async (projectPath) => {
    const scopeId = 'scope-archive';
    const history = [{ role: 'user', content: 'archive me too', timestamp: new Date().toISOString() }];
    await archiveConversation(projectPath, history, scopeId);

    const scopedArchiveDir = join(projectPath, '.devrelay', 'sessions', scopeId, 'conversation-archive');
    assert.ok(existsSync(scopedArchiveDir));
    const files = await readdir(scopedArchiveDir);
    assert.equal(files.length, 1);
    assert.ok(files[0].startsWith('conversation_'));

    // 既定スレッド（.devrelay/ 直下）のアーカイブディレクトリは作られない（無傷）
    assert.equal(existsSync(join(projectPath, '.devrelay', 'conversation-archive')), false);
  });
});

test('archiveConversation: agentScopeId 指定時に .devrelay/ 直下の他ファイルは一切変更されない（既定スレッド無傷の回帰テスト）', async () => {
  await withTempProject(async (projectPath) => {
    // 既定スレッド側に先に会話を保存しておく
    await saveConversation(projectPath, [{ role: 'user', content: 'default thread', timestamp: new Date().toISOString() }]);
    const defaultConversationPath = join(projectPath, '.devrelay', 'conversation.json');
    const before = await (await import('node:fs/promises')).readFile(defaultConversationPath, 'utf-8');

    const scopeId = 'scope-archive-isolated';
    await archiveConversation(projectPath, [{ role: 'user', content: 'scoped', timestamp: new Date().toISOString() }], scopeId);

    const after = await (await import('node:fs/promises')).readFile(defaultConversationPath, 'utf-8');
    assert.equal(after, before, '既定スレッドの conversation.json が変更されてはならない');
    assert.equal(existsSync(join(projectPath, '.devrelay', 'conversation-archive')), false, '既定スレッドのアーカイブディレクトリが作られてはならない');
  });
});
