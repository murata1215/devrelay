// サイクルG（クロス ask の既存バグ修正）の配線（wiring）ソース静的ガード
// （node:fs のみ、dist/ には依存しない。agents/windows/tests/scope-wiring.test.mjs と同じ手口）。
//
// これが無いと、将来のリファクタで以下が黙って外れても気づけない:
// - G-3: loadStorageContext() のプロンプト注入が statePolicy.storageContext のガードを失う
// - G-4: collectOutputFiles() の 2 箇所が statePolicy.outputFileCollect のガードを失う
// - G-7: Devin の git 自動復元ガード（captureBaseline）より前に isolated の拒否判定が無くなる
// - G-8: approveAllMode の読み書きが isEphemeralSession の判定を失う

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONNECTION_TS = join(__dirname, '..', 'src', 'services', 'connection.ts');
const AI_RUNNER_TS = join(__dirname, '..', 'src', 'services', 'ai-runner.ts');

test('G-3: loadStorageContext(sessionInfo.projectPath) の直前 100 文字に statePolicy.storageContext がある', async () => {
  const src = await readFile(CONNECTION_TS, 'utf-8');
  const idx = src.indexOf('loadStorageContext(sessionInfo.projectPath)');
  assert.ok(idx > 0, 'loadStorageContext(sessionInfo.projectPath) が見当たらない');
  const before = src.slice(Math.max(0, idx - 100), idx);
  assert.match(before, /statePolicy\.storageContext\s*\?/, 'statePolicy.storageContext によるガードが無い');
});

test('G-4: collectOutputFiles(sessionInfo.projectPath) が 2 箇所とも statePolicy.outputFileCollect でガードされている', async () => {
  const src = await readFile(CONNECTION_TS, 'utf-8');
  const calls = [...src.matchAll(/collectOutputFiles\(sessionInfo\.projectPath\)/g)];
  assert.equal(calls.length, 2, `collectOutputFiles(sessionInfo.projectPath) の出現数が想定(2)と異なる: ${calls.length}`);
  for (const call of calls) {
    const before = src.slice(Math.max(0, call.index - 100), call.index);
    assert.match(before, /statePolicy\.outputFileCollect\s*\?/, `collectOutputFiles call at ${call.index} にガードが無い`);
  }
});

test('G-7: isAiToolReadOnlyEnforceable( による拒否判定が captureBaseline( より前にある', async () => {
  const src = await readFile(CONNECTION_TS, 'utf-8');
  const enforceIdx = src.indexOf('isAiToolReadOnlyEnforceable(');
  const baselineIdx = src.indexOf('captureBaseline(');
  assert.ok(enforceIdx > 0, 'isAiToolReadOnlyEnforceable( の呼び出しが見当たらない');
  assert.ok(baselineIdx > enforceIdx, 'isAiToolReadOnlyEnforceable( が captureBaseline( より後にある（拒否判定が巻き戻しより後に退行している）');
});

test('G-8: approveAllMode の module-level 読み出しは isEphemeralSession と併記されている', async () => {
  const src = await readFile(AI_RUNNER_TS, 'utf-8');
  assert.match(
    src,
    /!isEphemeralSession\(sessionId\)\s*&&\s*approveAllMode/,
    'approveAllMode の直接読み出しが isEphemeralSession でガードされていない'
  );
});

test('G-8: resolveToolApproval の write 2 箇所が pending.sessionId で isEphemeralSession 判定している', async () => {
  const src = await readFile(AI_RUNNER_TS, 'utf-8');
  const matches = src.match(/!isEphemeralSession\(pending\.sessionId\)/g) ?? [];
  assert.equal(matches.length, 2, `pending.sessionId による isEphemeralSession 判定の出現数が想定(2)と異なる: ${matches.length}`);
});

test('G-5: ai-runner.ts の options.persistProjectState ガードが 10 箇所以上ある（既存4 + サイクルG新設分）', async () => {
  const src = await readFile(AI_RUNNER_TS, 'utf-8');
  const matches = src.match(/options\.persistProjectState/g) ?? [];
  assert.ok(matches.length >= 10, `options.persistProjectState の出現数が想定より少ない (${matches.length})`);
});

test('G-5b: ai-runner.ts の options.projectStateRead ガードが存在する', async () => {
  const src = await readFile(AI_RUNNER_TS, 'utf-8');
  const matches = src.match(/options\.projectStateRead/g) ?? [];
  assert.ok(matches.length >= 4, `options.projectStateRead の出現数が想定より少ない (${matches.length})`);
});
