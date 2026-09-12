import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  decideSessionReactivation,
  decideEndedRevival,
  decideSessionInfoPush,
} from '../dist/services/thread-reestablish.js';

/**
 * スレッド管理 サイクル6（事象1〜3 修正）:
 * - 事象1（送信が既定スレッドではなく新規スレッドに入る）
 * - 事象2（生中継が2スレッドに出る）
 * - 事象3（空 ended セッションの増殖）
 * の3つを、純ロジック（decideSessionReactivation / decideEndedRevival / decideSessionInfoPush）の
 * 単体テストと、`command-handler.ts` のソースを直接読む静的ガード（node:fs、dist/ には依存しない。
 * thread-list-query.test.mjs と同じ流儀）の2本立てで固定する。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');

function readServerSource(relPath) {
  return readFileSync(path.join(serverRoot, relPath), 'utf8');
}

describe('decideSessionReactivation（Fix A: ended だった旧セッションの復帰）', () => {
  test('status=ended なら active + endedAt:null に戻すべきと判定する', () => {
    const result = decideSessionReactivation({ status: 'ended' });
    assert.deepEqual(result, { shouldReactivate: true, data: { status: 'active', endedAt: null } });
  });

  test('status=active なら何もしない', () => {
    const result = decideSessionReactivation({ status: 'active' });
    assert.deepEqual(result, { shouldReactivate: false });
  });

  test('未知の status（将来値が増えても ended 以外は触らない）', () => {
    const result = decideSessionReactivation({ status: 'archived' });
    assert.deepEqual(result, { shouldReactivate: false });
  });
});

describe('decideEndedRevival（Fix C: //connect の ended 復活は preferredThreadId 一致のみ）', () => {
  test('preferredThreadId が ended 候補に含まれていれば復活する', () => {
    const result = decideEndedRevival({
      preferredThreadId: 'sess-prev',
      endedCandidateIds: ['sess-prev', 'sess-other'],
    });
    assert.deepEqual(result, { action: 'revive', sessionId: 'sess-prev' });
  });

  test('preferredThreadId が null なら候補があっても常に新規作成（最新の ended を勝手に選ばない）', () => {
    const result = decideEndedRevival({
      preferredThreadId: null,
      endedCandidateIds: ['sess-latest-ended', 'sess-older-ended'],
    });
    assert.deepEqual(result, { action: 'createNew' });
  });

  test('preferredThreadId が ended 候補に含まれない（別プロジェクトのセッション等）なら新規作成', () => {
    const result = decideEndedRevival({
      preferredThreadId: 'sess-unrelated',
      endedCandidateIds: ['sess-a', 'sess-b'],
    });
    assert.deepEqual(result, { action: 'createNew' });
  });

  test('ended 候補が0件なら常に新規作成', () => {
    const result = decideEndedRevival({ preferredThreadId: 'sess-prev', endedCandidateIds: [] });
    assert.deepEqual(result, { action: 'createNew' });
  });

  // 「最新の ended を復活」ではなく「preferredThreadId に一致する ended のみ復活」であることの回帰検知。
  // 24h アイドルスイープの対象である無関係な古い ended スレッドまで復活させてしまうと、
  // スイープが機能しなくなる。
  test('複数の ended 候補があっても、一致しない限り最新のものを勝手に選ばない', () => {
    const result = decideEndedRevival({
      preferredThreadId: 'sess-mid',
      endedCandidateIds: ['sess-oldest', 'sess-mid', 'sess-newest'],
    });
    assert.deepEqual(result, { action: 'revive', sessionId: 'sess-mid' });
  });
});

describe('decideEndedRevival: サイクルC（案3-1a）machineOnline による緩和（②）', () => {
  // 【最重要・退行ガード】machineOnline 省略/true のときは①と createNew しか通らない
  // = 69bcd3e と数学的に同一であることを、既存の①系テストと同じ入力の組み合わせで再確認する。
  test('machineOnline 省略（undefined）は従来と同じ結果（mostRecentEndedId があっても無視）', () => {
    const result = decideEndedRevival({
      preferredThreadId: null,
      endedCandidateIds: ['sess-a', 'sess-b'],
      mostRecentEndedId: 'sess-b',
    });
    assert.deepEqual(result, { action: 'createNew' });
  });

  test('machineOnline: true は従来と同じ結果（mostRecentEndedId があっても無視）', () => {
    const result = decideEndedRevival({
      preferredThreadId: null,
      endedCandidateIds: ['sess-a', 'sess-b'],
      machineOnline: true,
      mostRecentEndedId: 'sess-b',
    });
    assert.deepEqual(result, { action: 'createNew' });
  });

  test('machineOnline: false かつ preferredThreadId 不一致（①失敗）なら mostRecentEndedId を復活させる（②）', () => {
    const result = decideEndedRevival({
      preferredThreadId: null,
      endedCandidateIds: ['sess-a', 'sess-b'],
      machineOnline: false,
      mostRecentEndedId: 'sess-b',
    });
    assert.deepEqual(result, { action: 'revive', sessionId: 'sess-b' });
  });

  test('machineOnline: false でも preferredThreadId 一致（①）があればそちらを優先する', () => {
    const result = decideEndedRevival({
      preferredThreadId: 'sess-a',
      endedCandidateIds: ['sess-a', 'sess-b'],
      machineOnline: false,
      mostRecentEndedId: 'sess-b',
    });
    assert.deepEqual(result, { action: 'revive', sessionId: 'sess-a' });
  });

  test('machineOnline: false でも mostRecentEndedId が null/未指定なら新規作成', () => {
    const result = decideEndedRevival({
      preferredThreadId: null,
      endedCandidateIds: ['sess-a'],
      machineOnline: false,
      mostRecentEndedId: null,
    });
    assert.deepEqual(result, { action: 'createNew' });
  });

  test('machineOnline: false でも endedCandidateIds が空なら新規作成（mostRecentEndedId 自体が無いはず）', () => {
    const result = decideEndedRevival({
      preferredThreadId: null,
      endedCandidateIds: [],
      machineOnline: false,
    });
    assert.deepEqual(result, { action: 'createNew' });
  });
});

describe('decideSessionInfoPush（Fix B: web:session_info 再送要否）', () => {
  test('前後で currentSessionId が変わっていれば再送すべき', () => {
    const result = decideSessionInfoPush({ beforeSessionId: 'a', afterSessionId: 'b' });
    assert.deepEqual(result, { shouldPush: true });
  });

  test('前後で同じなら再送不要', () => {
    const result = decideSessionInfoPush({ beforeSessionId: 'a', afterSessionId: 'a' });
    assert.deepEqual(result, { shouldPush: false });
  });

  test('afterSessionId が null（未接続のまま）なら再送不要', () => {
    const result = decideSessionInfoPush({ beforeSessionId: 'a', afterSessionId: null });
    assert.deepEqual(result, { shouldPush: false });
  });

  test('beforeSessionId が null で afterSessionId がある（新規接続）なら再送すべき', () => {
    const result = decideSessionInfoPush({ beforeSessionId: null, afterSessionId: 'a' });
    assert.deepEqual(result, { shouldPush: true });
  });

  test('両方 null なら再送不要', () => {
    const result = decideSessionInfoPush({ beforeSessionId: null, afterSessionId: null });
    assert.deepEqual(result, { shouldPush: false });
  });
});

describe('静的ガード: command-handler.ts の再確立ブロックに createSession( が再混入していない（事象1回帰検知）', () => {
  const source = readServerSource('src/services/command-handler.ts');

  // isAgentRestarted(context.currentMachineId) 〜 「Session re-established」ログ行までの各ブロックを
  // 機械的に抽出する（interactive 経路・exec 経路の2箇所が対象）。
  // 終端マーカーに clearAgentRestarted(context.currentMachineId) を使わないのは、各ブロックの内部に
  // `if (!oldSession) { clearAgentRestarted(...); return ...; }` という早期リターンがあり、
  // そちらの呼び出しの方が先に出現してブロックを途中で打ち切ってしまうため
  // （decideSessionReactivation( 等の本体ロジックはこの早期リターンより後にある）。
  function extractReestablishBlocks(src) {
    const startMarker = 'isAgentRestarted(context.currentMachineId)';
    const endMarker = 'Session re-established';
    const blocks = [];
    let searchFrom = 0;
    while (true) {
      const startIdx = src.indexOf(startMarker, searchFrom);
      if (startIdx === -1) break;
      const endIdx = src.indexOf(endMarker, startIdx);
      if (endIdx === -1) break;
      blocks.push(src.slice(startIdx, endIdx + endMarker.length));
      searchFrom = endIdx + endMarker.length;
    }
    return blocks;
  }

  const blocks = extractReestablishBlocks(source);

  test('再確立ブロックが2箇所（interactive経路 handleAiPrompt + exec経路 handleExec）見つかる（テスト自体が空振りしていないことの確認）', () => {
    assert.equal(blocks.length, 2, `期待した2ブロックと異なる件数が見つかった: ${blocks.length}`);
  });

  test('どの再確立ブロックにも createSession( が含まれない（新規 Session 行を作らない）', () => {
    const offenders = blocks
      .map((block, i) => ({ i, hasCreateSession: block.includes('createSession(') }))
      .filter((b) => b.hasCreateSession);
    assert.deepEqual(offenders, [], `createSession( が再混入しているブロックが見つかった: ${JSON.stringify(offenders)}`);
  });

  test('どの再確立ブロックにも decideSessionReactivation( の呼び出しがある（Fix A の配線確認）', () => {
    const missing = blocks
      .map((block, i) => ({ i, hasReactivation: block.includes('decideSessionReactivation(') }))
      .filter((b) => !b.hasReactivation);
    assert.deepEqual(missing, [], `decideSessionReactivation( 呼び出しが無いブロックが見つかった: ${JSON.stringify(missing)}`);
  });
});

describe('静的ガード: handleProjectConnect が decideEndedRevival( を使っている（事象3の配線確認）', () => {
  const source = readServerSource('src/services/command-handler.ts');

  test('decideEndedRevival( の呼び出しが存在する', () => {
    assert.match(source, /decideEndedRevival\(/);
  });

  test('「最新の ended」ロジック（orderBy: startedAt desc 等で ended を直接選ぶコード）が復活可否の判定に使われていない', () => {
    // decideEndedRevival 呼び出しの直前一定範囲に「ended の候補を sort/orderBy して先頭を選ぶ」ような
    // 独自ロジックが追加で紛れ込んでいないことの簡易チェック。
    // （decideEndedRevival の呼び出し自体が preferredThreadId 一致のみを見る設計であることは
    //   上の decideEndedRevival 単体テストで固定済み。ここでは呼び出し側がその結果を尊重して
    //   `revival.action === 'revive'` の分岐だけで sessionId を決めていることを確認する）
    const idx = source.indexOf('decideEndedRevival(');
    assert.notEqual(idx, -1);
    const after = source.slice(idx, idx + 800);
    assert.match(after, /revival\.action === 'revive'/);
  });

  test('サイクルC: decideEndedRevival( 呼び出しに machineOnline と mostRecentEndedId が配線されている', () => {
    const idx = source.indexOf('decideEndedRevival(');
    assert.notEqual(idx, -1);
    const call = source.slice(idx, idx + 400);
    assert.match(call, /machineOnline/);
    assert.match(call, /mostRecentEndedId/);
  });
});

describe('静的ガード: mcp 経由の origin:\'mcp\' createSession は本サイクルで無変更（回帰検知）', () => {
  test('apps/server/src/mcp 配下に origin: \'mcp\' を渡す createSession 呼び出しが残っている', () => {
    const source = readServerSource('src/mcp/tools.ts');
    assert.match(source, /createSession\(/);
    assert.match(source, /origin:\s*'mcp'/);
  });
});
