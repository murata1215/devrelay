// 2026-10-18 障害（x220-158-18-103 の Agent 10 台が crontab 構文エラーで @reboot 不発）の真因修正。
// `u` 自己更新が crontab を書き換える sed 2 本（agents/linux/src/services/crontab-fix-rules.ts）
// が冪等であることをコンパイル済み dist から直接検証する（update-guard-rules.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCrontabFixSed, buildFixCrontabCommand, CRONTAB_FIX_SED_1, CRONTAB_FIX_SED_2 } from '../dist/services/crontab-fix-rules.js';

// scripts/install-agent.sh:835 が最初に書く「正しい」形（export 済み・セミコロンあり）
const INSTALLER_CORRECT_LINE =
  '@reboot export PATH=/home/x/.devrelay/bin:/home/x/.local/bin:/home/x/.devrelay/node/bin:/usr/local/bin:/usr/bin:/bin; cd /home/x/.devrelay/agent/agents/linux && /home/x/.devrelay/node/bin/node /home/x/.devrelay/agent/agents/linux/dist/index.js > /home/x/.devrelay/logs/agent.log 2>&1';

// 旧形式（export が無い。1本目の sed が対象とする形）
const LEGACY_LINE =
  '@reboot PATH=/home/x/.devrelay/bin:/home/x/.local/bin:/home/x/.devrelay/node/bin:/usr/local/bin:/usr/bin:/bin cd /home/x/.devrelay/agent/agents/linux && /home/x/.devrelay/node/bin/node /home/x/.devrelay/agent/agents/linux/dist/index.js > /home/x/.devrelay/logs/agent.log 2>&1';

test('applyCrontabFixSed: 旧形式（export なし）を正しい形に変換する', () => {
  const result = applyCrontabFixSed(LEGACY_LINE);
  assert.equal(
    result,
    '@reboot export PATH=/home/x/.devrelay/bin:/home/x/.local/bin:/home/x/.devrelay/node/bin:/usr/local/bin:/usr/bin:/bin; cd /home/x/.devrelay/agent/agents/linux && /home/x/.devrelay/node/bin/node /home/x/.devrelay/agent/agents/linux/dist/index.js > /home/x/.devrelay/logs/agent.log 2>&1',
  );
});

test('applyCrontabFixSed: 【回帰】既に正しい形の行に適用しても変化しない（旧実装はセミコロンが増え続けていた）', () => {
  const once = applyCrontabFixSed(INSTALLER_CORRECT_LINE);
  assert.equal(once, INSTALLER_CORRECT_LINE, '1回適用しても変化しないこと');
});

test('applyCrontabFixSed: 冪等性 — 何度適用しても1回目と同じ結果になる', () => {
  let line = LEGACY_LINE;
  const results = [];
  for (let i = 0; i < 10; i++) {
    line = applyCrontabFixSed(line);
    results.push(line);
  }
  // 2回目以降はすべて1回目と同一（セミコロンが増え続けない）
  for (let i = 1; i < results.length; i++) {
    assert.equal(results[i], results[0], `${i + 1}回目の適用結果が1回目と異なる（セミコロン増殖の回帰）`);
  }
  // セミコロンの個数が1個のまま（旧実装なら10回で11個になっていた）
  const semicolonCount = (results[9].match(/;/g) || []).length;
  assert.equal(semicolonCount, 1, 'セミコロンが増殖していないこと');
});

test('applyCrontabFixSed: 既に実行中に蓄積したセミコロン（;;; 等）は増やさないが減らすわけでもない', () => {
  // 旧実装のバグで既に複数セミコロンが付いた行（修復は対象外。今後増やさないことだけを保証する）
  const alreadyBroken = INSTALLER_CORRECT_LINE.replace('; cd', ';;; cd');
  const once = applyCrontabFixSed(alreadyBroken);
  assert.equal(once, alreadyBroken, '既に壊れた行をさらに壊さないこと');
});

test('applyCrontabFixSed: devrelay 以外の無関係な行には一致せず素通りする', () => {
  const unrelated = '23 4 * * * /opt/devrelay/backup/devrelay-backup.sh >> /opt/devrelay/logs/backup.log 2>&1';
  assert.equal(applyCrontabFixSed(unrelated), unrelated);
});

test('buildFixCrontabCommand: crontab -l と crontab - を両端に持つパイプラインを返す', () => {
  const cmd = buildFixCrontabCommand();
  assert.match(cmd, /^crontab -l 2>\/dev\/null \| sed /);
  assert.match(cmd, /\| crontab -$/);
  assert.ok(cmd.includes(CRONTAB_FIX_SED_1));
  assert.ok(cmd.includes(CRONTAB_FIX_SED_2));
});

test('CRONTAB_FIX_SED_2: キャプチャが空白とセミコロンの両方を除外している（修正の核心）', () => {
  assert.ok(CRONTAB_FIX_SED_2.includes('[^ ;]*'), '修正後は [^ ;]* であること（旧実装は [^ ]* でセミコロンを飲み込んでいた）');
});
