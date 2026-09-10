import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildThreadCreateRequest,
  decideSendAction,
  decideProjectChange,
  resolveThreadProjectView,
  shouldShowApprovalCard,
  FORBIDDEN_LITE_BINDINGS,
  FORBIDDEN_LITE_MODULES,
  findForbiddenLiteImports,
  L2_FORBIDDEN_LITE_BINDINGS,
  L2_FORBIDDEN_LITE_MODULES,
  containsNamespaceImport,
  containsRawWebSocketConstruction,
  decideThreadRowAction,
  buildProjectSelectorOptions,
} from '../dist-test/components/lite/lite-shell-rules.js';
// F4 pin ブロック: このモジュールのソースは無変更。既存の fail-open ゲートが Lite の前提として
// 崩れていないことを固定する（D2: ソース変更ゼロ、cycle3 の実装を再利用する想定）。
import { shouldRouteToTab } from '../dist-test/lib/thread-routing-client.js';

describe('buildThreadCreateRequest（R8: tabId 必須の唯一の入口）', () => {
  test('projectId / tabId が両方あれば ThreadCreateRequest を返す', () => {
    const req = buildThreadCreateRequest({ projectId: 'p1', tabId: 't1' });
    assert.deepEqual(req, { projectId: 'p1', tabId: 't1', __liteThreadCreate: true });
  });

  test('projectId が空文字なら null', () => {
    assert.equal(buildThreadCreateRequest({ projectId: '', tabId: 't1' }), null);
  });

  test('tabId が空文字なら null（R8 の実行時ガード）', () => {
    assert.equal(buildThreadCreateRequest({ projectId: 'p1', tabId: '' }), null);
  });
});

describe('decideSendAction（F1 の 3 ケース）', () => {
  const base = {
    selectedProjectId: 'p1',
    tabId: 't1',
    machineOnline: true,
    connected: true,
    hasText: true,
    hasFiles: false,
    inFlight: false,
  };

  test('F1 ケース1: スレッド未選択なら必ず create-then-send', () => {
    const action = decideSendAction({ ...base, selectedSessionId: null, selectedThreadProjectId: null });
    assert.equal(action.kind, 'create-then-send');
    assert.deepEqual(action.request, { projectId: 'p1', tabId: 't1', __liteThreadCreate: true });
    assert.equal(action.sendProjectIdHint, 'p1');
  });

  test('F1 ケース2: スレッド選択中でも送信先プロジェクトが異なれば create-then-send（既存スレッドへの合流を禁止）', () => {
    const action = decideSendAction({
      ...base,
      selectedSessionId: 'sess-1',
      selectedThreadProjectId: 'p-other',
    });
    assert.equal(action.kind, 'create-then-send');
    assert.equal(action.request.projectId, 'p1');
    assert.equal(action.sendProjectIdHint, 'p1');
  });

  test('F1 ケース3: スレッド選択中で送信先プロジェクトが同一なら send-existing', () => {
    const action = decideSendAction({
      ...base,
      selectedSessionId: 'sess-1',
      selectedThreadProjectId: 'p1',
    });
    assert.deepEqual(action, { kind: 'send-existing', sessionId: 'sess-1', sendProjectIdHint: 'p1' });
  });
});

describe('decideSendAction（blocked の優先順位）', () => {
  const full = {
    selectedSessionId: 'sess-1',
    selectedThreadProjectId: 'p1',
    selectedProjectId: 'p1',
    tabId: 't1',
    machineOnline: true,
    connected: true,
    hasText: true,
    hasFiles: false,
    inFlight: false,
  };

  test('no-project: selectedProjectId が無い', () => {
    assert.deepEqual(decideSendAction({ ...full, selectedProjectId: null }), { kind: 'blocked', reason: 'no-project' });
  });

  test('no-tab-id: tabId が無い', () => {
    assert.deepEqual(decideSendAction({ ...full, tabId: null }), { kind: 'blocked', reason: 'no-tab-id' });
  });

  test('offline: machineOnline が false', () => {
    assert.deepEqual(decideSendAction({ ...full, machineOnline: false }), { kind: 'blocked', reason: 'offline' });
  });

  test('disconnected: connected が false', () => {
    assert.deepEqual(decideSendAction({ ...full, connected: false }), { kind: 'blocked', reason: 'disconnected' });
  });

  test('in-flight: inFlight が true', () => {
    assert.deepEqual(decideSendAction({ ...full, inFlight: true }), { kind: 'blocked', reason: 'in-flight' });
  });

  test('empty: テキストも添付も無い', () => {
    assert.deepEqual(decideSendAction({ ...full, hasText: false, hasFiles: false }), { kind: 'blocked', reason: 'empty' });
  });

  test('hasFiles だけあれば empty にならない', () => {
    const action = decideSendAction({ ...full, hasText: false, hasFiles: true });
    assert.notEqual(action.kind, 'blocked');
  });

  test('優先順位: no-project と no-tab-id が同時に成立すれば no-project が勝つ', () => {
    assert.deepEqual(
      decideSendAction({ ...full, selectedProjectId: null, tabId: null }),
      { kind: 'blocked', reason: 'no-project' }
    );
  });

  test('優先順位: offline と disconnected が同時に成立すれば offline が勝つ', () => {
    assert.deepEqual(
      decideSendAction({ ...full, machineOnline: false, connected: false }),
      { kind: 'blocked', reason: 'offline' }
    );
  });

  test('優先順位: in-flight と empty が同時に成立すれば in-flight が勝つ（送信直後に入力欄が空になる想定）', () => {
    assert.deepEqual(
      decideSendAction({ ...full, inFlight: true, hasText: false, hasFiles: false }),
      { kind: 'blocked', reason: 'in-flight' }
    );
  });

  test('優先順位: disconnected と in-flight が同時に成立すれば disconnected が勝つ（環境障害を先に見せる）', () => {
    assert.deepEqual(
      decideSendAction({ ...full, connected: false, inFlight: true }),
      { kind: 'blocked', reason: 'disconnected' }
    );
  });
});

describe('decideSendAction（R3: sendProjectIdHint は常に送信先と一致）', () => {
  test('create-then-send のとき sendProjectIdHint === request.projectId', () => {
    const action = decideSendAction({
      selectedSessionId: null,
      selectedThreadProjectId: null,
      selectedProjectId: 'p9',
      tabId: 't1',
      machineOnline: true,
      connected: true,
      hasText: true,
      hasFiles: false,
      inFlight: false,
    });
    assert.equal(action.kind, 'create-then-send');
    assert.equal(action.sendProjectIdHint, action.request.projectId);
  });

  test('send-existing のとき sendProjectIdHint === selectedProjectId', () => {
    const action = decideSendAction({
      selectedSessionId: 'sess-1',
      selectedThreadProjectId: 'p9',
      selectedProjectId: 'p9',
      tabId: 't1',
      machineOnline: true,
      connected: true,
      hasText: true,
      hasFiles: false,
      inFlight: false,
    });
    assert.equal(action.kind, 'send-existing');
    assert.equal(action.sendProjectIdHint, 'p9');
  });
});

describe('decideProjectChange（D4: 作成は絶対に返さない）', () => {
  test('新しいプロジェクトを選べば select-only', () => {
    assert.deepEqual(
      decideProjectChange({ currentProjectId: 'p1', nextProjectId: 'p2' }),
      { kind: 'select-only', projectId: 'p2' }
    );
  });

  test('同じプロジェクトを選べば noop（same-project）', () => {
    assert.deepEqual(
      decideProjectChange({ currentProjectId: 'p1', nextProjectId: 'p1' }),
      { kind: 'noop', reason: 'same-project' }
    );
  });

  test('nextProjectId が無ければ noop（no-project）', () => {
    assert.deepEqual(
      decideProjectChange({ currentProjectId: 'p1', nextProjectId: null }),
      { kind: 'noop', reason: 'no-project' }
    );
  });

  test('currentProjectId が未選択（null）でも nextProjectId があれば select-only', () => {
    assert.deepEqual(
      decideProjectChange({ currentProjectId: null, nextProjectId: 'p2' }),
      { kind: 'select-only', projectId: 'p2' }
    );
  });

  test('戻り値の kind に create 系の値が現れない（回帰固定）', () => {
    const results = [
      decideProjectChange({ currentProjectId: 'p1', nextProjectId: 'p2' }),
      decideProjectChange({ currentProjectId: 'p1', nextProjectId: 'p1' }),
      decideProjectChange({ currentProjectId: 'p1', nextProjectId: null }),
      decideProjectChange({ currentProjectId: null, nextProjectId: null }),
    ];
    for (const r of results) {
      assert.notEqual(r.kind, 'create-new-thread');
      assert.ok(r.kind === 'select-only' || r.kind === 'noop');
    }
  });
});

describe('resolveThreadProjectView（F2/F3 吸収層: displayName ?? name、トリムしない）', () => {
  const projects = new Map([
    ['p1', { id: 'p1', name: 'raw-name', displayName: 'Pretty Name', machine: { name: 'raw-machine', displayName: 'Pretty Machine', online: true } }],
    ['p2', { id: 'p2', name: 'raw-name-2', displayName: null, machine: { name: 'raw-machine-2', displayName: null, online: false } }],
    ['p3', { id: 'p3', name: 'raw-name-3', displayName: '', machine: null }],
  ]);

  test('displayName があれば displayName を使う', () => {
    const view = resolveThreadProjectView({ projectId: 'p1', projects });
    assert.deepEqual(view, { projectId: 'p1', projectLabel: 'Pretty Name', machineLabel: 'Pretty Machine', online: true });
  });

  test('displayName が null なら name にフォールバック', () => {
    const view = resolveThreadProjectView({ projectId: 'p2', projects });
    assert.equal(view.projectLabel, 'raw-name-2');
    assert.equal(view.machineLabel, 'raw-machine-2');
    assert.equal(view.online, false);
  });

  test('displayName が空文字ならそのまま空文字を使う（トリムしない・?? の意味論を固定）', () => {
    const view = resolveThreadProjectView({ projectId: 'p3', projects });
    assert.equal(view.projectLabel, '');
  });

  test('machine が無ければ machineLabel は空文字・online は false', () => {
    const view = resolveThreadProjectView({ projectId: 'p3', projects });
    assert.equal(view.machineLabel, '');
    assert.equal(view.online, false);
  });

  test('projects に該当が無ければ fallbackProjectName を使う（F2: 作成直後は machine 情報が無い）', () => {
    const view = resolveThreadProjectView({ projectId: 'unknown', projects, fallbackProjectName: 'Fallback Name' });
    assert.deepEqual(view, { projectId: 'unknown', projectLabel: 'Fallback Name', machineLabel: '', online: false });
  });

  test('projects に該当が無く fallbackProjectName も無ければ空文字', () => {
    const view = resolveThreadProjectView({ projectId: 'unknown', projects });
    assert.equal(view.projectLabel, '');
  });

  test('projectId が undefined なら projectId は空文字扱い', () => {
    const view = resolveThreadProjectView({ projectId: undefined, projects });
    assert.equal(view.projectId, '');
  });
});

describe('shouldShowApprovalCard（R5: fail-open 原則の唯一の例外・fail-closed）', () => {
  test('viewSessionId が null なら常に false（未選択スレッドへの誤表示防止）', () => {
    assert.equal(shouldShowApprovalCard({ viewSessionId: null, payloadSessionId: 'sess-1' }), false);
  });

  test('viewSessionId が undefined でも false', () => {
    assert.equal(shouldShowApprovalCard({ viewSessionId: undefined, payloadSessionId: 'sess-1' }), false);
  });

  test('viewSessionId があり payloadSessionId が無ければ true（後方互換 payload）', () => {
    assert.equal(shouldShowApprovalCard({ viewSessionId: 'sess-1', payloadSessionId: null }), true);
  });

  test('両方あって一致すれば true', () => {
    assert.equal(shouldShowApprovalCard({ viewSessionId: 'sess-1', payloadSessionId: 'sess-1' }), true);
  });

  test('両方あって不一致なら false（R5 の核心: 別スレッドの承認カードを誤表示しない）', () => {
    assert.equal(shouldShowApprovalCard({ viewSessionId: 'sess-1', payloadSessionId: 'sess-2' }), false);
  });
});

describe('findForbiddenLiteImports（F5 トリップワイヤ）', () => {
  test('Layout の import を検出する', () => {
    const hits = findForbiddenLiteImports(`import { Layout } from '../components/Layout';`);
    assert.ok(hits.includes('Layout'));
  });

  test('useOrganization の import を検出する', () => {
    const hits = findForbiddenLiteImports(`import { useOrganization } from '../contexts/OrganizationContext';`);
    assert.ok(hits.includes('useOrganization'));
  });

  test('複数行 import ブロックでも検出する', () => {
    const src = `import {\n  useState,\n  useEffect,\n} from 'react';\nimport {\n  Layout,\n} from '../components/Layout';\n`;
    const hits = findForbiddenLiteImports(src);
    assert.ok(hits.includes('Layout'));
  });

  test('as 別名の前の名前で判定する（R8 と同じ流儀）', () => {
    const hits = findForbiddenLiteImports(`import { Layout as L } from '../components/Layout';`);
    assert.ok(hits.includes('Layout'));
  });

  test('許可された import（threads/projects/sessions 等）は検出しない', () => {
    const hits = findForbiddenLiteImports(`import { threads as threadsApi, projects, sessions } from '../lib/api';`);
    assert.deepEqual(hits.filter((h) => h === 'threads' || h === 'threadsApi'), []);
  });

  test('禁止モジュールパスも検出する（バインディング名が異なっていても）', () => {
    const hits = findForbiddenLiteImports(`import { OrgContext as Foo } from '../contexts/OrganizationContext';`);
    assert.ok(hits.some((h) => h.includes('contexts/OrganizationContext')));
  });

  test('既知の限界: namespace import (import * as X) は検出できない', () => {
    const hits = findForbiddenLiteImports(`import * as Layout from '../components/Layout';`);
    assert.deepEqual(hits, []);
  });

  test('import が無いソースは空配列', () => {
    assert.deepEqual(findForbiddenLiteImports('const x = 1;'), []);
  });
});

describe('FORBIDDEN_LITE_BINDINGS / FORBIDDEN_LITE_MODULES（定数の内容固定）', () => {
  test('useOrganization / OrganizationProvider / Layout を含む', () => {
    assert.ok(FORBIDDEN_LITE_BINDINGS.includes('useOrganization'));
    assert.ok(FORBIDDEN_LITE_BINDINGS.includes('OrganizationProvider'));
    assert.ok(FORBIDDEN_LITE_BINDINGS.includes('Layout'));
  });

  test('contexts/OrganizationContext / components/Layout を含む', () => {
    assert.ok(FORBIDDEN_LITE_MODULES.includes('contexts/OrganizationContext'));
    assert.ok(FORBIDDEN_LITE_MODULES.includes('components/Layout'));
  });
});

describe('F4 pin: shouldRouteToTab の fail-open 前提（ソース変更ゼロ、D2）', () => {
  test('sessionId 無し payload は accept（再接続時の進捗復元・//connect 応答等が消えないことを Lite の前提として固定）', () => {
    const result = shouldRouteToTab({ payloadSessionId: undefined, tabSessionId: 'tab-1' });
    assert.equal(result.route, 'accept');
  });

  test('両方あって不一致なら drop（Lite でも背景スレッドの出力が混入しない）', () => {
    const result = shouldRouteToTab({ payloadSessionId: 'sess-1', tabSessionId: 'sess-2' });
    assert.equal(result.route, 'drop');
  });
});

// ---------------------------------------------------------------------------
// L2: /lite ルーティング・行選択・プロジェクトセレクタの純ロジック
// ---------------------------------------------------------------------------

describe('decideThreadRowAction（B1: readOnly のとき絶対に server-switch を返さない）', () => {
  test('readOnly=true・未選択・非switching中 → local-select', () => {
    const action = decideThreadRowAction({ sessionId: 's1', currentSessionId: null, readOnly: true, switching: false });
    assert.deepEqual(action, { kind: 'local-select', sessionId: 's1' });
  });

  test('readOnly=false・未選択・非switching中 → server-switch（従来 UI の非退行を固定）', () => {
    const action = decideThreadRowAction({ sessionId: 's1', currentSessionId: null, readOnly: false, switching: false });
    assert.deepEqual(action, { kind: 'server-switch', sessionId: 's1' });
  });

  test('既に current なら readOnly の値によらず noop（already-current）', () => {
    for (const readOnly of [true, false]) {
      const action = decideThreadRowAction({ sessionId: 's1', currentSessionId: 's1', readOnly, switching: false });
      assert.deepEqual(action, { kind: 'noop', reason: 'already-current' });
    }
  });

  test('switching 中なら readOnly の値によらず noop（switching）', () => {
    for (const readOnly of [true, false]) {
      const action = decideThreadRowAction({ sessionId: 's1', currentSessionId: 's2', readOnly, switching: true });
      assert.deepEqual(action, { kind: 'noop', reason: 'switching' });
    }
  });

  test('B1 の核心: readOnly=true のとき、あらゆる入力の組み合わせで server-switch を一度も返さない', () => {
    const sessionIds = ['s1', 's2', ''];
    const currentIds = [null, undefined, 's1', 's2', 'other'];
    const switchingVals = [true, false];
    for (const sessionId of sessionIds) {
      for (const currentSessionId of currentIds) {
        for (const switching of switchingVals) {
          const action = decideThreadRowAction({ sessionId, currentSessionId, readOnly: true, switching });
          assert.notEqual(action.kind, 'server-switch');
        }
      }
    }
  });
});

describe('buildProjectSelectorOptions（F2/F3: displayName ?? name を各行に適用）', () => {
  test('displayName があれば displayName、無ければ name にフォールバック', () => {
    const options = buildProjectSelectorOptions([
      { id: 'p1', name: 'raw-1', displayName: 'Pretty 1', machine: { name: 'm1', displayName: 'Machine 1', online: true } },
      { id: 'p2', name: 'raw-2', displayName: null, machine: { name: 'm2', displayName: null, online: false } },
    ]);
    assert.deepEqual(options, [
      { projectId: 'p1', label: 'Pretty 1', machineLabel: 'Machine 1', online: true },
      { projectId: 'p2', label: 'raw-2', machineLabel: 'm2', online: false },
    ]);
  });

  test('machine が無ければ machineLabel は空文字・online は false', () => {
    const options = buildProjectSelectorOptions([{ id: 'p1', name: 'raw-1' }]);
    assert.deepEqual(options, [{ projectId: 'p1', label: 'raw-1', machineLabel: '', online: false }]);
  });

  test('空配列を渡せば空配列を返す', () => {
    assert.deepEqual(buildProjectSelectorOptions([]), []);
  });

  test('API の返す並び順をそのまま保持する（ソートしない）', () => {
    const options = buildProjectSelectorOptions([
      { id: 'z', name: 'z-proj' },
      { id: 'a', name: 'a-proj' },
    ]);
    assert.deepEqual(options.map((o) => o.projectId), ['z', 'a']);
  });

  test('オフライン機は online: false を返す（セレクタ側でバッジ表示に使う）', () => {
    const options = buildProjectSelectorOptions([
      { id: 'p1', name: 'raw-1', machine: { name: 'm1', online: false } },
    ]);
    assert.equal(options[0].online, false);
  });
});

describe('containsNamespaceImport（findForbiddenLiteImports の既知の限界を塞ぐ）', () => {
  test('namespace import を検出する', () => {
    assert.equal(containsNamespaceImport(`import * as Layout from '../components/Layout';`), true);
  });

  test('通常の named import では false', () => {
    assert.equal(containsNamespaceImport(`import { Layout } from '../components/Layout';`), false);
  });

  test('import が無ければ false', () => {
    assert.equal(containsNamespaceImport('const x = 1;'), false);
  });
});

describe('containsRawWebSocketConstruction（LitePage が WS を生成しないことの検出用）', () => {
  test('new WebSocket(...) を検出する', () => {
    assert.equal(containsRawWebSocketConstruction(`const ws = new WebSocket('wss://example');`), true);
  });

  test('WebSocket という文字列が単に import/コメントに現れるだけでは検出しない', () => {
    assert.equal(containsRawWebSocketConstruction(`// WebSocket is used elsewhere`), false);
  });

  test('new を伴わなければ false', () => {
    assert.equal(containsRawWebSocketConstruction(`function WebSocket() {}`), false);
  });
});

describe('findForbiddenLiteImports（L2: 禁止リストを optional 引数で切り替え可能にする一般化）', () => {
  test('引数省略時は従来どおり恒久リスト（Layout/useOrganization）で判定する（既存呼び出し元の非退行）', () => {
    const hits = findForbiddenLiteImports(`import { Layout } from '../components/Layout';`);
    assert.ok(hits.includes('Layout'));
  });

  test('L2_FORBIDDEN_LITE_BINDINGS を明示的に渡すと useWebSocket の import を検出する', () => {
    const hits = findForbiddenLiteImports(
      `import { useWebSocket } from '../hooks/useWebSocket';`,
      L2_FORBIDDEN_LITE_BINDINGS,
      L2_FORBIDDEN_LITE_MODULES
    );
    assert.ok(hits.includes('useWebSocket'));
    assert.ok(hits.some((h) => h.includes('hooks/useWebSocket')));
  });

  test('恒久リストで判定するときは useWebSocket を検出しない（リストの独立性を固定）', () => {
    const hits = findForbiddenLiteImports(`import { useWebSocket } from '../hooks/useWebSocket';`);
    assert.deepEqual(hits, []);
  });
});

describe('L2_FORBIDDEN_LITE_BINDINGS / L2_FORBIDDEN_LITE_MODULES（定数の内容固定）', () => {
  test('useWebSocket / hooks/useWebSocket を含む', () => {
    assert.ok(L2_FORBIDDEN_LITE_BINDINGS.includes('useWebSocket'));
    assert.ok(L2_FORBIDDEN_LITE_MODULES.includes('hooks/useWebSocket'));
  });
});
