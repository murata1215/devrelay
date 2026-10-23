// 会社 private リポジトリ clone 対応サイクル: apps/server/src/services/agent-repo-rules.ts の単体テスト。
// 外部 import ゼロの純粋関数をコンパイル済み dist から直接 import する（update-busy-rules.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAgentRepoUrl } from '../dist/services/agent-repo-rules.js';

test('未設定（undefined）は null', () => {
  assert.equal(resolveAgentRepoUrl(undefined), null);
});

test('空文字は null', () => {
  assert.equal(resolveAgentRepoUrl(''), null);
});

test('空白のみは null', () => {
  assert.equal(resolveAgentRepoUrl('   '), null);
});

test('正常な https URL はそのまま返す', () => {
  assert.equal(resolveAgentRepoUrl('https://github.com/tisa-devin/devrelay.git'), 'https://github.com/tisa-devin/devrelay.git');
});

test('前後の空白は trim する', () => {
  assert.equal(resolveAgentRepoUrl('  https://github.com/tisa-devin/devrelay.git  '), 'https://github.com/tisa-devin/devrelay.git');
});

test('http:// スキームは拒否して null', () => {
  assert.equal(resolveAgentRepoUrl('http://github.com/tisa-devin/devrelay.git'), null);
});

test('scheme なしは拒否して null', () => {
  assert.equal(resolveAgentRepoUrl('github.com/tisa-devin/devrelay.git'), null);
});

test('userinfo（PAT 埋め込み、ダミー値）を含む URL は拒否して null', () => {
  assert.equal(resolveAgentRepoUrl('https://x-access-token:dummyPatValue@github.com/tisa-devin/devrelay.git'), null);
});

test('userinfo（ユーザー名のみ、ダミー値）を含む URL も拒否して null', () => {
  assert.equal(resolveAgentRepoUrl('https://dummyuser@github.com/tisa-devin/devrelay.git'), null);
});

test('git@ 形式（SSH）は https:// で始まらないため拒否して null', () => {
  assert.equal(resolveAgentRepoUrl('git@github.com:tisa-devin/devrelay.git'), null);
});
