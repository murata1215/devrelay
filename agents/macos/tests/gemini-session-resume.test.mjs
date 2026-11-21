// 2026-10-27 サイクル2（plan→exec resume）: gemini 分岐の UUID 採番・watchdog 除外・resumeSource
// ガードに関する回帰テスト。
//
// 背景: MCP `approve_implementation` が gemini だけ `planAiSessionMissing` で fail-closed していた
// （真因: gemini 分岐が AI セッション ID の概念を一切持たず、result.extractedSessionId を一度も
// 設定しない）。D1（採番は MCP plan ターン限定）/ D2（resume は explicit のみ）/ D4（60秒 resume
// watchdog を gemini では arm しない）という設計判断の退行を、挙動テスト（dist 経由）では検出しにくい
// 箇所（「crypto.randomUUID() が分岐内で呼ばれている」「&& aiTool !== 'gemini' が外れていない」等）を
// 他の source-text 回帰テスト（output-callback-tdz.test.mjs 等）と同じ流儀でソースを直接読んで検証する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AI_RUNNER_TS = join(__dirname, '..', 'src', 'services', 'ai-runner.ts');
const CONNECTION_TS = join(__dirname, '..', 'src', 'services', 'connection.ts');

test('gemini-session-resume: gemini 分岐の新規セッション採番は crypto.randomUUID() をその場で呼ぶ（options 経由で持ち回さない）', async () => {
  const src = await readFile(AI_RUNNER_TS, 'utf-8');
  assert.match(
    src,
    /geminiNewSessionId = \([\s\S]{0,120}?crypto\.randomUUID\(\) : undefined;/,
    'geminiNewSessionId の採番が crypto.randomUUID() をその場で呼んでいない（再 spawn ごとの採り直しが壊れている可能性）'
  );
});

test('gemini-session-resume: RESUME_STARTUP_TIMEOUT の arm 条件に aiTool !== \'gemini\' がある（D4、誤 kill 防止）', async () => {
  const src = await readFile(AI_RUNNER_TS, 'utf-8');
  assert.match(
    src,
    /if \(options\.resumeSessionId && aiTool !== 'gemini'\) \{/,
    'RESUME_STARTUP_TIMEOUT の arm 条件が aiTool !== \'gemini\' を含んでいない（gemini の exec ターンを60秒で誤 kill する危険）'
  );
});

test('gemini-session-resume: gemini 分岐が resumeSource === \'explicit\' のときのみ --resume を使う（D2、ツール跨ぎ ID の誤用防止）', async () => {
  const src = await readFile(AI_RUNNER_TS, 'utf-8');
  assert.match(
    src,
    /options\.resumeSource === 'explicit'/,
    'gemini 分岐に resumeSource === \'explicit\' のガードが無い（stored を --resume に使ってしまう可能性）'
  );
});

test('gemini-session-resume: gemini 分岐は options.turnId がある場合のみ新規セッションを採番する（D1、chat ターンの argv 無変化）', async () => {
  const src = await readFile(AI_RUNNER_TS, 'utf-8');
  assert.match(
    src,
    /geminiNewSessionId = \(geminiSessionEnabled && !geminiExplicitResume && options\.turnId\)/,
    'geminiNewSessionId の採番条件に options.turnId が含まれていない（chat ターンの argv が変わってしまう可能性）'
  );
});

test('gemini-session-resume: close ハンドラが gemini の result.extractedSessionId を resolveGeminiAiSessionId() 経由で設定している', async () => {
  const src = await readFile(AI_RUNNER_TS, 'utf-8');
  assert.match(
    src,
    /if \(aiTool === 'gemini'\) \{\s*\n\s*result\.extractedSessionId = resolveGeminiAiSessionId\(/,
    'close ハンドラで gemini の result.extractedSessionId が resolveGeminiAiSessionId() から設定されていない'
  );
});

test('gemini-session-resume: connection.ts が decideResume() の source を sendOptions.resumeSource として渡している', async () => {
  const src = await readFile(CONNECTION_TS, 'utf-8');
  assert.match(
    src,
    /resumeSource:\s*resumeDecision\.source,/,
    'connection.ts の sendOptions に resumeSource: resumeDecision.source が無い'
  );
});

test('gemini-session-resume: resumeFailed リトライの retryOptions は resumeSource を渡さない（D2、新規セッション扱いにする）', async () => {
  const src = await readFile(CONNECTION_TS, 'utf-8');
  // retryOptions オブジェクトリテラルの範囲だけを切り出して検証する
  const retryOptionsMatch = src.match(/const retryOptions: SendPromptOptions = \{[\s\S]*?\n {6}\};/);
  assert.ok(retryOptionsMatch, 'retryOptions オブジェクトリテラルが見つからない（connection.ts の構造が変わった可能性）');
  assert.equal(
    /resumeSource\s*:/.test(retryOptionsMatch[0]),
    false,
    'retryOptions に resumeSource が設定されている（resumeFailed リトライは新規セッション扱いであるべき）'
  );
});
