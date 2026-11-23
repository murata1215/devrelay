import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildSandboxCliCommand } from '../dist/services/sandbox-cli-hint.js';

describe('sandbox-cli-hint: buildSandboxCliCommand', () => {
  test('win32: & 呼び出し演算子付き・ダブルクォート引用', () => {
    const cmd = buildSandboxCliCommand({
      platform: 'win32',
      nodeExe: 'C:\\Program Files\\nodejs\\node.exe',
      cliEntry: 'C:\\Users\\dev\\AppData\\Roaming\\devrelay\\agent\\agents\\linux\\dist\\cli\\index.js',
      subcommand: 'sandbox status',
    });
    assert.equal(
      cmd,
      '& "C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\dev\\AppData\\Roaming\\devrelay\\agent\\agents\\linux\\dist\\cli\\index.js" sandbox status',
    );
  });

  test('win32: --project 付き', () => {
    const cmd = buildSandboxCliCommand({
      platform: 'win32',
      nodeExe: 'C:\\node.exe',
      cliEntry: 'C:\\cli\\index.js',
      subcommand: 'sandbox prep',
      projectPath: 'C:\\dev\\repo',
    });
    assert.equal(cmd, '& "C:\\node.exe" "C:\\cli\\index.js" sandbox prep --project "C:\\dev\\repo"');
  });

  test('win32: パス中のダブルクォートをエスケープする', () => {
    const cmd = buildSandboxCliCommand({
      platform: 'win32',
      nodeExe: 'C:\\node.exe',
      cliEntry: 'C:\\cli\\index.js',
      subcommand: 'sandbox status',
      projectPath: 'C:\\dev\\"weird"',
    });
    assert.match(cmd, /--project "C:\\dev\\`"weird`""/);
  });

  test('linux: & 無し・シングルクォート引用（nodeExe も含め全パスを引用する）', () => {
    const cmd = buildSandboxCliCommand({
      platform: 'linux',
      nodeExe: '/usr/bin/node',
      cliEntry: '/home/dev/.devrelay/agent/agents/linux/dist/cli/index.js',
      subcommand: 'sandbox status',
    });
    assert.equal(cmd, "'/usr/bin/node' '/home/dev/.devrelay/agent/agents/linux/dist/cli/index.js' sandbox status");
  });

  test('linux: --project 付き・シングルクォートのエスケープ', () => {
    const cmd = buildSandboxCliCommand({
      platform: 'linux',
      nodeExe: '/usr/bin/node',
      cliEntry: '/cli/index.js',
      subcommand: 'sandbox prep',
      projectPath: "/home/dev/it's-a-repo",
    });
    assert.equal(cmd, "'/usr/bin/node' '/cli/index.js' sandbox prep --project '/home/dev/it'\\''s-a-repo'");
  });

  test('projectPath 未指定なら --project を付けない', () => {
    const cmd = buildSandboxCliCommand({
      platform: 'win32',
      nodeExe: 'node.exe',
      cliEntry: 'index.js',
      subcommand: 'sandbox set-token',
    });
    assert.ok(!cmd.includes('--project'));
  });
});
