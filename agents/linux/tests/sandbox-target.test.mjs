import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decideSandboxTarget, normalizeSandboxProjectPath, shouldDeclareSandboxHostCapability } from '../dist/services/sandbox-target.js';

describe('sandbox-target: normalizeSandboxProjectPath', () => {
  test('スラッシュをバックスラッシュに統一する', () => {
    assert.equal(normalizeSandboxProjectPath('C:/dev/repo', 'win32'), 'c:\\dev\\repo');
  });

  test('末尾の区切り文字を除去する', () => {
    assert.equal(normalizeSandboxProjectPath('C:\\dev\\repo\\', 'win32'), 'c:\\dev\\repo');
    assert.equal(normalizeSandboxProjectPath('C:\\dev\\repo\\\\', 'win32'), 'c:\\dev\\repo');
  });

  test('win32 では大文字小文字を無視する（小文字化）', () => {
    assert.equal(normalizeSandboxProjectPath('C:\\Dev\\Repo', 'win32'), 'c:\\dev\\repo');
  });

  test('win32 以外では大文字小文字を保持する（区切り文字の統一は行う）', () => {
    assert.equal(normalizeSandboxProjectPath('/Dev/Repo', 'linux'), '\\Dev\\Repo');
  });
});

describe('sandbox-target: decideSandboxTarget', () => {
  test('configuredProjects が未設定なら対象外（全 OS）', () => {
    for (const platform of ['win32', 'linux', 'darwin']) {
      assert.deepEqual(
        decideSandboxTarget({ configuredProjects: undefined, projectPath: 'C:\\dev\\repo', platform }),
        { kind: 'not-target' },
      );
    }
  });

  test('configuredProjects が空配列なら対象外', () => {
    assert.deepEqual(
      decideSandboxTarget({ configuredProjects: [], projectPath: 'C:\\dev\\repo', platform: 'win32' }),
      { kind: 'not-target' },
    );
  });

  test('projectPath が一致すれば対象（完全一致）', () => {
    const result = decideSandboxTarget({
      configuredProjects: ['C:\\dev\\repo'],
      projectPath: 'C:\\dev\\repo',
      platform: 'win32',
    });
    assert.deepEqual(result, { kind: 'target' });
  });

  test('大文字小文字・スラッシュ・末尾区切りの違いを無視して一致判定する', () => {
    const result = decideSandboxTarget({
      configuredProjects: ['c:/dev/repo/'],
      projectPath: 'C:\\Dev\\Repo',
      platform: 'win32',
    });
    assert.deepEqual(result, { kind: 'target' });
  });

  test('一致しなければ対象外', () => {
    const result = decideSandboxTarget({
      configuredProjects: ['C:\\dev\\other'],
      projectPath: 'C:\\dev\\repo',
      platform: 'win32',
    });
    assert.deepEqual(result, { kind: 'not-target' });
  });

  test('projectPath が空文字なら判定不能', () => {
    const result = decideSandboxTarget({
      configuredProjects: ['C:\\dev\\repo'],
      projectPath: '',
      platform: 'win32',
    });
    assert.equal(result.kind, 'undecidable');
  });

  test('projectPath が絶対パスでない（win32）なら判定不能', () => {
    const result = decideSandboxTarget({
      configuredProjects: ['C:\\dev\\repo'],
      projectPath: 'relative\\path',
      platform: 'win32',
    });
    assert.equal(result.kind, 'undecidable');
  });

  test('configuredProjects に絶対パスでない項目が混ざっていれば判定不能（設定ミスを対象外に倒さない）', () => {
    const result = decideSandboxTarget({
      configuredProjects: ['C:\\dev\\repo', 'relative\\other'],
      projectPath: 'C:\\dev\\repo',
      platform: 'win32',
    });
    assert.equal(result.kind, 'undecidable');
  });

  test('configuredProjects に空文字が混ざっていれば判定不能', () => {
    const result = decideSandboxTarget({
      configuredProjects: ['C:\\dev\\repo', ''],
      projectPath: 'C:\\dev\\repo',
      platform: 'win32',
    });
    assert.equal(result.kind, 'undecidable');
  });

  test('win32 以外のプラットフォームでは絶対パス判定（win32 専用チェック）をスキップする', () => {
    const result = decideSandboxTarget({
      configuredProjects: ['/dev/repo'],
      projectPath: '/dev/repo',
      platform: 'linux',
    });
    assert.deepEqual(result, { kind: 'target' });
  });

  test('UNC パス（\\\\server\\share\\...）も絶対パスとして認める', () => {
    const result = decideSandboxTarget({
      configuredProjects: ['\\\\server\\share\\repo'],
      projectPath: '\\\\server\\share\\repo',
      platform: 'win32',
    });
    assert.deepEqual(result, { kind: 'target' });
  });
});

// サイクルSB-1b: サーバーが伝えた serverEnabled との OR 合成（サーバーの ON を手元で OFF にはできない）
describe('sandbox-target: decideSandboxTarget（サイクルSB-1b: serverEnabled との合成）', () => {
  test('サーバー ON のみ（手元の sandbox.projects は未設定）→ 対象', () => {
    const result = decideSandboxTarget({
      configuredProjects: undefined,
      projectPath: 'C:\\dev\\repo',
      platform: 'win32',
      serverEnabled: true,
    });
    assert.deepEqual(result, { kind: 'target' });
  });

  test('手元の設定のみ（serverEnabled 未指定）→ 従来どおり一致判定で対象', () => {
    const result = decideSandboxTarget({
      configuredProjects: ['C:\\dev\\repo'],
      projectPath: 'C:\\dev\\repo',
      platform: 'win32',
    });
    assert.deepEqual(result, { kind: 'target' });
  });

  test('両方（サーバー ON かつ手元の設定にも一致）→ 対象', () => {
    const result = decideSandboxTarget({
      configuredProjects: ['C:\\dev\\repo'],
      projectPath: 'C:\\dev\\repo',
      platform: 'win32',
      serverEnabled: true,
    });
    assert.deepEqual(result, { kind: 'target' });
  });

  test('サーバー ON だが手元の設定には一致しない項目のみ → それでも対象（OR 合成）', () => {
    const result = decideSandboxTarget({
      configuredProjects: ['C:\\dev\\other'],
      projectPath: 'C:\\dev\\repo',
      platform: 'win32',
      serverEnabled: true,
    });
    assert.deepEqual(result, { kind: 'target' });
  });

  test('どちらも無し（serverEnabled=false かつ手元未設定）→ 対象外', () => {
    const result = decideSandboxTarget({
      configuredProjects: undefined,
      projectPath: 'C:\\dev\\repo',
      platform: 'win32',
      serverEnabled: false,
    });
    assert.deepEqual(result, { kind: 'not-target' });
  });

  test('サーバー ON だが projectPath が絶対パスでない（win32） → 判定不能（サーバーの ON でも fail-closed）', () => {
    const result = decideSandboxTarget({
      configuredProjects: undefined,
      projectPath: 'relative\\path',
      platform: 'win32',
      serverEnabled: true,
    });
    assert.equal(result.kind, 'undecidable');
  });

  test('サーバー ON だが手元の sandbox.projects に不正な項目がある → 判定不能（手元の設定ミスが優先）', () => {
    const result = decideSandboxTarget({
      configuredProjects: ['relative\\other'],
      projectPath: 'C:\\dev\\repo',
      platform: 'win32',
      serverEnabled: true,
    });
    assert.equal(result.kind, 'undecidable');
  });
});

describe('sandbox-target: shouldDeclareSandboxHostCapability', () => {
  test('win32 のみ true', () => {
    assert.equal(shouldDeclareSandboxHostCapability('win32'), true);
  });

  test('linux は false', () => {
    assert.equal(shouldDeclareSandboxHostCapability('linux'), false);
  });

  test('darwin は false', () => {
    assert.equal(shouldDeclareSandboxHostCapability('darwin'), false);
  });
});
