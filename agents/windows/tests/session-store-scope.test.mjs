// core#336: session-store.ts の agentScopeId スコープ分離の単体テスト。
// mkdtemp した一時ディレクトリに対して各アクセサを呼び、agentScopeId 指定時は
// .devrelay/sessions/<id>/ 配下、未指定時は .devrelay/ 直下にファイルが出来ることを検証する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  saveClaudeSessionId,
  saveDevinSessionId,
  saveDevinModel,
  saveDevinAtifStepOffset,
  saveDevinPermissionMode,
  saveCodexSessionId,
  saveContextUsage,
} from '../dist/services/session-store.js';

async function withTempProject(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'devrelay-session-store-scope-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// linux は 8 ファイル（claude-session-id / claude-session-meta.json / devin-session-id /
// devin-model / devin-atif-step-offset / devin-permission-mode / codex-session-id / context-usage.json）
const EXPECTED_FILES = [
  'claude-session-id',
  'claude-session-meta.json',
  'devin-session-id',
  'devin-model',
  'devin-atif-step-offset',
  'devin-permission-mode',
  'codex-session-id',
  'context-usage.json',
];

test('session-store: agentScopeId 未指定時は .devrelay/ 直下にファイルが出来る（8 ファイル）', async () => {
  await withTempProject(async (projectPath) => {
    await saveClaudeSessionId(projectPath, 'sess-abc', 'exec');
    await saveDevinSessionId(projectPath, 'devin-abc');
    await saveDevinModel(projectPath, 'gpt-5');
    await saveDevinAtifStepOffset(projectPath, 3);
    await saveDevinPermissionMode(projectPath, 'exec');
    await saveCodexSessionId(projectPath, 'codex-abc');
    await saveContextUsage(projectPath, { used: 1, total: 2, percentage: 50 });

    for (const file of EXPECTED_FILES) {
      const p = join(projectPath, '.devrelay', file);
      assert.ok(existsSync(p), `${p} が存在しない`);
    }
    // スコープディレクトリ配下には作られない
    assert.equal(existsSync(join(projectPath, '.devrelay', 'sessions')), false);
  });
});

test('session-store: agentScopeId 指定時は .devrelay/sessions/<id>/ 配下にファイルが出来る（8 ファイル）', async () => {
  await withTempProject(async (projectPath) => {
    const scopeId = 'submission123';
    await saveClaudeSessionId(projectPath, 'sess-abc', 'exec', scopeId);
    await saveDevinSessionId(projectPath, 'devin-abc', scopeId);
    await saveDevinModel(projectPath, 'gpt-5', scopeId);
    await saveDevinAtifStepOffset(projectPath, 3, scopeId);
    await saveDevinPermissionMode(projectPath, 'exec', scopeId);
    await saveCodexSessionId(projectPath, 'codex-abc', scopeId);
    await saveContextUsage(projectPath, { used: 1, total: 2, percentage: 50 }, scopeId);

    for (const file of EXPECTED_FILES) {
      const p = join(projectPath, '.devrelay', 'sessions', scopeId, file);
      assert.ok(existsSync(p), `${p} が存在しない`);
    }
    // プロジェクト直下には作られない（スコープ分離できている）
    assert.equal(existsSync(join(projectPath, '.devrelay', 'claude-session-id')), false);
    assert.equal(existsSync(join(projectPath, '.devrelay', 'context-usage.json')), false);
  });
});

test('session-store: 異なる agentScopeId 同士はファイルを共有しない', async () => {
  await withTempProject(async (projectPath) => {
    await saveClaudeSessionId(projectPath, 'sess-A', 'exec', 'scope-a');
    await saveClaudeSessionId(projectPath, 'sess-B', 'exec', 'scope-b');

    assert.ok(existsSync(join(projectPath, '.devrelay', 'sessions', 'scope-a', 'claude-session-id')));
    assert.ok(existsSync(join(projectPath, '.devrelay', 'sessions', 'scope-b', 'claude-session-id')));
  });
});
