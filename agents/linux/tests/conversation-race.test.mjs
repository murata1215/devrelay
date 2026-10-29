// 2026-10-29 Devin 記憶喪失事故の再発防止テスト。
// (1) server:session:start 再送時に既存 SessionInfo を使い回す判定（session-info-reuse.ts）
// (2) saveConversation がアトミック書き込み（書き込み中に読んでも空/壊れた JSON にならない）
// (3) loadConversation が壊れたファイルを `.corrupt-<ts>` に退避してから [] を返す

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canReuseSessionInfo } from '../dist/services/session-info-reuse.js';
import { saveConversation, loadConversation } from '../dist/services/conversation-store.js';

async function withTempProject(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'devrelay-conversation-race-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('canReuseSessionInfo: 同じ projectPath・scope の既存 SessionInfo は使い回す', () => {
  assert.equal(canReuseSessionInfo({ projectPath: '/p' }, { projectPath: '/p', isEphemeral: false }), true);
  assert.equal(canReuseSessionInfo({ projectPath: '/p', agentScopeId: 's1' }, { projectPath: '/p', agentScopeId: 's1', isEphemeral: false }), true);
});

test('canReuseSessionInfo: 既存なし・一時セッション・別プロジェクト・別 scope は作り直す', () => {
  assert.equal(canReuseSessionInfo(undefined, { projectPath: '/p', isEphemeral: false }), false);
  assert.equal(canReuseSessionInfo({ projectPath: '/p' }, { projectPath: '/p', isEphemeral: true }), false);
  assert.equal(canReuseSessionInfo({ projectPath: '/p' }, { projectPath: '/q', isEphemeral: false }), false);
  assert.equal(canReuseSessionInfo({ projectPath: '/p', agentScopeId: 's1' }, { projectPath: '/p', isEphemeral: false }), false);
  assert.equal(canReuseSessionInfo({ projectPath: '/p' }, { projectPath: '/p', agentScopeId: 's2', isEphemeral: false }), false);
});

test('saveConversation: 保存と並行して読んでも履歴が欠けない（アトミック書き込み）', async () => {
  await withTempProject(async (projectPath) => {
    const big = Array.from({ length: 200 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: 'x'.repeat(2000) + i,
      timestamp: new Date().toISOString(),
    }));
    await saveConversation(projectPath, big);

    for (let round = 0; round < 10; round++) {
      const next = [...big, { role: 'user', content: `round ${round}`, timestamp: new Date().toISOString() }];
      const [, loaded] = await Promise.all([
        saveConversation(projectPath, next),
        loadConversation(projectPath),
      ]);
      assert.ok(loaded.length >= big.length, `round ${round}: 読み込んだ履歴が欠けた (${loaded.length})`);
    }

    // temp ファイルが残っていない
    const entries = await readdir(join(projectPath, '.devrelay'));
    assert.deepEqual(entries.filter((n) => n.includes('.tmp-')), []);
  });
});

test('loadConversation: 壊れた JSON は退避してから [] を返す', async () => {
  await withTempProject(async (projectPath) => {
    const dir = join(projectPath, '.devrelay');
    await mkdir(dir, { recursive: true });
    const broken = '{"projectPath":"x","history":[{"role":"user"';
    await writeFile(join(dir, 'conversation.json'), broken, 'utf-8');

    const history = await loadConversation(projectPath);
    assert.deepEqual(history, []);

    const backups = (await readdir(dir)).filter((n) => n.startsWith('conversation.json.corrupt-'));
    assert.equal(backups.length, 1);
    assert.equal(await readFile(join(dir, backups[0]), 'utf-8'), broken);
  });
});

test('loadConversation: 空ファイルは退避せず [] を返す', async () => {
  await withTempProject(async (projectPath) => {
    const dir = join(projectPath, '.devrelay');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'conversation.json'), '', 'utf-8');

    assert.deepEqual(await loadConversation(projectPath), []);
    const backups = (await readdir(dir)).filter((n) => n.startsWith('conversation.json.corrupt-'));
    assert.equal(backups.length, 0);
  });
});
