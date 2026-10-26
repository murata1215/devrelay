// 2026-10-26 `spawn codex ENOENT` 障害の根治（agents/linux/src/services/node-bin-path.ts）の単体テスト。
// 外部 import ゼロの純関数をコンパイル済み dist から直接 import する（crontab-fix-rules.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prependBinDir } from '../dist/services/node-bin-path.js';

const exists = (set) => (p) => set.has(p);

test('prependBinDir: PATH が空のとき dir のみを返す', () => {
  assert.equal(prependBinDir(undefined, '/exec/bin', ':', exists(new Set(['/exec/bin']))), '/exec/bin');
  assert.equal(prependBinDir('', '/exec/bin', ':', exists(new Set(['/exec/bin']))), '/exec/bin');
});

test('prependBinDir: dir を PATH の先頭に前置する', () => {
  const result = prependBinDir('/usr/bin:/bin', '/exec/bin', ':', exists(new Set(['/exec/bin'])));
  assert.equal(result, '/exec/bin:/usr/bin:/bin');
});

test('prependBinDir: dir が既に PATH に含まれていれば前置しない（重複防止、2026-10-18 crontab 増殖事故と同型のバグの再発防止）', () => {
  const result = prependBinDir('/exec/bin:/usr/bin', '/exec/bin', ':', exists(new Set(['/exec/bin'])));
  assert.equal(result, '/exec/bin:/usr/bin');
});

test('prependBinDir: 10 回適用しても結果が変わらない（冪等性）', () => {
  let path = '/usr/bin:/bin';
  const existsFn = exists(new Set(['/exec/bin']));
  const results = [];
  for (let i = 0; i < 10; i++) {
    path = prependBinDir(path, '/exec/bin', ':', existsFn);
    results.push(path);
  }
  for (let i = 1; i < results.length; i++) {
    assert.equal(results[i], results[0], `${i + 1}回目の適用結果が1回目と異なる（重複増殖の回帰）`);
  }
  assert.equal((results[9].match(/\/exec\/bin/g) || []).length, 1, '/exec/bin が重複していないこと');
});

test('prependBinDir: dir が存在しない場合は PATH をそのまま返す（Windows ポータブル node が無い機体で無効パスを積まない）', () => {
  const result = prependBinDir('/usr/bin:/bin', '/does/not/exist', ':', exists(new Set()));
  assert.equal(result, '/usr/bin:/bin');
});

test('prependBinDir: dir が空文字の場合は PATH をそのまま返す', () => {
  const result = prependBinDir('/usr/bin:/bin', '', ':', exists(new Set([''])));
  assert.equal(result, '/usr/bin:/bin');
});

test('prependBinDir: Windows セパレータ（;）でも動作する', () => {
  const result = prependBinDir('C:\\Windows;C:\\Windows\\System32', 'C:\\nvm\\v20', ';', exists(new Set(['C:\\nvm\\v20'])));
  assert.equal(result, 'C:\\nvm\\v20;C:\\Windows;C:\\Windows\\System32');
});

test('prependBinDir: 既存 PATH に部分文字列として含まれるだけ（完全一致しない）場合は前置する（誤判定で足されない回帰防止）', () => {
  // '/exec/bin' は '/exec/bin-old' の部分文字列だが、split 後の完全一致判定でないと誤って「含まれる」と判定してしまう
  const result = prependBinDir('/exec/bin-old:/usr/bin', '/exec/bin', ':', exists(new Set(['/exec/bin'])));
  assert.equal(result, '/exec/bin:/exec/bin-old:/usr/bin');
});
