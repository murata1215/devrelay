// Usage 案件必須サイクル: lib/usage-case-rules.ts（案件が空なら AI プロンプトを止める判定）のテスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideCaseGuard } from '../dist-test/lib/usage-case-rules.js';

// テストでは shared を import しない（dist-test は src のみ）。代表的なコマンドだけ判定するスタブ
const isCommand = (t) => ['e', 'exec', 'x', 'h', 'n make', 'u'].includes(t.toLowerCase()) || /^\d+$/.test(t);
const base = { required: true, loaded: true, caseName: null, text: 'ログ画面を直して', hasFiles: false, isCommand };

test('必須モード OFF なら常に通す', () => {
  assert.equal(decideCaseGuard({ ...base, required: false }), 'ok');
});

test('案件が空の AI プロンプトは止める', () => {
  assert.equal(decideCaseGuard(base), 'need-case');
  assert.equal(decideCaseGuard({ ...base, caseName: '   ' }), 'need-case');
});

test('案件があれば通す', () => {
  assert.equal(decideCaseGuard({ ...base, caseName: '案件名1' }), 'ok');
});

test('コマンド・内部コマンド・空文字は案件なしでも通す', () => {
  for (const text of ['e', 'x', 'h', 'n make', '2', '//connect abc', '']) {
    assert.equal(decideCaseGuard({ ...base, text }), 'ok', text);
  }
});

test('添付付きは AI に渡るので、テキストがコマンド風でも止める', () => {
  assert.equal(decideCaseGuard({ ...base, text: '', hasFiles: true }), 'need-case');
});

test('案件をまだ読めていない（スレッド未確定）ときは止める', () => {
  assert.equal(decideCaseGuard({ ...base, loaded: false, caseName: '案件名1' }), 'not-ready');
  assert.equal(decideCaseGuard({ ...base, loaded: false, text: 'h' }), 'ok');
});
