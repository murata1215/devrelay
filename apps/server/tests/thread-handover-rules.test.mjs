// スレッド引継ぎ（`n` コマンド）: apps/server/src/services/thread-handover-rules.ts の単体テスト。
// 外部 import ゼロの純関数をコンパイル済み dist から直接 import する（agent-repo-rules.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isThreadHandoverEnabled,
  buildHandoverStamp,
  isValidHandoverStamp,
  buildHandoverFileName,
  selectHandoverCandidates,
  handoverThreadLabel,
  canReuseHandoverDoc,
  buildHandoverDocument,
  extractHandoverTitle,
  buildHandoverPreview,
  HANDOVER_CANDIDATE_MAX,
} from '../dist/services/thread-handover-rules.js';

test('キルスイッチ: 未設定・1 は有効、0 のみ無効', () => {
  assert.equal(isThreadHandoverEnabled(undefined), true);
  assert.equal(isThreadHandoverEnabled('1'), true);
  assert.equal(isThreadHandoverEnabled(' 0 '), false);
  assert.equal(isThreadHandoverEnabled('0'), false);
});

test('スタンプはローカル時刻の YYYYMMDD_HHmmss', () => {
  const d = new Date(2026, 9, 31, 10, 51, 30); // 2026-10-31 10:51:30（ローカル）
  assert.equal(buildHandoverStamp(d), '20261031_105130');
  assert.equal(isValidHandoverStamp('20261031_105130'), true);
  assert.equal(isValidHandoverStamp('20261031-105130'), false);
  assert.equal(isValidHandoverStamp('../x'), false);
});

test('ファイル名: 全桁の ID、未使用と使用中', () => {
  const src = 'cmh1a2b3c4d5e6f7g8h9i0j1k';
  const tgt = 'cmh9z8y7x6w5v4u3t2s1r0q9p';
  assert.equal(buildHandoverFileName('20261031_105130', src), `20261031_105130_${src}.md`);
  assert.equal(buildHandoverFileName('20261031_105130', src, tgt), `20261031_105130_${src}_${tgt}.md`);
});

test('候補: 今のスレッドとメッセージ 0 件を除き、新しい順に最大 9 件', () => {
  const base = new Date('2026-10-01T00:00:00Z').getTime();
  const rows = [];
  for (let i = 0; i < 12; i++) {
    rows.push({ id: `s${i}`, title: null, lastActiveAt: new Date(base + i * 1000), startedAt: new Date(base), messageCount: 1 });
  }
  rows.push({ id: 'empty', title: null, lastActiveAt: new Date(base + 99999), startedAt: new Date(base), messageCount: 0 });
  const result = selectHandoverCandidates(rows, 's11');
  assert.equal(result.length, HANDOVER_CANDIDATE_MAX);
  assert.equal(result[0].id, 's10');
  assert.ok(!result.some((r) => r.id === 's11' || r.id === 'empty'));
});

test('候補: lastActiveAt が null なら startedAt で並べる', () => {
  const rows = [
    { id: 'a', title: null, lastActiveAt: null, startedAt: new Date('2026-10-03T00:00:00Z'), messageCount: 2 },
    { id: 'b', title: null, lastActiveAt: new Date('2026-10-02T00:00:00Z'), startedAt: new Date('2026-10-01T00:00:00Z'), messageCount: 2 },
  ];
  assert.deepEqual(selectHandoverCandidates(rows, 'x').map((r) => r.id), ['a', 'b']);
});

test('表示名: title → 先頭ユーザー発言 → ID、40 文字で切る', () => {
  assert.equal(handoverThreadLabel({ id: 'id1', title: '設計の相談' }), '設計の相談');
  assert.equal(handoverThreadLabel({ id: 'id1', title: null, firstUserMessage: ' セッション の\n引継ぎ ' }), 'セッション の 引継ぎ');
  assert.equal(handoverThreadLabel({ id: 'id1', title: null }), 'id1');
  assert.equal(handoverThreadLabel({ id: 'id1', title: 'あ'.repeat(50) }), 'あ'.repeat(40) + '…');
});

test('使い回し: 作成以降に会話が無いときだけ', () => {
  const at = new Date('2026-10-31T10:00:00Z');
  assert.equal(canReuseHandoverDoc({ handoverDoc: '# x', handoverDocAt: at, lastMessageAt: new Date('2026-10-31T09:59:00Z') }), true);
  assert.equal(canReuseHandoverDoc({ handoverDoc: '# x', handoverDocAt: at, lastMessageAt: at }), true);
  assert.equal(canReuseHandoverDoc({ handoverDoc: '# x', handoverDocAt: at, lastMessageAt: new Date('2026-10-31T10:00:01Z') }), false);
  assert.equal(canReuseHandoverDoc({ handoverDoc: null, handoverDocAt: at, lastMessageAt: null }), false);
  assert.equal(canReuseHandoverDoc({ handoverDoc: '# x', handoverDocAt: null, lastMessageAt: null }), false);
});

test('引継ぎ書: 前置きを落とし、見出し直後にメタ行を入れる', () => {
  const out = '以下が引継ぎ書です。\n\n# 引継ぎ機能の設計\n## 目的\nn コマンドを作る\n';
  const doc = buildHandoverDocument(out, {
    sourceSessionId: 'cmhsrc',
    createdAt: new Date(2026, 9, 31, 10, 51, 30),
    aiTool: 'claude',
    defaultTitle: 'fallback',
  });
  assert.equal(doc, '# 引継ぎ機能の設計\n- 元スレッド: cmhsrc / 作成: 2026-10-31 10:51 / AI: claude\n\n## 目的\nn コマンドを作る\n');
  assert.equal(extractHandoverTitle(doc), '引継ぎ機能の設計');
});

test('引継ぎ書: 見出しが無ければ既定タイトル、空なら null', () => {
  const meta = { sourceSessionId: 's', createdAt: new Date(2026, 0, 1, 0, 0, 0), aiTool: 'devin', defaultTitle: 'スレッドA' };
  assert.match(buildHandoverDocument('## 目的\nabc', meta), /^# スレッドA\n/);
  assert.equal(buildHandoverDocument('   ', meta), null);
  assert.equal(buildHandoverDocument('# タイトルだけ', meta), null);
});

test('プレビュー: 見出し・メタ行を除いた先頭行を引用で', () => {
  const doc = '# T\n- 元スレッド: s / 作成: x / AI: claude\n\n## 目的\nA\nB\n';
  assert.equal(buildHandoverPreview(doc, 2), '> ## 目的\n> A\n> …');
});
