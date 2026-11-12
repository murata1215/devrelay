// サイクルS2a: クロス ask スコープの CLAUDE.md 安全注入（cross-ask-claude-md.ts）の単体テスト。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  stripClaudeMdImportLines,
  clampClaudeMdContent,
  loadCrossAskClaudeMd,
  buildCrossAskClaudeMdPrompt,
  CROSS_ASK_CLAUDE_MD_MAX_CHARS,
} from '../dist/services/cross-ask-claude-md.js';
import { resolveProjectRootReal } from '../dist/services/cross-ask-path-guard.js';

function withTempProject(fn) {
  const projectPath = mkdtempSync(path.join(tmpdir(), 'devrelay-cross-ask-claudemd-'));
  try {
    return fn(projectPath);
  } finally {
    rmSync(projectPath, { recursive: true, force: true });
  }
}

test('stripClaudeMdImportLines: 行頭が @ の取り込み行を除去する', () => {
  const input = '# Title\n@../../secret.md\nBody text\n  @~/.claude/history.jsonl\nMore body';
  const result = stripClaudeMdImportLines(input);
  assert.ok(!result.includes('@../../secret.md'));
  assert.ok(!result.includes('@~/.claude/history.jsonl'));
  assert.ok(result.includes('# Title'));
  assert.ok(result.includes('Body text'));
  assert.ok(result.includes('More body'));
});

test('stripClaudeMdImportLines: 行頭以外の @ は本文として残す（email 等の誤除去防止）', () => {
  const input = 'Contact: owner@example.com\nSee also user@host for details.';
  const result = stripClaudeMdImportLines(input);
  assert.equal(result, input);
});

test('clampClaudeMdContent: 上限以下はそのまま返す', () => {
  const short = 'a'.repeat(100);
  assert.equal(clampClaudeMdContent(short, 1000), short);
});

test('clampClaudeMdContent: 上限超過時は切り詰めて省略注記を付ける', () => {
  const long = 'a'.repeat(100);
  const clamped = clampClaudeMdContent(long, 50);
  assert.equal(clamped.length < long.length + 20, true);
  assert.ok(clamped.includes('省略'));
  assert.ok(clamped.startsWith('a'.repeat(50)));
});

test('clampClaudeMdContent: 既定の上限値は CROSS_ASK_CLAUDE_MD_MAX_CHARS', () => {
  assert.equal(typeof CROSS_ASK_CLAUDE_MD_MAX_CHARS, 'number');
  assert.ok(CROSS_ASK_CLAUDE_MD_MAX_CHARS > 0);
});

test('loadCrossAskClaudeMd: プロジェクトルートの CLAUDE.md を安全化して返す', () => {
  withTempProject((projectPath) => {
    const root = resolveProjectRootReal(projectPath);
    writeFileSync(path.join(projectPath, 'CLAUDE.md'), '# Proj\n@../../outside.md\nHello');
    const content = loadCrossAskClaudeMd(root);
    assert.ok(content !== null);
    assert.ok(!content.includes('@../../outside.md'));
    assert.ok(content.includes('Hello'));
  });
});

test('loadCrossAskClaudeMd: CLAUDE.md が存在しない場合は null', () => {
  withTempProject((projectPath) => {
    const root = resolveProjectRootReal(projectPath);
    assert.equal(loadCrossAskClaudeMd(root), null);
  });
});

test('buildCrossAskClaudeMdPrompt: 本文が無い場合は空文字列', () => {
  withTempProject((projectPath) => {
    const root = resolveProjectRootReal(projectPath);
    assert.equal(buildCrossAskClaudeMdPrompt(root), '');
  });
});

test('buildCrossAskClaudeMdPrompt: 本文がある場合は読み取り専用の見出し付きブロックを返す', () => {
  withTempProject((projectPath) => {
    const root = resolveProjectRootReal(projectPath);
    writeFileSync(path.join(projectPath, 'CLAUDE.md'), '# Proj\nHello');
    const prompt = buildCrossAskClaudeMdPrompt(root);
    assert.ok(prompt.includes('Project CLAUDE.md'));
    assert.ok(prompt.includes('Hello'));
  });
});
