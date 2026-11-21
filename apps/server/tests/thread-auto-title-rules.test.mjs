// スレッドタイトル自動命名（0033）: thread-auto-title-rules.ts と
// thread-label-source.ts の pickFirstLabelUserMessage の単体テスト（dist を直接 import）。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isThreadAutoTitleEnabled,
  shouldGenerateAutoTitle,
  pickTitleSourceMessages,
  hasAutoTitleMaterial,
  buildAutoTitleUserPrompt,
  parseAutoTitle,
  normalizeAutoTitle,
  AUTO_TITLE_TURNS,
  AUTO_TITLE_MAX_LENGTH,
} from '../dist/services/thread-auto-title-rules.js';
import { pickFirstLabelUserMessage } from '../dist/services/thread-label-source.js';

describe('isThreadAutoTitleEnabled', () => {
  test('未設定・1 は有効、0 のみ無効', () => {
    assert.equal(isThreadAutoTitleEnabled(undefined), true);
    assert.equal(isThreadAutoTitleEnabled('1'), true);
    assert.equal(isThreadAutoTitleEnabled('0'), false);
  });
});

describe('shouldGenerateAutoTitle', () => {
  test('節目は 1・3・8', () => {
    assert.deepEqual([...AUTO_TITLE_TURNS], [1, 3, 8]);
    for (const n of [1, 3, 8]) assert.equal(shouldGenerateAutoTitle({ aiTurnCount: n, title: null, autoTitleTurns: null }), true);
    for (const n of [0, 2, 4, 5, 7, 9, 20]) assert.equal(shouldGenerateAutoTitle({ aiTurnCount: n, title: null, autoTitleTurns: null }), false);
  });
  test('ユーザー命名（title）があれば生成しない', () => {
    assert.equal(shouldGenerateAutoTitle({ aiTurnCount: 1, title: '手動の名前', autoTitleTurns: null }), false);
  });
  test('空白だけの title は未命名扱い', () => {
    assert.equal(shouldGenerateAutoTitle({ aiTurnCount: 1, title: '  ', autoTitleTurns: null }), true);
  });
  test('同じ節目で生成済みなら再生成しない、前の節目の値なら生成する', () => {
    assert.equal(shouldGenerateAutoTitle({ aiTurnCount: 3, title: null, autoTitleTurns: 3 }), false);
    assert.equal(shouldGenerateAutoTitle({ aiTurnCount: 3, title: null, autoTitleTurns: 1 }), true);
  });
});

describe('pickTitleSourceMessages', () => {
  test('5 件以下はそのまま', () => {
    assert.deepEqual(pickTitleSourceMessages(['a', 'b', 'c']), ['a', 'b', 'c']);
  });
  test('6 件以上は先頭 2 + 直近 3', () => {
    assert.deepEqual(pickTitleSourceMessages(['1', '2', '3', '4', '5', '6', '7']), ['1', '2', '5', '6', '7']);
  });
});

describe('hasAutoTitleMaterial / buildAutoTitleUserPrompt', () => {
  test('発言も引継ぎメモも無ければ材料なし', () => {
    assert.equal(hasAutoTitleMaterial({ handoverNote: null, userMessages: [] }), false);
    assert.equal(hasAutoTitleMaterial({ handoverNote: '引継ぎ', userMessages: [] }), true);
    assert.equal(hasAutoTitleMaterial({ handoverNote: null, userMessages: ['質問'] }), true);
  });
  test('プロンプトに各セクションが入り、長い発言は切り詰められる', () => {
    const p = buildAutoTitleUserPrompt({ handoverNote: 'メモ', userMessages: ['x'.repeat(1000)], aiExcerpt: '回答' });
    assert.match(p, /引継ぎメモ/);
    assert.match(p, /ユーザーの発言/);
    assert.match(p, /直近の AI の応答/);
    assert.ok(p.length < 1200);
  });
});

describe('parseAutoTitle / normalizeAutoTitle', () => {
  test('JSON から取り出す', () => {
    assert.equal(parseAutoTitle('{"title":"スレッド一覧の自動命名"}'), 'スレッド一覧の自動命名');
  });
  test('コードフェンス付き JSON', () => {
    assert.equal(parseAutoTitle('```json\n{"title":"ポータル改修"}\n```'), 'ポータル改修');
  });
  test('JSON でなければ 1 行目', () => {
    assert.equal(parseAutoTitle('「Usage 画面の改ページ」。\n補足'), 'Usage 画面の改ページ');
  });
  test('空・不正は null', () => {
    assert.equal(parseAutoTitle(''), null);
    assert.equal(parseAutoTitle('{"title":""}'), null);
    assert.equal(parseAutoTitle(null), null);
  });
  test('接頭辞・引用符・句点を除き、最大長で切る', () => {
    assert.equal(normalizeAutoTitle('タイトル: "テーマ色の追加"。'), 'テーマ色の追加');
    assert.equal(Array.from(normalizeAutoTitle('あ'.repeat(100))).length, AUTO_TITLE_MAX_LENGTH);
  });
});

describe('pickFirstLabelUserMessage', () => {
  const isCmd = (t) => /^n(\s+(\d+|make))?$/i.test(t.trim()) || t.trim() === 'e';
  test('コマンドだけの発言（n / n 1）を飛ばす', () => {
    assert.equal(pickFirstLabelUserMessage(['n', 'n 1', 'カラー選択の続き'], isCmd), 'カラー選択の続き');
  });
  test('コマンドタグを剥がして判定する', () => {
    assert.equal(pickFirstLabelUserMessage(['[exec] ', '[exec] 実装して'], isCmd), '実装して');
  });
  test('全部コマンドなら null', () => {
    assert.equal(pickFirstLabelUserMessage(['n', 'e'], isCmd), null);
    assert.equal(pickFirstLabelUserMessage([], isCmd), null);
  });
});
