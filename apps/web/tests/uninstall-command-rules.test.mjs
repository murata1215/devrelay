// Agents ページの Uninstall セクション用純関数のテスト。
// 2026-09-17 サイクル: Windows 用アンインストール一行が `Name='node.exe'` 限定で
// Electron GUI 版（DevRelay Agent.exe）を取り逃していた穴を修正し、非退行を機械的に固定する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSettingsOs,
  buildUninstallCommand,
  buildFullUninstallCommand,
} from '../dist-test/lib/uninstall-command-rules.js';

// ---- resolveSettingsOs ----

test('resolveSettingsOs: win32 → windows', () => {
  assert.equal(resolveSettingsOs('win32'), 'windows');
});

test('resolveSettingsOs: darwin → macos', () => {
  assert.equal(resolveSettingsOs('darwin'), 'macos');
});

test('resolveSettingsOs: linux 系文字列 → linux', () => {
  assert.equal(resolveSettingsOs('linux'), 'linux');
});

test('resolveSettingsOs: 空文字 → linux（フォールバック）', () => {
  assert.equal(resolveSettingsOs(''), 'linux');
});

test('resolveSettingsOs: null/undefined → linux（フォールバック、誤操作リスクの低い側に倒す）', () => {
  assert.equal(resolveSettingsOs(null), 'linux');
  assert.equal(resolveSettingsOs(undefined), 'linux');
});

test('resolveSettingsOs: 未知の値 → linux（fail-closed ではなく最も無害な表示へ）', () => {
  assert.equal(resolveSettingsOs('freebsd'), 'linux');
});

// ---- buildUninstallCommand: Windows（今回の修正対象） ----

test('buildUninstallCommand windows: Name=node.exe 限定を含まない（GUI版を取り逃さない）', () => {
  const cmd = buildUninstallCommand('windows');
  assert.ok(!cmd.includes("Name='node.exe'"), 'node.exe 限定フィルタが残っていないこと');
});

test('buildUninstallCommand windows: 自己 kill 防止（$PID 除外）を含む', () => {
  const cmd = buildUninstallCommand('windows');
  assert.ok(cmd.includes('$PID'), '自身のプロセスを除外する条件が無い');
  assert.ok(cmd.includes('powershell.exe'), 'powershell.exe 自身の除外が無い');
});

test('buildUninstallCommand windows: タスクスケジューラ削除を含む', () => {
  const cmd = buildUninstallCommand('windows');
  assert.ok(cmd.includes('schtasks /Delete /TN "DevRelay Agent" /F'));
});

test('buildUninstallCommand windows: Startup VBS 削除と設定ディレクトリ削除を維持', () => {
  const cmd = buildUninstallCommand('windows');
  assert.ok(cmd.includes('DevRelay Agent.vbs'));
  assert.ok(cmd.includes('$env:APPDATA\\devrelay'));
});

// ---- buildUninstallCommand: Linux / macOS（非退行 — 現行コマンドと完全一致） ----

test('buildUninstallCommand macos: 既存コマンドと完全一致（非退行）', () => {
  assert.equal(
    buildUninstallCommand('macos'),
    'launchctl unload ~/Library/LaunchAgents/io.devrelay.agent.plist 2>/dev/null; rm -f ~/Library/LaunchAgents/io.devrelay.agent.plist; pkill -f "devrelay.*index.js"; rm -rf ~/.devrelay'
  );
});

test('buildUninstallCommand linux: 既存コマンドと完全一致（非退行）', () => {
  assert.equal(
    buildUninstallCommand('linux'),
    'sudo systemctl stop devrelay-agent 2>/dev/null; sudo systemctl disable devrelay-agent 2>/dev/null; crontab -l 2>/dev/null | grep -v devrelay | crontab -; pkill -f "devrelay.*index.js"; rm -rf ~/.devrelay'
  );
});

// ---- buildFullUninstallCommand ----

test('buildFullUninstallCommand windows: uninstall-agent.ps1 を irm | iex する1行', () => {
  const cmd = buildFullUninstallCommand('windows');
  assert.ok(cmd.includes('irm '));
  assert.ok(cmd.includes('uninstall-agent.ps1'));
  assert.ok(cmd.includes('| iex'));
});

test('buildFullUninstallCommand macos: 空文字（UIに2本目を出さない判定に使う）', () => {
  assert.equal(buildFullUninstallCommand('macos'), '');
});

test('buildFullUninstallCommand linux: 空文字', () => {
  assert.equal(buildFullUninstallCommand('linux'), '');
});
