// サイクル3.1: Agent 自己更新の busy 判定（実行中ターン台帳）の配線（wiring）のソース静的ガード
// （node:fs、dist/ には依存しない。knowledge-wiring.test.mjs / mcp-ask-source-guard.test.mjs と同じ手口）。
//
// これが無いと、将来のリファクタで以下が黙って外れても気づけない:
// - agent-manager.ts の 4 つの送信点（sendPromptToAgent/execConversation/sendRawPromptToAgent/
//   applyAgreement）のいずれかで inFlightTurns.start() が外れる（根本原因の再発）
// - 解除点（handleAiOutput/handleAiCancelled/handleAgentDisconnect）のいずれかで end()/clearMachine()
//   が外れ、busy 判定が永久に true になり続ける（Agent が一生更新されなくなる）
// - handleUpdateStatus の 'deferred' 分岐が外れ、D3（attempts を数えない）が崩れる
// - server:agent:update の payload に force が紛れ込み、Agent 側が「サーバーが force を伝える」前提で
//   実装される事故（C5: Agent 側は常に安全側であるべき）
// - DEVRELAY_UPDATE_BUSY_GUARD キルスイッチが外れる
// - agents/linux と agents/macos の update-guard-rules.ts が byte-for-byte 同一でなくなる

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

function readRepoFile(relPath) {
  return readFileSync(path.join(repoRoot, relPath), 'utf8');
}

describe('agent-manager.ts: 実行中ターン台帳への登録（送信点 4 箇所）', () => {
  const source = readServerSource('src/services/agent-manager.ts');

  test('in-flight-turns.ts / update-busy-rules.ts を import している', () => {
    assert.match(source, /import\s*\{\s*inFlightTurns\s*\}\s*from\s*['"]\.\/in-flight-turns\.js['"]/);
    assert.match(source, /import\s*\{\s*isUpdateBusyGuardEnabled\s*\}\s*from\s*['"]\.\/update-busy-rules\.js['"]/);
  });

  test('sendPromptToAgent: server:ai:prompt 送信前に inFlightTurns.start( がある', () => {
    const idx = source.indexOf(`type: 'server:ai:prompt'`);
    assert.ok(idx > 0, 'server:ai:prompt の送信箇所が見つからない');
    const before = source.slice(Math.max(0, idx - 800), idx);
    assert.match(before, /inFlightTurns\.start\(/);
  });

  test('execConversation: server:conversation:exec 送信前に inFlightTurns.start( がある', () => {
    const idx = source.indexOf(`type: 'server:conversation:exec'`);
    assert.ok(idx > 0, 'server:conversation:exec の送信箇所が見つからない');
    const before = source.slice(Math.max(0, idx - 800), idx);
    assert.match(before, /inFlightTurns\.start\(/);
  });

  test('sendRawPromptToAgent: server:raw:prompt 送信前に inFlightTurns.start( があり、.finally で end( している', () => {
    const idx = source.indexOf(`type: 'server:raw:prompt'`);
    assert.ok(idx > 0, 'server:raw:prompt の送信箇所が見つからない');
    const before = source.slice(Math.max(0, idx - 500), idx);
    assert.match(before, /inFlightTurns\.start\(/);
    const after = source.slice(idx, idx + 500);
    assert.match(after, /\.finally\(\(\)\s*=>\s*\{\s*inFlightTurns\.end\(/);
  });

  test('applyAgreement: server:agreement:apply 送信前に inFlightTurns.start( がある', () => {
    const idx = source.indexOf(`type: 'server:agreement:apply'`);
    assert.ok(idx > 0, 'server:agreement:apply の送信箇所が見つからない');
    const before = source.slice(Math.max(0, idx - 500), idx);
    assert.match(before, /inFlightTurns\.start\(/);
  });

  test('全ての start( 呼び出しが isUpdateBusyGuardEnabled でガードされている（素の呼び出しが無い）', () => {
    // "inFlightTurns.start(" の直前（800文字以内）に isUpdateBusyGuardEnabled がない出現が無いことを確認
    const re = /inFlightTurns\.start\(/g;
    let m;
    let count = 0;
    while ((m = re.exec(source)) !== null) {
      count++;
      const before = source.slice(Math.max(0, m.index - 400), m.index);
      assert.match(before, /isUpdateBusyGuardEnabled\(process\.env\.DEVRELAY_UPDATE_BUSY_GUARD\)/,
        `inFlightTurns.start( at offset ${m.index} is not guarded by isUpdateBusyGuardEnabled`);
    }
    assert.equal(count, 4, `expected exactly 4 inFlightTurns.start( call sites, found ${count}`);
  });
});

describe('agent-manager.ts: 実行中ターン台帳の解除（handleAiOutput / handleAiCancelled / 切断）', () => {
  const source = readServerSource('src/services/agent-manager.ts');

  test('handleAiOutput の isComplete 分岐内に inFlightTurns.end( がある', () => {
    const fnIdx = source.indexOf('async function handleAiOutput');
    assert.ok(fnIdx > 0);
    const isCompleteIdx = source.indexOf('if (isComplete)', fnIdx);
    assert.ok(isCompleteIdx > 0);
    const body = source.slice(isCompleteIdx, isCompleteIdx + 400);
    assert.match(body, /inFlightTurns\.end\(/);
  });

  test('handleAiCancelled に inFlightTurns.end( がある', () => {
    const fnIdx = source.indexOf('async function handleAiCancelled');
    assert.ok(fnIdx > 0);
    const body = source.slice(fnIdx, fnIdx + 600);
    assert.match(body, /inFlightTurns\.end\(/);
  });

  test('handleAgentDisconnect に inFlightTurns.clearMachine( がある（取りこぼし経路の保険）', () => {
    const fnIdx = source.indexOf('async function handleAgentDisconnect');
    assert.ok(fnIdx > 0);
    const body = source.slice(fnIdx, fnIdx + 1200);
    assert.match(body, /inFlightTurns\.clearMachine\(/);
  });
});

describe('agent-manager.ts: handleUpdateStatus の deferred 分岐・未知 status の扱い', () => {
  const source = readServerSource('src/services/agent-manager.ts');

  test(`status === 'deferred' の分岐がある`, () => {
    const fnIdx = source.indexOf('async function handleUpdateStatus');
    assert.ok(fnIdx > 0);
    const body = source.slice(fnIdx, fnIdx + 2000);
    assert.match(body, /status === 'deferred'/);
  });

  test('deferred 受信時、手動起点（pendingUpdateNotify あり）は autoUpdateAttempts を触らない分岐がある', () => {
    const fnIdx = source.indexOf('async function handleUpdateStatus');
    const body = source.slice(fnIdx, fnIdx + 2000);
    assert.match(body, /pendingUpdateNotify\.has\(machineId\)/);
  });

  test('自動更新起点では recordAutoUpdateDeferred を呼ぶ', () => {
    const fnIdx = source.indexOf('async function handleUpdateStatus');
    const body = source.slice(fnIdx, fnIdx + 2000);
    assert.match(body, /recordAutoUpdateDeferred/);
  });

  test('未知 status は warn ログのみ（attempts を増やす呼び出しが無い）', () => {
    const fnIdx = source.indexOf('async function handleUpdateStatus');
    const fnEnd = source.indexOf('\n}', fnIdx);
    const body = source.slice(fnIdx, fnEnd);
    assert.match(body, /console\.warn/);
  });
});

describe('agent-manager.ts: server:agent:update の payload に force を送らない（C5: Agent 側は常に安全側）', () => {
  const source = readServerSource('src/services/agent-manager.ts');

  test('updateAgent() の server:agent:update payload は空オブジェクト', () => {
    const idx = source.indexOf('export function updateAgent(');
    assert.ok(idx > 0);
    const body = source.slice(idx, idx + 800);
    const sendIdx = body.indexOf(`type: 'server:agent:update'`);
    assert.ok(sendIdx > 0);
    const after = body.slice(sendIdx, sendIdx + 60);
    assert.match(after, /payload:\s*\{\s*\}/);
  });

  test('updateAgentAuto() の server:agent:update payload も空オブジェクト', () => {
    const idx = source.indexOf('export function updateAgentAuto(');
    assert.ok(idx > 0);
    const body = source.slice(idx, idx + 300);
    assert.match(body, /payload:\s*\{\s*\}/);
  });
});

describe('auto-updater.ts: sweepStale 呼び出し・isMachineBusyWithReason の存在', () => {
  const source = readServerSource('src/services/auto-updater.ts');

  test('定期スイープの run() 冒頭で inFlightTurns.sweepStale( を呼ぶ', () => {
    assert.match(source, /inFlightTurns\.sweepStale\(/);
  });

  test('isMachineBusyWithReason がエクスポートされている', () => {
    assert.match(source, /export\s+async\s+function\s+isMachineBusyWithReason\(/);
  });

  test('isMachineBusy は isMachineBusyWithReason に委譲する薄いラッパ（既存シグネチャ非破壊）', () => {
    const idx = source.indexOf('export async function isMachineBusy(');
    assert.ok(idx > 0);
    const body = source.slice(idx, idx + 300);
    assert.match(body, /isMachineBusyWithReason\(machineId\)/);
  });

  test('recordAutoUpdateDeferred がエクスポートされている（C3: attempts ロールバック）', () => {
    assert.match(source, /export\s+async\s+function\s+recordAutoUpdateDeferred\(/);
  });
});

describe('command-handler.ts: 手動 `u` の busy ガード（D4、2026-10-24 自家中毒修正・force 一発化）', () => {
  const source = readServerSource('src/services/command-handler.ts');

  test('handleUpdate は force 引数を受け取る', () => {
    assert.match(source, /async function handleUpdate\(context: UserContext, force: boolean/);
  });

  test('getMachineBusyState / decideManualUpdate を使っている（isMachineBusyWithReason の素の文字列判定はやめた）', () => {
    const fnIdx = source.indexOf('async function handleUpdate(');
    const body = source.slice(fnIdx, fnIdx + 1500);
    assert.match(body, /getMachineBusyState\(/);
    assert.match(body, /decideManualUpdate\(/);
    assert.doesNotMatch(body, /isMachineBusyWithReason\(/);
  });

  test('busy hold 時に理由を 1 行ログ出力している（観測性）', () => {
    const fnIdx = source.indexOf('async function handleUpdate(');
    const body = source.slice(fnIdx, fnIdx + 1500);
    assert.match(body, /console\.log\(`⏸️ \[u\] held for/);
  });

  test('resolveDeferredBusyMessage を使って理由別キーを返している', () => {
    const fnIdx = source.indexOf('async function handleUpdate(');
    const body = source.slice(fnIdx, fnIdx + 1500);
    assert.match(body, /resolveDeferredBusyMessage\(/);
  });

  test(`update.deferredBusy（フォールバック）を update-busy-rules.ts 側で使っている`, () => {
    const rulesSource = readServerSource('src/services/update-busy-rules.ts');
    assert.match(rulesSource, /'update\.deferredBusy'/);
  });

  test('update コマンドの dispatch で command.force を渡している', () => {
    assert.match(source, /handleUpdate\(context, command\.force/);
  });

  test('`u force` 一発化: decideUpdateFlow を使い、execute 時は pendingUpdate を経由せず runUpdateNow を呼ぶ', () => {
    const fnIdx = source.indexOf('async function handleUpdate(');
    const fnEnd = source.indexOf('\nasync function handleQuit', fnIdx);
    const body = source.slice(fnIdx, fnEnd > 0 ? fnEnd : fnIdx + 4000);
    assert.match(body, /decideUpdateFlow\(/);
    assert.match(body, /flow === 'execute'/);
    assert.match(body, /runUpdateNow\(/);
  });
});

describe('routes/api.ts: POST /api/machines/:id/restart の busy ガード（D8/C4、2026-10-24 自家中毒修正）', () => {
  const source = readRepoFile('apps/server/src/routes/api.ts');

  test('restart ルートに getMachineBusyState / decideManualUpdate がある（isMachineBusyWithReason の素の文字列判定はやめた）', () => {
    const idx = source.indexOf(`/api/machines/:id/restart`);
    assert.ok(idx > 0);
    const body = source.slice(idx, idx + 2000);
    assert.match(body, /getMachineBusyState\(/);
    assert.match(body, /decideManualUpdate\(/);
    assert.match(body, /reply\.status\(409\)/);
    assert.doesNotMatch(body, /isMachineBusyWithReason\(/);
  });

  test('busy hold 時に理由を 1 行ログ出力している（観測性）', () => {
    const idx = source.indexOf(`/api/machines/:id/restart`);
    const body = source.slice(idx, idx + 2000);
    assert.match(body, /console\.log\(`⏸️ \[restart\] held for/);
  });

  test('buildBusyHoldApiMessage を使って 409 本文を組み立てている', () => {
    const idx = source.indexOf(`/api/machines/:id/restart`);
    const body = source.slice(idx, idx + 2000);
    assert.match(body, /buildBusyHoldApiMessage\(/);
  });
});

describe('auto-updater.ts: busy 判定の自家中毒修正（2026-10-24）', () => {
  const source = readServerSource('src/services/auto-updater.ts');

  test('getMachineBusyState がエクスポートされている（新しい単一情報源）', () => {
    assert.match(source, /export\s+async\s+function\s+getMachineBusyState\(/);
  });

  test('isMachineBusyWithReason は getMachineBusyState + formatBusyReason に委譲する薄いラッパ', () => {
    const idx = source.indexOf('export async function isMachineBusyWithReason(');
    assert.ok(idx > 0);
    const body = source.slice(idx, idx + 300);
    assert.match(body, /formatBusyReason\(await getMachineBusyState\(machineId\)\)/);
  });

  test('recent activity の判定が buildRecentAiActivityWhere( 経由（role 限定の配線固定）', () => {
    const idx = source.indexOf('export async function getMachineBusyState(');
    assert.ok(idx > 0);
    const body = source.slice(idx, idx + 2000);
    assert.match(body, /buildRecentAiActivityWhere\(/);
  });

  test('session running の判定が isSessionRunning ではなく getProgressTrackerAgeMs + RUNNING_FRESHNESS_MS（鮮度ベース）', () => {
    const idx = source.indexOf('export async function getMachineBusyState(');
    assert.ok(idx > 0);
    const body = source.slice(idx, idx + 2000);
    assert.match(body, /getProgressTrackerAgeMs\(/);
    assert.match(body, /RUNNING_FRESHNESS_MS/);
    assert.doesNotMatch(source, /isSessionRunning\(/);
  });
});

describe('agent-manager.ts: handleAgentConnect での台帳掃除（再接続時の取りこぼし対策、2026-10-24）', () => {
  const source = readServerSource('src/services/agent-manager.ts');

  test('handleAgentConnect 内（connectedAgents.set の後）に inFlightTurns.clearMachine( がある', () => {
    const fnIdx = source.indexOf('async function handleAgentConnect(');
    assert.ok(fnIdx > 0);
    const setIdx = source.indexOf('connectedAgents.set(machine.id, ws);', fnIdx);
    assert.ok(setIdx > 0);
    const after = source.slice(setIdx, setIdx + 600);
    assert.match(after, /isUpdateBusyGuardEnabled\(process\.env\.DEVRELAY_UPDATE_BUSY_GUARD\)/);
    assert.match(after, /inFlightTurns\.clearMachine\(/);
  });
});

describe('command-parser.ts / natural-language-parser.ts: `u force` / `u!`', () => {
  test('command-parser.ts が `u force`/`u!` を { type: \'update\', force: true } にパースする', () => {
    const source = readServerSource('src/services/command-parser.ts');
    assert.match(source, /type:\s*'update',\s*force:\s*true/);
  });

  test('natural-language-parser.ts の isTraditionalCommand が `u force`/`u!` を拾う', () => {
    const source = readServerSource('src/services/natural-language-parser.ts');
    const fnIdx = source.indexOf('export function isTraditionalCommand');
    assert.ok(fnIdx > 0);
    const body = source.slice(fnIdx, fnIdx + 2000);
    assert.match(body, /u\(\?:pdate\)\?\(\?:\\s\+force\|!\)\$/);
  });
});

describe('packages/shared/src/types.ts: status 型に deferred・UserCommand に force', () => {
  const source = readRepoFile('packages/shared/src/types.ts');

  test(`AgentUpdateStatusPayload.status に 'deferred' が追加されている`, () => {
    assert.match(source, /status:\s*'started'\s*\|\s*'error'\s*\|\s*'deferred'/);
  });

  test(`UserCommand の update バリアントに force?: boolean がある`, () => {
    assert.match(source, /\{\s*type:\s*'update';\s*force\?:\s*boolean\s*\}/);
  });
});

describe('agents/linux と agents/macos の update-guard-rules.ts は byte-for-byte 同一', () => {
  test('同一内容である（resume-priority.ts と同じ流儀）', () => {
    const linux = readRepoFile('agents/linux/src/services/update-guard-rules.ts');
    const macos = readRepoFile('agents/macos/src/services/update-guard-rules.ts');
    assert.equal(linux, macos);
  });
});

describe('agents/linux と agents/macos の connection.ts: D2（Agent 側保留）の配線', () => {
  for (const osName of ['linux', 'macos']) {
    test(`${osName}: handleAgentUpdate が decideAgentUpdateAction を使っている`, () => {
      const source = readRepoFile(`agents/${osName}/src/services/connection.ts`);
      const fnIdx = source.indexOf('async function handleAgentUpdate');
      assert.ok(fnIdx > 0);
      const body = source.slice(fnIdx, fnIdx + 4000);
      assert.match(body, /decideAgentUpdateAction\(/);
      assert.match(body, /status:\s*'deferred'/);
    });

    test(`${osName}: agent:version:info の成功 payload に activeAiTurns がある`, () => {
      const source = readRepoFile(`agents/${osName}/src/services/connection.ts`);
      const idx = source.indexOf(`type: 'agent:version:info'`);
      assert.ok(idx > 0);
      const body = source.slice(idx, idx + 400);
      assert.match(body, /activeAiTurns:\s*getActiveAiTurnCount\(\)/);
    });
  }
});

describe('agents/windows: server:agent:update を処理しない（対象外、0 行変更）', () => {
  test('windows/src に agent:update 関連の記述が無い', () => {
    const source = readRepoFile('agents/windows/src/services/connection.ts');
    assert.doesNotMatch(source, /server:agent:update/);
    assert.doesNotMatch(source, /handleAgentUpdate/);
  });
});
