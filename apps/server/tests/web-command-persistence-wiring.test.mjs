// WebUI のコマンド応答が消える問題の根治（2026-10-18）: 配線（wiring）のソース静的ガード。
// knowledge-wiring.test.mjs / thread-list-filter.test.mjs と同じ手口（node:fs、dist/ には依存しない）。
//
// web-command-persistence.ts の SELF_PERSISTING_TYPES は「command-handler.ts 側のハンドラが
// 自前で prisma.message.create を呼ぶ」ことを前提に除外している。将来の実装変更で
// どちらかが崩れると二重保存（SELF_PERSISTING_TYPES から外れた）/ 保存漏れ（ハンドラが
// 保存をやめたのに本モジュールが除外したまま）が黙って発生するため、対応関係を固定する。

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

/** `functionName` の関数本体（次の `async function` 定義の手前まで）を source から切り出す。 */
function extractFunctionBody(source, functionName) {
  const startMarker = `async function ${functionName}(`;
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `${functionName} が見つからない`);
  const nextFunctionIndex = source.indexOf('\nasync function ', start + startMarker.length);
  const end = nextFunctionIndex > 0 ? nextFunctionIndex : source.length;
  return source.slice(start, end);
}

describe('command-handler.ts: SELF_PERSISTING_TYPES 対応ハンドラが自前で message.create している', () => {
  const source = readServerSource('src/services/command-handler.ts');

  // web-command-persistence.ts の SELF_PERSISTING_TYPES と1対1で対応させる
  // （command type → ハンドラ関数名のマッピングは executeCommand() のディスパッチと一致させること）
  const handlersByType = {
    exec: 'handleExec',
    agreement: 'handleAgreement',
    'ai:prompt': 'handleAiPrompt',
    'ask:member': 'handleAskMember',
    'teamexec:member': 'handleTeamExec',
  };

  for (const [commandType, functionName] of Object.entries(handlersByType)) {
    test(`${commandType} → ${functionName} は prisma.message.create を自前で呼ぶ`, () => {
      const body = extractFunctionBody(source, functionName);
      assert.match(body, /prisma\.message\.create\(/, `${functionName} 内に prisma.message.create が見つからない`);
    });
  }
});

describe('web-command-persistence.ts: SELF_PERSISTING_TYPES の宣言', () => {
  const source = readServerSource('src/services/web-command-persistence.ts');

  test('SELF_PERSISTING_TYPES に exec/agreement/ai:prompt/ask:member/teamexec:member が含まれる', () => {
    const match = source.match(/const SELF_PERSISTING_TYPES = \[([^\]]+)\]/);
    assert.ok(match, 'SELF_PERSISTING_TYPES の宣言が見つからない');
    const listed = match[1];
    for (const type of ['exec', 'agreement', 'ai:prompt', 'ask:member', 'teamexec:member']) {
      assert.ok(listed.includes(`'${type}'`), `SELF_PERSISTING_TYPES に '${type}' が含まれていない`);
    }
  });
});
