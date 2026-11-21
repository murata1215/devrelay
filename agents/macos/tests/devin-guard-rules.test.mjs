// Devin CLI ガードレール調査サイクル（2026-11-05）: devin-guard-rules.ts の単体テスト。
// 外部 import ゼロの純関数（agents/linux/src/services/devin-guard-rules.ts）を
// コンパイル済み dist から直接 import する（git-guard-core.test.mjs と同じ流儀）。
// 本モジュールは未配線（ai-runner.ts からは呼ばれていない）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidDevinPermissionRule,
  buildDevinAgentConfig,
  buildDevinGuardOrgPolicy,
  DEVIN_GUARD_IRREVERSIBLE_EXEC_PREFIXES,
  DEVIN_GUARD_SECRET_READ_GLOBS,
  DEVIN_GUARD_SECRET_WRITE_GLOBS,
} from '../dist/services/devin-guard-rules.js';

// --- isValidDevinPermissionRule ---

test('isValidDevinPermissionRule: Exec() の素のコマンド名は妥当', () => {
  assert.equal(isValidDevinPermissionRule('Exec(rm)'), true);
  assert.equal(isValidDevinPermissionRule('Exec(git push)'), true);
  assert.equal(isValidDevinPermissionRule('Exec(sudo)'), true);
});

test('isValidDevinPermissionRule: Exec() に glob を含むものは無効（公式ドキュメント実測: Exec(**)は無効ルール）', () => {
  assert.equal(isValidDevinPermissionRule('Exec(**)'), false);
  assert.equal(isValidDevinPermissionRule('Exec(rm *)'), false);
  assert.equal(isValidDevinPermissionRule('Exec(rm -rf ?)'), false);
  assert.equal(isValidDevinPermissionRule('Exec([abc])'), false);
});

test('isValidDevinPermissionRule: Read()/Write()/Fetch() は glob を含んでいても妥当（公式ドキュメント上 glob 対応）', () => {
  assert.equal(isValidDevinPermissionRule('Read(~/.ssh/**)'), true);
  assert.equal(isValidDevinPermissionRule('Write(**/.env*)'), true);
  assert.equal(isValidDevinPermissionRule('Fetch(https://*.example.com/*)'), true);
});

test('isValidDevinPermissionRule: 括弧が無い・ツール名が未知なら無効', () => {
  assert.equal(isValidDevinPermissionRule('rm'), false);
  assert.equal(isValidDevinPermissionRule('Unknown(rm)'), false);
  assert.equal(isValidDevinPermissionRule(''), false);
});

test('isValidDevinPermissionRule: 括弧内が空なら無効', () => {
  assert.equal(isValidDevinPermissionRule('Exec()'), false);
});

test('isValidDevinPermissionRule: 括弧の対応が取れていなければ無効', () => {
  assert.equal(isValidDevinPermissionRule('Exec(rm'), false);
  assert.equal(isValidDevinPermissionRule('Exec rm)'), false);
});

test('isValidDevinPermissionRule: 改行・NULを含む内容は無効（例外も投げない）', () => {
  assert.equal(isValidDevinPermissionRule('Exec(rm\n)'), false);
  assert.equal(isValidDevinPermissionRule('Exec(rm\0)'), false);
  assert.equal(isValidDevinPermissionRule('Exec(rm\r)'), false);
});

test('isValidDevinPermissionRule: null/undefined相当の空文字は例外を投げずfalse', () => {
  assert.doesNotThrow(() => isValidDevinPermissionRule(''));
  assert.equal(isValidDevinPermissionRule(''), false);
});

// --- プリセット定数の自己整合性 ---

test('DEVIN_GUARD_IRREVERSIBLE_EXEC_PREFIXES: 全エントリが Exec() に包んだ時に妥当なルールになる', () => {
  for (const prefix of DEVIN_GUARD_IRREVERSIBLE_EXEC_PREFIXES) {
    assert.equal(isValidDevinPermissionRule(`Exec(${prefix})`), true, `Exec(${prefix}) が無効と判定された`);
  }
});

test('DEVIN_GUARD_IRREVERSIBLE_EXEC_PREFIXES: rm は意図的に含まれない（#362〜#368 の教訓）', () => {
  assert.equal(DEVIN_GUARD_IRREVERSIBLE_EXEC_PREFIXES.includes('rm'), false);
});

test('DEVIN_GUARD_SECRET_READ_GLOBS / _WRITE_GLOBS: 全エントリが Read()/Write() に包んだ時に妥当', () => {
  for (const glob of DEVIN_GUARD_SECRET_READ_GLOBS) {
    assert.equal(isValidDevinPermissionRule(`Read(${glob})`), true, `Read(${glob}) が無効と判定された`);
  }
  for (const glob of DEVIN_GUARD_SECRET_WRITE_GLOBS) {
    assert.equal(isValidDevinPermissionRule(`Write(${glob})`), true, `Write(${glob}) が無効と判定された`);
  }
});

// --- buildDevinAgentConfig ---

test('buildDevinAgentConfig: 空の入力なら deny が空配列', () => {
  assert.deepEqual(buildDevinAgentConfig({}), { permissions: { deny: [] } });
});

test('buildDevinAgentConfig: allow/ask キーを一切生成しない（型レベルの構造的制約の実行時検証）', () => {
  const config = buildDevinAgentConfig({ denyExecPrefixes: ['rm'] });
  assert.deepEqual(Object.keys(config), ['permissions']);
  assert.deepEqual(Object.keys(config.permissions), ['deny']);
});

test('buildDevinAgentConfig: 4カテゴリを deny ルールへ変換する', () => {
  const config = buildDevinAgentConfig({
    denyExecPrefixes: ['sudo'],
    denyReadGlobs: ['~/.ssh/**'],
    denyWriteGlobs: ['/etc/**'],
    denyFetchPatterns: ['https://internal.example.com/*'],
  });
  assert.deepEqual(config.permissions.deny, [
    'Exec(sudo)',
    'Read(~/.ssh/**)',
    'Write(/etc/**)',
    'Fetch(https://internal.example.com/*)',
  ]);
});

test('buildDevinAgentConfig: 無効なルール（Exec内glob）は黙って除外される', () => {
  const config = buildDevinAgentConfig({ denyExecPrefixes: ['rm', 'rm *', '**'] });
  assert.deepEqual(config.permissions.deny, ['Exec(rm)']);
});

test('buildDevinAgentConfig: 重複は除去され入力順を保つ', () => {
  const config = buildDevinAgentConfig({ denyExecPrefixes: ['sudo', 'rm', 'sudo'] });
  assert.deepEqual(config.permissions.deny, ['Exec(sudo)', 'Exec(rm)']);
});

// --- buildDevinGuardOrgPolicy ---

test('buildDevinGuardOrgPolicy: ask/allow は常に空配列（入力に関わらず上書きされる）', () => {
  const policy = buildDevinGuardOrgPolicy({ denyExecPrefixes: ['sudo'] });
  assert.deepEqual(policy.ask, []);
  assert.deepEqual(policy.allow, []);
  assert.deepEqual(policy.deny, ['Exec(sudo)']);
});

test('buildDevinGuardOrgPolicy: 3キー（deny/ask/allow）のみを持つ', () => {
  const policy = buildDevinGuardOrgPolicy({});
  assert.deepEqual(Object.keys(policy).sort(), ['allow', 'ask', 'deny']);
});

test('buildDevinGuardOrgPolicy: 推奨プリセット（不可逆操作+シークレット保護）を渡すと妥当なJSONが組み立てられる', () => {
  const policy = buildDevinGuardOrgPolicy({
    denyExecPrefixes: DEVIN_GUARD_IRREVERSIBLE_EXEC_PREFIXES,
    denyReadGlobs: DEVIN_GUARD_SECRET_READ_GLOBS,
    denyWriteGlobs: DEVIN_GUARD_SECRET_WRITE_GLOBS,
  });
  assert.equal(policy.deny.length, DEVIN_GUARD_IRREVERSIBLE_EXEC_PREFIXES.length + DEVIN_GUARD_SECRET_READ_GLOBS.length + DEVIN_GUARD_SECRET_WRITE_GLOBS.length);
  assert.equal(policy.ask.length, 0);
  assert.equal(policy.allow.length, 0);
  // JSON.stringify が例外を投げずに通る（ダッシュボードへ貼り付け可能な形であることの確認）
  assert.doesNotThrow(() => JSON.stringify(policy));
});
