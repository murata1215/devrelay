// サイクルP3-A: skill-tree-io.ts の実 tmpdir を使った I/O テスト（symlink 安全性・アトミック swap・上限）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, readFile, rm, lstat, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  copyTreeSafe,
  hashTree,
  isContainedPath,
  atomicSwapDir,
  removeManagedDir,
  cleanupResidue,
  listDirNames,
  removeDirIfEmpty,
  removeResidueDirsIfEmpty,
} from '../dist/services/capabilities/skill-tree-io.js';

async function mkTemp() {
  return mkdtemp(join(tmpdir(), 'devrelay-skill-tree-io-'));
}

// ---- copyTreeSafe: symlink 安全性 ----

test('copyTreeSafe: symlink は作られない（スキップされる）', async () => {
  const root = await mkTemp();
  const src = join(root, 'src');
  const dest = join(root, 'dest');
  await mkdir(src, { recursive: true });
  await writeFile(join(src, 'SKILL.md'), '# hello');
  const outsideTarget = join(root, 'outside-secret.txt');
  await writeFile(outsideTarget, 'secret');
  await symlink(outsideTarget, join(src, 'evil-link'));

  const result = await copyTreeSafe(src, dest, { maxBytes: 1024 * 1024, maxFiles: 100, maxDepth: 16 });
  assert.equal(result.ok, true);

  const destEntries = await listDirNames(dest);
  // evil-link はコピーされないため present しない（ディレクトリではないので listDirNames には出ない）
  assert.ok(!destEntries.includes('evil-link'));
  await assert.rejects(() => lstat(join(dest, 'evil-link')));
  await rm(root, { recursive: true, force: true });
});

test('copyTreeSafe: clone 外を指す symlink 経由でファイルが出ない', async () => {
  const root = await mkTemp();
  const src = join(root, 'src');
  const dest = join(root, 'dest');
  await mkdir(src, { recursive: true });
  const outsideDir = join(root, 'outside-dir');
  await mkdir(outsideDir, { recursive: true });
  await writeFile(join(outsideDir, 'leaked.txt'), 'leaked-content');
  await symlink(outsideDir, join(src, 'link-to-outside'));

  await copyTreeSafe(src, dest, { maxBytes: 1024 * 1024, maxFiles: 100, maxDepth: 16 });
  await assert.rejects(() => readFile(join(dest, 'link-to-outside', 'leaked.txt')));
  await rm(root, { recursive: true, force: true });
});

// ---- copyTreeSafe: 上限 ----

test('copyTreeSafe: ファイル数上限超過で too-many-files', async () => {
  const root = await mkTemp();
  const src = join(root, 'src');
  await mkdir(src, { recursive: true });
  for (let i = 0; i < 5; i++) await writeFile(join(src, `f${i}.txt`), 'x');
  const result = await copyTreeSafe(src, join(root, 'dest'), { maxBytes: 1024 * 1024, maxFiles: 3, maxDepth: 16 });
  assert.deepEqual(result, { ok: false, reason: 'too-many-files' });
  await rm(root, { recursive: true, force: true });
});

test('copyTreeSafe: サイズ上限超過で too-large', async () => {
  const root = await mkTemp();
  const src = join(root, 'src');
  await mkdir(src, { recursive: true });
  await writeFile(join(src, 'big.txt'), Buffer.alloc(2000, 'a'));
  const result = await copyTreeSafe(src, join(root, 'dest'), { maxBytes: 1000, maxFiles: 100, maxDepth: 16 });
  assert.deepEqual(result, { ok: false, reason: 'too-large' });
  await rm(root, { recursive: true, force: true });
});

test('copyTreeSafe: 深さ上限超過で too-deep', async () => {
  const root = await mkTemp();
  let cur = join(root, 'src');
  await mkdir(cur, { recursive: true });
  for (let i = 0; i < 20; i++) {
    cur = join(cur, `d${i}`);
    await mkdir(cur, { recursive: true });
  }
  await writeFile(join(cur, 'deep.txt'), 'x');
  const result = await copyTreeSafe(join(root, 'src'), join(root, 'dest'), { maxBytes: 1024 * 1024, maxFiles: 1000, maxDepth: 5 });
  assert.deepEqual(result, { ok: false, reason: 'too-deep' });
  await rm(root, { recursive: true, force: true });
});

// ---- isContainedPath ----

test('isContainedPath: 配下のパスは true', () => {
  assert.equal(isContainedPath('/a/b/c', '/a/b'), true);
});

test('isContainedPath: 配下でない/traversal は false', () => {
  assert.equal(isContainedPath('/a/other', '/a/b'), false);
  assert.equal(isContainedPath('/a/b/../../etc', '/a/b'), false);
});

// ---- atomicSwapDir ----

test('atomicSwapDir: 既存 dest を staging で置き換え、swap 後に dest が完全', async () => {
  const root = await mkTemp();
  const staging = join(root, 'staging');
  const dest = join(root, 'dest');
  const trash = join(root, 'trash');
  await mkdir(dest, { recursive: true });
  await writeFile(join(dest, 'old.txt'), 'old');
  await mkdir(staging, { recursive: true });
  await writeFile(join(staging, 'new.txt'), 'new');

  const result = await atomicSwapDir(staging, dest, trash);
  assert.deepEqual(result, { ok: true });
  const content = await readFile(join(dest, 'new.txt'), 'utf-8');
  assert.equal(content, 'new');
  await assert.rejects(() => readFile(join(dest, 'old.txt'), 'utf-8'));
  await assert.rejects(() => lstat(trash)); // trash は掃除済み
  await rm(root, { recursive: true, force: true });
});

test('atomicSwapDir: dest が存在しない新規インストールでも成功する', async () => {
  const root = await mkTemp();
  const staging = join(root, 'staging');
  const dest = join(root, 'dest-new');
  const trash = join(root, 'trash');
  await mkdir(staging, { recursive: true });
  await writeFile(join(staging, 'new.txt'), 'new');

  const result = await atomicSwapDir(staging, dest, trash);
  assert.deepEqual(result, { ok: true });
  assert.equal(await readFile(join(dest, 'new.txt'), 'utf-8'), 'new');
  await rm(root, { recursive: true, force: true });
});

test('atomicSwapDir: staging→dest の rename が失敗したら dest を元に戻す（ロールバック）', async () => {
  const root = await mkTemp();
  const staging = join(root, 'staging-does-not-exist'); // 存在しない → rename が ENOENT で失敗する
  const dest = join(root, 'dest');
  const trash = join(root, 'trash');
  await mkdir(dest, { recursive: true });
  await writeFile(join(dest, 'old.txt'), 'old');

  const result = await atomicSwapDir(staging, dest, trash);
  assert.equal(result.ok, false);
  // ロールバックにより dest は元の内容のまま残っている
  assert.equal(await readFile(join(dest, 'old.txt'), 'utf-8'), 'old');
  await rm(root, { recursive: true, force: true });
});

// ---- atomicSwapDir: T1b 回帰テスト（.devrelay-trash 親ディレクトリ未作成バグ） ----

test('atomicSwapDir: T1b回帰 — trash の親ディレクトリが存在しなくても update（dest既存）が成功する', async () => {
  const root = await mkTemp();
  const staging = join(root, 'staging');
  const dest = join(root, 'dest');
  // trash の親（.devrelay-trash 相当）がまだ存在しない状態を再現する
  // （修正前のコードはここで `rename(destDir, trashDir)` が ENOENT で必ず失敗していた＝
  //   skill の update 経路が構造的に必ず失敗するバグの再現条件）。
  const trashParent = join(root, '.devrelay-trash');
  const trash = join(trashParent, 'my-skill-abc123');
  await mkdir(dest, { recursive: true });
  await writeFile(join(dest, 'old.txt'), 'old');
  await mkdir(staging, { recursive: true });
  await writeFile(join(staging, 'new.txt'), 'new');

  await assert.rejects(() => lstat(trashParent)); // 前提: 親がまだ無いことを確認

  const result = await atomicSwapDir(staging, dest, trash);
  assert.deepEqual(result, { ok: true });
  assert.equal(await readFile(join(dest, 'new.txt'), 'utf-8'), 'new');
  await assert.rejects(() => readFile(join(dest, 'old.txt'), 'utf-8'));
  // swap 完了後、trash の子（旧内容）自体は掃除されるが、mkdir(recursive) で作った
  // trash の親ディレクトリ（.devrelay-trash 相当）は atomicSwapDir の役目ではなく空のまま残る
  // （T1 の removeResidueDirsIfEmpty が reconcile 末尾で回収する。ここでは atomicSwapDir 単体の
  //   契約として「親は作られるが子までは掃除しない」ことだけを確認する）
  const trashParentEntries = await readdir(trashParent);
  assert.deepEqual(trashParentEntries, []);
  await removeDirIfEmpty(trashParent);
  await assert.rejects(() => lstat(trashParent));
  await rm(root, { recursive: true, force: true });
});

test('atomicSwapDir: dest が存在しない新規インストールでは trash 親を作らない（空ディレクトリを残さない）', async () => {
  const root = await mkTemp();
  const staging = join(root, 'staging');
  const dest = join(root, 'dest-new');
  const trashParent = join(root, '.devrelay-trash');
  const trash = join(trashParent, 'my-skill-xyz');
  await mkdir(staging, { recursive: true });
  await writeFile(join(staging, 'new.txt'), 'new');

  const result = await atomicSwapDir(staging, dest, trash);
  assert.deepEqual(result, { ok: true });
  // 新規 install（destExisted===false）は trash を一切使わないため、親ディレクトリも作られない
  await assert.rejects(() => lstat(trashParent));
  await rm(root, { recursive: true, force: true });
});

// ---- removeDirIfEmpty / removeResidueDirsIfEmpty（T1） ----

test('removeDirIfEmpty: 中身が空なら削除する', async () => {
  const root = await mkTemp();
  const dir = join(root, 'empty-dir');
  await mkdir(dir, { recursive: true });
  await removeDirIfEmpty(dir);
  await assert.rejects(() => lstat(dir));
  await rm(root, { recursive: true, force: true });
});

test('removeDirIfEmpty: 中身があれば削除しない', async () => {
  const root = await mkTemp();
  const dir = join(root, 'nonempty-dir');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'f.txt'), 'x');
  await removeDirIfEmpty(dir);
  const st = await lstat(dir); // 削除されていなければ lstat が成功する
  assert.ok(st.isDirectory());
  await rm(root, { recursive: true, force: true });
});

test('removeDirIfEmpty: 存在しないディレクトリは無害（throw しない）', async () => {
  const root = await mkTemp();
  await removeDirIfEmpty(join(root, 'does-not-exist'));
  await rm(root, { recursive: true, force: true });
});

test('removeResidueDirsIfEmpty: .devrelay-staging / .devrelay-trash が空ならどちらも削除する', async () => {
  const root = await mkTemp();
  await mkdir(join(root, '.devrelay-staging'), { recursive: true });
  await mkdir(join(root, '.devrelay-trash'), { recursive: true });
  await removeResidueDirsIfEmpty(root);
  await assert.rejects(() => lstat(join(root, '.devrelay-staging')));
  await assert.rejects(() => lstat(join(root, '.devrelay-trash')));
  await rm(root, { recursive: true, force: true });
});

test('removeResidueDirsIfEmpty: 中身が残っていれば触らない（次回 cleanupResidue に委ねる）', async () => {
  const root = await mkTemp();
  await mkdir(join(root, '.devrelay-staging', 'leftover'), { recursive: true });
  await removeResidueDirsIfEmpty(root);
  const st = await lstat(join(root, '.devrelay-staging'));
  assert.ok(st.isDirectory()); // 中身ありなので残る
  await rm(root, { recursive: true, force: true });
});

// ---- removeManagedDir ----

test('removeManagedDir: symlink は unlink のみ行いリンク先を辿って削除しない', async () => {
  const root = await mkTemp();
  const realTarget = join(root, 'real-target');
  await mkdir(realTarget, { recursive: true });
  await writeFile(join(realTarget, 'keep.txt'), 'keep');
  const linkPath = join(root, 'link');
  await symlink(realTarget, linkPath);

  await removeManagedDir(linkPath);
  await assert.rejects(() => lstat(linkPath)); // リンク自体は消える
  assert.equal(await readFile(join(realTarget, 'keep.txt'), 'utf-8'), 'keep'); // リンク先は無事
  await rm(root, { recursive: true, force: true });
});

test('removeManagedDir: 通常ディレクトリは再帰削除される', async () => {
  const root = await mkTemp();
  const target = join(root, 'target');
  await mkdir(join(target, 'sub'), { recursive: true });
  await writeFile(join(target, 'sub', 'f.txt'), 'x');
  await removeManagedDir(target);
  await assert.rejects(() => lstat(target));
  await rm(root, { recursive: true, force: true });
});

// ---- cleanupResidue ----

test('cleanupResidue: .devrelay-staging / .devrelay-trash の残骸を掃除する', async () => {
  const root = await mkTemp();
  await mkdir(join(root, '.devrelay-staging', 'x'), { recursive: true });
  await mkdir(join(root, '.devrelay-trash', 'y'), { recursive: true });
  await cleanupResidue(root);
  await assert.rejects(() => lstat(join(root, '.devrelay-staging')));
  await assert.rejects(() => lstat(join(root, '.devrelay-trash')));
  await rm(root, { recursive: true, force: true });
});

// ---- hashTree ----

test('hashTree: 同一内容なら同じハッシュ（決定性）', async () => {
  const root = await mkTemp();
  const dirA = join(root, 'a');
  const dirB = join(root, 'b');
  await mkdir(join(dirA, 'sub'), { recursive: true });
  await mkdir(join(dirB, 'sub'), { recursive: true });
  await writeFile(join(dirA, 'SKILL.md'), '# hello');
  await writeFile(join(dirB, 'SKILL.md'), '# hello');
  await writeFile(join(dirA, 'sub', 'x.txt'), 'x');
  await writeFile(join(dirB, 'sub', 'x.txt'), 'x');

  const hashA = await hashTree(dirA);
  const hashB = await hashTree(dirB);
  assert.equal(hashA, hashB);
  assert.match(hashA, /^sha256:[0-9a-f]{64}$/);
  await rm(root, { recursive: true, force: true });
});

test('hashTree: 内容が変わればハッシュも変わる', async () => {
  const root = await mkTemp();
  const dir = join(root, 'a');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), '# hello');
  const before = await hashTree(dir);
  await writeFile(join(dir, 'SKILL.md'), '# hello world');
  const after = await hashTree(dir);
  assert.notEqual(before, after);
  await rm(root, { recursive: true, force: true });
});
