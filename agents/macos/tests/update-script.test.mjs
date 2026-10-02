// #cmurfdjgu0b2rjhjhjqdo4zux 案2: `u` の pnpm install を --filter で絞るための
// 純粋関数（agents/macos/src/services/update-script.ts）の単体テスト。
// 外部 import ゼロの純粋関数を、コンパイル済み dist から直接 import する
// （agents/linux/tests/update-script.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPnpmInstallCommand,
  AGENT_INSTALL_FILTER,
  WIN32_AGENT_INSTALL_FILTER,
} from '../dist/services/update-script.js';

test('AGENT_INSTALL_FILTER: macOS Agent パッケージ + 依存のみを選択するセレクタ（末尾 ...）', () => {
  assert.equal(AGENT_INSTALL_FILTER, '@devrelay/agent-macos...');
  assert.ok(AGENT_INSTALL_FILTER.endsWith('...'));
});

test('WIN32_AGENT_INSTALL_FILTER: 同分岐の build 行（@devrelay/agent）に揃えたセレクタ', () => {
  assert.equal(WIN32_AGENT_INSTALL_FILTER, '@devrelay/agent...');
});

test('buildPnpmInstallCommand: frozen=true は --filter と --frozen-lockfile の両方を含む完全一致', () => {
  const cmd = buildPnpmInstallCommand({ pnpmCommand: 'pnpm', frozen: true, filter: '@devrelay/agent-macos...' });
  assert.equal(cmd, 'pnpm install --filter "@devrelay/agent-macos..." --frozen-lockfile --ignore-scripts');
});

test('buildPnpmInstallCommand: frozen=false（リトライ段）でも --filter は残る（本件の核心）', () => {
  const cmd = buildPnpmInstallCommand({ pnpmCommand: 'pnpm', frozen: false, filter: '@devrelay/agent-macos...' });
  assert.equal(cmd, 'pnpm install --filter "@devrelay/agent-macos..." --ignore-scripts');
  assert.ok(cmd.includes('--filter'));
});

test('buildPnpmInstallCommand: frozen=false では --frozen-lockfile を含まない', () => {
  const cmd = buildPnpmInstallCommand({ pnpmCommand: 'pnpm', frozen: false, filter: '@devrelay/agent-macos...' });
  assert.ok(!cmd.includes('--frozen-lockfile'));
});

test('buildPnpmInstallCommand: --ignore-scripts は frozen の真偽に関係なく必ず含む', () => {
  for (const frozen of [true, false]) {
    const cmd = buildPnpmInstallCommand({ pnpmCommand: 'pnpm', frozen, filter: '@devrelay/agent-macos...' });
    assert.ok(cmd.includes('--ignore-scripts'));
  }
});

test('buildPnpmInstallCommand: セレクタは必ずダブルクォートで囲む（PowerShell splat operator 誤解釈回避）', () => {
  const cmd = buildPnpmInstallCommand({ pnpmCommand: 'pnpm', frozen: true, filter: '@devrelay/agent-macos...' });
  assert.ok(cmd.includes('--filter "@devrelay/agent-macos..."'));
  assert.ok(!/--filter @devrelay/.test(cmd));
});

test('buildPnpmInstallCommand: filter が空文字なら throw', () => {
  assert.throws(() => buildPnpmInstallCommand({ pnpmCommand: 'pnpm', frozen: true, filter: '' }));
});

test('buildPnpmInstallCommand: filter がダブルクォートを含むなら throw（コマンドインジェクション防御）', () => {
  assert.throws(() => buildPnpmInstallCommand({ pnpmCommand: 'pnpm', frozen: true, filter: '@devrelay/agent-macos"...' }));
});

test('buildPnpmInstallCommand: pnpmCommand が空文字なら throw', () => {
  assert.throws(() => buildPnpmInstallCommand({ pnpmCommand: '', frozen: true, filter: '@devrelay/agent-macos...' }));
});
