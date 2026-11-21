// ポータル サイクル P1（3 カラム化）の純関数テスト。
// サーバー応答（資料・ニュース・課題）を信用しない入力として正規化すること、
// PDF の URL・資料ページ・ナレッジ検索のパスが安全に組み立てられることを固定する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePortalDocs,
  portalDocFileHref,
  portalDocsPagePath,
  normalizePortalNews,
  mergeNoticesIntoNews,
  filterPortalNews,
  normalizePortalIssues,
  buildKnowledgeSearchPath,
  formatPortalFileSize,
  sanitizeNextPath,
} from '../dist-test/lib/portal-rules.js';

const BASE = '/tsinternal/devrelay/';

test('normalizePortalDocs: 不正な分類・資料を捨て、資料 0 件の分類は出さない', () => {
  const cats = normalizePortalDocs({
    categories: [
      { name: '方針', root: true, docs: [{ title: 'A', path: 'A.pdf', size: 10, updatedAt: '2026-11-21T00:00:00Z' }] },
      { name: '空', docs: [] },
      { name: '', docs: [{ title: 'x', path: 'x.pdf' }] },
      { name: 'マニュアル', docs: [{ title: 'B', path: 'マニュアル/B.pdf' }, { title: '', path: 'c.pdf' }, 'bad'] },
      'bad',
    ],
  });
  assert.deepEqual(cats.map((c) => [c.name, c.root, c.docs.length]), [['方針', true, 1], ['マニュアル', false, 1]]);
  assert.equal(cats[1].docs[0].size, 0);
  assert.deepEqual(normalizePortalDocs(null), []);
  assert.deepEqual(normalizePortalDocs({ categories: 'x' }), []);
});

test('portalDocFileHref: base 付きの API URL、パスは丸ごとエンコード', () => {
  assert.equal(
    portalDocFileHref('Devrelayマニュアル/社内 画面.pdf', BASE),
    '/tsinternal/devrelay/api/portal/docs/file?path=Devrelay%E3%83%9E%E3%83%8B%E3%83%A5%E3%82%A2%E3%83%AB%2F%E7%A4%BE%E5%86%85%20%E7%94%BB%E9%9D%A2.pdf',
  );
  assert.equal(portalDocFileHref('a&b=c.pdf', '/'), '/api/portal/docs/file?path=a%26b%3Dc.pdf');
});

test('portalDocsPagePath: 分類はクエリで渡す。ログイン後の戻り先には使われない（/portal 系は除外）', () => {
  assert.equal(portalDocsPagePath('Devrelayマニュアル'), `/portal/docs?c=${encodeURIComponent('Devrelayマニュアル')}`);
  assert.equal(portalDocsPagePath(null), '/portal/docs');
  assert.equal(sanitizeNextPath(portalDocsPagePath('x')), null);
});

test('normalizePortalNews: 日付・タイトル必須、カテゴリは既知以外 other、危険なリンクは捨てる、新しい順', () => {
  const items = normalizePortalNews({
    items: [
      { id: '1', date: '2026-11-20', category: 'update', title: 'A', body: 'b' },
      { id: '2', date: '2026-11-21', category: 'x', title: 'B', link: 'javascript:alert(1)' },
      { id: '3', date: '2026/11/22', title: 'C' },
      { id: '4', date: '2026-11-19', title: 'D', link: 'https://example.com/' },
    ],
  });
  assert.deepEqual(items.map((i) => i.id), ['2', '1', '4']);
  assert.equal(items[0].category, 'other');
  assert.equal(items[0].link, undefined);
  assert.equal(items[2].link, 'https://example.com/');
});

test('mergeNoticesIntoNews / filterPortalNews', () => {
  const news = [{ id: 'u', date: '2026-11-21', category: 'update', title: 'U', body: '' }];
  const merged = mergeNoticesIntoNews([{ date: '2026-11-22', text: 'お知らせ' }, { date: '', text: '日付なし' }], news);
  assert.deepEqual(merged.map((i) => [i.category, i.title]), [['notice', 'お知らせ'], ['update', 'U'], ['notice', '日付なし']]);
  assert.deepEqual(filterPortalNews(merged, 'update').map((i) => i.id), ['u']);
  assert.equal(filterPortalNews(merged, 'latest').length, 3);
});

test('normalizePortalIssues', () => {
  assert.deepEqual(
    normalizePortalIssues({ items: [{ title: 'A', owner: '村田', due: '2026-12-01', link: 'ftp://x' }, { owner: 'x' }] }),
    [{ title: 'A', owner: '村田', due: '2026-12-01' }],
  );
  assert.deepEqual(normalizePortalIssues([]), []);
});

test('buildKnowledgeSearchPath: 空なら検索画面、文字列はエンコード', () => {
  assert.equal(buildKnowledgeSearchPath('  '), '/knowledge');
  assert.equal(buildKnowledgeSearchPath('引継ぎ n make'), `/knowledge?q=${encodeURIComponent('引継ぎ n make')}`);
  assert.ok(sanitizeNextPath(buildKnowledgeSearchPath('x&y')));
});

test('formatPortalFileSize', () => {
  assert.equal(formatPortalFileSize(0), '');
  assert.equal(formatPortalFileSize(300), '1 KB');
  assert.equal(formatPortalFileSize(296 * 1024), '296 KB');
  assert.equal(formatPortalFileSize(1.5 * 1024 * 1024), '1.5 MB');
});
