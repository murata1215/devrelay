import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decideSandboxPrepPrecheck, buildSandboxPrepPrecheckMessage } from '../dist/services/sandbox-prep-commands.js';

describe('sandbox-prep-commands: decideSandboxPrepPrecheck（B2対応: prep前の存在確認）', () => {
  test('存在しないパスは not_found で拒否（ACLを一切変更しない契約）', () => {
    const result = decideSandboxPrepPrecheck({ exists: false, isDirectory: false, hasGit: false });
    assert.deepEqual(result, { ok: false, reason: 'not_found' });
  });

  test('存在するがディレクトリでない（ファイル）場合は not_a_directory', () => {
    const result = decideSandboxPrepPrecheck({ exists: true, isDirectory: false, hasGit: false });
    assert.deepEqual(result, { ok: false, reason: 'not_a_directory' });
  });

  test('ディレクトリだが .git が無い場合は no_git', () => {
    const result = decideSandboxPrepPrecheck({ exists: true, isDirectory: true, hasGit: false });
    assert.deepEqual(result, { ok: false, reason: 'no_git' });
  });

  test('存在し・ディレクトリで・.git がある場合は ok', () => {
    const result = decideSandboxPrepPrecheck({ exists: true, isDirectory: true, hasGit: true });
    assert.deepEqual(result, { ok: true });
  });

  test('buildSandboxPrepPrecheckMessage は全ての reason に対応するメッセージを持つ', () => {
    for (const reason of ['not_found', 'not_a_directory', 'no_git']) {
      const message = buildSandboxPrepPrecheckMessage(reason);
      assert.equal(typeof message, 'string');
      assert.ok(message.length > 0);
    }
  });
});
