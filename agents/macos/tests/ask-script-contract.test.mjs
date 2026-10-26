// macOS ask.sh 生成本文（#348 フル移植: callerProjectPath 送信 + 候補からの self 除外 +
// 同一マシン自動選択の廃止）の契約テスト。linux 側は #348 で既に本番稼働中で、
// 2026-10-22 の TruckBoard 誤表示を機に macOS にも同等の挙動を移植した。
//
// 生成スクリプトは bash テキストのため、実行はせず文字列の存在/非存在を検証する
// （既存 skill-invocations.test.mjs と同じ「生成物を正規表現で検証する」流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateAskScript } from '../dist/services/skill-manager.js';

const script = generateAskScript('wss://example.test', 'dummy-token');

test('ask.sh: DEVRELAY_PROJECT から SELF_PATH を拾う（#348）', () => {
  assert.match(script, /SELF_PATH="\$\{DEVRELAY_PROJECT:-\}"/);
});

test('ask.sh: SELF_PATH 非空時は body に callerProjectPath を追加する', () => {
  assert.match(script, /callerProjectPath/);
  assert.match(script, /if \[ -n "\$SELF_PATH" \]; then/);
});

test('ask.sh: SELF_PATH 空時は従来と1バイト同一の body にフォールバックする（後方互換）', () => {
  // if/else の else 分岐で BASE_BODY をそのまま使う（jq の追加マージを通さない）形になっていること
  assert.match(script, /else\s*\n\s*JSON_BODY=\$\(echo "\$BASE_BODY" \| tr -d '\\r'\)/);
});

test('ask.sh: 候補一覧から自分自身（.self）を除外する', () => {
  assert.match(script, /map\(select\(\.self \| not\)\)/);
});

test('ask.sh: memberProjectPath を self 判定に使う', () => {
  assert.match(script, /self: \(\(\$self_path \| length\) > 0 and \(\(\.memberProjectPath \/\/ ""\) == \$self_path\)\)/);
});

test('ask.sh: 同一マシン自動選択（$same が1件なら無条件採用）は廃止されている（#348 本体）', () => {
  assert.doesNotMatch(script, /\(\s*\$same\s*\|\s*length\s*\)\s*==\s*1/);
  assert.doesNotMatch(script, /as \$same/);
});

test('ask.sh: フィルタの最終行は $avail をそのまま返す（self除外後は追加の絞り込みをしない）', () => {
  assert.match(script, /\| \$avail\s*\n\s*'/);
});
