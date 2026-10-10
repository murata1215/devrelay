import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldRouteToTab,
  resolveHistorySource,
  decideInboundDisplay,
  resolveOlderMessagesSource,
  pickOlderCursorId,
  isSameHistorySource,
} from '../dist-test/lib/thread-routing-client.js';

describe('shouldRouteToTab（fail-open: 両方あって不一致のときだけ drop）', () => {
  test('payload に sessionId が無ければ accept（//connect応答・web:user_message・旧server dist）', () => {
    const result = shouldRouteToTab({ payloadSessionId: undefined, tabSessionId: 'tab-1' });
    assert.deepEqual(result, { route: 'accept', reason: 'no-payload-session' });
  });

  test('payload の sessionId が null でも accept', () => {
    const result = shouldRouteToTab({ payloadSessionId: null, tabSessionId: 'tab-1' });
    assert.equal(result.route, 'accept');
  });

  test('tab 側の sessionId が未確定（session_info 受信前）なら accept', () => {
    const result = shouldRouteToTab({ payloadSessionId: 'sess-1', tabSessionId: null });
    assert.deepEqual(result, { route: 'accept', reason: 'tab-session-unknown' });
  });

  test('両方あって一致すれば accept', () => {
    const result = shouldRouteToTab({ payloadSessionId: 'sess-1', tabSessionId: 'sess-1' });
    assert.deepEqual(result, { route: 'accept', reason: 'match' });
  });

  test('両方あって不一致なら drop（背景スレッドの出力が現在スレッドに混入しない）', () => {
    const result = shouldRouteToTab({ payloadSessionId: 'sess-1', tabSessionId: 'sess-2' });
    assert.deepEqual(result, { route: 'drop', reason: 'session-mismatch' });
  });

  test('両方 undefined でも accept（安全側のデフォルト）', () => {
    const result = shouldRouteToTab({});
    assert.equal(result.route, 'accept');
  });
});

describe('resolveHistorySource（後方互換フォールバック）', () => {
  test('sessionId があればスレッド単位の履歴取得先', () => {
    const result = resolveHistorySource({ sessionId: 'sess-1', projectId: 'proj-1' });
    assert.deepEqual(result, { kind: 'session', id: 'sess-1' });
  });

  test('sessionId が無ければプロジェクト横断の履歴取得先にフォールバック', () => {
    const result = resolveHistorySource({ sessionId: null, projectId: 'proj-1' });
    assert.deepEqual(result, { kind: 'project', id: 'proj-1' });
  });

  test('sessionId が undefined でも同様にフォールバック', () => {
    const result = resolveHistorySource({ projectId: 'proj-1' });
    assert.deepEqual(result, { kind: 'project', id: 'proj-1' });
  });

  test('sessionId が空文字ならフォールバック（falsy値の扱いを固定）', () => {
    const result = resolveHistorySource({ sessionId: '', projectId: 'proj-1' });
    assert.deepEqual(result, { kind: 'project', id: 'proj-1' });
  });
});

describe('decideInboundDisplay（session ゲート優先 + 判定不能時のみ projectId フォールバック）', () => {
  test('session 一致なら projectId が不一致でも表示（終端。projectId は見ない）', () => {
    const result = decideInboundDisplay({
      payloadSessionId: 'sess-1',
      tabSessionId: 'sess-1',
      payloadProjectId: 'proj-A',
      tabProjectId: 'proj-B',
    });
    assert.deepEqual(result, { display: true, reason: 'session-match' });
  });

  test('session 不一致は projectId が一致していても非表示（終端）', () => {
    const result = decideInboundDisplay({
      payloadSessionId: 'sess-1',
      tabSessionId: 'sess-2',
      payloadProjectId: 'proj-A',
      tabProjectId: 'proj-A',
    });
    assert.deepEqual(result, { display: false, reason: 'session-mismatch' });
  });

  test('session 判定不能（両方 sessionId 欠落）かつ projectId も両方欠落なら表示', () => {
    const result = decideInboundDisplay({});
    assert.deepEqual(result, { display: true, reason: 'project-fallback-accept' });
  });

  test('session 判定不能で projectId が片方だけ欠落なら表示（fail-open）', () => {
    const result = decideInboundDisplay({ payloadProjectId: 'proj-A' });
    assert.deepEqual(result, { display: true, reason: 'project-fallback-accept' });
  });

  test('session 判定不能（tab 側 sessionId 未確定）で projectId が両方あり一致なら表示', () => {
    const result = decideInboundDisplay({
      payloadSessionId: 'sess-1',
      tabSessionId: null,
      payloadProjectId: 'proj-A',
      tabProjectId: 'proj-A',
    });
    assert.deepEqual(result, { display: true, reason: 'project-fallback-accept' });
  });

  test('session 判定不能で projectId が両方あり不一致なら非表示', () => {
    const result = decideInboundDisplay({
      payloadSessionId: 'sess-1',
      tabSessionId: null,
      payloadProjectId: 'proj-A',
      tabProjectId: 'proj-B',
    });
    assert.deepEqual(result, { display: false, reason: 'project-mismatch' });
  });

  test('再接続時の progress 復元の再現: sessionId を持たず projectId のみで一致すれば表示', () => {
    // web.ts:86-89 の再接続 progress 復元は {output, elapsed, projectId} で sessionId が無い
    const result = decideInboundDisplay({
      payloadSessionId: undefined,
      tabSessionId: 'sess-1',
      payloadProjectId: 'proj-A',
      tabProjectId: 'proj-A',
    });
    assert.deepEqual(result, { display: true, reason: 'project-fallback-accept' });
  });

  test('再接続時の progress 復元の再現: projectId も不一致なら非表示', () => {
    const result = decideInboundDisplay({
      payloadSessionId: undefined,
      tabSessionId: 'sess-1',
      payloadProjectId: 'proj-A',
      tabProjectId: 'proj-other',
    });
    assert.deepEqual(result, { display: false, reason: 'project-mismatch' });
  });
});

describe('resolveOlderMessagesSource（スクロールバック時の取得元を loadHistory と揃える）', () => {
  test('historySessionId が string → スレッド単位（表示中の履歴と同じカーソル空間）', () => {
    const result = resolveOlderMessagesSource({
      historySessionId: 'sess-1',
      tabSessionId: 'sess-1',
      projectId: 'proj-1',
    });
    assert.deepEqual(result, { kind: 'session', id: 'sess-1' });
  });

  test('historySessionId が string → tabSessionId と異なっていても historySessionId を優先（表示中の履歴に合わせる）', () => {
    const result = resolveOlderMessagesSource({
      historySessionId: 'sess-1',
      tabSessionId: 'sess-2',
      projectId: 'proj-1',
    });
    assert.deepEqual(result, { kind: 'session', id: 'sess-1' });
  });

  test('historySessionId が null → loadHistory がプロジェクト横断で読んだので横断を継続', () => {
    const result = resolveOlderMessagesSource({
      historySessionId: null,
      tabSessionId: 'sess-1',
      projectId: 'proj-1',
    });
    assert.deepEqual(result, { kind: 'project', id: 'proj-1' });
  });

  test('historySessionId が undefined（loadHistory 未実行）→ tabSessionId にフォールバック', () => {
    const result = resolveOlderMessagesSource({
      historySessionId: undefined,
      tabSessionId: 'sess-1',
      projectId: 'proj-1',
    });
    assert.deepEqual(result, { kind: 'session', id: 'sess-1' });
  });

  test('historySessionId・tabSessionId 両方無し → プロジェクト横断にフォールバック', () => {
    const result = resolveOlderMessagesSource({ projectId: 'proj-1' });
    assert.deepEqual(result, { kind: 'project', id: 'proj-1' });
  });
});

describe('pickOlderCursorId（before カーソルに使える DB 由来 ID を選ぶ）', () => {
  test('先頭が DB ID ならそれを返す', () => {
    const result = pickOlderCursorId([{ id: 'db-id-1' }, { id: 'msg_123_1' }]);
    assert.equal(result, 'db-id-1');
  });

  test('先頭がクライアント生成 ID（msg_ プレフィックス）なら次の DB ID まで走査する', () => {
    const result = pickOlderCursorId([{ id: 'msg_123_1' }, { id: 'db-id-2' }]);
    assert.equal(result, 'db-id-2');
  });

  test('全部クライアント生成 ID なら null（カーソル無効）', () => {
    const result = pickOlderCursorId([{ id: 'msg_123_1' }, { id: 'msg_124_2' }]);
    assert.equal(result, null);
  });

  test('空配列なら null', () => {
    const result = pickOlderCursorId([]);
    assert.equal(result, null);
  });
});

describe('isSameHistorySource（レースガード用の同値判定）', () => {
  test('kind・id とも一致すれば true', () => {
    assert.equal(
      isSameHistorySource({ kind: 'session', id: 'sess-1' }, { kind: 'session', id: 'sess-1' }),
      true
    );
  });

  test('kind が違えば false（同じ id でも session と project は別物）', () => {
    assert.equal(
      isSameHistorySource({ kind: 'session', id: 'x' }, { kind: 'project', id: 'x' }),
      false
    );
  });

  test('id が違えば false', () => {
    assert.equal(
      isSameHistorySource({ kind: 'session', id: 'sess-1' }, { kind: 'session', id: 'sess-2' }),
      false
    );
  });
});
