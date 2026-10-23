// 会社 private リポジトリ clone 対応サイクル: apps/web/src/lib/install-command-rules.ts の単体テスト。
// uninstall-command-rules.test.mjs と同じ流儀（dist-test/ をコンパイル後に直接 import）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInstallCommand } from '../dist-test/lib/install-command-rules.js';

test('非退行: repoUrl 未指定の Linux/macOS コマンドは現行文字列と完全一致する', () => {
  assert.equal(
    buildInstallCommand({ os: 'linux', token: 'TOKEN123' }),
    'curl -fsSL https://raw.githubusercontent.com/murata1215/devrelay/main/scripts/install-agent.sh | bash -s -- --token TOKEN123'
  );
});

test('非退行: repoUrl 未指定の Windows コマンドは現行文字列と完全一致する', () => {
  assert.equal(
    buildInstallCommand({ os: 'windows', token: 'TOKEN123' }),
    '$env:DEVRELAY_TOKEN="TOKEN123"; irm https://raw.githubusercontent.com/murata1215/devrelay/main/scripts/install-agent.ps1 | iex'
  );
});

test('非退行: repoUrl が null でも現行文字列と完全一致する', () => {
  assert.equal(
    buildInstallCommand({ os: 'linux', token: 'TOKEN123', repoUrl: null }),
    'curl -fsSL https://raw.githubusercontent.com/murata1215/devrelay/main/scripts/install-agent.sh | bash -s -- --token TOKEN123'
  );
});

test('repoUrl 指定: Linux は --repo を追加する', () => {
  assert.equal(
    buildInstallCommand({ os: 'linux', token: 'TOKEN123', repoUrl: 'https://github.com/tisa-devin/devrelay.git' }),
    'curl -fsSL https://raw.githubusercontent.com/murata1215/devrelay/main/scripts/install-agent.sh | bash -s -- --token TOKEN123 --repo https://github.com/tisa-devin/devrelay.git'
  );
});

test('repoUrl 指定: macOS も Linux と同じインストーラーコマンドになる', () => {
  assert.equal(
    buildInstallCommand({ os: 'macos', token: 'TOKEN123', repoUrl: 'https://github.com/tisa-devin/devrelay.git' }),
    'curl -fsSL https://raw.githubusercontent.com/murata1215/devrelay/main/scripts/install-agent.sh | bash -s -- --token TOKEN123 --repo https://github.com/tisa-devin/devrelay.git'
  );
});

test('repoUrl 指定: Windows は $env:DEVRELAY_REPO_URL を追加する', () => {
  assert.equal(
    buildInstallCommand({ os: 'windows', token: 'TOKEN123', repoUrl: 'https://github.com/tisa-devin/devrelay.git' }),
    '$env:DEVRELAY_TOKEN="TOKEN123"; $env:DEVRELAY_REPO_URL="https://github.com/tisa-devin/devrelay.git"; irm https://raw.githubusercontent.com/murata1215/devrelay/main/scripts/install-agent.ps1 | iex'
  );
});

test('repoUrl が空文字なら付与されない', () => {
  assert.equal(
    buildInstallCommand({ os: 'linux', token: 'TOKEN123', repoUrl: '' }),
    'curl -fsSL https://raw.githubusercontent.com/murata1215/devrelay/main/scripts/install-agent.sh | bash -s -- --token TOKEN123'
  );
});

test('repoUrl が空白のみなら付与されない', () => {
  assert.equal(
    buildInstallCommand({ os: 'windows', token: 'TOKEN123', repoUrl: '   ' }),
    '$env:DEVRELAY_TOKEN="TOKEN123"; irm https://raw.githubusercontent.com/murata1215/devrelay/main/scripts/install-agent.ps1 | iex'
  );
});

test('token が空文字なら常に空文字を返す', () => {
  assert.equal(buildInstallCommand({ os: 'linux', token: '', repoUrl: 'https://github.com/tisa-devin/devrelay.git' }), '');
  assert.equal(buildInstallCommand({ os: 'windows', token: '' }), '');
});

test('os 省略時のデフォルト扱いは呼び出し側の責務（本関数は os 必須）', () => {
  // buildInstallCommand は os を必須パラメータとして要求する（MachinesPage.tsx 側で既定値 'linux' を渡す）
  assert.equal(
    buildInstallCommand({ os: 'linux', token: 'T' }),
    'curl -fsSL https://raw.githubusercontent.com/murata1215/devrelay/main/scripts/install-agent.sh | bash -s -- --token T'
  );
});

test('repoUrl の前後空白は trim されてコマンドに反映される', () => {
  assert.equal(
    buildInstallCommand({ os: 'linux', token: 'TOKEN123', repoUrl: '  https://github.com/tisa-devin/devrelay.git  ' }),
    'curl -fsSL https://raw.githubusercontent.com/murata1215/devrelay/main/scripts/install-agent.sh | bash -s -- --token TOKEN123 --repo https://github.com/tisa-devin/devrelay.git'
  );
});
