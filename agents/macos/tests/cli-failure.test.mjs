// #344: AI CLI（devin 等）の出力ゼロ終了を分類する classifyCliFailure() の単体テスト。
// 外部 import ゼロの純粋関数（agents/linux/src/services/cli-failure.ts）を
// コンパイル済み dist から直接 import する（control-response.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCliFailure, isWorkspaceTrustError } from '../dist/services/cli-failure.js';

test('stdout が空でなければ none（stdoutLength > 0）', () => {
  const result = classifyCliFailure({ exitCode: 1, stdoutLength: 10, stderr: 'unexpected argument \'--foo\' found' });
  assert.equal(result.kind, 'none');
});

test('exitCode が null（シグナル終了）は none', () => {
  const result = classifyCliFailure({ exitCode: null, stdoutLength: 0, stderr: '' });
  assert.equal(result.kind, 'none');
});

test('unexpected argument はフラグ名付きで unknownFlag', () => {
  const result = classifyCliFailure({ exitCode: 2, stdoutLength: 0, stderr: "error: unexpected argument '--agent-config' found" });
  assert.equal(result.kind, 'unknownFlag');
  assert.equal(result.flag, '--agent-config');
});

test('unexpected argument はケースを問わず検出する', () => {
  const result = classifyCliFailure({ exitCode: 2, stdoutLength: 0, stderr: "Error: Unexpected Argument '--model' found" });
  assert.equal(result.kind, 'unknownFlag');
  assert.equal(result.flag, '--model');
});

test('Windows cmd.exe の command not found は commandNotFound', () => {
  const result = classifyCliFailure({ exitCode: 1, stdoutLength: 0, stderr: "'devin' is not recognized as an internal or external command,\noperable program or batch file." });
  assert.equal(result.kind, 'commandNotFound');
});

test('PowerShell の command not found は commandNotFound', () => {
  const result = classifyCliFailure({ exitCode: 1, stdoutLength: 0, stderr: "The term 'devin' is not recognized as the name of a cmdlet, function, script file, or operable program." });
  assert.equal(result.kind, 'commandNotFound');
});

test('POSIX シェルの command not found は commandNotFound', () => {
  const result = classifyCliFailure({ exitCode: 127, stdoutLength: 0, stderr: 'sh: 1: devin: command not found' });
  assert.equal(result.kind, 'commandNotFound');
});

test('Node の ENOENT は commandNotFound', () => {
  const result = classifyCliFailure({ exitCode: 1, stdoutLength: 0, stderr: 'spawn devin ENOENT' });
  assert.equal(result.kind, 'commandNotFound');
});

test('exit 0 で出力ゼロは emptyExitZero', () => {
  const result = classifyCliFailure({ exitCode: 0, stdoutLength: 0, stderr: '' });
  assert.equal(result.kind, 'emptyExitZero');
});

test('exit 0 で出力ゼロ・stderr ありでも emptyExitZero（commandNotFound/unknownFlag に一致しない場合）', () => {
  const result = classifyCliFailure({ exitCode: 0, stdoutLength: 0, stderr: 'some warning message' });
  assert.equal(result.kind, 'emptyExitZero');
});

test('非 0 exit・原因不明の stderr は emptyNonZero', () => {
  const result = classifyCliFailure({ exitCode: 1, stdoutLength: 0, stderr: 'panic: something broke' });
  assert.equal(result.kind, 'emptyNonZero');
});

test('非 0 exit・stderr 空も emptyNonZero', () => {
  const result = classifyCliFailure({ exitCode: 134, stdoutLength: 0, stderr: '' });
  assert.equal(result.kind, 'emptyNonZero');
  assert.equal(result.stderrTail, '');
});

test('stderrTail は末尾 maxLines 行のみ（既定 5）', () => {
  const stderr = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n');
  const result = classifyCliFailure({ exitCode: 1, stdoutLength: 0, stderr });
  assert.equal(result.stderrTail, 'line6\nline7\nline8\nline9\nline10');
});

test('maxLines を指定すればその行数に従う', () => {
  const stderr = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n');
  const result = classifyCliFailure({ exitCode: 1, stdoutLength: 0, stderr, maxLines: 2 });
  assert.equal(result.stderrTail, 'line9\nline10');
});

test('stderr が undefined でも例外を投げない', () => {
  const result = classifyCliFailure({ exitCode: 1, stdoutLength: 0, stderr: undefined });
  assert.equal(result.kind, 'emptyNonZero');
  assert.equal(result.stderrTail, '');
});

// #345: isWorkspaceTrustError() — classifyCliFailure() 自体は無変更のまま、
// emptyNonZero の中身をさらに細分類するための独立した純関数のテスト。

test('isWorkspaceTrustError: "Refusing to run in an untrusted workspace" を検出する', () => {
  const stderr = "devin: error=Refusing to run in an untrusted workspace: d:\\iap\\eBuilder8\\workspace\\Lafit";
  assert.equal(isWorkspaceTrustError(stderr), true);
});

test('isWorkspaceTrustError: config 案内の "respect_workspace_trust" を検出する', () => {
  const stderr = 'Start `devin` interactively in this directory to trust it, or set\n`respect_workspace_trust: false` in your config to restore the previous behavior.';
  assert.equal(isWorkspaceTrustError(stderr), true);
});

test('isWorkspaceTrustError: 大文字小文字を区別しない', () => {
  assert.equal(isWorkspaceTrustError('REFUSING TO RUN IN AN UNTRUSTED WORKSPACE'), true);
});

test('isWorkspaceTrustError: 無関係な stderr では false（例外も投げない）', () => {
  assert.equal(isWorkspaceTrustError('panic: something broke'), false);
  assert.equal(isWorkspaceTrustError(''), false);
});
