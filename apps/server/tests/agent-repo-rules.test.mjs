// 会社 private リポジトリ clone 対応サイクル: apps/server/src/services/agent-repo-rules.ts の単体テスト。
// 外部 import ゼロの純粋関数をコンパイル済み dist から直接 import する（update-busy-rules.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveAgentRepoUrl,
  resolveAgentRepoToken,
  buildRepoAuthHeader,
  resolveAgentRepoAuth,
  decideRepoAuthRateLimit,
} from '../dist/services/agent-repo-rules.js';

// ダミーの base64 実装（Buffer に依存せず、テストが依存注入パターンを使っていることを明示する）
const b64 = (s) => Buffer.from(s).toString('base64');
// テストに使う PAT はすべてダミー値（実 PAT は絶対に使わない）
const DUMMY_PAT = 'github_pat_DUMMY1234567890abcdefghijklmnop';

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

// =============================================================================
// 読取PATのサーバー配布サイクル: resolveAgentRepoToken / buildRepoAuthHeader /
// resolveAgentRepoAuth / decideRepoAuthRateLimit
// =============================================================================

test('resolveAgentRepoToken: 未設定（undefined）は null', () => {
  assert.equal(resolveAgentRepoToken(undefined), null);
});

test('resolveAgentRepoToken: 空文字は null', () => {
  assert.equal(resolveAgentRepoToken(''), null);
});

test('resolveAgentRepoToken: 空白のみは null', () => {
  assert.equal(resolveAgentRepoToken('   '), null);
});

test('resolveAgentRepoToken: 正常な値はそのまま返す', () => {
  assert.equal(resolveAgentRepoToken(DUMMY_PAT), DUMMY_PAT);
});

test('resolveAgentRepoToken: 前後の空白は trim する', () => {
  assert.equal(resolveAgentRepoToken(`  ${DUMMY_PAT}  `), DUMMY_PAT);
});

test('resolveAgentRepoToken: 改行を含む値は null（CRLF インジェクション対策）', () => {
  assert.equal(resolveAgentRepoToken(`${DUMMY_PAT}\nEvil-Header: x`), null);
});

test('resolveAgentRepoToken: タブ等の制御文字を含む値は null', () => {
  assert.equal(resolveAgentRepoToken(`${DUMMY_PAT}\t\x01`), null);
});

test('resolveAgentRepoToken: 印字可能 ASCII 以外（マルチバイト文字）を含む値は null', () => {
  assert.equal(resolveAgentRepoToken(`${DUMMY_PAT}日本語`), null);
});

test('resolveAgentRepoToken: 短すぎる値（20文字未満）は null', () => {
  assert.equal(resolveAgentRepoToken('short_token'), null);
});

test('resolveAgentRepoToken: 長すぎる値（255文字超）は null', () => {
  assert.equal(resolveAgentRepoToken('a'.repeat(256)), null);
});

test('resolveAgentRepoToken: 値そのものを console.warn に出さない', () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    // 内部に改行を含む値（trim() では取れない位置）を渡し、確実に警告分岐を通す
    resolveAgentRepoToken(`${DUMMY_PAT}\nEvil-Header: x`);
  } finally {
    console.warn = original;
  }
  assert.ok(warnings.length > 0, 'warn が呼ばれていること');
  for (const w of warnings) {
    assert.ok(!w.includes(DUMMY_PAT), `warn 文に PAT の値が含まれていない: ${w}`);
  }
});

test('buildRepoAuthHeader: x-access-token:<PAT> を base64 して Basic ヘッダにする', () => {
  const header = buildRepoAuthHeader(DUMMY_PAT, b64);
  assert.equal(header, `Authorization: Basic ${b64(`x-access-token:${DUMMY_PAT}`)}`);
});

test('resolveAgentRepoAuth: URL も PAT も未設定なら両方 null', () => {
  const result = resolveAgentRepoAuth({ rawUrl: undefined, rawToken: undefined, base64Encode: b64 });
  assert.deepEqual(result, { repoUrl: null, authHeader: null });
});

test('resolveAgentRepoAuth: URL 未設定・PAT 設定済みでも authHeader は null（URL とセットのときのみ有効）', () => {
  const result = resolveAgentRepoAuth({ rawUrl: undefined, rawToken: DUMMY_PAT, base64Encode: b64 });
  assert.deepEqual(result, { repoUrl: null, authHeader: null });
});

test('resolveAgentRepoAuth: URL のみ設定（PAT 未設定）は repoUrl のみ返す', () => {
  const result = resolveAgentRepoAuth({
    rawUrl: 'https://github.com/tisa-devin/devrelay.git',
    rawToken: undefined,
    base64Encode: b64,
  });
  assert.deepEqual(result, { repoUrl: 'https://github.com/tisa-devin/devrelay.git', authHeader: null });
});

test('resolveAgentRepoAuth: URL・PAT ともに設定済みなら両方返す', () => {
  const result = resolveAgentRepoAuth({
    rawUrl: 'https://github.com/tisa-devin/devrelay.git',
    rawToken: DUMMY_PAT,
    base64Encode: b64,
  });
  assert.equal(result.repoUrl, 'https://github.com/tisa-devin/devrelay.git');
  assert.equal(result.authHeader, `Authorization: Basic ${b64(`x-access-token:${DUMMY_PAT}`)}`);
});

test('resolveAgentRepoAuth: URL が無効（userinfo 付き）なら PAT があっても両方 null', () => {
  const result = resolveAgentRepoAuth({
    rawUrl: 'https://x-access-token:dummy@github.com/tisa-devin/devrelay.git',
    rawToken: DUMMY_PAT,
    base64Encode: b64,
  });
  assert.deepEqual(result, { repoUrl: null, authHeader: null });
});

test('decideRepoAuthRateLimit: 窓内の件数が上限未満なら許可', () => {
  const now = 1_000_000;
  const result = decideRepoAuthRateLimit({ timestamps: [now - 1000, now - 2000], now, windowMs: 60_000, max: 10 });
  assert.equal(result, true);
});

test('decideRepoAuthRateLimit: 窓内の件数が上限以上なら拒否', () => {
  const now = 1_000_000;
  const timestamps = Array.from({ length: 10 }, (_, i) => now - i * 1000);
  const result = decideRepoAuthRateLimit({ timestamps, now, windowMs: 60_000, max: 10 });
  assert.equal(result, false);
});

test('decideRepoAuthRateLimit: 窓外（古い）のタイムスタンプは数えない', () => {
  const now = 1_000_000;
  const timestamps = Array.from({ length: 10 }, (_, i) => now - 120_000 - i * 1000);
  const result = decideRepoAuthRateLimit({ timestamps, now, windowMs: 60_000, max: 10 });
  assert.equal(result, true);
});
