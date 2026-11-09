// クロスユーザー Team Phase C（購読/借用プロジェクトを Agents ツリーに出し WebUI から直接 ask
// する機能）の配線（wiring）ソース静的ガード（node:fs のみ、dist/ には依存しない。
// cross-team-api-wiring.test.mjs と同じ手口）。
//
// これが無いと、将来のリファクタで以下が黙って外れても気づけない:
// - `web:cross:ask` ハンドラが `parseCommandWithNLP`/`executeCommand`/`handleProjectConnect` を
//   経由するようになり、e/k/a/testflight/`//connect` が構造的に到達不能という前提が崩れる
// - `handleProjectConnect`/`handleMachineConnect`/`handleProjectList` の所有者チェック
//   （2026-11-09 の権限昇格の穴の修正）が後退する
// - クロス履歴 API の認可（requestedByUserId）が外れる
// - `cross-ask-runner.ts` が requesterUserId を実行者として渡してしまう
//   （rules/project.md の最重要設計判断の逆転）
// - 新ルートが `listCrossTeamAskCandidateProjects()` を迂回する独自の認可クエリを持つ
//   （「ツリーに出る集合」と「ask できる集合」がずれる）
// - セルフレビューで撤回した「crossquery_ を非 ephemeral 化する」案が復活する
//   （#348 の `.devrelay-output/` 全消し事故の再発につながる）
// - G-2（クロス ask が所有者の work state を食う既存バグ）の修正が Agent 側で後退する

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(serverRoot, '../..');

function readServerSource(relPath) {
  return readFileSync(path.join(serverRoot, relPath), 'utf8');
}

function readRepoSource(relPath) {
  return readFileSync(path.join(repoRoot, relPath), 'utf8');
}

/** 行コメント（`// ...`）を除去する（コメント中の関数名言及を実呼び出しと誤検出しないため）。
 *  この用途に限れば文字列リテラル内の `//` は無視してよい（対象コードに該当箇所が無い）。 */
function stripLineComments(src) {
  return src
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

describe('platforms/web.ts: web:cross:ask は executeCommand() を一切通らない', () => {
  const source = readServerSource('src/platforms/web.ts');
  const idx = source.indexOf(`case 'web:cross:ask'`);

  test(`case 'web:cross:ask' が存在する`, () => {
    assert.ok(idx > 0, 'web:cross:ask case not found');
  });

  const nextCaseIdx = source.indexOf(`case '`, idx + 20);
  const rawBody = source.slice(idx, nextCaseIdx > idx ? nextCaseIdx : idx + 3000);
  // コメント中の言及（「〜を一切呼ばない」という JSDoc 風コメント自体が関数名を含む）を
  // 実呼び出しと誤検出しないよう、コメントを除去してから検査する。
  const body = stripLineComments(rawBody);

  test('handleProjectConnect を呼ばない', () => {
    assert.doesNotMatch(body, /handleProjectConnect\(/);
  });
  test('parseCommandWithNLP を呼ばない', () => {
    assert.doesNotMatch(body, /parseCommandWithNLP\(/);
  });
  test('executeCommand を呼ばない', () => {
    assert.doesNotMatch(body, /executeCommand\(/);
  });
  test('payload.files を参照しない（クロス ask はファイル添付非対応）', () => {
    assert.doesNotMatch(body, /payload\.files/);
  });
  test('isCrossTeamEnabled と isCrossTeamChatEnabled の両方でガードされている', () => {
    assert.match(body, /isCrossTeamEnabled\(process\.env\.DEVRELAY_CROSS_TEAM\)/);
    assert.match(body, /isCrossTeamChatEnabled\(process\.env\.DEVRELAY_CROSS_TEAM_CHAT\)/);
  });
  test('findCrossTeamAskProjectById で宛先を解決する（新しい認可クエリを書かない）', () => {
    assert.match(body, /findCrossTeamAskProjectById\(/);
  });
});

describe('command-handler.ts: 既存の権限昇格の穴の修正（2026-11-09）が後退していない', () => {
  const source = readServerSource('src/services/command-handler.ts');

  test('handleProjectConnect は evaluateProjectOwnership を使う', () => {
    const idx = source.indexOf('export async function handleProjectConnect');
    assert.ok(idx > 0, 'handleProjectConnect not found');
    const body = source.slice(idx, idx + 1200);
    assert.match(body, /evaluateProjectOwnership\(/);
  });

  test('handleMachineConnect は userId で絞り込む', () => {
    const idx = source.indexOf('async function handleMachineConnect');
    assert.ok(idx > 0, 'handleMachineConnect not found');
    const body = source.slice(idx, idx + 600);
    assert.match(body, /userId:\s*dbUserId/);
  });

  test('handleProjectList は machine.userId で絞り込む', () => {
    const idx = source.indexOf('async function handleProjectList');
    assert.ok(idx > 0, 'handleProjectList not found');
    const body = source.slice(idx, idx + 800);
    assert.match(body, /machine:\s*\{\s*userId:\s*dbUserId\s*\}/);
  });
});

describe('cross-ask-runner.ts: executorUserId/requesterUserId の分離が守られている', () => {
  const source = readServerSource('src/services/cross-ask-runner.ts');

  test('executeCrossProjectQuery には executorUserId を渡す', () => {
    // JSDoc コメント中の言及（ファイル先頭の手順コメント）ではなく、実際の呼び出し箇所
    // （最後に出現する = 関数本体の呼び出し）を見る。
    const idx = source.lastIndexOf('executeCrossProjectQuery(');
    assert.ok(idx > 0, 'executeCrossProjectQuery call not found');
    const body = source.slice(idx, idx + 400);
    assert.match(body, /executorUserId/);
    // requesterUserId を実行者として渡す退行を検出する（rules/project.md の最重要設計判断）
    assert.doesNotMatch(body, /executeCrossProjectQuery\(\s*[\s\S]{0,300}requesterUserId\s*,?\s*\)/);
  });

  test('長さ検証（validateHumanTextLength）が関数の先頭、DB 書き込みより前にある', () => {
    const fnIdx = source.indexOf('export async function runCrossProjectAsk');
    const lengthIdx = source.indexOf('validateHumanTextLength(', fnIdx);
    const sessionCreateIdx = source.indexOf('prisma.session.create(', fnIdx);
    assert.ok(fnIdx > 0 && lengthIdx > fnIdx, 'validateHumanTextLength not found inside runCrossProjectAsk');
    assert.ok(sessionCreateIdx > lengthIdx, 'length check must precede session creation');
  });

  test('セッション採番は crossquery_ のまま（セルフレビューで撤回した非 ephemeral 化案が復活していない）', () => {
    assert.match(source, /`crossquery_\$\{crypto\.randomUUID\(\)\}`/);
    assert.doesNotMatch(source, /`crossask_/);
  });

  test('文脈前置（案 B）は neutralizeHumanInputTag を通す', () => {
    const idx = source.indexOf('buildCrossAskContextPrefix(');
    assert.ok(idx > 0, 'buildCrossAskContextPrefix call not found');
    const before = source.slice(Math.max(0, idx - 800), idx);
    assert.match(before, /neutralizeHumanInputTag\(/);
  });

  test('文脈前置は fenceIfHuman の外側に置く（fence の中に混ぜない）', () => {
    const fenceIdx = source.indexOf('fenceIfHuman(');
    const prefixIdx = source.indexOf('contextPrefix ?');
    assert.ok(fenceIdx > 0 && prefixIdx > 0, 'fence/prefix composition not found');
  });
});

describe('services/thread-scope.ts: クロス履歴フィルタの単一情報源', () => {
  const source = readServerSource('src/services/thread-scope.ts');

  test('buildCrossAskSessionIdFilter が crossquery_ プレフィックスを返す', () => {
    const idx = source.indexOf('export function buildCrossAskSessionIdFilter');
    assert.ok(idx > 0, 'buildCrossAskSessionIdFilter not found');
    const body = source.slice(idx, idx + 300);
    assert.match(body, /crossquery_/);
  });
});

describe('routes/api.ts: 新 2 ルートが独自の認可クエリを持たない', () => {
  const source = readServerSource('src/routes/api.ts');
  const idx = source.indexOf(`'/api/cross-team/ask-targets'`);
  const endIdx = source.indexOf(`'/api/cross-team/projects/:projectId/messages'`);

  test('両ルートが存在する', () => {
    assert.ok(idx > 0, 'ask-targets route not found');
    assert.ok(endIdx > idx, 'messages route not found');
  });

  const body = source.slice(idx, source.indexOf('\n  });', endIdx) + 10);

  test('listCrossTeamAskCandidateProjects() を呼ぶだけで、crossTeamGrant.findMany / teamSubscription.findMany を直接呼ばない', () => {
    assert.match(body, /listCrossTeamAskCandidateProjects\(/);
    assert.doesNotMatch(body, /crossTeamGrant\.findMany/);
    assert.doesNotMatch(body, /teamSubscription\.findMany/);
  });

  test('両ルートが isCrossTeamEnabled と isCrossTeamChatEnabled の AND でガードされている', () => {
    assert.match(body, /crossTeamChatFeatureEnabled\(\)/);
  });

  test('履歴ルートの where に requestedByUserId がある', () => {
    const msgIdx = source.indexOf(`'/api/cross-team/projects/:projectId/messages'`);
    const msgBody = source.slice(msgIdx, msgIdx + 1500);
    assert.match(msgBody, /requestedByUserId:\s*userId/);
  });
});

describe('Agent 3機種: G-2（クロス ask が所有者の work state を食う既存バグ）の修正', () => {
  for (const os of ['linux', 'macos', 'windows']) {
    test(`agents/${os}: loadWorkState は isEphemeral でガードされている`, () => {
      const source = readRepoSource(`agents/${os}/src/services/connection.ts`);
      const idx = source.indexOf('loadWorkState(projectPath)');
      assert.ok(idx > 0, `loadWorkState call not found in agents/${os}`);
      const before = source.slice(Math.max(0, idx - 200), idx);
      assert.match(before, /isEphemeral\s*\?\s*null\s*:/, `agents/${os} loadWorkState call is not guarded by isEphemeral`);
    });
  }
});
