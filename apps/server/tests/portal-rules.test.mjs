// ポータル サイクル P1: services/portal-rules.ts・portal-service.ts の単体テスト（dist を直接 import）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isPortalEnabled,
  resolvePortalDir,
  isSafePortalRelPath,
  groupPortalDocs,
  PORTAL_ROOT_CATEGORY,
  normalizeNewsItems,
  mergeNewsItems,
  parseGitLog,
  isNewsworthyCommit,
  cleanCommitSubject,
  buildRuleBasedUpdateItem,
  RULE_NEWS_MAX_LINES,
  parseAiNewsJson,
  jstDateKey,
  normalizeIssues,
  normalizeTodoText,
} from '../dist/services/portal-rules.js';
import { listPortalDocFiles, resolvePortalDocFile, loadPortalDocs } from '../dist/services/portal-service.js';

test('isPortalEnabled: 既定 ON、"0" のときだけ OFF', () => {
  assert.equal(isPortalEnabled(undefined), true);
  assert.equal(isPortalEnabled('1'), true);
  assert.equal(isPortalEnabled('0'), false);
});

test('resolvePortalDir: 空・未設定は null、引用符は外す', () => {
  assert.equal(resolvePortalDir(undefined), null);
  assert.equal(resolvePortalDir('  '), null);
  assert.equal(resolvePortalDir('D:\\portal'), 'D:\\portal');
  assert.equal(resolvePortalDir('"D:\\portal"'), 'D:\\portal');
});

test('isSafePortalRelPath: DIR の外・PDF 以外・危険な文字は拒否', () => {
  assert.equal(isSafePortalRelPath('a.pdf'), true);
  assert.equal(isSafePortalRelPath('Devrelayマニュアル/社内DevRelay 画面の使い方.pdf'), true);
  assert.equal(isSafePortalRelPath('x/y/z.PDF'), true);
  for (const bad of [
    '', '/a.pdf', '../a.pdf', 'a/../b.pdf', './a.pdf', 'a\\b.pdf', 'C:/a.pdf', 'a.pdf:stream',
    'a.docx', 'a.pdf.exe', 'a//b.pdf', ' a.pdf', 'a /b.pdf', 'a./b.pdf', '.hidden.pdf', '~$lock.pdf',
    'a\u0000.pdf', 'a?.pdf', 'x'.repeat(600) + '.pdf', null, 1,
  ]) {
    assert.equal(isSafePortalRelPath(bad), false, String(bad));
  }
});

test('groupPortalDocs: 直下は方針、フォルダ名が分類、サブフォルダは表示名に前置、方針が先頭', () => {
  const t = '2026-11-21T00:00:00.000Z';
  const cats = groupPortalDocs([
    { rel: 'Devrelayマニュアル/b.pdf', size: 1, updatedAt: t },
    { rel: '44期.pdf', size: 2, updatedAt: t },
    { rel: 'Devrelayマニュアル/sub/a.pdf', size: 3, updatedAt: t },
    { rel: 'Aフォルダ/x.pdf', size: 4, updatedAt: t },
    { rel: '../evil.pdf', size: 5, updatedAt: t },
  ]);
  assert.deepEqual(cats.map((c) => c.name), [PORTAL_ROOT_CATEGORY, 'Aフォルダ', 'Devrelayマニュアル']);
  assert.equal(cats[0].root, true);
  assert.deepEqual(cats[0].docs.map((d) => d.title), ['44期']);
  assert.deepEqual(cats[2].docs.map((d) => d.title), ['b', 'sub / a']);
  assert.equal(cats[2].docs[1].path, 'Devrelayマニュアル/sub/a.pdf');
});

test('listPortalDocFiles / resolvePortalDocFile: PDF だけ列挙・news は除外・外には出られない', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-out-'));
  try {
    fs.writeFileSync(path.join(root, '方針A.pdf'), 'x');
    fs.writeFileSync(path.join(root, 'memo.docx'), 'x');
    fs.mkdirSync(path.join(root, 'マニュアル'));
    fs.writeFileSync(path.join(root, 'マニュアル', '使い方.pdf'), 'x');
    fs.mkdirSync(path.join(root, '規約'));
    fs.writeFileSync(path.join(root, '規約', '規約.docx'), 'x');
    fs.mkdirSync(path.join(root, 'news'));
    fs.writeFileSync(path.join(root, 'news', 'hidden.pdf'), 'x');
    fs.writeFileSync(path.join(outside, 'secret.pdf'), 'x');

    const files = (await listPortalDocFiles(root)).map((f) => f.rel).sort();
    assert.deepEqual(files, ['マニュアル/使い方.pdf', '方針A.pdf'].sort());
    const cats = await loadPortalDocs(root);
    assert.ok(!cats.some((c) => c.name === '規約'), 'PDF が無い分類は出さない');

    assert.ok(await resolvePortalDocFile(root, 'マニュアル/使い方.pdf'));
    assert.equal(await resolvePortalDocFile(root, 'memo.docx'), null);
    assert.equal(await resolvePortalDocFile(root, 'news/hidden.pdf'), null);
    assert.equal(await resolvePortalDocFile(root, `../${path.basename(outside)}/secret.pdf`), null);
    assert.equal(await resolvePortalDocFile(root, 'none.pdf'), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('normalizeNewsItems: 壊れた行を捨て、重複 id を除き、新しい順', () => {
  const items = normalizeNewsItems({
    items: [
      { id: 'a', date: '2026-11-20', category: 'update', title: 'A', body: 'x' },
      { id: 'b', date: '2026-11-21', category: 'weird', title: 'B', link: 'javascript:alert(1)' },
      { id: 'a', date: '2026-11-22', title: 'dup' },
      { date: 'bad', title: 'C' },
      { date: '2026-11-19' },
      'str',
    ],
  });
  assert.deepEqual(items.map((i) => i.id), ['b', 'a']);
  assert.equal(items[0].category, 'other');
  assert.equal(items[0].link, undefined);
  assert.deepEqual(normalizeNewsItems(null), []);
  assert.equal(normalizeNewsItems([{ date: '2026-11-01', title: 'T' }]).length, 1);
});

test('mergeNewsItems: 同じ id は既存を残し、上限で切る', () => {
  const e = [{ id: 'x', date: '2026-11-01', category: 'update', title: '手直し', body: '' }];
  const merged = mergeNewsItems(e, [
    { id: 'x', date: '2026-11-01', category: 'update', title: '自動', body: '' },
    { id: 'y', date: '2026-11-02', category: 'update', title: 'Y', body: '' },
  ], 10);
  assert.deepEqual(merged.map((i) => [i.id, i.title]), [['y', 'Y'], ['x', '手直し']]);
  assert.equal(mergeNewsItems([], Array.from({ length: 5 }, (_, i) => ({ id: `${i}`, date: '2026-11-01', category: 'update', title: 't', body: '' })), 3).length, 3);
});

test('parseGitLog: \\x1f / \\x1e 区切りを解釈', () => {
  const rec = (h, s, b = '') => `${h}\x1f${h.slice(0, 7)}\x1f2026-11-21T10:00:00+09:00\x1fme\x1f${s}\x1f${b}\x1e`;
  const out = parseGitLog(`${rec('a'.repeat(40), 'feat: X', 'body\nline')}\n${rec('b'.repeat(40), 'fix(web): Y')}\nzz`);
  assert.equal(out.length, 2);
  assert.equal(out[0].subject, 'feat: X');
  assert.equal(out[0].body, 'body\nline');
  assert.equal(out[1].short, 'bbbbbbb');
});

test('isNewsworthyCommit / cleanCommitSubject', () => {
  assert.equal(isNewsworthyCommit('feat(usage): 案件欄'), true);
  assert.equal(isNewsworthyCommit('fix: 何か'), true);
  assert.equal(isNewsworthyCommit('サイクルS2a: 新ゲート'), true);
  assert.equal(isNewsworthyCommit('docs: 文書'), false);
  assert.equal(isNewsworthyCommit('docs(db): 文書'), false);
  assert.equal(isNewsworthyCommit('test: x'), false);
  assert.equal(isNewsworthyCommit('chore: x'), false);
  assert.equal(cleanCommitSubject('feat(web): 画面を直す'), '画面を直す');
  assert.equal(cleanCommitSubject('fix!: 重大'), '重大');
  assert.equal(
    cleanCommitSubject('Merge origin/main (b57e78c) into main: 本家の 32 コミットを取り込み'),
    '本家の更新を取り込み: 本家の 32 コミットを取り込み',
  );
});

test('buildRuleBasedUpdateItem: 対象外を除き、上限行 + ほか N 件', () => {
  const c = (s) => ({ hash: 'a'.repeat(40), short: 'aaaaaaa', date: '', author: '', subject: s, body: '' });
  assert.equal(buildRuleBasedUpdateItem('2026-11-21', 'abc1234', [c('docs: x')]), null);
  const many = Array.from({ length: RULE_NEWS_MAX_LINES + 2 }, (_, i) => c(`feat: 機能${i}`));
  const item = buildRuleBasedUpdateItem('2026-11-21', 'abc1234', [...many, c('test: t')]);
  assert.equal(item.id, 'update-2026-11-21-abc1234');
  assert.equal(item.category, 'update');
  assert.match(item.title, /8 件/);
  assert.equal(item.body.split('\n').length, RULE_NEWS_MAX_LINES + 1);
  assert.match(item.body, /ほか 2 件$/);
});

test('parseAiNewsJson: 前後に余計な文字があっても JSON を拾う。欠けていれば null', () => {
  assert.deepEqual(parseAiNewsJson('```json\n{"title":"T","body":"・a"}\n```'), { title: 'T', body: '・a' });
  assert.equal(parseAiNewsJson('{"title":"T"}'), null);
  assert.equal(parseAiNewsJson('not json'), null);
  assert.equal(parseAiNewsJson('{broken'), null);
});

test('jstDateKey: UTC 15:00 以降は翌日', () => {
  assert.equal(jstDateKey(new Date('2026-11-20T14:59:00Z')), '2026-11-20');
  assert.equal(jstDateKey(new Date('2026-11-20T15:00:00Z')), '2026-11-21');
});

test('normalizeIssues / normalizeTodoText', () => {
  assert.deepEqual(normalizeIssues({ items: [{ title: 'A', owner: '村田', link: 'ftp://x' }, { owner: 'x' }] }), [{ title: 'A', owner: '村田' }]);
  assert.equal(normalizeTodoText('  買い物\nする '), '買い物 する');
  assert.equal(normalizeTodoText(''), null);
  assert.equal(normalizeTodoText('x'.repeat(201)), null);
  assert.equal(normalizeTodoText(3), null);
});
