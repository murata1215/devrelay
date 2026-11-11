// サイクルG（クロス ask の既存バグ修正）の配線（wiring）ソース静的ガード
// （node:fs のみ、dist/ には依存しない。cross-team-chat-wiring.test.mjs と同じ手口）。
//
// これが無いと、将来のリファクタで以下が黙って外れても気づけない:
// - `decideCrossAskIsolation()` の判定が Session 作成より後に移動し、拒否時に
//   ゴミの `crossquery_` Session/Message が残ってしまう
// - G-12（`//connect` が実行中のクロス ask セッションを拾う既存バグ）の修正が後退する
// - キルスイッチの極性が入れ替わり、`DEVRELAY_CROSS_ASK_ISOLATION` が既定で無効化と逆方向になる

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');

function readServerSource(relPath) {
  return readFileSync(path.join(serverRoot, relPath), 'utf8');
}

describe('cross-ask-runner.ts: 隔離判定が Session 作成より前にある', () => {
  const source = readServerSource('src/services/cross-ask-runner.ts');

  test('decideCrossAskIsolation( が prisma.session.create( より前', () => {
    const isolationIdx = source.indexOf('decideCrossAskIsolation(');
    const createIdx = source.indexOf('prisma.session.create(');
    assert.ok(isolationIdx > 0, 'decideCrossAskIsolation call not found');
    assert.ok(createIdx > isolationIdx, 'decideCrossAskIsolation must precede prisma.session.create');
  });

  test('拒否時に action: \'denied\' で監査を記録する', () => {
    const isolationIdx = source.indexOf('decideCrossAskIsolation(');
    const body = source.slice(isolationIdx, isolationIdx + 1400);
    assert.match(body, /action:\s*'denied'/);
  });

  test('statePolicy が executeCrossProjectQuery( に渡っている', () => {
    const idx = source.lastIndexOf('executeCrossProjectQuery(');
    const body = source.slice(idx, idx + 400);
    assert.match(body, /crossAskStatePolicy/);
  });
});

describe('document-api.ts: ask-member エンドポイントも同じ 2 点を検証する（cross-ask-runner.ts を経由しない独立経路）', () => {
  const source = readServerSource('src/routes/document-api.ts');

  test('decideCrossAskIsolation( が tempSession 作成より前にある（複数 session.create の先頭側）', () => {
    const isolationIdx = source.indexOf('decideCrossAskIsolation(');
    const createIdx = source.indexOf('prisma.session.create(', isolationIdx);
    assert.ok(isolationIdx > 0, 'decideCrossAskIsolation call not found');
    assert.ok(createIdx > isolationIdx, 'decideCrossAskIsolation must precede the ask-member session create');
  });

  test('拒否時に action: \'denied\' で監査を記録する', () => {
    const isolationIdx = source.indexOf('decideCrossAskIsolation(');
    const body = source.slice(isolationIdx, isolationIdx + 1400);
    assert.match(body, /action:\s*'denied'/);
  });

  test('statePolicy が executeCrossProjectQuery( に渡っている', () => {
    const idx = source.lastIndexOf('executeCrossProjectQuery(');
    const body = source.slice(idx, idx + 400);
    assert.match(body, /askStatePolicy/);
  });
});

describe('command-handler.ts: G-12（実行中のクロス ask セッションを //connect が拾う既存バグ）の修正', () => {
  const source = readServerSource('src/services/command-handler.ts');

  test('buildEphemeralSessionIdExclusion() が active/ended 両方の where に展開されている（2 箇所）', () => {
    const matches = source.match(/\.\.\.buildEphemeralSessionIdExclusion\(\)/g) ?? [];
    assert.equal(matches.length, 2, `expected 2 occurrences, found ${matches.length}`);
  });

  test('active セッション取得の where に status: \'active\' と除外が両方ある', () => {
    const idx = source.indexOf('const activeSessions = await prisma.session.findMany(');
    assert.ok(idx > 0, 'activeSessions query not found');
    const body = source.slice(idx, idx + 400);
    assert.match(body, /status:\s*'active'/);
    assert.match(body, /\.\.\.buildEphemeralSessionIdExclusion\(\)/);
  });

  test('ended 復活候補の where に status: \'ended\' と除外が両方ある', () => {
    const idx = source.indexOf('const endedSessions = await prisma.session.findMany(');
    assert.ok(idx > 0, 'endedSessions query not found');
    const body = source.slice(idx, idx + 400);
    assert.match(body, /status:\s*'ended'/);
    assert.match(body, /\.\.\.buildEphemeralSessionIdExclusion\(\)/);
  });
});

describe('サイクルS1（2026-11-12）: decideCrossAskIsolation( の呼び出しが全て agentHasPlanGateCapability を渡している', () => {
  // decideCrossAskIsolation( の呼び出し箇所ごとに、直後 600 文字以内に
  // `agentHasPlanGateCapability:` フィールドがあることを確認する（1 箇所でも渡し忘れると
  // プランモードのゲート未対応 Agent へのクロスユーザー ask が fail-open に後退する）。
  // `decideCrossAskIsolation\(\{` で絞る（JSDoc コメント中の `decideCrossAskIsolation()`
  // ＝括弧が空の言及と、実際の呼び出し＝オブジェクトリテラルの `{` を区別するため）。
  function assertAllCallsPassPlanGateCapability(source, label) {
    const matches = [...source.matchAll(/decideCrossAskIsolation\(\{/g)];
    assert.ok(matches.length > 0, `${label}: decideCrossAskIsolation({ の呼び出しが見つからない`);
    for (const m of matches) {
      const body = source.slice(m.index, m.index + 600);
      assert.match(body, /agentHasPlanGateCapability:/, `${label}: decideCrossAskIsolation( の呼び出し（index=${m.index}）に agentHasPlanGateCapability が渡っていない`);
    }
  }

  test('cross-ask-runner.ts', () => {
    assertAllCallsPassPlanGateCapability(readServerSource('src/services/cross-ask-runner.ts'), 'cross-ask-runner.ts');
  });

  test('document-api.ts', () => {
    assertAllCallsPassPlanGateCapability(readServerSource('src/routes/document-api.ts'), 'document-api.ts');
  });

  test('cross-ask-target-state.ts（decideCrossAskIsolation を直接呼ぶ唯一の第3呼び出し元）', () => {
    assertAllCallsPassPlanGateCapability(readServerSource('src/services/cross-ask-target-state.ts'), 'cross-ask-target-state.ts');
  });
});

describe('cross-team-guard.ts: DEVRELAY_CROSS_ASK_ISOLATION の極性（既定 ON）', () => {
  const source = readServerSource('src/services/cross-team-guard.ts');

  test('isCrossAskIsolationEnabled が raw !== \'0\' で既定 ON', () => {
    const idx = source.indexOf('export function isCrossAskIsolationEnabled');
    assert.ok(idx > 0, 'isCrossAskIsolationEnabled not found');
    const body = source.slice(idx, idx + 200);
    assert.match(body, /return\s+raw\s*!==\s*'0'/);
  });
});
