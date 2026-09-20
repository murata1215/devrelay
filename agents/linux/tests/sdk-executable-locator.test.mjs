// サイクル SDK-1: sdk-executable-locator.ts（claude-agent-sdk 0.2/0.3 両対応検出器）の単体テスト。
// 外部 import ゼロの純粋関数を、コンパイル済み dist から直接 import する
// （claude-locator.test.mjs / running-code-stale.test.mjs と同じ流儀）。
// T5 のみ実 fs / 実 createRequire を使い、pnpm 配置（プラットフォームパッケージが SDK の
// private node_modules にのみ存在する）の再現性を検証する。
// agents/macos/tests/sdk-executable-locator.test.mjs と byte-for-byte 同一。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  preferMuslFromGlibc,
  sdkNativeBinarySpecifiers,
  runSdkExecutableProbe,
  decideSdkExecutable,
  buildSdkExecutableStatusLine,
  buildSdkExecutableTriedLine,
} from '../dist/services/sdk-executable-locator.js';

/** テスト用の最小 deps を組み立てる（個別ケースで一部を上書きする）。 */
function baseDeps(overrides = {}) {
  return {
    platform: 'linux',
    arch: 'x64',
    glibcVersionRuntime: '2.35',
    resolveSdkEntry: () => '/fake/sdk/sdk.mjs',
    resolveFromSdk: () => {
      throw Object.assign(new Error('Cannot find module'), { code: 'MODULE_NOT_FOUND' });
    },
    exists: () => false,
    readPackageJson: () => ({ version: '0.2.80', claudeCodeVersion: '2.1.80' }),
    joinPath: (dir, file) => `${dir}/${file}`,
    dirname: (p) => p.slice(0, p.lastIndexOf('/')),
    onWarn: () => {},
    ...overrides,
  };
}

// ---- T1: 0.2 系のみ（cli.js あり・プラットフォームパッケージ無し） ----

test('runSdkExecutableProbe T1: cli.js のみ存在 → form=clijs / decision=sdk-default、resolveFromSdk は一度も呼ばれない', () => {
  let resolveFromSdkCalls = 0;
  const deps = baseDeps({
    exists: (p) => p === '/fake/sdk/cli.js',
    resolveFromSdk: () => {
      resolveFromSdkCalls += 1;
      throw new Error('should not be called');
    },
  });
  const probe = runSdkExecutableProbe(deps);
  assert.equal(probe.form, 'clijs');
  assert.equal(probe.path, '/fake/sdk/cli.js');
  assert.equal(probe.probeStatus, 'ok');
  assert.equal(resolveFromSdkCalls, 0);
  const { decision, executable } = decideSdkExecutable(probe, null);
  assert.equal(decision, 'sdk-default');
  assert.equal(executable, null);
});

// ---- T2: 0.3 系のみ（cli.js 無し・ネイティブあり） ----

test('runSdkExecutableProbe T2: cli.js 無し・ネイティブバイナリあり → form=native / decision=sdk-default', () => {
  const nativePath = '/fake/sdk/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude';
  const deps = baseDeps({
    exists: (p) => p === nativePath,
    resolveFromSdk: (sdkEntry, specifier) => {
      if (specifier === '@anthropic-ai/claude-agent-sdk-linux-x64/claude') return nativePath;
      throw Object.assign(new Error('Cannot find module'), { code: 'MODULE_NOT_FOUND' });
    },
  });
  const probe = runSdkExecutableProbe(deps);
  assert.equal(probe.form, 'native');
  assert.equal(probe.path, nativePath);
  assert.equal(probe.probeStatus, 'ok');
  const { decision, executable } = decideSdkExecutable(probe, null);
  assert.equal(decision, 'sdk-default');
  assert.equal(executable, null);
});

// ---- T3: 両方あり（cli.js 優先＝ 0.2.80 上の同一性保証） ----

test('runSdkExecutableProbe T3: cli.js とネイティブ両方存在 → form=clijs（cli.js 優先）', () => {
  const nativePath = '/fake/sdk/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude';
  const deps = baseDeps({
    exists: (p) => p === '/fake/sdk/cli.js' || p === nativePath,
    resolveFromSdk: () => nativePath,
  });
  const probe = runSdkExecutableProbe(deps);
  assert.equal(probe.form, 'clijs');
  assert.equal(probe.path, '/fake/sdk/cli.js');
});

// ---- T4 / T4b: どちらも無い ----

test('runSdkExecutableProbe T4: どちらも無し・システム claude あり → form=none / decision=system-claude', () => {
  const deps = baseDeps({ exists: () => false });
  const probe = runSdkExecutableProbe(deps);
  assert.equal(probe.form, 'none');
  assert.equal(probe.path, null);
  const { decision, executable } = decideSdkExecutable(probe, '/usr/local/bin/claude');
  assert.equal(decision, 'system-claude');
  assert.equal(executable, '/usr/local/bin/claude');
});

test('runSdkExecutableProbe T4b: どちらも無し・システム claude も無し → decision=none', () => {
  const deps = baseDeps({ exists: () => false });
  const probe = runSdkExecutableProbe(deps);
  const { decision, executable } = decideSdkExecutable(probe, null);
  assert.equal(decision, 'none');
  assert.equal(executable, null);
});

// ---- T5: 実ディレクトリ木（pnpm 配置の再現：SDK の private node_modules にのみ配置） ----

test('runSdkExecutableProbe T5: 実 fs/createRequire — Agent 起点は MODULE_NOT_FOUND、sdk.mjs 起点は成功（訂正3の回帰テスト）', (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-exec-locator-t5-'));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  // SDK 本体ディレクトリ（sdk.mjs が存在する場所）。プラットフォームパッケージは
  // この直下の node_modules（＝ SDK の private node_modules）にのみ配置する。
  const sdkDir = path.join(tmpRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  fs.mkdirSync(sdkDir, { recursive: true });
  const sdkEntry = path.join(sdkDir, 'sdk.mjs');
  fs.writeFileSync(sdkEntry, '// fake sdk.mjs\n');
  fs.writeFileSync(path.join(sdkDir, 'package.json'), JSON.stringify({ version: '0.3.278', claudeCodeVersion: '2.1.278' }));

  const platformPkgDir = path.join(sdkDir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-linux-x64');
  fs.mkdirSync(platformPkgDir, { recursive: true });
  fs.writeFileSync(path.join(platformPkgDir, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk-linux-x64' }));
  const binaryPath = path.join(platformPkgDir, 'claude');
  fs.writeFileSync(binaryPath, '#!/bin/sh\necho fake\n');

  // Agent 側モジュール起点（sdk.mjs と兄弟階層ではない別ディレクトリ）の createRequire は
  // このプラットフォームパッケージを一切見つけられない（pnpm の実配置と同じ状態）。
  const agentDir = path.join(tmpRoot, 'agent-src');
  fs.mkdirSync(agentDir, { recursive: true });
  const agentFakeModule = path.join(agentDir, 'ai-runner.js');
  fs.writeFileSync(agentFakeModule, '// fake agent module\n');
  assert.throws(() => {
    createRequire(agentFakeModule).resolve('@anthropic-ai/claude-agent-sdk-linux-x64/claude');
  }, /Cannot find module/);

  // sdk.mjs 起点の createRequire は成功する（findings 訂正3 の絶対条件）。
  const deps = baseDeps({
    resolveSdkEntry: () => sdkEntry,
    resolveFromSdk: (entry, specifier) => createRequire(entry).resolve(specifier),
    exists: (p) => fs.existsSync(p),
    readPackageJson: (dir) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
      } catch {
        return null;
      }
    },
    joinPath: (dir, file) => path.join(dir, file),
    dirname: (p) => path.dirname(p),
  });
  const probe = runSdkExecutableProbe(deps);
  assert.equal(probe.form, 'native');
  assert.equal(probe.path, binaryPath);
  assert.equal(probe.sdkVersion, '0.3.278');
  assert.equal(probe.claudeCodeVersion, '2.1.278');
  assert.equal(probe.probeStatus, 'ok');
});

// ---- T6: ネイティブ検出中の想定外の例外 → legacy フォールバック ----

test('runSdkExecutableProbe T6: exists() が想定外の例外を投げる → onWarn 1回・form=none・probeStatus=legacy（throw しない）', () => {
  let warnCalls = 0;
  const nativePath = '/fake/sdk/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude';
  const deps = baseDeps({
    exists: (p) => {
      if (p === '/fake/sdk/cli.js') return false;
      throw new Error('unexpected fs error');
    },
    resolveFromSdk: () => nativePath,
    onWarn: () => {
      warnCalls += 1;
    },
  });
  assert.doesNotThrow(() => {
    const probe = runSdkExecutableProbe(deps);
    assert.equal(probe.form, 'none');
    assert.equal(probe.path, null);
    assert.equal(probe.probeStatus, 'legacy');
  });
  assert.equal(warnCalls, 1);
});

// ---- T7: resolveSdkEntry が throw ----

test('runSdkExecutableProbe T7: resolveSdkEntry() が throw → form=unresolved / decision=sdk-default（#287 以前の挙動を保存）', () => {
  const deps = baseDeps({
    resolveSdkEntry: () => {
      throw new Error('Cannot find package @anthropic-ai/claude-agent-sdk');
    },
  });
  const probe = runSdkExecutableProbe(deps);
  assert.equal(probe.form, 'unresolved');
  assert.equal(probe.path, null);
  assert.equal(probe.sdkEntry, null);
  const { decision, executable } = decideSdkExecutable(probe, '/usr/local/bin/claude');
  assert.equal(decision, 'sdk-default');
  assert.equal(executable, null);
});

// ---- T8: sdkNativeBinarySpecifiers の候補順（SDK の tW() と同一） ----

test('sdkNativeBinarySpecifiers T8: linux + preferMusl=false → 標準版を先に試す', () => {
  assert.deepEqual(sdkNativeBinarySpecifiers('linux', 'x64', false), [
    '@anthropic-ai/claude-agent-sdk-linux-x64/claude',
    '@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude',
  ]);
});

test('sdkNativeBinarySpecifiers T8: linux + preferMusl=true → musl 版を先に試す', () => {
  assert.deepEqual(sdkNativeBinarySpecifiers('linux', 'arm64', true), [
    '@anthropic-ai/claude-agent-sdk-linux-arm64-musl/claude',
    '@anthropic-ai/claude-agent-sdk-linux-arm64/claude',
  ]);
});

test('sdkNativeBinarySpecifiers T8: win32 は .exe 拡張子付き単一候補', () => {
  assert.deepEqual(sdkNativeBinarySpecifiers('win32', 'x64', false), [
    '@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe',
  ]);
});

test('sdkNativeBinarySpecifiers T8: darwin-arm64 は拡張子無し単一候補', () => {
  assert.deepEqual(sdkNativeBinarySpecifiers('darwin', 'arm64', false), [
    '@anthropic-ai/claude-agent-sdk-darwin-arm64/claude',
  ]);
});

test('sdkNativeBinarySpecifiers T8: android は linux-<arch>-android 単一候補', () => {
  assert.deepEqual(sdkNativeBinarySpecifiers('android', 'arm64', false), [
    '@anthropic-ai/claude-agent-sdk-linux-arm64-android/claude',
  ]);
});

// ---- T9: preferMuslFromGlibc ----

test('preferMuslFromGlibc T9: linux かつ glibcVersionRuntime undefined のときだけ true', () => {
  assert.equal(preferMuslFromGlibc('linux', undefined), true);
  assert.equal(preferMuslFromGlibc('linux', '2.35'), false);
  assert.equal(preferMuslFromGlibc('darwin', undefined), false);
  assert.equal(preferMuslFromGlibc('win32', undefined), false);
});

// ---- T10: buildSdkExecutableStatusLine / buildSdkExecutableTriedLine ----

test('buildSdkExecutableStatusLine T10: 固定書式・path= が末尾（空白入りパスでも先行フィールドが壊れない）', () => {
  const probe = {
    form: 'clijs',
    path: 'C:\\Users\\c shiraki\\.devrelay\\agent\\node_modules\\@anthropic-ai\\claude-agent-sdk\\cli.js',
    sdkEntry: 'C:\\Users\\c shiraki\\.devrelay\\agent\\node_modules\\@anthropic-ai\\claude-agent-sdk\\sdk.mjs',
    sdkVersion: '0.2.80',
    claudeCodeVersion: '2.1.80',
    platform: 'win32',
    arch: 'x64',
    preferMusl: false,
    triedSpecifiers: [],
    probeStatus: 'ok',
  };
  const line = buildSdkExecutableStatusLine(probe, 'sdk-default', null);
  assert.equal(
    line,
    '🩺 [SDK] claude-exec sdk=0.2.80 cc=2.1.80 form=clijs decision=sdk-default platform=win32-x64 preferMusl=false probe=ok path=C:\\Users\\c shiraki\\.devrelay\\agent\\node_modules\\@anthropic-ai\\claude-agent-sdk\\cli.js',
  );
  // path= より前のフィールドはすべて空白を含まないキー=値のスペース区切りであることを確認
  const beforePath = line.slice(0, line.indexOf('path='));
  assert.ok(!/\s{2,}/.test(beforePath));
});

test('buildSdkExecutableStatusLine T10: sdk/cc が unknown のフォールバック表示', () => {
  const probe = {
    form: 'unresolved',
    path: null,
    sdkEntry: null,
    sdkVersion: null,
    claudeCodeVersion: null,
    platform: 'linux',
    arch: 'x64',
    preferMusl: false,
    triedSpecifiers: [],
    probeStatus: 'ok',
  };
  const line = buildSdkExecutableStatusLine(probe, 'sdk-default', null);
  assert.equal(
    line,
    '🩺 [SDK] claude-exec sdk=unknown cc=unknown form=unresolved decision=sdk-default platform=linux-x64 preferMusl=false probe=ok path=-',
  );
});

test('buildSdkExecutableStatusLine T10: decision=none のとき path=-', () => {
  const probe = {
    form: 'none',
    path: null,
    sdkEntry: '/fake/sdk/sdk.mjs',
    sdkVersion: '0.3.278',
    claudeCodeVersion: '2.1.278',
    platform: 'linux',
    arch: 'x64',
    preferMusl: false,
    triedSpecifiers: ['@anthropic-ai/claude-agent-sdk-linux-x64/claude', '@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude'],
    probeStatus: 'ok',
  };
  const line = buildSdkExecutableStatusLine(probe, 'none', null);
  assert.equal(
    line,
    '🩺 [SDK] claude-exec sdk=0.3.278 cc=2.1.278 form=none decision=none platform=linux-x64 preferMusl=false probe=ok path=-',
  );
  const tried = buildSdkExecutableTriedLine(probe);
  assert.equal(
    tried,
    '🩺 [SDK] claude-exec tried=@anthropic-ai/claude-agent-sdk-linux-x64/claude,@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude',
  );
});

test('buildSdkExecutableTriedLine T10: form が none 以外なら null', () => {
  const probe = {
    form: 'clijs',
    path: '/fake/sdk/cli.js',
    sdkEntry: '/fake/sdk/sdk.mjs',
    sdkVersion: '0.2.80',
    claudeCodeVersion: '2.1.80',
    platform: 'linux',
    arch: 'x64',
    preferMusl: false,
    triedSpecifiers: [],
    probeStatus: 'ok',
  };
  assert.equal(buildSdkExecutableTriedLine(probe), null);
});
