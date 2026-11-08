// Phase 0-1: 他ユーザーの TeamMember 行を memberId 推測で削除できてしまう問題の再発防止
// （ソース静的ガード。update-guard-wiring.test.mjs と同じ手口 — node:fs + dist 非依存）。
//
// 修正前は `prisma.teamMember.delete({ where: { id: memberId } })` が teamId でスコープ
// されておらず、2988-2991 の「自分が Team を持っているか」チェックだけでは、他ユーザーの
// Team に属する TeamMember 行の memberId を直接指定すれば削除できてしまっていた
// （.catch(() => null) + 常に {success:true} のためエラーも出ない）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');

function readServerSource(relPath) {
  return readFileSync(path.join(serverRoot, relPath), 'utf8');
}

test('DELETE /api/teams/:teamId/members/:memberId は teamMember.delete({ where: { id } }) 単体を使わない', () => {
  const source = readServerSource('src/routes/api.ts');
  const idx = source.indexOf(`'/api/teams/:teamId/members/:memberId'`);
  assert.ok(idx > 0, 'ルートが見つからない');
  const body = source.slice(idx, idx + 1000);
  // id のみで delete している（teamId を伴わない）呼び出しが残っていないこと
  assert.doesNotMatch(body, /teamMember\.delete\(\{\s*where:\s*\{\s*id:\s*memberId\s*\}\s*\}\)/);
});

test('DELETE /api/teams/:teamId/members/:memberId は deleteMany({ where: { id, teamId } }) で teamId スコープしている', () => {
  const source = readServerSource('src/routes/api.ts');
  const idx = source.indexOf(`'/api/teams/:teamId/members/:memberId'`);
  const body = source.slice(idx, idx + 1000);
  assert.match(body, /teamMember\.deleteMany\(\{\s*where:\s*\{\s*id:\s*memberId,\s*teamId\s*\}\s*\}\)/);
});

test('同ルートは Team 所有権チェック（team.userId !== userId → 404）を保持している（既存の砦を壊していない）', () => {
  const source = readServerSource('src/routes/api.ts');
  const idx = source.indexOf(`'/api/teams/:teamId/members/:memberId'`);
  const body = source.slice(idx, idx + 1000);
  assert.match(body, /team\.userId\s*!==\s*userId/);
});
