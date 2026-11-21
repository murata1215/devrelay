// Backlog 連携（2026-11-21）: services/backlog-rules.ts の単体テスト（dist を直接 import）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isBacklogEnabled,
  isBacklogIssueKey,
  projectKeyOfIssue,
  normalizeBacklogSpace,
  guessPhaseMap,
  resolveTargetStatus,
  sanitizeProjectsSetting,
  parseProjectsSetting,
  parseConnections,
  serializeConnections,
  legacyToConnections,
  nextConnectionId,
  pickConnectionForProject,
  toConnectionView,
  isPlausibleBacklogApiKey,
  parseAssigneeScope,
  assigneeScopeLabel,
  filterByAssignee,
} from '../dist/services/backlog-rules.js';

const st = (id, name, displayOrder) => ({ id, name, color: '#888888', displayOrder });

// 画像1（LAFIT）: 7 状態
const LAFIT = [
  st(1, '未対応', 1), st(2, '処理中', 2), st(101, '結合テスト', 3), st(102, '検証依頼中', 4),
  st(103, 'リリース待ち', 5), st(3, '処理済み', 6), st(4, '完了', 7),
];
// 画像3（TISA 標準）: 4 状態
const STD = [st(1, '未対応', 1), st(2, '処理中', 2), st(3, '処理済み', 3), st(4, '完了', 4)];

test('キルスイッチ: 0 のときだけ無効', () => {
  assert.equal(isBacklogEnabled(undefined), true);
  assert.equal(isBacklogEnabled('1'), true);
  assert.equal(isBacklogEnabled('0'), false);
});

test('課題キーの判定とプロジェクトキー', () => {
  assert.equal(isBacklogIssueKey('ATG_39_P_0002-1167'), true);
  assert.equal(isBacklogIssueKey('ABC-1'), true);
  assert.equal(isBacklogIssueKey('Devrelay基盤'), false);
  assert.equal(isBacklogIssueKey('abc-1'), false);
  assert.equal(isBacklogIssueKey('ABC-'), false);
  assert.equal(isBacklogIssueKey(null), false);
  assert.equal(projectKeyOfIssue('ATG_39_P_0002-1167'), 'ATG_39_P_0002');
});

test('スペース URL の正規化と許可ドメイン', () => {
  assert.equal(normalizeBacklogSpace('https://foo.backlog.jp/'), 'foo.backlog.jp');
  assert.equal(normalizeBacklogSpace('FOO.backlog.com/projects/ABC'), 'foo.backlog.com');
  assert.equal(normalizeBacklogSpace('foo.backlogtool.com'), 'foo.backlogtool.com');
  assert.equal(normalizeBacklogSpace('evil.example.com'), null);
  assert.equal(normalizeBacklogSpace('foo.backlog.jp.evil.com'), null);
  assert.equal(normalizeBacklogSpace(''), null);
  assert.equal(normalizeBacklogSpace(123), null);
});

test('段階の推測: LAFIT は 処理中 / 結合テスト / リリース待ち', () => {
  assert.deepEqual(guessPhaseMap(LAFIT), { start: 2, test: 101, done: 103 });
});

test('段階の推測: 標準 4 状態は 処理中 / なし / 処理済み', () => {
  assert.deepEqual(guessPhaseMap(STD), { start: 2, test: null, done: 3 });
});

test('段階の推測: テスト中 という名前も拾う', () => {
  const s = [st(1, '未対応', 1), st(2, '処理中', 2), st(9, 'テスト中', 3), st(3, '処理済み', 4), st(4, '完了', 5)];
  assert.deepEqual(guessPhaseMap(s), { start: 2, test: 9, done: 3 });
});

test('変更先の解決: 段階名・状態名・対応表の「なし」', () => {
  const r1 = resolveTargetStatus('done', LAFIT, null);
  assert.ok(r1.ok && r1.status.name === 'リリース待ち' && r1.phase === 'done');
  const r2 = resolveTargetStatus('検証依頼中', LAFIT, null);
  assert.ok(r2.ok && r2.status.id === 102 && r2.phase === null);
  const r3 = resolveTargetStatus('test', STD, null);
  assert.equal(r3.ok, false);
  // 設定画面で test を「なし」にしたら、推測で埋め戻さない
  const r4 = resolveTargetStatus('test', LAFIT, { start: 2, test: null, done: 103 });
  assert.equal(r4.ok, false);
  const r5 = resolveTargetStatus('存在しない', LAFIT, null);
  assert.equal(r5.ok, false);
});

test('設定 JSON の検証', () => {
  const v = sanitizeProjectsSetting({
    projects: [
      { projectId: 10, projectKey: 'ABC', name: 'A', map: { start: 2, test: 'x', done: 3 } },
      { projectId: 11, projectKey: 'abc', name: 'bad key' },
      { projectId: 0, projectKey: 'DEF' },
      { projectId: 12, projectKey: 'ABC', name: 'dup' },
    ],
  });
  assert.deepEqual(v, { projects: [{ projectId: 10, projectKey: 'ABC', name: 'A', map: { start: 2, test: null, done: 3 } }] });
  assert.equal(sanitizeProjectsSetting(null), null);
  assert.deepEqual(parseProjectsSetting('{broken'), { projects: [] });
  assert.deepEqual(parseProjectsSetting(null), { projects: [] });
});

// ---- 複数接続（1 人で複数の Backlog スペース） ----
const KEY = 'a'.repeat(64);
const proj = (projectKey, projectId = 1) => ({ projectId, projectKey, name: projectKey, map: { start: 2, test: null, done: 3 } });

test('旧形式（1 人 1 件）は接続 1 件として読める。スペースは本人 → 組織既定', () => {
  const projectsRaw = JSON.stringify({ projects: [proj('ATG_39_P_0002')] });
  const a = legacyToConnections({ space: null, envSpace: 'https://tisahansys.backlog.com', apiKey: KEY, projectsRaw });
  assert.equal(a.length, 1);
  assert.equal(a[0].id, 'c1');
  assert.equal(a[0].space, 'tisahansys.backlog.com');
  assert.equal(a[0].projects[0].projectKey, 'ATG_39_P_0002');
  const b = legacyToConnections({ space: 'own.backlog.jp', envSpace: 'tisahansys.backlog.com', apiKey: KEY, projectsRaw: null });
  assert.equal(b[0].space, 'own.backlog.jp');
  assert.deepEqual(legacyToConnections({ space: null, envSpace: null, apiKey: KEY, projectsRaw: null }), []);
  assert.deepEqual(legacyToConnections({ space: 'a.backlog.jp', envSpace: null, apiKey: null, projectsRaw: null }), []);
});

test('接続一覧の保存形式は往復でき、壊れた要素・許可外ドメイン・重複 ID は捨てる', () => {
  const list = [
    { id: 'c1', space: 'tisahansys.backlog.com', apiKey: KEY, projects: [proj('ATG_39_P_0002')] },
    { id: 'c2', space: 'cust.backlog.jp', apiKey: KEY, projects: [proj('ABC', 9)] },
  ];
  assert.deepEqual(parseConnections(serializeConnections(list)), list);
  const dirty = JSON.stringify({ connections: [list[0], { ...list[1], id: 'c1' }, { id: 'c3', space: 'evil.example.com', apiKey: KEY, projects: [] }, null, { id: 'BAD!', space: 'x.backlog.jp' }] });
  assert.deepEqual(parseConnections(dirty).map((c) => c.id), ['c1']);
  assert.deepEqual(parseConnections('{broken'), []);
  assert.deepEqual(parseConnections(null), []);
});

test('API キーは画面向けの形に含めない', () => {
  const v = toConnectionView({ id: 'c1', space: 'a.backlog.jp', apiKey: KEY, projects: [] });
  assert.deepEqual(v, { id: 'c1', space: 'a.backlog.jp', hasKey: true, projects: [] });
  assert.equal(JSON.stringify(v).includes(KEY), false);
});

test('課題キーのプロジェクトキーから接続を決める（0 件・1 件・あいまい）', () => {
  const list = [
    { id: 'c1', space: 'tisahansys.backlog.com', apiKey: KEY, projects: [proj('ATG_39_P_0002'), proj('DUP', 5)] },
    { id: 'c2', space: 'cust.backlog.jp', apiKey: KEY, projects: [proj('ABC', 9), proj('DUP', 6)] },
    { id: 'c3', space: 'nokey.backlog.jp', apiKey: '', projects: [proj('NOKEY')] },
  ];
  const r1 = pickConnectionForProject(list, 'ABC');
  assert.ok(r1.ok && r1.conn.id === 'c2');
  const r2 = pickConnectionForProject(list, 'ATG_39_P_0002');
  assert.ok(r2.ok && r2.conn.id === 'c1');
  const r3 = pickConnectionForProject(list, 'DUP');
  assert.ok(!r3.ok && r3.reason === 'ambiguous' && r3.spaces.length === 2);
  const r4 = pickConnectionForProject(list, 'NONE');
  assert.ok(!r4.ok && r4.reason === 'none');
  // キーが無い接続は対象外
  const r5 = pickConnectionForProject(list, 'NOKEY');
  assert.ok(!r5.ok && r5.reason === 'none');
});

test('接続 ID の採番と API キー形式', () => {
  assert.equal(nextConnectionId([]), 'c1');
  assert.equal(nextConnectionId([{ id: 'c1' }, { id: 'c3' }]), 'c2');
  assert.equal(isPlausibleBacklogApiKey(KEY), true);
  assert.equal(isPlausibleBacklogApiKey('short'), false);
  assert.equal(isPlausibleBacklogApiKey('has space '.repeat(5)), false);
});

// ---- 担当者の絞り込み（初期表示 = 自分＋担当なし） ----
test('担当者の絞り込み: 自分＋担当なし / 自分のみ / 担当なしのみ / 全員', () => {
  const ME = 10;
  const list = [
    { key: 'mine', assigneeId: ME },
    { key: 'none', assigneeId: null },
    { key: 'other', assigneeId: 99 },
  ];
  const keys = (scope) => filterByAssignee(list, scope, ME).map((i) => i.key);
  assert.deepEqual(keys('mine_unassigned'), ['mine', 'none']);
  assert.deepEqual(keys('mine'), ['mine']);
  assert.deepEqual(keys('unassigned'), ['none']);
  assert.deepEqual(keys('everyone'), ['mine', 'none', 'other']);
  // 自分の ID が分からないときは「自分」に当てない
  assert.deepEqual(filterByAssignee(list, 'mine_unassigned', null).map((i) => i.key), ['none']);
});

test('担当者指定の読み取り: 未指定は自分＋担当なし、旧 everyone=1 は全員、不正値は既定', () => {
  assert.equal(parseAssigneeScope(undefined), 'mine_unassigned');
  assert.equal(parseAssigneeScope('unassigned'), 'unassigned');
  assert.equal(parseAssigneeScope(undefined, true), 'everyone');
  assert.equal(parseAssigneeScope('bogus'), 'mine_unassigned');
  assert.equal(assigneeScopeLabel('mine_unassigned'), '自分＋担当なし');
});
