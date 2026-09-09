// core#383: 端末モード（PTY）のセッション ID 決定ロジック（terminal-session-id.ts）の単体テスト。
// 外部 import ゼロの純粋関数をコンパイル済み dist から直接 import する（resume-priority.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideTerminalSessionArgs,
  resolveTerminalAiSessionId,
  classifyTerminalStartupFailure,
  isUuidV4Like,
} from '../dist/services/terminal-session-id.js';

// --- decideTerminalSessionArgs ---

test('decideTerminalSessionArgs: resumeSessionId があれば --resume を優先する', () => {
  const decision = decideTerminalSessionArgs({ resumeSessionId: 'resume-id', newSessionId: 'new-id' });
  assert.equal(decision.flag, '--resume');
  assert.equal(decision.value, 'resume-id');
});

test('decideTerminalSessionArgs: resumeSessionId が無く newSessionId があれば --session-id', () => {
  const decision = decideTerminalSessionArgs({ newSessionId: 'new-id' });
  assert.equal(decision.flag, '--session-id');
  assert.equal(decision.value, 'new-id');
});

test('decideTerminalSessionArgs: 両方無ければ flag は null（CLI 任せの新規セッション）', () => {
  const decision = decideTerminalSessionArgs({});
  assert.equal(decision.flag, null);
  assert.equal(decision.value, undefined);
});

test('decideTerminalSessionArgs: resumeSessionId が空文字なら newSessionId にフォールバックする', () => {
  const decision = decideTerminalSessionArgs({ resumeSessionId: '', newSessionId: 'new-id' });
  assert.equal(decision.flag, '--session-id');
  assert.equal(decision.value, 'new-id');
});

test('decideTerminalSessionArgs: --resume と --session-id が同時に返らない（相互排他の不変条件）', () => {
  const cases = [
    {},
    { resumeSessionId: 'r' },
    { newSessionId: 'n' },
    { resumeSessionId: 'r', newSessionId: 'n' },
  ];
  for (const c of cases) {
    const decision = decideTerminalSessionArgs(c);
    // flag が両方立つことは型上あり得ないが、value がどちらのソースからも同時に来ないことを確認
    if (decision.flag === '--resume') assert.equal(decision.value, c.resumeSessionId);
    if (decision.flag === '--session-id') assert.equal(decision.value, c.newSessionId);
  }
});

// --- resolveTerminalAiSessionId ---

test('resolveTerminalAiSessionId: promptSent=false なら常に undefined（値があっても無視）', () => {
  const id = resolveTerminalAiSessionId({
    promptSent: false,
    newSessionId: 'new-id',
    resumeSessionId: 'resume-id',
    scrapedSessionId: 'scraped-id',
  });
  assert.equal(id, undefined);
});

test('resolveTerminalAiSessionId: promptSent=true では newSessionId を最優先する', () => {
  const id = resolveTerminalAiSessionId({
    promptSent: true,
    newSessionId: 'new-id',
    resumeSessionId: 'resume-id',
    scrapedSessionId: 'scraped-id',
  });
  assert.equal(id, 'new-id');
});

test('resolveTerminalAiSessionId: newSessionId が無ければ resumeSessionId を使う', () => {
  const id = resolveTerminalAiSessionId({
    promptSent: true,
    resumeSessionId: 'resume-id',
    scrapedSessionId: 'scraped-id',
  });
  assert.equal(id, 'resume-id');
});

test('resolveTerminalAiSessionId: newSessionId/resumeSessionId が無ければ scrapedSessionId にフォールバック（旧 CLI 用）', () => {
  const id = resolveTerminalAiSessionId({
    promptSent: true,
    scrapedSessionId: 'scraped-id',
  });
  assert.equal(id, 'scraped-id');
});

test('resolveTerminalAiSessionId: 何も無ければ undefined', () => {
  const id = resolveTerminalAiSessionId({ promptSent: true });
  assert.equal(id, undefined);
});

test('resolveTerminalAiSessionId: 空文字は falsy として扱われ次の優先順位にフォールバックする', () => {
  const id = resolveTerminalAiSessionId({
    promptSent: true,
    newSessionId: '',
    resumeSessionId: '',
    scrapedSessionId: 'scraped-id',
  });
  assert.equal(id, 'scraped-id');
});

// --- classifyTerminalStartupFailure ---

test('classifyTerminalStartupFailure: --session-id の unknown option を legacy-session-id-unsupported と判定する', () => {
  const kind = classifyTerminalStartupFailure('error: unknown option \'--session-id\'');
  assert.equal(kind, 'legacy-session-id-unsupported');
});

test('classifyTerminalStartupFailure: 排他違反メッセージを legacy-session-id-unsupported と判定する', () => {
  const kind = classifyTerminalStartupFailure(
    '--session-id can only be used with --continue or --resume if --fork-session is also specified.'
  );
  assert.equal(kind, 'legacy-session-id-unsupported');
});

test('classifyTerminalStartupFailure: --fork-session の unknown option も legacy-session-id-unsupported と判定する', () => {
  const kind = classifyTerminalStartupFailure('error: unknown option \'--fork-session\'');
  assert.equal(kind, 'legacy-session-id-unsupported');
});

test('classifyTerminalStartupFailure: 既存 ID 再指定エラーを session-id-already-in-use と判定する', () => {
  const kind = classifyTerminalStartupFailure('Session ID 12345678-1234-4234-8234-123456789abc is already in use.');
  assert.equal(kind, 'session-id-already-in-use');
});

test('classifyTerminalStartupFailure: 大文字小文字を区別しない', () => {
  assert.equal(classifyTerminalStartupFailure('IS ALREADY IN USE'), 'session-id-already-in-use');
});

test('classifyTerminalStartupFailure: 該当しない画面出力は other', () => {
  const kind = classifyTerminalStartupFailure('Welcome to Claude Code!\nType your prompt below.');
  assert.equal(kind, 'other');
});

test('classifyTerminalStartupFailure: 空文字・undefined でも例外を投げず other を返す', () => {
  assert.equal(classifyTerminalStartupFailure(''), 'other');
  assert.equal(classifyTerminalStartupFailure(undefined), 'other');
});

// --- isUuidV4Like ---

test('isUuidV4Like: crypto.randomUUID() 形式の文字列を true と判定する', () => {
  assert.equal(isUuidV4Like('3b12f1df-5232-4e13-9b1e-1e1c0f8f8f8f'), true);
});

test('isUuidV4Like: ハイフン無しは false', () => {
  assert.equal(isUuidV4Like('3b12f1df52324e139b1e1e1c0f8f8f8f'), false);
});

test('isUuidV4Like: 空文字・undefined・null は false（例外を投げない）', () => {
  assert.equal(isUuidV4Like(''), false);
  assert.equal(isUuidV4Like(undefined), false);
  assert.equal(isUuidV4Like(null), false);
});

test('isUuidV4Like: 数値など非文字列は false（例外を投げない）', () => {
  assert.equal(isUuidV4Like(12345), false);
});

test('isUuidV4Like: 大文字混じりの UUID も true（大文字小文字を区別しない）', () => {
  assert.equal(isUuidV4Like('3B12F1DF-5232-4E13-9B1E-1E1C0F8F8F8F'), true);
});
