// サイクル SDK-2 ④b: 同梱 Claude Code バージョンが claude-fable-5-1 の要求下限を満たすことを
// 保証する回帰テスト。#353 で claude-fable-5-1 は CC >= 2.1.251 を要求すると判明した
// （SDK 0.2.80 の同梱 CC は 2.1.80 で満たさない）。
// バージョン比較は成分ごとの数値比較で行う（文字列比較だと '2.1.80' > '2.1.251' になる罠がある）。
// SDK の具体的なバージョン番号（例: '0.3.278'）はこのテストにハードコードしない
// （将来の再バンプ時に二重修正が要らないように、package.json の宣言と実インストールの一致だけを見る）。
// agents/macos/tests/sdk-version.test.mjs と byte-for-byte 同一。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { probeSdkExecutable } from '../dist/services/sdk-executable.js';

/** "x.y.z" 形式のバージョン文字列を成分ごとの数値配列に変換する。 */
function parseVersion(v) {
  const parts = v.split('.').map((s) => Number.parseInt(s, 10));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
    throw new Error(`不正なバージョン形式: ${v}`);
  }
  return parts;
}

/** a >= b を成分ごとの数値比較で判定する（文字列比較の罠を回避）。 */
function isVersionGte(a, b) {
  const [aMaj, aMin, aPat] = parseVersion(a);
  const [bMaj, bMin, bPat] = parseVersion(b);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPat >= bPat;
}

const MIN_CLAUDE_CODE_VERSION = '2.1.251'; // claude-fable-5-1 の要求下限（#353）

test('isVersionGte: 成分ごとの数値比較（文字列比較の罠を回避）', () => {
  assert.equal(isVersionGte('2.1.278', '2.1.251'), true);
  assert.equal(isVersionGte('2.1.80', '2.1.251'), false); // 文字列比較だと true になってしまう罠
  assert.equal(isVersionGte('2.1.251', '2.1.251'), true);
  assert.equal(isVersionGte('3.0.0', '2.1.251'), true);
  assert.equal(isVersionGte('2.2.0', '2.1.251'), true);
});

test('同梱 Claude Code バージョンが claude-fable-5-1 の要求下限を満たす', () => {
  const probe = probeSdkExecutable();
  assert.ok(probe.claudeCodeVersion, 'claudeCodeVersion が取得できていない');
  assert.ok(
    isVersionGte(probe.claudeCodeVersion, MIN_CLAUDE_CODE_VERSION),
    `同梱 CC(${probe.claudeCodeVersion}) が要求下限(${MIN_CLAUDE_CODE_VERSION})未満`,
  );
});

test('agent package.json の宣言バージョンと実インストールの sdkVersion が一致する', () => {
  const probe = probeSdkExecutable();
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
  const declared = pkg.dependencies?.['@anthropic-ai/claude-agent-sdk'];
  assert.ok(declared, 'agent package.json に @anthropic-ai/claude-agent-sdk の宣言が無い');
  assert.match(declared, /^\d+\.\d+\.\d+$/, `宣言バージョンはキャレット無しの完全一致指定であるべき: ${declared}`);
  assert.equal(probe.sdkVersion, declared, `宣言(${declared})と実インストール(${probe.sdkVersion})が不一致`);
});
