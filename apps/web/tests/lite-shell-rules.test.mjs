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
  filterProjectsByLiveMachines,
  looksLikeDeletedMachineName,
  sortProjectSelectorOptions,
  resolveComposerPlaceholderReason,
  decideProjectSelectorUrl,
  shouldShowNewThreadNotice,
  decideThreadCreateButton,
  stripComments,
  resolveSendInFlight,
  resolveConfirmationOnProjectChange,
  decideThreadListRefresh,
  THREAD_REFRESH_MIN_INTERVAL_MS,
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

describe('filterProjectsByLiveMachines（L3 A2: 削除済みマシンのプロジェクトを除外する交差案）', () => {
  const proj = (id, machineId) => ({
    id,
    name: `proj-${id}`,
    machine: machineId ? { id: machineId, name: `m-${machineId}`, online: true } : null,
  });

  test('liveMachineIds が null（取得失敗・未取得）なら fail-open で入力をそのまま返す', () => {
    const projects = [proj('p1', 'm1'), proj('p2', 'm2')];
    const result = filterProjectsByLiveMachines(projects, null);
    assert.deepEqual(result, projects);
  });

  test('liveMachineIds が空の Set（正常取得・生存マシン 0 件）なら machine.id を持つ行を全除外する（fail-open にしない）', () => {
    const projects = [proj('p1', 'm1'), proj('p2', 'm2')];
    const result = filterProjectsByLiveMachines(projects, new Set());
    assert.deepEqual(result, []);
  });

  test('machine が不在の行は常に残す（fail-open。liveMachineIds が空でも）', () => {
    const projects = [proj('p1', undefined)];
    const result = filterProjectsByLiveMachines(projects, new Set());
    assert.deepEqual(result, projects);
  });

  test('machine.id が不在の行（machine はあるが id 無し）は常に残す', () => {
    const projects = [{ id: 'p1', name: 'proj-p1', machine: { name: 'm', online: true } }];
    const result = filterProjectsByLiveMachines(projects, new Set());
    assert.deepEqual(result, projects);
  });

  test('生存 id 集合に含まれる machine.id の行だけを残す（順序保存）', () => {
    const projects = [proj('p1', 'm1'), proj('p2', 'm2'), proj('p3', 'm1')];
    const result = filterProjectsByLiveMachines(projects, new Set(['m1']));
    assert.deepEqual(
      result.map((p) => p.id),
      ['p1', 'p3']
    );
  });

  test('入力配列を破壊しない（非破壊）', () => {
    const projects = [proj('p1', 'm1'), proj('p2', 'm2')];
    const before = [...projects];
    filterProjectsByLiveMachines(projects, new Set(['m1']));
    assert.deepEqual(projects, before);
  });
});

describe('looksLikeDeletedMachineName（診断専用。フィルタには使わない）', () => {
  test('`__deleted_<timestamp>` 形式に一致する', () => {
    assert.equal(looksLikeDeletedMachineName('my-machine__deleted_1234567890'), true);
  });

  test('通常の名前には一致しない', () => {
    assert.equal(looksLikeDeletedMachineName('my-machine'), false);
  });

  test('末尾以外に __deleted_ が含まれても数字で終わらなければ一致しない', () => {
    assert.equal(looksLikeDeletedMachineName('my-machine__deleted_abc'), false);
  });
});

// ---------------------------------------------------------------------------
// L4: sortProjectSelectorOptions / resolveComposerPlaceholderReason /
//     decideProjectSelectorUrl / shouldShowNewThreadNotice / decideThreadCreateButton / stripComments
// ---------------------------------------------------------------------------

describe('sortProjectSelectorOptions（A1: マシン名 → プロジェクト名の順でソート）', () => {
  const opt = (projectId, label, machineLabel, online = true) => ({ projectId, label, machineLabel, online });

  test('マシン名を優先してソートする', () => {
    const input = [
      opt('p1', 'proj-a', 'zzz-machine'),
      opt('p2', 'proj-b', 'aaa-machine'),
    ];
    const result = sortProjectSelectorOptions(input);
    assert.deepEqual(result.map((o) => o.projectId), ['p2', 'p1']);
  });

  test('同一マシン内はプロジェクト名でソートする', () => {
    const input = [
      opt('p1', 'zzz-proj', 'same-machine'),
      opt('p2', 'aaa-proj', 'same-machine'),
    ];
    const result = sortProjectSelectorOptions(input);
    assert.deepEqual(result.map((o) => o.projectId), ['p2', 'p1']);
  });

  test('オフラインも同じ並びに混ざる（online はソートキーに含めない）', () => {
    const input = [
      opt('p1', 'proj-a', 'aaa-machine', false),
      opt('p2', 'proj-b', 'bbb-machine', true),
    ];
    const result = sortProjectSelectorOptions(input);
    assert.deepEqual(result.map((o) => o.projectId), ['p1', 'p2']);
  });

  test('マシン名・プロジェクト名が同名なら projectId で決定的にソートする', () => {
    const input = [
      opt('z', 'same-proj', 'same-machine'),
      opt('a', 'same-proj', 'same-machine'),
    ];
    const result = sortProjectSelectorOptions(input);
    assert.deepEqual(result.map((o) => o.projectId), ['a', 'z']);
  });

  test('入力配列を破壊しない（非破壊）', () => {
    const input = [opt('p1', 'z', 'z'), opt('p2', 'a', 'a')];
    const before = [...input];
    sortProjectSelectorOptions(input);
    assert.deepEqual(input, before);
  });

  test('buildProjectSelectorOptions の並び順保持テストは影響を受けない（既存の非破壊性の確認）', () => {
    const options = buildProjectSelectorOptions([
      { id: 'z', name: 'z-proj' },
      { id: 'a', name: 'a-proj' },
    ]);
    assert.deepEqual(options.map((o) => o.projectId), ['z', 'a']);
    const sorted = sortProjectSelectorOptions(options);
    assert.deepEqual(sorted.map((o) => o.projectId), ['a', 'z']);
  });
});

describe('resolveComposerPlaceholderReason（A2: 入力不可の理由をプレースホルダ種別へ写す）', () => {
  test('disconnected → connecting', () => {
    assert.equal(resolveComposerPlaceholderReason('disconnected'), 'connecting');
  });

  test('offline（マシンオフライン） → machine-offline（人間の承認条件 4: connecting とは区別する）', () => {
    assert.equal(resolveComposerPlaceholderReason('offline'), 'machine-offline');
  });

  test('no-project → no-project', () => {
    assert.equal(resolveComposerPlaceholderReason('no-project'), 'no-project');
  });

  test('no-tab-id → no-project', () => {
    assert.equal(resolveComposerPlaceholderReason('no-tab-id'), 'no-project');
  });

  test('empty → ready（空文字は入力不可の理由ではない）', () => {
    assert.equal(resolveComposerPlaceholderReason('empty'), 'ready');
  });

  test('in-flight → ready', () => {
    assert.equal(resolveComposerPlaceholderReason('in-flight'), 'ready');
  });

  test('null → ready', () => {
    assert.equal(resolveComposerPlaceholderReason(null), 'ready');
  });
});

describe('decideProjectSelectorUrl（A3: プロジェクトセレクタ変更時の URL 遷移）', () => {
  test('別プロジェクトを選ぶと session を破棄する', () => {
    assert.deepEqual(
      decideProjectSelectorUrl({ currentProjectId: 'p1', currentSessionId: 's1', nextProjectId: 'p2' }),
      { project: 'p2', session: null }
    );
  });

  test('同一プロジェクトを選び直しても session を維持する', () => {
    assert.deepEqual(
      decideProjectSelectorUrl({ currentProjectId: 'p1', currentSessionId: 's1', nextProjectId: 'p1' }),
      { project: 'p1', session: 's1' }
    );
  });

  test('nextProjectId が空文字なら project も session も null', () => {
    assert.deepEqual(
      decideProjectSelectorUrl({ currentProjectId: 'p1', currentSessionId: 's1', nextProjectId: '' }),
      { project: null, session: null }
    );
  });

  test('currentSessionId が無くても別プロジェクトへの遷移は成立する', () => {
    assert.deepEqual(
      decideProjectSelectorUrl({ currentProjectId: null, currentSessionId: null, nextProjectId: 'p2' }),
      { project: 'p2', session: null }
    );
  });
});

describe('shouldShowNewThreadNotice（A3: 新規スレッド告知の表示可否は decideSendAction の needsNewThread と一致する）', () => {
  test('プロジェクト未選択なら false', () => {
    assert.equal(
      shouldShowNewThreadNotice({ selectedProjectId: null, selectedSessionId: null, selectedThreadProjectId: null }),
      false
    );
  });

  test('プロジェクト選択済み・スレッド未選択なら true', () => {
    assert.equal(
      shouldShowNewThreadNotice({ selectedProjectId: 'p1', selectedSessionId: null, selectedThreadProjectId: null }),
      true
    );
  });

  test('プロジェクト選択済み・スレッド選択済みでプロジェクトが一致すれば false', () => {
    assert.equal(
      shouldShowNewThreadNotice({ selectedProjectId: 'p1', selectedSessionId: 's1', selectedThreadProjectId: 'p1' }),
      false
    );
  });

  test('プロジェクト選択済み・スレッド選択済みでプロジェクトが不一致なら true', () => {
    assert.equal(
      shouldShowNewThreadNotice({ selectedProjectId: 'p1', selectedSessionId: 's1', selectedThreadProjectId: 'p-other' }),
      true
    );
  });

  test('decideSendAction の needsNewThread 判定と一致する（単一情報源の担保）', () => {
    const cases = [
      { selectedProjectId: 'p1', selectedSessionId: null, selectedThreadProjectId: null },
      { selectedProjectId: 'p1', selectedSessionId: 's1', selectedThreadProjectId: 'p1' },
      { selectedProjectId: 'p1', selectedSessionId: 's1', selectedThreadProjectId: 'p-other' },
    ];
    for (const c of cases) {
      const notice = shouldShowNewThreadNotice(c);
      const action = decideSendAction({
        ...c,
        tabId: 't1',
        machineOnline: true,
        connected: true,
        hasText: true,
        hasFiles: false,
        inFlight: false,
      });
      const needsNewThread = action.kind === 'create-then-send';
      assert.equal(notice, needsNewThread);
    }
  });
});

describe('decideThreadCreateButton（B4: classic 8 パターンの真理値表一致 + Lite 経路）', () => {
  test('classic（hasRequestCreate=false）は既存の disabled 判定と完全一致する', () => {
    for (const createTargetProjectId of [null, 'p1']) {
      for (const creating of [true, false]) {
        for (const readOnly of [true, false]) {
          const expected = !createTargetProjectId || creating || readOnly;
          const result = decideThreadCreateButton({
            createTargetProjectId,
            creating,
            readOnly,
            hasRequestCreate: false,
            createInFlight: false,
          });
          assert.equal(result.disabled, expected);
          assert.equal(result.label, creating ? 'creating' : 'new');
        }
      }
    }
  });

  test('Lite（hasRequestCreate=true）は readOnly を無視し createInFlight を使う', () => {
    const result = decideThreadCreateButton({
      createTargetProjectId: 'p1',
      creating: false,
      readOnly: true,
      hasRequestCreate: true,
      createInFlight: false,
    });
    assert.equal(result.disabled, false);
    assert.equal(result.label, 'new');
  });

  test('Lite で createInFlight のとき disabled=true・label=creating', () => {
    const result = decideThreadCreateButton({
      createTargetProjectId: 'p1',
      creating: false,
      readOnly: true,
      hasRequestCreate: true,
      createInFlight: true,
    });
    assert.equal(result.disabled, true);
    assert.equal(result.label, 'creating');
  });

  test('Lite で createTargetProjectId が無ければ disabled=true', () => {
    const result = decideThreadCreateButton({
      createTargetProjectId: null,
      creating: false,
      readOnly: true,
      hasRequestCreate: true,
      createInFlight: false,
    });
    assert.equal(result.disabled, true);
  });
});

describe('stripComments（R4/C-2: ソース静的走査用のコメント除去）', () => {
  test('行コメントを除去する', () => {
    const result = stripComments('const x = 1; // これはコメント //connect\nconst y = 2;');
    assert.equal(result.includes('//connect'), false);
    assert.match(result, /const x = 1;/);
    assert.match(result, /const y = 2;/);
  });

  test('ブロックコメントを除去する', () => {
    const result = stripComments('/* //connect の説明 */\nconst z = 3;');
    assert.equal(result.includes('//connect'), false);
    assert.match(result, /const z = 3;/);
  });

  test('文字列リテラル中の // は保持する', () => {
    const result = stripComments(`const url = 'https://example.com';`);
    assert.match(result, /https:\/\/example\.com/);
  });

  test('テンプレートリテラル中の // は保持する', () => {
    const result = stripComments('const url = `https://example.com`;');
    assert.match(result, /https:\/\/example\.com/);
  });

  test('コメントの無いソースはそのまま（改行構造以外は不変）', () => {
    const src = 'const a = 1;\nconst b = 2;';
    assert.equal(stripComments(src), src);
  });
});

// ---------------------------------------------------------------------------
// L4.1: 「＋新規」直後の送信先固定 + 一覧の自動再取得
// ---------------------------------------------------------------------------

describe('resolveSendInFlight（startTransition レース対策の核心）', () => {
  const base = {
    sending: false,
    creatingThread: false,
    confirmationSessionId: null,
    urlSessionId: null,
    requestedProjectId: null,
    urlProjectId: null,
  };

  test('sending 単独で true', () => {
    assert.equal(resolveSendInFlight({ ...base, sending: true }), true);
  });

  test('creatingThread 単独で true', () => {
    assert.equal(resolveSendInFlight({ ...base, creatingThread: true }), true);
  });

  test('「＋新規」直後: confirmation は新 sessionId、URL はまだ旧値 → true（重複スレッド作成レースの核心）', () => {
    const result = resolveSendInFlight({
      ...base,
      confirmationSessionId: 'new-session',
      urlSessionId: 'old-session-or-null',
    });
    assert.equal(result, true);
  });

  test('URL が追いついた後（confirmation と urlSessionId が一致）→ false', () => {
    const result = resolveSendInFlight({
      ...base,
      confirmationSessionId: 'sess-1',
      urlSessionId: 'sess-1',
    });
    assert.equal(result, false);
  });

  test('confirmationSessionId が null（未確定・深いリンク初回ロード等）→ fail-open で false', () => {
    const result = resolveSendInFlight({
      ...base,
      confirmationSessionId: null,
      urlSessionId: 'sess-1',
    });
    assert.equal(result, false);
  });

  test('project 軸: requestedProjectId と urlProjectId が不一致なら true', () => {
    const result = resolveSendInFlight({
      ...base,
      requestedProjectId: 'p-new',
      urlProjectId: 'p-old',
    });
    assert.equal(result, true);
  });

  test('project 軸: requestedProjectId が urlProjectId に追いつけば false', () => {
    const result = resolveSendInFlight({
      ...base,
      requestedProjectId: 'p1',
      urlProjectId: 'p1',
    });
    assert.equal(result, false);
  });

  test('requestedProjectId が null（未操作）→ fail-open で project 軸はブロックしない', () => {
    const result = resolveSendInFlight({
      ...base,
      requestedProjectId: null,
      urlProjectId: 'p1',
    });
    assert.equal(result, false);
  });

  test('両軸 null・sending/creatingThread も false → false（fail-open の総合確認）', () => {
    assert.equal(resolveSendInFlight(base), false);
  });

  test('session 軸と project 軸が両方追いついていれば false（通常状態）', () => {
    const result = resolveSendInFlight({
      sending: false,
      creatingThread: false,
      confirmationSessionId: 'sess-1',
      urlSessionId: 'sess-1',
      requestedProjectId: 'p1',
      urlProjectId: 'p1',
    });
    assert.equal(result, false);
  });
});

describe('resolveConfirmationOnProjectChange（プロジェクト切替時の confirmation クリア）', () => {
  test('同一 projectId なら confirmation をそのまま保持する', () => {
    const confirmation = { sessionId: 's1', projectId: 'p1' };
    assert.equal(resolveConfirmationOnProjectChange(confirmation, 'p1'), confirmation);
  });

  test('異なる projectId なら null にする（必須: 無いと送信が永久ブロックされる）', () => {
    const confirmation = { sessionId: 's1', projectId: 'p1' };
    assert.equal(resolveConfirmationOnProjectChange(confirmation, 'p2'), null);
  });

  test('confirmation が null なら null のまま', () => {
    assert.equal(resolveConfirmationOnProjectChange(null, 'p1'), null);
  });
});

describe('decideThreadListRefresh（一覧再取得のスロットリング。ポーリングではない）', () => {
  test('初回（lastRefreshAt が null）は常に refresh-now', () => {
    const result = decideThreadListRefresh({ now: 1000, lastRefreshAt: null, pendingTimer: false });
    assert.deepEqual(result, { kind: 'refresh-now' });
  });

  test('窓外（経過時間が最短間隔以上）なら refresh-now', () => {
    const result = decideThreadListRefresh({
      now: 10000,
      lastRefreshAt: 10000 - THREAD_REFRESH_MIN_INTERVAL_MS,
      pendingTimer: false,
    });
    assert.deepEqual(result, { kind: 'refresh-now' });
  });

  test('窓内・pendingTimer 無し → schedule（残り時間を返す）', () => {
    const lastRefreshAt = 10000;
    const now = lastRefreshAt + 500;
    const result = decideThreadListRefresh({ now, lastRefreshAt, pendingTimer: false });
    assert.deepEqual(result, { kind: 'schedule', delayMs: THREAD_REFRESH_MIN_INTERVAL_MS - 500 });
  });

  test('窓内・pendingTimer 有り → skip（二重スケジュール防止）', () => {
    const result = decideThreadListRefresh({
      now: 10500,
      lastRefreshAt: 10000,
      pendingTimer: true,
    });
    assert.deepEqual(result, { kind: 'skip' });
  });

  test('境界: 経過時間がちょうど最短間隔 → refresh-now', () => {
    const lastRefreshAt = 10000;
    const now = lastRefreshAt + THREAD_REFRESH_MIN_INTERVAL_MS;
    const result = decideThreadListRefresh({ now, lastRefreshAt, pendingTimer: false });
    assert.deepEqual(result, { kind: 'refresh-now' });
  });
});

describe('decideSendAction（「＋新規 直後」の送信先固定を回帰テストとして固定、指示項目1）', () => {
  test('「＋新規」で作られた新スレッドが選択中で、送信先プロジェクトも同一なら send-existing（新スレッドの sessionId を維持）', () => {
    const action = decideSendAction({
      selectedSessionId: 'new-session-from-plus-button',
      selectedThreadProjectId: 'p1',
      selectedProjectId: 'p1',
      tabId: 't1',
      machineOnline: true,
      connected: true,
      hasText: true,
      hasFiles: false,
      inFlight: false,
    });
    assert.deepEqual(action, {
      kind: 'send-existing',
      sessionId: 'new-session-from-plus-button',
      sendProjectIdHint: 'p1',
    });
  });

  test('上と同じ状況でも resolveSendInFlight が true を返す窓（URL 未追従）では in-flight で blocked になる', () => {
    const inFlight = resolveSendInFlight({
      sending: false,
      creatingThread: false,
      confirmationSessionId: 'new-session-from-plus-button',
      urlSessionId: null, // URL がまだ追いついていない
      requestedProjectId: null,
      urlProjectId: null,
    });
    assert.equal(inFlight, true);
    const action = decideSendAction({
      selectedSessionId: 'new-session-from-plus-button',
      selectedThreadProjectId: 'p1',
      selectedProjectId: 'p1',
      tabId: 't1',
      machineOnline: true,
      connected: true,
      hasText: true,
      hasFiles: false,
      inFlight,
    });
    assert.deepEqual(action, { kind: 'blocked', reason: 'in-flight' });
  });
});
