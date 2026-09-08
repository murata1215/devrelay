// core#336: resume 優先順位判定（resume-priority.ts）の単体テスト。
// 外部 import ゼロの純粋関数をコンパイル済み dist から直接 import する（session-scope.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideResume } from '../dist/services/resume-priority.js';

test('decideResume: explicit 指定時は forceNewSession に関わらず必ず resume する', () => {
  const decision = decideResume({
    explicitResumeSessionId: 'explicit-id',
    forceNewSession: true,
    storedSessionId: 'stored-id',
  });
  assert.equal(decision.resumeSessionId, 'explicit-id');
  assert.equal(decision.source, 'explicit');
  assert.equal(decision.skipStoredLookup, true);
});

test('decideResume: explicit 未指定 + forceNewSession=true は resume しない', () => {
  const decision = decideResume({
    forceNewSession: true,
    storedSessionId: 'stored-id',
  });
  assert.equal(decision.resumeSessionId, undefined);
  assert.equal(decision.source, 'none');
  assert.equal(decision.skipStoredLookup, true);
});

test('decideResume: explicit 未指定 + forceNewSession 未指定はスコープ内保存 ID を resume する', () => {
  const decision = decideResume({
    storedSessionId: 'stored-id',
  });
  assert.equal(decision.resumeSessionId, 'stored-id');
  assert.equal(decision.source, 'stored');
  assert.equal(decision.skipStoredLookup, false);
});

test('decideResume: explicit 未指定 + forceNewSession=false もスコープ内保存 ID を resume する', () => {
  const decision = decideResume({
    forceNewSession: false,
    storedSessionId: 'stored-id',
  });
  assert.equal(decision.resumeSessionId, 'stored-id');
  assert.equal(decision.source, 'stored');
  assert.equal(decision.skipStoredLookup, false);
});

test('decideResume: 何も無ければ resume しない（stored も undefined）', () => {
  const decision = decideResume({});
  assert.equal(decision.resumeSessionId, undefined);
  assert.equal(decision.source, 'stored');
  assert.equal(decision.skipStoredLookup, false);
});

test('decideResume: explicit が空文字は falsy として扱われる（forceNewSession 優先へフォールバック）', () => {
  const decision = decideResume({
    explicitResumeSessionId: '',
    forceNewSession: true,
    storedSessionId: 'stored-id',
  });
  assert.equal(decision.source, 'none');
});
