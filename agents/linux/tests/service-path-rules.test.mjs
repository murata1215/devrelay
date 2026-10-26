// 2026-10-18 障害で発見した本体バグ2件目: setup.ts 側の systemd unit テンプレートに
// Environment=PATH= が無かった問題の修正（agents/linux/src/services/service-path-rules.ts）。
//
// 2026-10-27 `chatgpt-user` 障害の根治: `~/.local/bin` の存在確認（hasLocalBin 引数）を廃止し、
// 無条件で PATH に含めるよう変更（「Agent を先にインストールし、AI CLI を後から入れる」順序だと
// 欠落したまま unit が固定され、CLI を検出できても spawn できない事故になっていたため）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServicePath } from '../dist/services/service-path-rules.js';

test('buildServicePath: binDir → ~/.local/bin → nodeBinDir → 標準パスの順になる', () => {
  const result = buildServicePath('/home/pixblog', '/home/pixblog/.devrelay/bin', '/home/pixblog/.nvm/versions/node/v20.20.0/bin/node');
  assert.equal(
    result,
    '/home/pixblog/.devrelay/bin:/home/pixblog/.local/bin:/home/pixblog/.nvm/versions/node/v20.20.0/bin:/usr/local/bin:/usr/bin:/bin',
  );
});

test('buildServicePath: ~/.local/bin が未作成の環境でも無条件で PATH に含める（chatgpt-user 障害の根治）', () => {
  // 2026-10-27 以前は「インストール実行時点でディレクトリが存在するか」で分岐していたため、
  // AI CLI を後からインストールするとこのケースで ~/.local/bin が PATH から欠落していた。
  const result = buildServicePath('/home/uso8m', '/home/uso8m/.devrelay/bin', '/home/uso8m/.devrelay/node/bin/node');
  assert.equal(
    result,
    '/home/uso8m/.devrelay/bin:/home/uso8m/.local/bin:/home/uso8m/.devrelay/node/bin:/usr/local/bin:/usr/bin:/bin',
  );
  assert.ok(result.includes('.local/bin'));
});

test('buildServicePath: install-agent.sh:638-649 の SERVICE_PATH と同一の並びになる', () => {
  // install-agent.sh の組み立て順: CONFIG_DIR/bin : ~/.local/bin : NODE_BIN_DIR : 標準パス
  const result = buildServicePath('/home/keisuke', '/home/keisuke/.devrelay/bin', '/home/keisuke/.devrelay/node/bin/node');
  const parts = result.split(':');
  assert.equal(parts[0], '/home/keisuke/.devrelay/bin');
  assert.equal(parts[1], '/home/keisuke/.local/bin');
  assert.equal(parts[2], '/home/keisuke/.devrelay/node/bin');
  assert.deepEqual(parts.slice(3), ['/usr/local/bin', '/usr/bin', '/bin']);
});
