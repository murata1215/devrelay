// #345: packages/shared/src/i18n.ts のテスト（コンパイル済み dist を直接 import、node:test）。
// #86→#90 / #293→#304 / #345 §40 で3回発生した「呼び出し側の同期漏れ（{tool} 等のプレースホルダ
// 未置換）」を、個別キーのテストではなく仕組みで検出できるようにするための回帰テスト。

import test from 'node:test';
import assert from 'node:assert/strict';
import { chatMessages, tChat } from '../dist/i18n.js';

/** テンプレート文字列に含まれる `{param}` プレースホルダ名の集合を返す */
function placeholderSet(template) {
  const matches = template.match(/\{[a-zA-Z][a-zA-Z0-9_]*\}/g) ?? [];
  return new Set(matches);
}

test('chatMessages の全キーで ja/en のプレースホルダ集合が一致する', () => {
  const mismatches = [];
  for (const key of Object.keys(chatMessages)) {
    const entry = chatMessages[key];
    const enSet = placeholderSet(entry.en);
    const jaSet = placeholderSet(entry.ja);
    const enOnly = [...enSet].filter((p) => !jaSet.has(p));
    const jaOnly = [...jaSet].filter((p) => !enSet.has(p));
    if (enOnly.length > 0 || jaOnly.length > 0) {
      mismatches.push({ key, enOnly, jaOnly });
    }
  }
  assert.deepEqual(mismatches, [], `プレースホルダ不一致: ${JSON.stringify(mismatches)}`);
});

test('tChat() は全パラメータ指定時に {...} を一切残さない', () => {
  // devin.workspaceUntrusted（{path}）で確認
  const result = tChat('ja', 'devin.workspaceUntrusted', { path: '/tmp/example' });
  assert.doesNotMatch(result, /\{[a-zA-Z][a-zA-Z0-9_]*\}/);
  assert.match(result, /\/tmp\/example/);
});

test('tChat() はパラメータ不足時に warn するが表示自体はそのまま返す（{tool} 欠落の再発防止）', () => {
  const originalWarn = console.warn;
  const warnCalls = [];
  console.warn = (...args) => { warnCalls.push(args); };
  try {
    // ai.cliFailed は {tool}/{code}/{stderr} の3パラメータが必要だが、意図的に tool を渡さない
    const result = tChat('ja', 'ai.cliFailed', { code: '1', stderr: 'boom' });
    assert.match(result, /\{tool\}/, '欠落したプレースホルダは置換されずそのまま残る');
    assert.equal(warnCalls.length, 1);
    assert.match(warnCalls[0][0], /unresolved placeholder/);
    assert.match(warnCalls[0][0], /ai\.cliFailed/);
  } finally {
    console.warn = originalWarn;
  }
});

test('tChat() は params 未指定でプレースホルダを含まないテンプレートなら warn しない', () => {
  const originalWarn = console.warn;
  let warned = false;
  console.warn = () => { warned = true; };
  try {
    const result = tChat('ja', 'quit.done');
    assert.equal(result, '👋 切断しました');
    assert.equal(warned, false);
  } finally {
    console.warn = originalWarn;
  }
});
