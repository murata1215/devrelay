// スレッド状態バッジ（プラン作成済み/実行済み/回答済み）: 配線（wiring）のソース静的ガード。
// web-command-persistence-wiring.test.mjs / knowledge-wiring.test.mjs と同じ手口
// （node:fs のみ。dist/ には依存しない）。
//
// 目的:
// 1. agent-manager.ts の handleAiOutput() が、保存・ライブ配信の両方で「印を取り除いた本文」を
//    使っていること（生の HTML コメント行がユーザーに見える事故を防ぐ）。
// 2. 同関数が exec 完了を execCompletedAt、プラン印検出を planReadyAt に記録していること
//    （AI の文章ではなく自身が検知した事実のみを記録するという設計を固定する）。
// 3. sendPromptToAgent()（plan ターン経路）にだけプラン印の指示文を前置し、
//    execConversation()（exec ターン経路）には前置しないこと（exec に印の指示を出す意味は無い）。
// 4. GET /api/threads が turnState を返すこと。

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

/** `functionName` の関数本体（次のトップレベル関数定義の手前まで）を source から切り出す。 */
function extractFunctionBody(source, functionName) {
  const re = new RegExp(`(?:export\\s+)?async function ${functionName}\\(`);
  const match = re.exec(source);
  assert.ok(match, `${functionName} が見つからない`);
  const start = match.index;
  const nextFunctionRe = /\n(?:export\s+)?async function \w+\(/g;
  nextFunctionRe.lastIndex = start + match[0].length;
  const next = nextFunctionRe.exec(source);
  const end = next ? next.index : source.length;
  return source.slice(start, end);
}

describe('agent-manager.ts: thread-state-rules の import', () => {
  const source = readServerSource('src/services/agent-manager.ts');

  test('isThreadStateBadgeEnabled / hasPlanMarkerLine / stripPlanMarkerLine / PLAN_MARKER_PROMPT_LINE を import している', () => {
    assert.match(source, /from '\.\/thread-state-rules\.js'/);
    assert.match(source, /isThreadStateBadgeEnabled/);
    assert.match(source, /hasPlanMarkerLine/);
    assert.match(source, /stripPlanMarkerLine/);
    assert.match(source, /PLAN_MARKER_PROMPT_LINE/);
  });
});

describe('agent-manager.ts: handleAiOutput() が印を取り除いた本文を使う', () => {
  const source = readServerSource('src/services/agent-manager.ts');
  const body = extractFunctionBody(source, 'handleAiOutput');

  test('DB 保存（contentWithContext）は outputForSave を使う（生の output を直接使わない）', () => {
    assert.match(body, /contentWithContext\s*=\s*contextPrefix\s*\+\s*mark\s*\+\s*outputForSave/);
  });

  test('ライブ配信（finalizeProgress）も outputForSave を使う', () => {
    assert.match(body, /finalizeProgress\(sessionId,\s*mark\s*\+\s*outputForSave/);
  });

  test('outputForSave は stateBadgeEnabled のときだけ stripPlanMarkerLine を通す', () => {
    assert.match(body, /stripPlanMarkerLine\(output\)/);
  });

  test('exec ターン完了時に execCompletedAt を記録する（execCompletedAt: null の atomic claim）', () => {
    assert.match(body, /execCompletedAt:\s*null\s*\},\s*\n\s*data:\s*\{\s*execCompletedAt:\s*new Date\(\)/);
  });

  test('プラン印検出時に planReadyAt を記録する（既に executed なら claim しない）', () => {
    assert.match(body, /execCompletedAt:\s*null,\s*planReadyAt:\s*null\s*\},\s*\n\s*data:\s*\{\s*planReadyAt:\s*new Date\(\)/);
  });

  test('BuildLog 作成条件の判定は raw output.trim() のまま（outputForSave に差し替えていない）', () => {
    assert.match(body, /isExec && \(output\.trim\(\) \|\| truncated\)/);
  });
});

describe('agent-manager.ts: プラン印の前置は plan ターン経路（sendPromptToAgent）にのみ存在する', () => {
  const source = readServerSource('src/services/agent-manager.ts');

  test('sendPromptToAgent() は PLAN_MARKER_PROMPT_LINE を前置する（BRIEF_REPLY と同じガード条件）', () => {
    const body = extractFunctionBody(source, 'sendPromptToAgent');
    assert.match(body, /isThreadStateBadgeEnabled\(process\.env\.DEVRELAY_THREAD_STATE_BADGE\)/);
    assert.match(body, /promptToSend = `\$\{PLAN_MARKER_PROMPT_LINE\}/);
  });

  test('execConversation() には前置しない（exec ターンに印の指示を出さない）', () => {
    const body = extractFunctionBody(source, 'execConversation');
    assert.doesNotMatch(body, /PLAN_MARKER_PROMPT_LINE/);
  });
});

describe('GET /api/threads: turnState を返す', () => {
  const source = readServerSource('src/routes/api.ts');

  test('thread-state-rules.ts を import している', () => {
    assert.match(source, /from '\.\.\/services\/thread-state-rules\.js'/);
    assert.match(source, /isThreadStateBadgeEnabled/);
    assert.match(source, /resolveThreadState/);
  });

  test('レスポンスの各行に turnState を含む', () => {
    assert.match(source, /turnState:\s*resolveThreadState\(/);
  });

  test('追加クエリを増やさない（hasAiMessage は既存の firstBySessionRole 由来）', () => {
    assert.match(source, /hasAiMessage:\s*first\?\.ai !== undefined/);
  });
});
