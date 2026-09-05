// 欠陥2対策（Devin プランモードの「無言で途中終了」と .svn 洪水の解消プラン、変更3）:
// isNoisyChangedPath()/DEFAULT_FILE_WATCH_NOTICE_LIMIT の単体テスト。
// 外部 import ゼロの純粋関数（agents/linux/src/services/devin-file-watch.ts）を
// コンパイル済み dist から直接 import する（devin-diagnostics.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNoisyChangedPath, DEFAULT_FILE_WATCH_NOTICE_LIMIT } from '../dist/services/devin-file-watch.js';

test('isNoisyChangedPath: .svn/pristine/91/913d75c4... は除外される（Lafit 実測パス、欠陥2本体）', () => {
  assert.equal(isNoisyChangedPath('.svn/pristine/91/913d75c4abcdef.svn-base'), true);
});

test('isNoisyChangedPath: .hg 配下は除外される', () => {
  assert.equal(isNoisyChangedPath('.hg/store/data/foo.i'), true);
});

test('isNoisyChangedPath: .bzr 配下は除外される', () => {
  assert.equal(isNoisyChangedPath('.bzr/checkout/dirstate'), true);
});

test('isNoisyChangedPath: CVS 配下は除外される', () => {
  assert.equal(isNoisyChangedPath('CVS/Entries'), true);
});

test('isNoisyChangedPath: 既存の除外ディレクトリ（.git/node_modules/.devrelay/dist等）は引き続き除外される', () => {
  assert.equal(isNoisyChangedPath('.git/index'), true);
  assert.equal(isNoisyChangedPath('node_modules/foo/index.js'), true);
  assert.equal(isNoisyChangedPath('.devrelay/config.yaml'), true);
  assert.equal(isNoisyChangedPath('.devrelay-output/result.md'), true);
  assert.equal(isNoisyChangedPath('dist/index.js'), true);
  assert.equal(isNoisyChangedPath('build/output.bin'), true);
  assert.equal(isNoisyChangedPath('__pycache__/mod.pyc'), true);
  assert.equal(isNoisyChangedPath('.next/cache/x'), true);
  assert.equal(isNoisyChangedPath('target/debug/app'), true);
  assert.equal(isNoisyChangedPath('vendor/lib/x.go'), true);
});

test('isNoisyChangedPath: 既存の除外拡張子・一時ファイルパターンは引き続き除外される', () => {
  assert.equal(isNoisyChangedPath('foo.txt~'), true);
  assert.equal(isNoisyChangedPath('foo.txt.swp'), true);
  assert.equal(isNoisyChangedPath('foo.tmp'), true);
  assert.equal(isNoisyChangedPath('app.log'), true);
  assert.equal(isNoisyChangedPath('foo.lock'), true);
});

test('isNoisyChangedPath: src/main/java/.../Foo.java は除外されない', () => {
  assert.equal(isNoisyChangedPath('src/main/java/com/example/Foo.java'), false);
});

test('isNoisyChangedPath: .gitignore（先頭が .git だがディレクトリではないファイル）は誤除外しない（境界ケース）', () => {
  assert.equal(isNoisyChangedPath('.gitignore'), false);
  assert.equal(isNoisyChangedPath('.gitattributes'), false);
});

test('isNoisyChangedPath: .hgignore（同種の境界ケース、.hg 誤爆防止）も誤除外しない', () => {
  assert.equal(isNoisyChangedPath('.hgignore'), false);
});

test('isNoisyChangedPath: Windows パス区切り（\\）も正しく判定される', () => {
  assert.equal(isNoisyChangedPath('.svn\\pristine\\91\\913d75c4.svn-base'), true);
  assert.equal(isNoisyChangedPath('src\\main\\java\\Foo.java'), false);
});

test('isNoisyChangedPath: サブディレクトリ深部の .svn も除外される（先頭一致に限定しない）', () => {
  assert.equal(isNoisyChangedPath('project/sub/.svn/entries'), true);
});

test('isNoisyChangedPath: 空文字・undefined は false（例外を投げない）', () => {
  assert.equal(isNoisyChangedPath(''), false);
  assert.equal(isNoisyChangedPath(undefined), false);
});

test('DEFAULT_FILE_WATCH_NOTICE_LIMIT: 既定値は20', () => {
  assert.equal(DEFAULT_FILE_WATCH_NOTICE_LIMIT, 20);
});
