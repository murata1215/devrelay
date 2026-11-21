// サイクルS2a: クロスユーザー ask のパス実体判定（cross-ask-path-guard.ts）の単体テスト。
// fs を要するため実際の一時ディレクトリ・シンボリックリンクを作って検証する
// （plan-gate-live.test.mjs 等と異なり実 SDK は起動しない。既定 skip 不要の軽量テスト）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveProjectRootReal, checkCrossAskPath } from '../dist/services/cross-ask-path-guard.js';

function withTempProject(fn) {
  const projectPath = mkdtempSync(path.join(tmpdir(), 'devrelay-cross-ask-path-'));
  try {
    return fn(projectPath);
  } finally {
    rmSync(projectPath, { recursive: true, force: true });
  }
}

test('resolveProjectRootReal: 実在するディレクトリは realpath を返す', () => {
  withTempProject((projectPath) => {
    const real = resolveProjectRootReal(projectPath);
    assert.ok(path.isAbsolute(real));
  });
});

test('checkCrossAskPath: プロジェクト配下の通常ファイルは allow', () => {
  withTempProject((projectPath) => {
    const root = resolveProjectRootReal(projectPath);
    writeFileSync(path.join(projectPath, 'index.ts'), 'export const x = 1;');
    const result = checkCrossAskPath(root, path.join(projectPath, 'index.ts'));
    assert.deepEqual(result, { allowed: true });
  });
});

test('checkCrossAskPath: 相対パスはプロジェクトルート基準で解決する', () => {
  withTempProject((projectPath) => {
    const root = resolveProjectRootReal(projectPath);
    mkdirSync(path.join(projectPath, 'src'));
    writeFileSync(path.join(projectPath, 'src', 'a.ts'), 'export {};');
    const result = checkCrossAskPath(root, 'src/a.ts');
    assert.deepEqual(result, { allowed: true });
  });
});

test('checkCrossAskPath: .. で遡ってプロジェクト外に出るパスは deny（outsideProject）', () => {
  withTempProject((projectPath) => {
    const root = resolveProjectRootReal(projectPath);
    const result = checkCrossAskPath(root, path.join(projectPath, '..', 'secret.txt'));
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'outsideProject');
  });
});

test('checkCrossAskPath: 絶対パスでプロジェクト外を指すものは deny（outsideProject）', () => {
  withTempProject((projectPath) => {
    const root = resolveProjectRootReal(projectPath);
    const result = checkCrossAskPath(root, '/etc/passwd');
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'outsideProject');
  });
});

test('checkCrossAskPath: シンボリックリンクでプロジェクト外を指すファイルは deny', () => {
  withTempProject((projectPath) => {
    const outsideDir = mkdtempSync(path.join(tmpdir(), 'devrelay-cross-ask-outside-'));
    try {
      const root = resolveProjectRootReal(projectPath);
      writeFileSync(path.join(outsideDir, 'secret.txt'), 'OUTSIDE_SECRET');
      const linkPath = path.join(projectPath, 'link-to-secret.txt');
      symlinkSync(path.join(outsideDir, 'secret.txt'), linkPath);
      const result = checkCrossAskPath(root, linkPath);
      assert.equal(result.allowed, false);
      // realpath 解決により outsideProject として落ちる（symlink 検出より先に境界判定で deny）
      assert.equal(result.reason, 'outsideProject');
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

test('checkCrossAskPath: プロジェクト内を指すシンボリックリンクは symlink 構成要素として deny（defense-in-depth）', () => {
  withTempProject((projectPath) => {
    const root = resolveProjectRootReal(projectPath);
    writeFileSync(path.join(projectPath, 'real.txt'), 'inside content');
    const linkPath = path.join(projectPath, 'link-to-real.txt');
    symlinkSync(path.join(projectPath, 'real.txt'), linkPath);
    const result = checkCrossAskPath(root, linkPath);
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'symlink');
  });
});

test('checkCrossAskPath: 中間ディレクトリがシンボリックリンクの場合も deny', () => {
  withTempProject((projectPath) => {
    const root = resolveProjectRootReal(projectPath);
    mkdirSync(path.join(projectPath, 'real-dir'));
    writeFileSync(path.join(projectPath, 'real-dir', 'f.ts'), 'export {};');
    symlinkSync(path.join(projectPath, 'real-dir'), path.join(projectPath, 'link-dir'));
    const result = checkCrossAskPath(root, path.join(projectPath, 'link-dir', 'f.ts'));
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'symlink');
  });
});

test('checkCrossAskPath: .devrelay 配下は deniedPath', () => {
  withTempProject((projectPath) => {
    const root = resolveProjectRootReal(projectPath);
    mkdirSync(path.join(projectPath, '.devrelay', 'sessions', 'x'), { recursive: true });
    writeFileSync(path.join(projectPath, '.devrelay', 'sessions', 'x', 'conversation.json'), '[]');
    const result = checkCrossAskPath(root, path.join(projectPath, '.devrelay', 'sessions', 'x', 'conversation.json'));
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'deniedPath');
  });
});

test('checkCrossAskPath: .env は deniedPath', () => {
  withTempProject((projectPath) => {
    const root = resolveProjectRootReal(projectPath);
    writeFileSync(path.join(projectPath, '.env'), 'SECRET=1');
    const result = checkCrossAskPath(root, path.join(projectPath, '.env'));
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'deniedPath');
  });
});

test('checkCrossAskPath: 存在しないパス（新規作成対象）はプロジェクト外なら deny', () => {
  withTempProject((projectPath) => {
    const root = resolveProjectRootReal(projectPath);
    const result = checkCrossAskPath(root, '/tmp/does-not-exist-' + Date.now());
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'outsideProject');
  });
});

test('checkCrossAskPath: 存在しないパス（プロジェクト内・未作成ファイル）は realpath フォールバックでも境界内なら allow', () => {
  withTempProject((projectPath) => {
    const root = resolveProjectRootReal(projectPath);
    const result = checkCrossAskPath(root, path.join(projectPath, 'not-yet-created.ts'));
    assert.deepEqual(result, { allowed: true });
  });
});
