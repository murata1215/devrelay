// サイクル SDK-2 ④a: 実インストール済み SDK に対して sdk-executable.ts の I/O シェルを実行し、
// 検出器が form=none に劣化していないことを検証する。
// sdk-executable-locator.test.mjs はモック deps による判定ロジックのみを検証しており、
// 実際にインストールされた SDK に対する検出は一度も検証していなかった穴を埋める
// （doc/sdk-executable-runbook.md §3「④（依存バンプ）を実施する際は、実際にインストールした SDK に
// 対して probeSdkExecutable() を実行し、form=none になったら red になるテストを追加すること」）。
// 0.2.80 上では form=clijs で green、0.3.278 バンプ後（findings コミット④）は form=native で
// green になることを期待する。
// agents/macos/tests/sdk-executable-real.test.mjs と byte-for-byte 同一。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { probeSdkExecutable } from '../dist/services/sdk-executable.js';
import { decideSdkExecutable } from '../dist/services/sdk-executable-locator.js';

// ---- R1: 実インストールされた SDK に同梱実行ファイルが見つかること ----

test('probeSdkExecutable R1: 実インストール済み SDK に対する検出が form=none に劣化していない', () => {
  const probe = probeSdkExecutable();
  assert.ok(
    probe.form === 'clijs' || probe.form === 'native',
    `期待外の form=${probe.form}（同梱実行ファイルが見つからない。SDK の再インストールが必要な可能性がある）`,
  );
  assert.equal(probe.probeStatus, 'ok');
  assert.ok(probe.path, 'path が null');
  assert.ok(fs.existsSync(probe.path), `検出されたパスが実在しない: ${probe.path}`);
  if (process.platform !== 'win32') {
    const stat = fs.statSync(probe.path);
    assert.ok((stat.mode & fs.constants.S_IXUSR) !== 0, `実行権限が無い: ${probe.path}`);
  }
});

// ---- R2: 同梱実行ファイルが健全な限り、システム claude が無くても sdk-default のまま ----

test('probeSdkExecutable R2: システム claude が見つからない環境でも decision は sdk-default のまま', () => {
  const probe = probeSdkExecutable();
  const { decision, executable } = decideSdkExecutable(probe, '/nonexistent/system/claude');
  assert.equal(decision, 'sdk-default');
  assert.equal(executable, null);
});

// ---- R3: platform/arch/バージョン情報が実行環境および package.json の宣言と整合する ----

test('probeSdkExecutable R3: platform/arch/バージョン情報が実行環境および package.json の宣言と整合する', () => {
  const probe = probeSdkExecutable();
  assert.equal(probe.platform, process.platform);
  assert.equal(probe.arch, process.arch);

  const pkgRaw = fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8');
  const pkg = JSON.parse(pkgRaw);
  const declared = pkg.dependencies?.['@anthropic-ai/claude-agent-sdk'];
  assert.ok(declared, 'agent package.json に @anthropic-ai/claude-agent-sdk の宣言が無い');

  assert.ok(probe.sdkVersion, 'sdkVersion が取得できていない（package.json 読み込み失敗の可能性）');
  const declaredVersion = declared.replace(/^[\^~]/, '');
  assert.equal(
    probe.sdkVersion,
    declaredVersion,
    `宣言バージョン(${declaredVersion})と実インストール(${probe.sdkVersion})が不一致`,
  );
});
