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
  formatHandoverCreated,
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

test('候補: n make 済みだけを、作成が新しい順に最大 9 件（今のスレッドと使用中の引継ぎ元は除く）', () => {
  const base = new Date('2026-10-01T00:00:00Z').getTime();
  const rows = [];
  for (let i = 0; i < 12; i++) {
    rows.push({ id: `s${i}`, title: null, lastActiveAt: null, handoverDocAt: new Date(base + i * 1000), hasHandoverDoc: true });
  }
  rows.push({ id: 'nodoc', title: null, lastActiveAt: null, handoverDocAt: null, hasHandoverDoc: false });
  const result = selectHandoverCandidates(rows, 's11', undefined, ['s10']);
  assert.equal(result.length, HANDOVER_CANDIDATE_MAX);
  assert.equal(result[0].id, 's9');
  assert.ok(!result.some((r) => r.id === 's11' || r.id === 's10' || r.id === 'nodoc'));
});

test('作成日時の表示: 今日 / 昨日 / MM/DD', () => {
  const now = new Date(2026, 9, 31, 15, 0, 0);
  assert.equal(formatHandoverCreated(new Date(2026, 9, 31, 13, 20, 0), now, 'ja'), '今日 13:20');
  assert.equal(formatHandoverCreated(new Date(2026, 9, 30, 9, 5, 0), now, 'ja'), '昨日 09:05');
  assert.equal(formatHandoverCreated(new Date(2026, 9, 28, 9, 5, 0), now, 'ja'), '10/28 09:05');
  assert.equal(formatHandoverCreated(new Date(2026, 9, 31, 13, 20, 0), now, 'en'), 'today 13:20');
});

test('表示名: title → 先頭ユーザー発言 → ID、40 文字で切る', () => {
  assert.equal(handoverThreadLabel({ id: 'id1', title: '設計の相談' }), '設計の相談');
  assert.equal(handoverThreadLabel({ id: 'id1', title: null, firstUserMessage: ' セッション の\n引継ぎ ' }), 'セッション の 引継ぎ');
  assert.equal(handoverThreadLabel({ id: 'id1', title: null }), 'id1');
  assert.equal(handoverThreadLabel({ id: 'id1', title: 'あ'.repeat(50) }), 'あ'.repeat(40) + '…');
});

test('最新判定: 作成以降にプロンプト（lastActiveAt）が無いときだけ', () => {
  const at = new Date('2026-10-31T10:00:00Z');
  assert.equal(canReuseHandoverDoc({ handoverDoc: '# x', handoverDocAt: at, lastActiveAt: new Date('2026-10-31T09:59:00Z') }), true);
  assert.equal(canReuseHandoverDoc({ handoverDoc: '# x', handoverDocAt: at, lastActiveAt: at }), true);
  assert.equal(canReuseHandoverDoc({ handoverDoc: '# x', handoverDocAt: at, lastActiveAt: new Date('2026-10-31T10:00:01Z') }), false);
  assert.equal(canReuseHandoverDoc({ handoverDoc: '# x', handoverDocAt: at, lastActiveAt: null }), true);
  assert.equal(canReuseHandoverDoc({ handoverDoc: null, handoverDocAt: at, lastActiveAt: null }), false);
  assert.equal(canReuseHandoverDoc({ handoverDoc: '# x', handoverDocAt: null, lastActiveAt: null }), false);
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
