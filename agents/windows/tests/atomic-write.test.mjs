// #348: アトミックなファイル書き込み（atomic-write.ts）の単体テスト。
// コンパイル済み dist から直接 import する（control-response.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { buildTempPath, nextUniqueSuffix, writeFileAtomic } from '../dist/services/atomic-write.js';

test('nextUniqueSuffix: 連続呼び出しでも一意な値を返す', () => {
  const suffixes = new Set();
  for (let i = 0; i < 100; i++) {
    suffixes.add(nextUniqueSuffix());
  }
  assert.equal(suffixes.size, 100);
});

test('buildTempPath: 対象と同じディレクトリに "." 始まりの隠しファイル名を組み立てる', () => {
  const target = '/tmp/foo/conversation.json';
  const suffix = 'abc123';
  const tempPath = buildTempPath(target, suffix);
  assert.equal(dirname(tempPath), dirname(target));
  assert.equal(basename(tempPath), '.conversation.json.tmp-abc123');
});

test('writeFileAtomic: 新規ファイルへの書き込みに成功し、内容が読み戻せる', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devrelay-348-atomic-'));
  try {
    const target = join(dir, 'sub', 'file.json');
    const result = await writeFileAtomic(target, '{"a":1}');
    assert.equal(result, 'atomic');
    const content = await readFile(target, 'utf-8');
    assert.equal(content, '{"a":1}');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writeFileAtomic: 既存ファイルを上書きできる（rename による置き換え）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devrelay-348-atomic-'));
  try {
    const target = join(dir, 'file.json');
    await writeFileAtomic(target, 'OLD');
    const result = await writeFileAtomic(target, 'NEW');
    assert.equal(result, 'atomic');
    const content = await readFile(target, 'utf-8');
    assert.equal(content, 'NEW');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writeFileAtomic: 完了後に temp ファイルが残らない', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devrelay-348-atomic-'));
  try {
    const target = join(dir, 'file.json');
    await writeFileAtomic(target, 'DATA');
    const entries = await readdir(dir);
    const tempLeftovers = entries.filter((e) => e.includes('.tmp-'));
    assert.deepEqual(tempLeftovers, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writeFileAtomic: 10並行書き込み（別ターゲット）が全て成功する', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devrelay-348-atomic-'));
  try {
    const tasks = [];
    for (let i = 0; i < 10; i++) {
      tasks.push(writeFileAtomic(join(dir, `file-${i}.json`), `content-${i}`));
    }
    const results = await Promise.all(tasks);
    assert.ok(results.every((r) => r === 'atomic'));
    for (let i = 0; i < 10; i++) {
      const content = await readFile(join(dir, `file-${i}.json`), 'utf-8');
      assert.equal(content, `content-${i}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
