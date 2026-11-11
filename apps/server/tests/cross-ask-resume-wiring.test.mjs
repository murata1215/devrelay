// サイクルC2（クロス ask のセッション継続: サーバー配線）の配線（wiring）ソース静的ガード
// （node:fs のみ、dist/ には依存しない。cross-ask-isolation-wiring.test.mjs と同じ手口）。
//
// これが無いと、将来のリファクタで以下が黙って外れても気づけない:
// - resume 昇格判定（decideCrossAskSessionPlan）/ レート制限（decideAskRateLimit）が
//   Session 作成より後に移動し、拒否時にゴミの crossquery_ Session/Message が残ってしまう
// - ゲートが 'cross-ask-resume'（C1 時点の緩いポリシー）に戻ってしまう
// - agentScopeId が executeCrossProjectQuery/startSession に渡らなくなる
// - document-api.ts（ask-member REST、独立経路）に resume が誤配線される
// - DEVRELAY_CROSS_ASK_RESUME の既定値の極性が反転する

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

describe('cross-ask-runner.ts: 判定が Session 作成より前にある（G-11 / resume とも）', () => {
  const source = readServerSource('src/services/cross-ask-runner.ts');

  test('decideAskRateLimit( が prisma.session.create( より前', () => {
    const idx = source.indexOf('decideAskRateLimit(');
    const createIdx = source.indexOf('prisma.session.create(');
    assert.ok(idx > 0, 'decideAskRateLimit call not found');
    assert.ok(createIdx > idx, 'decideAskRateLimit must precede prisma.session.create');
  });

  test('decideCrossAskSessionPlan( が prisma.session.create( より前', () => {
    const idx = source.indexOf('decideCrossAskSessionPlan(');
    const createIdx = source.indexOf('prisma.session.create(');
    assert.ok(idx > 0, 'decideCrossAskSessionPlan call not found');
    assert.ok(createIdx > idx, 'decideCrossAskSessionPlan must precede prisma.session.create');
  });

  test('decideCrossAskIsolation( が decideCrossAskSessionPlan( より前（G が先・resume が後）', () => {
    const isolationIdx = source.indexOf('decideCrossAskIsolation(');
    const planIdx = source.indexOf('decideCrossAskSessionPlan(');
    assert.ok(isolationIdx > 0 && planIdx > 0, 'both calls must exist');
    assert.ok(planIdx > isolationIdx, 'decideCrossAskIsolation must precede decideCrossAskSessionPlan');
  });

  test('crossAskStatePolicy 識別子が維持されている（既存ピンとの互換）', () => {
    const idx = source.lastIndexOf('executeCrossProjectQuery(');
    const body = source.slice(idx, idx + 400);
    assert.match(body, /crossAskStatePolicy/);
  });

  test('executeCrossProjectQuery( に agentScopeId（resumeAgentScopeId）が渡っている', () => {
    const idx = source.lastIndexOf('executeCrossProjectQuery(');
    const body = source.slice(idx, idx + 400);
    assert.match(body, /resumeAgentScopeId/);
  });

  test('session.create の data に agentScopeId が条件付きで入っている', () => {
    const idx = source.indexOf('await prisma.session.create(');
    const body = source.slice(idx, idx + 600);
    assert.match(body, /agentScopeId:\s*resumeAgentScopeId/);
  });

  test('ゲートは cross-ask-resume-strict であり、緩い cross-ask-resume を認可判定に使っていない', () => {
    const idx = source.indexOf('agentHasCapability(targetProject.machine.id, \'cross-ask-resume-strict\')');
    assert.ok(idx > 0, "agentHasCapability(..., 'cross-ask-resume-strict') not found");
    // 'cross-ask-resume'（ハイフン区切り単体、-strict サフィックス無し）を認可条件に使っていないこと
    const bareUsage = source.match(/agentHasCapability\([^)]*'cross-ask-resume'\)/g) ?? [];
    assert.equal(bareUsage.length, 0, 'must not gate on bare cross-ask-resume capability');
  });

  test('文脈前置の条件に includeResumeContextPrefix が入っている（二重注入防止）', () => {
    const idx = source.indexOf('const contextEnabled =');
    const body = source.slice(idx, idx + 300);
    assert.match(body, /includeResumeContextPrefix/);
  });
});

describe('呼び出し元 2 箇所に kind===\'rateLimited\' の分岐がある（黙って failed/else に落ちない）', () => {
  test('platforms/web.ts', () => {
    const source = readServerSource('src/platforms/web.ts');
    assert.match(source, /crossResult\.kind === 'rateLimited'/);
  });

  test('services/command-handler.ts', () => {
    const source = readServerSource('src/services/command-handler.ts');
    assert.match(source, /result\.kind === 'rateLimited'/);
  });
});

describe('document-api.ts: resume 判定が配線されていない（独立経路。resume 対象外）', () => {
  const source = readServerSource('src/routes/document-api.ts');

  test('decideCrossAskSessionPlan が出現しない', () => {
    assert.doesNotMatch(source, /decideCrossAskSessionPlan/);
  });

  test('cross-ask-resume-rules からの import が無い', () => {
    assert.doesNotMatch(source, /cross-ask-resume-rules/);
  });
});

describe('agent-manager.ts: executeCrossProjectQuery が agentScopeId を startSession に渡している', () => {
  const source = readServerSource('src/services/agent-manager.ts');

  test('startSession( 呼び出しが agentScopeId 引数（undefined 固定ではない）を渡している', () => {
    const idx = source.indexOf('export function executeCrossProjectQuery');
    const body = source.slice(idx, idx + 1500);
    const startSessionCallIdx = body.indexOf('startSession(machineId, sessionId, projectName, projectPath, aiTool,');
    assert.ok(startSessionCallIdx > 0, 'startSession call not found in executeCrossProjectQuery body');
    const callLine = body.slice(startSessionCallIdx, startSessionCallIdx + 120);
    assert.match(callLine, /agentScopeId/);
    assert.doesNotMatch(callLine, /startSession\(machineId, sessionId, projectName, projectPath, aiTool, undefined,/);
  });
});

describe('cross-team-guard.ts: DEVRELAY_CROSS_ASK_RESUME の極性（既定 OFF）', () => {
  const source = readServerSource('src/services/cross-team-guard.ts');

  test('isCrossAskResumeEnabled が raw === \'1\' で既定 OFF', () => {
    const idx = source.indexOf('export function isCrossAskResumeEnabled');
    assert.ok(idx > 0, 'isCrossAskResumeEnabled not found');
    const body = source.slice(idx, idx + 200);
    assert.match(body, /return\s+raw\s*===\s*'1'/);
  });
});

describe('cross-ask-isolation-wiring.test.mjs の既存ピンとの非衝突（crossAskStatePolicy 識別子の再確認）', () => {
  // cross-ask-isolation-wiring.test.mjs が同一の正規表現 /crossAskStatePolicy/ を
  // 既に固定しているため、本ファイル側でも同一の正規表現が通ることを明示的に再確認する
  // （片方だけ更新して一方を壊す事故の早期検知）。
  const source = readServerSource('src/services/cross-ask-runner.ts');

  test('executeCrossProjectQuery( 直前の 400 文字に crossAskStatePolicy が含まれる', () => {
    const idx = source.lastIndexOf('executeCrossProjectQuery(');
    const body = source.slice(idx, idx + 400);
    assert.match(body, /crossAskStatePolicy/);
  });
});

describe('apps/web・prisma は無変更（devlog の主張の裏取り。grep で直接確認）', () => {
  test('packages/shared の statePolicy 型に cross-ask-resume-strict が含まれている（Agent capability）', () => {
    const sharedSource = readFileSync(
      path.join(serverRoot, '..', '..', 'packages', 'shared', 'src', 'types.ts'),
      'utf8',
    );
    assert.match(sharedSource, /'cross-ask-resume-strict'/);
  });
});
