// クロスユーザー Team（Phase 1: ask のみ）の REST API 配線（wiring）のソース静的ガード
// （node:fs のみ、dist/ には依存しない。update-guard-wiring.test.mjs と同じ手口）。
//
// これが無いと、将来のリファクタで以下が黙って外れても気づけない:
// - 新設の 6 ルートのいずれかが DEVRELAY_CROSS_TEAM キルスイッチを見ずに有効化される
//   （既定 OFF の環境で新しい信頼境界が誤って開く）
// - invite/accept/decline/revoke の所有者チェック（inviterUserId/inviteeUserId 一致）が外れる
// - ask-member / teamexec-member の authz 呼び出しが旧シグネチャ（positional 引数）に戻る
// - GET /api/agent/members の情報漏えいフィルタ（team.userId / project.machine.userId）が外れる

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

describe('routes/api.ts: クロスユーザー Team 招待 API 一式がキルスイッチでガードされている', () => {
  const source = readServerSource('src/routes/api.ts');

  const routes = [
    `'/api/teams/org-candidates'`,
    `'/api/teams/invites'`,
    `'/api/teams/:teamId/invites'`,
    `'/api/teams/invites/:id/accept'`,
    `'/api/teams/invites/:id/decline'`,
    `'/api/teams/invites/:id'`,
    `'/api/teams/members/:memberId/grant'`,
    `'/api/teams/shared-by-me'`,
  ];

  for (const route of routes) {
    test(`${route} のハンドラ内に isCrossTeamEnabled(process.env.DEVRELAY_CROSS_TEAM) がある`, () => {
      const idx = source.indexOf(route);
      assert.ok(idx > 0, `route ${route} not found`);
      const body = source.slice(idx, idx + 600);
      assert.match(body, /isCrossTeamEnabled\(process\.env\.DEVRELAY_CROSS_TEAM\)/);
    });
  }

  test('POST /api/teams/:teamId/invites はチーム所有権チェック（team.userId !== userId）を持つ', () => {
    const idx = source.indexOf(`'/api/teams/:teamId/invites'`);
    const body = source.slice(idx, idx + 1500);
    assert.match(body, /team\.userId\s*!==\s*userId/);
  });

  test('POST /api/teams/invites/:id/accept は招待の宛先チェック（invite.inviteeUserId !== userId）を持つ', () => {
    const idx = source.indexOf(`'/api/teams/invites/:id/accept'`);
    const body = source.slice(idx, idx + 1500);
    assert.match(body, /invite\.inviteeUserId\s*!==\s*userId/);
  });

  test('POST /api/teams/invites/:id/accept はプロジェクト所有権チェック（project.machine.userId !== userId）を持つ', () => {
    const idx = source.indexOf(`'/api/teams/invites/:id/accept'`);
    const body = source.slice(idx, idx + 2000);
    assert.match(body, /project\.machine\.userId\s*!==\s*userId/);
  });

  test('POST /api/teams/invites/:id/accept の CrossTeamGrant.execAllowed は常に false（Phase 2 で解禁）', () => {
    const idx = source.indexOf(`'/api/teams/invites/:id/accept'`);
    const body = source.slice(idx, idx + 4000);
    assert.match(body, /execAllowed:\s*false/);
  });

  test('POST /api/teams/invites/:id/accept は projectIds（複数）を受け付け、旧 projectId（単数）にもフォールバックする', () => {
    const idx = source.indexOf(`'/api/teams/invites/:id/accept'`);
    const body = source.slice(idx, idx + 1500);
    assert.match(body, /projectIds\?:\s*string\[\]/);
    assert.match(body, /body\.projectId/, '旧クライアント（単数）からのフォールバックが残っていること');
  });

  test('POST /api/teams/invites/:id/accept は 1 件でも所有権違反があれば全体を拒否する（部分適用しない）', () => {
    const idx = source.indexOf(`'/api/teams/invites/:id/accept'`);
    const body = source.slice(idx, idx + 2200);
    assert.match(body, /projects\.length\s*!==\s*projectIds\.length\s*\|\|\s*projects\.some/);
  });

  test('POST /api/teams/invites/:id/accept は既にメンバーの projectId をスキップし、全件スキップのみ 409 にする', () => {
    const idx = source.indexOf(`'/api/teams/invites/:id/accept'`);
    const body = source.slice(idx, idx + 3200);
    assert.match(body, /toAccept\.length === 0/);
    assert.match(body, /status\(409\)/);
  });

  test('POST /api/teams/:teamId/invites は invite.status が accepted でも再招待できる（公開停止後の行き止まりバグ修正）', () => {
    const idx = source.indexOf(`'/api/teams/:teamId/invites'`);
    const body = source.slice(idx, idx + 2500);
    // 旧実装にあった `existing.status === 'accepted'` による 409 ガードが復活していないこと
    assert.doesNotMatch(body, /existing\.status === 'accepted'/);
    assert.doesNotMatch(body, /already has an accepted invite/);
  });

  test('DELETE /api/teams/members/:memberId/grant は Team オーナーまたは grantee のみ許可する', () => {
    const idx = source.indexOf(`'/api/teams/members/:memberId/grant'`);
    const body = source.slice(idx, idx + 1500);
    assert.match(body, /!isOwner\s*&&\s*!isGrantee/);
  });

  test('GET /api/teams/shared-by-me は OFF 時に 404 ではなく { shares: [] } を返す（/api/teams/invites と同じ流儀）', () => {
    const idx = source.indexOf(`'/api/teams/shared-by-me'`);
    assert.ok(idx > 0);
    const body = source.slice(idx, idx + 400);
    assert.match(body, /isCrossTeamEnabled\(process\.env\.DEVRELAY_CROSS_TEAM\)/);
    assert.match(body, /reply\.send\(\{\s*shares:\s*\[\]\s*\}\)/);
    assert.doesNotMatch(body, /status\(404\)/);
  });

  test('GET /api/teams/shared-by-me は granteeUserId（自分）かつ revokedAt が null の grant だけを見る', () => {
    const idx = source.indexOf(`'/api/teams/shared-by-me'`);
    const body = source.slice(idx, idx + 1200);
    assert.match(body, /granteeUserId:\s*userId,\s*revokedAt:\s*null/);
  });
});

describe('routes/document-api.ts: checkCrossTargetAllowed のオブジェクト引数シグネチャに移行済み', () => {
  const source = readServerSource('src/routes/document-api.ts');

  test('checkCrossTargetAllowed の全呼び出しが positional 引数（旧シグネチャ）を使っていない', () => {
    // 旧シグネチャ: checkCrossTargetAllowed(auth.machineId, auth.userId, ...)
    assert.doesNotMatch(source, /checkCrossTargetAllowed\(auth\.machineId,\s*auth\.userId,/);
  });

  test('ask-member は allowCrossUser: true で呼んでいる', () => {
    const idx = source.indexOf(`app.post('/api/agent/ask-member'`);
    assert.ok(idx > 0);
    const body = source.slice(idx, idx + 2500);
    assert.match(body, /checkCrossTargetAllowed\(\{/);
    assert.match(body, /allowCrossUser:\s*true/);
  });

  test('teamexec-member は allowCrossUser: false で呼んでいる（Phase 1 では teamexec は同一ユーザーのみ）', () => {
    const idx = source.indexOf(`app.post('/api/agent/teamexec-member'`);
    assert.ok(idx > 0);
    const body = source.slice(idx, idx + 2500);
    assert.match(body, /checkCrossTargetAllowed\(\{/);
    assert.match(body, /allowCrossUser:\s*false/);
  });

  test('GET /api/agent/members は情報漏えい対策フィルタ（team.userId / project.machine.userId）を持つ', () => {
    const idx = source.indexOf(`app.get('/api/agent/members'`);
    assert.ok(idx > 0);
    const body = source.slice(idx, idx + 2000);
    assert.match(body, /m\.team\.userId === auth\.userId \|\| m\.project\.machine\.userId === auth\.userId/);
  });

  test('countRecentCrossSessions は requestedByUserId の OR 条件で依頼者を集計する', () => {
    const idx = source.indexOf('async function countRecentCrossSessions');
    assert.ok(idx > 0);
    const body = source.slice(idx, idx + 600);
    assert.match(body, /requestedByUserId:\s*requesterUserId/);
    assert.match(body, /requestedByUserId:\s*null,\s*userId:\s*requesterUserId/);
  });
});

describe('raw-completion-api.ts: checkCrossTargetAllowed はクロスユーザー非対応で据え置き', () => {
  const source = readServerSource('src/routes/raw-completion-api.ts');

  test('allowCrossUser: false で呼んでいる', () => {
    const idx = source.indexOf('checkCrossTargetAllowed({');
    assert.ok(idx > 0);
    const body = source.slice(idx, idx + 400);
    assert.match(body, /allowCrossUser:\s*false/);
  });
});

describe('command-handler.ts: resolveCrossTargetByName は ask のみクロス候補を含める', () => {
  const source = readServerSource('src/services/command-handler.ts');

  test('handleAskMember は includeCrossTeam=true で呼んでいる', () => {
    const idx = source.indexOf('async function handleAskMember');
    assert.ok(idx > 0);
    const body = source.slice(idx, idx + 2000);
    assert.match(body, /resolveCrossTargetByName\(dbUserId,\s*targetProjectName,\s*true\)/);
  });

  test('handleTeamExec は includeCrossTeam を渡さない（既定 false のまま。Phase 2 で解禁）', () => {
    const idx = source.indexOf('async function handleTeamExec');
    assert.ok(idx > 0);
    const body = source.slice(idx, idx + 2000);
    assert.match(body, /resolveCrossTargetByName\(dbUserId,\s*targetProjectName\)/);
    assert.doesNotMatch(body, /resolveCrossTargetByName\(dbUserId,\s*targetProjectName,\s*true\)/);
  });
});
