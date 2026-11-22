import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIcaclsGrantReadExecuteArgs,
  buildIcaclsGrantTraverseArgs,
  buildIcaclsGrantModifyArgs,
  buildIcaclsDenyWriteArgs,
  buildIcaclsLockdownArgs,
  buildSandboxPrepPlan,
  buildSandboxTokenLockdownStep,
  buildSandboxPrepManualFallbackText,
} from '../dist/services/sandbox-prep-commands.js';

describe('sandbox-prep-commands', () => {
  test('buildIcaclsGrantReadExecuteArgs: 継承あり RX', () => {
    assert.deepEqual(
      buildIcaclsGrantReadExecuteArgs('C:\\dev\\agent\\node_modules', 'NT SERVICE\\devrelay-sandbox'),
      ['C:\\dev\\agent\\node_modules', '/grant', 'NT SERVICE\\devrelay-sandbox:(OI)(CI)(RX)'],
    );
  });

  test('buildIcaclsGrantTraverseArgs: 継承なし traverse のみ', () => {
    assert.deepEqual(
      buildIcaclsGrantTraverseArgs('C:\\dev', '*S-1-5-80-123'),
      ['C:\\dev', '/grant', '*S-1-5-80-123:(X)'],
    );
  });

  test('buildIcaclsGrantModifyArgs: 継承あり Modify', () => {
    assert.deepEqual(
      buildIcaclsGrantModifyArgs('C:\\dev\\repo', '*S-1-5-80-123'),
      ['C:\\dev\\repo', '/grant', '*S-1-5-80-123:(OI)(CI)(M)'],
    );
  });

  test('buildIcaclsDenyWriteArgs: .git/hooks への書き込み拒否', () => {
    assert.deepEqual(
      buildIcaclsDenyWriteArgs('C:\\dev\\repo\\.git\\hooks', '*S-1-5-80-123'),
      ['C:\\dev\\repo\\.git\\hooks', '/deny', '*S-1-5-80-123:(OI)(CI)(W)'],
    );
  });

  test('buildIcaclsLockdownArgs: 継承を切り本人のみ R,W', () => {
    assert.deepEqual(
      buildIcaclsLockdownArgs('C:\\Users\\dev\\AppData\\Roaming\\devrelay\\sandbox-token', 'dev'),
      ['C:\\Users\\dev\\AppData\\Roaming\\devrelay\\sandbox-token', '/inheritance:r', '/grant', 'dev:(R,W)'],
    );
  });

  test('buildSandboxPrepPlan: 祖先 traverse → プロジェクト Modify → node_modules RX → hooks deny の順', () => {
    const steps = buildSandboxPrepPlan({
      projectPath: 'C:\\dev\\repo',
      nodeModulesPath: 'C:\\dev\\agent\\node_modules',
      gitHooksPath: 'C:\\dev\\repo\\.git\\hooks',
      ancestorPaths: ['C:\\dev', 'C:\\dev\\agent'],
      servicePrincipal: 'NT SERVICE\\devrelay-sandbox',
    });
    assert.equal(steps.length, 5);
    assert.deepEqual(steps[0].args, ['C:\\dev', '/grant', 'NT SERVICE\\devrelay-sandbox:(X)']);
    assert.deepEqual(steps[1].args, ['C:\\dev\\agent', '/grant', 'NT SERVICE\\devrelay-sandbox:(X)']);
    assert.deepEqual(steps[2].args, ['C:\\dev\\repo', '/grant', 'NT SERVICE\\devrelay-sandbox:(OI)(CI)(M)']);
    assert.deepEqual(steps[3].args, ['C:\\dev\\agent\\node_modules', '/grant', 'NT SERVICE\\devrelay-sandbox:(OI)(CI)(RX)']);
    assert.deepEqual(steps[4].args, ['C:\\dev\\repo\\.git\\hooks', '/deny', 'NT SERVICE\\devrelay-sandbox:(OI)(CI)(W)']);
    for (const step of steps) {
      assert.equal(step.command, 'icacls');
      assert.ok(step.description.length > 0);
    }
  });

  test('buildSandboxPrepPlan: 祖先が無い場合はその分のステップが無い', () => {
    const steps = buildSandboxPrepPlan({
      projectPath: 'C:\\dev\\repo',
      nodeModulesPath: 'C:\\dev\\agent\\node_modules',
      gitHooksPath: 'C:\\dev\\repo\\.git\\hooks',
      ancestorPaths: [],
      servicePrincipal: 'NT SERVICE\\devrelay-sandbox',
    });
    assert.equal(steps.length, 3);
  });

  test('buildSandboxTokenLockdownStep', () => {
    const step = buildSandboxTokenLockdownStep('C:\\path\\sandbox-token', 'dev');
    assert.equal(step.command, 'icacls');
    assert.deepEqual(step.args, ['C:\\path\\sandbox-token', '/inheritance:r', '/grant', 'dev:(R,W)']);
  });

  test('buildSandboxPrepManualFallbackText: コマンド文字列に変換できる', () => {
    const steps = [
      { description: 'x', command: 'icacls', args: ['C:\\dev', '/grant', 'dev:(R,W)'] },
      { description: 'y', command: 'icacls', args: ['C:\\dev\\with space', '/grant', 'dev:(R,W)'] },
    ];
    const text = buildSandboxPrepManualFallbackText(steps);
    assert.equal(
      text,
      'icacls C:\\dev /grant dev:(R,W)\nicacls "C:\\dev\\with space" /grant dev:(R,W)',
    );
  });
});
