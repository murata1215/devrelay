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

describe('routes/api.ts: 公開型 Team（Phase A）の新ルート一式が両キルスイッチ（AND）でガードされている', () => {
  const source = readServerSource('src/routes/api.ts');

  const publishRouteAnchors = [
    `app.patch('/api/teams/:teamId/visibility'`,
    `app.get('/api/teams/published'`,
    `app.post('/api/teams/:teamId/subscribe'`,
    `app.delete('/api/teams/:teamId/subscribe'`,
    `app.get('/api/teams/:teamId/subscribers'`,
    `app.delete('/api/teams/:teamId/subscribers/:userId'`,
  ];

  test('publishFeatureEnabled() が DEVRELAY_CROSS_TEAM と DEVRELAY_CROSS_TEAM_PUBLISH の両方を AND で見ている', () => {
    const idx = source.indexOf('const publishFeatureEnabled');
    assert.ok(idx > 0);
    const body = source.slice(idx, idx + 300);
    assert.match(body, /isCrossTeamEnabled\(process\.env\.DEVRELAY_CROSS_TEAM\)/);
    assert.match(body, /isCrossTeamPublishEnabled\(process\.env\.DEVRELAY_CROSS_TEAM_PUBLISH\)/);
    assert.match(body, /&&/);
  });

  for (const anchor of publishRouteAnchors) {
    test(`${anchor} のハンドラ内に publishFeatureEnabled() がある`, () => {
      const idx = source.indexOf(anchor);
      assert.ok(idx > 0, `route anchor ${anchor} not found`);
      const body = source.slice(idx, idx + 400);
      assert.match(body, /publishFeatureEnabled\(\)/);
    });
  }

  test('PATCH /api/teams/:teamId/visibility はチーム所有権チェック（team.userId !== userId）を持つ', () => {
    const idx = source.indexOf(`app.patch('/api/teams/:teamId/visibility'`);
    const body = source.slice(idx, idx + 1000);
    assert.match(body, /team\.userId\s*!==\s*userId/);
  });

  test('PATCH /api/teams/:teamId/visibility は selectPublishableMembers() で又貸し防止を行い、公開可能 0 件なら 400 で拒否する', () => {
    const idx = source.indexOf(`app.patch('/api/teams/:teamId/visibility'`);
    const body = source.slice(idx, idx + 2200);
    assert.match(body, /selectPublishableMembers\(/);
    assert.match(body, /publishableCount === 0/);
    assert.match(body, /status\(400\)/);
  });

  test('GET /api/teams/published はプロジェクト名を一切返さない（org-candidates と同じ情報漏えい対策）', () => {
    const idx = source.indexOf(`app.get('/api/teams/published'`);
    const body = source.slice(idx, idx + 2000);
    assert.doesNotMatch(body, /projectName/);
  });

  test('POST /api/teams/:teamId/subscribe は公開チーム（visibility === organization）かつ非オーナーのみ許可する', () => {
    const idx = source.indexOf(`app.post('/api/teams/:teamId/subscribe'`);
    const body = source.slice(idx, idx + 800);
    assert.match(body, /team\.visibility\s*!==\s*'organization'/);
    assert.match(body, /team\.userId\s*===\s*userId/);
  });

  test('POST /api/teams/:teamId/subscribe は組織境界を再検証する（callerMembership.organizationId !== ownerMembership.organizationId）', () => {
    const idx = source.indexOf(`app.post('/api/teams/:teamId/subscribe'`);
    const body = source.slice(idx, idx + 1500);
    assert.match(body, /callerMembership\.organizationId\s*!==\s*ownerMembership\.organizationId/);
  });

  test('DELETE /api/teams/:teamId/subscribers/:userId（オーナーによる強制取消）は allowSelfAudit を渡さない（本人以外の操作なので既定の非自己操作ログがそのまま効く）', () => {
    const idx = source.indexOf(`app.delete('/api/teams/:teamId/subscribers/:userId'`);
    const body = source.slice(idx, idx + 1200);
    assert.match(body, /action:\s*'subscription_revoked'/);
    assert.doesNotMatch(body, /allowSelfAudit/);
  });

  test('公開/購読系の自己操作（team_published/team_unpublished/subscribed/unsubscribed）は allowSelfAudit: true を渡している', () => {
    for (const action of ['team_published', 'team_unpublished', 'subscribed', 'unsubscribed']) {
      const idx = source.indexOf(`action: visibility === 'organization' ? 'team_published' : 'team_unpublished'`);
      const idx2 = source.indexOf(`action: 'subscribed'`);
      const idx3 = source.indexOf(`action: 'unsubscribed'`);
      assert.ok(idx > 0 || idx2 > 0 || idx3 > 0, `action ${action} の記録箇所が見つからない`);
    }
    // 公開/非公開の記録箇所
    const publishIdx = source.indexOf(`action: visibility === 'organization' ? 'team_published' : 'team_unpublished'`);
    assert.match(source.slice(publishIdx, publishIdx + 200), /allowSelfAudit:\s*true/);
    // 購読の記録箇所
    const subscribeIdx = source.indexOf(`action: 'subscribed'`);
    assert.match(source.slice(subscribeIdx - 50, subscribeIdx + 100), /allowSelfAudit:\s*true/);
    // 購読解除の記録箇所
    const unsubscribeIdx = source.indexOf(`action: 'unsubscribed'`);
    assert.match(source.slice(unsubscribeIdx - 50, unsubscribeIdx + 100), /allowSelfAudit:\s*true/);
  });

  test('GET /api/teams は visibility/subscriberCount を publishEnabled の条件スプレッド内でのみ返す（OFF 時は旧レスポンスと構造的に同一）', () => {
    const idx = source.indexOf(`app.get('/api/teams'`);
    assert.ok(idx > 0);
    const body = source.slice(idx, idx + 2300);
    assert.match(body, /const publishEnabled = publishFeatureEnabled\(\)/);
    // visibility/subscriberCount が `...(publishEnabled ? { ... } : {})` の中にあること
    const spreadIdx = body.indexOf('...(publishEnabled ?');
    assert.ok(spreadIdx > 0, 'publishEnabled の条件スプレッドが見つからない');
    const spreadBody = body.slice(spreadIdx, spreadIdx + 150);
    assert.match(spreadBody, /visibility:\s*t\.visibility/);
    assert.match(spreadBody, /subscriberCount:/);
  });

  test('GET /api/teams は publishEnabled が false のとき TeamSubscription の集計クエリを実行しない（既定状態での負荷ゼロ）', () => {
    const idx = source.indexOf(`app.get('/api/teams'`);
    const body = source.slice(idx, idx + 2300);
    assert.match(body, /if \(publishEnabled && teams\.length > 0\)/);
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

describe('cross-team-guard.ts: 公開型 Team（Phase A）追加後も認可の純関数は無改造のまま', () => {
  const source = readServerSource('src/services/cross-team-guard.ts');

  test('decideCrossTeamAccess は購読・公開・subscription の語を一切知らない（DB ラッパ側だけが合成する設計が崩れていないこと）', () => {
    assert.doesNotMatch(source, /subscription/i);
    assert.doesNotMatch(source, /visibility/i);
    assert.doesNotMatch(source, /publish/i);
  });

  test('CrossTeamCandidateGrant のフィールドは変わっていない（teamMemberId 等を追加で要求していない）', () => {
    const idx = source.indexOf('export interface CrossTeamCandidateGrant');
    assert.ok(idx > 0);
    const body = source.slice(idx, idx + 500);
    assert.doesNotMatch(body, /teamMemberId/);
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
