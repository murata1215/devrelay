import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  SANDBOX_ALLOW_RECONCILER_VERSION,
  digestSandboxAllowDestinations,
  parseSandboxAllowState,
  decideSandboxAllowReconcile,
  interpretSandboxAllowTaskState,
  isSandboxAllowStateFresherThan,
  decideSandboxAllowWait,
  classifySandboxAllowApplyOutcome,
  SANDBOX_ALLOW_APPLY_WAIT_MS,
  SANDBOX_ALLOW_APPLY_MAX_WAIT_MS,
  SANDBOX_ALLOW_TASK_START_GRACE_MS,
} from '../dist/services/sandbox-allow-state.js';
import { buildCanonicalAllowDestinations } from '../dist/services/sandbox-allow-destinations.js';

describe('sandbox-allow-state: digestSandboxAllowDestinations', () => {
  test('空文字列の digest は sha256("") の固定値', () => {
    assert.equal(
      digestSandboxAllowDestinations(''),
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  test('同じ canonical なら同じ digest', () => {
    const a = buildCanonicalAllowDestinations([{ ip: '10.1.200.1', port: 1521 }]);
    const b = buildCanonicalAllowDestinations([{ ip: '10.1.200.1', port: 1521 }]);
    assert.equal(digestSandboxAllowDestinations(a), digestSandboxAllowDestinations(b));
  });

  test('内容が変われば digest も変わる', () => {
    const a = buildCanonicalAllowDestinations([{ ip: '10.1.200.1', port: 1521 }]);
    const b = buildCanonicalAllowDestinations([{ ip: '10.1.200.2', port: 1521 }]);
    assert.notEqual(digestSandboxAllowDestinations(a), digestSandboxAllowDestinations(b));
  });

  test('入力順序が違っても canonical 化すれば同じ digest（順序非依存）', () => {
    const a = buildCanonicalAllowDestinations([
      { ip: '10.1.200.2', port: 1521 },
      { ip: '10.1.200.1', port: 1521 },
    ]);
    const b = buildCanonicalAllowDestinations([
      { ip: '10.1.200.1', port: 1521 },
      { ip: '10.1.200.2', port: 1521 },
    ]);
    assert.equal(digestSandboxAllowDestinations(a), digestSandboxAllowDestinations(b));
  });
});

describe('sandbox-allow-state: parseSandboxAllowState', () => {
  test('null は null を返す', () => {
    assert.equal(parseSandboxAllowState(null), null);
  });

  test('壊れた JSON は null を返す', () => {
    assert.equal(parseSandboxAllowState('{not json'), null);
  });

  test('reconcilerVersion が無いオブジェクトは null を返す', () => {
    assert.equal(parseSandboxAllowState(JSON.stringify({ result: 'ok' })), null);
  });

  test('result が既定の3値以外なら null を返す', () => {
    assert.equal(
      parseSandboxAllowState(JSON.stringify({ reconcilerVersion: 1, result: 'weird', applied: [], rejected: [], ruleNames: [] })),
      null,
    );
  });

  test('正しい形式を正しくパースする', () => {
    const raw = JSON.stringify({
      reconcilerVersion: 1,
      result: 'ok',
      appliedAt: '2026-11-24T00:00:00.000Z',
      digest: 'abc123',
      applied: [{ ip: '10.1.200.1', port: 1521 }],
      rejectedCount: 0,
      rejected: [],
      ruleNames: ['DevRelay-SandboxGen-abc123def456-ipv4'],
      error: null,
    });
    const parsed = parseSandboxAllowState(raw);
    assert.deepEqual(parsed, {
      reconcilerVersion: 1,
      result: 'ok',
      appliedAt: '2026-11-24T00:00:00.000Z',
      digest: 'abc123',
      applied: [{ ip: '10.1.200.1', port: 1521 }],
      rejectedCount: 0,
      rejected: [],
      ruleNames: ['DevRelay-SandboxGen-abc123def456-ipv4'],
      error: null,
    });
  });
});

describe('sandbox-allow-state: decideSandboxAllowReconcile（決定3）', () => {
  test('未設定（0件）かつ state.json 無しは一致として扱う', () => {
    const decision = decideSandboxAllowReconcile({
      configuredCount: 0,
      expectedDigest: digestSandboxAllowDestinations(''),
      state: null,
      alreadyRetried: false,
    });
    assert.equal(decision, 'match');
  });

  test('digest が一致し result が ok なら一致', () => {
    const decision = decideSandboxAllowReconcile({
      configuredCount: 1,
      expectedDigest: 'abc',
      state: {
        reconcilerVersion: SANDBOX_ALLOW_RECONCILER_VERSION,
        result: 'ok',
        appliedAt: null,
        digest: 'abc',
        applied: [],
        rejectedCount: 0,
        rejected: [],
        ruleNames: [],
        error: null,
      },
      alreadyRetried: false,
    });
    assert.equal(decision, 'match');
  });

  test('digest が不一致で未再試行なら apply-needed', () => {
    const decision = decideSandboxAllowReconcile({
      configuredCount: 1,
      expectedDigest: 'abc',
      state: null,
      alreadyRetried: false,
    });
    assert.equal(decision, 'apply-needed');
  });

  test('digest が不一致で再試行済みなら mismatch', () => {
    const decision = decideSandboxAllowReconcile({
      configuredCount: 1,
      expectedDigest: 'abc',
      state: null,
      alreadyRetried: true,
    });
    assert.equal(decision, 'mismatch');
  });

  test('result が rejected なら digest が一致していても mismatch 側（match ではない）', () => {
    const decision = decideSandboxAllowReconcile({
      configuredCount: 1,
      expectedDigest: 'abc',
      state: {
        reconcilerVersion: SANDBOX_ALLOW_RECONCILER_VERSION,
        result: 'rejected',
        appliedAt: null,
        digest: 'abc',
        applied: [],
        rejectedCount: 1,
        rejected: [{ index: 0, reason: 'invalid_ip' }],
        ruleNames: [],
        error: null,
      },
      alreadyRetried: true,
    });
    assert.equal(decision, 'mismatch');
  });

  test('未設定でも state.json が rejected/error を記録していれば一致としない', () => {
    const decision = decideSandboxAllowReconcile({
      configuredCount: 0,
      expectedDigest: digestSandboxAllowDestinations(''),
      state: {
        reconcilerVersion: SANDBOX_ALLOW_RECONCILER_VERSION,
        result: 'error',
        appliedAt: null,
        digest: null,
        applied: [],
        rejectedCount: 0,
        rejected: [],
        ruleNames: [],
        error: 'self_check_failed',
      },
      alreadyRetried: false,
    });
    assert.equal(decision, 'apply-needed');
  });
});

// サイクル SB-2.1.5: hp630g9 実機確認（commit 992ae26）で発覚した「反映待ちが短すぎる」不具合の修正
describe('sandbox-allow-state: interpretSandboxAllowTaskState（Get-ScheduledTask の State）', () => {
  test('Running は running', () => {
    assert.equal(interpretSandboxAllowTaskState('Running'), 'running');
  });

  test('Queued は running', () => {
    assert.equal(interpretSandboxAllowTaskState('Queued'), 'running');
  });

  test('Ready は finished', () => {
    assert.equal(interpretSandboxAllowTaskState('Ready'), 'finished');
  });

  test('Disabled は finished', () => {
    assert.equal(interpretSandboxAllowTaskState('Disabled'), 'finished');
  });

  test('前後に空白・改行が付いても判定できる', () => {
    assert.equal(interpretSandboxAllowTaskState('  Running\r\n'), 'running');
  });

  test('空文字は unknown', () => {
    assert.equal(interpretSandboxAllowTaskState(''), 'unknown');
  });

  test('想定外の文字列（例外メッセージ等）は unknown', () => {
    assert.equal(interpretSandboxAllowTaskState('Get-ScheduledTask : タスクが見つかりません'), 'unknown');
  });
});

describe('sandbox-allow-state: isSandboxAllowStateFresherThan', () => {
  test('appliedAt が sinceMs より後なら true', () => {
    const sinceMs = Date.parse('2026-11-24T00:00:00.000Z');
    const state = { appliedAt: '2026-11-24T00:00:05.000Z' };
    assert.equal(isSandboxAllowStateFresherThan(state, sinceMs), true);
  });

  test('appliedAt が sinceMs より前なら false', () => {
    const sinceMs = Date.parse('2026-11-24T00:00:10.000Z');
    const state = { appliedAt: '2026-11-24T00:00:00.000Z' };
    assert.equal(isSandboxAllowStateFresherThan(state, sinceMs), false);
  });

  test('state が null なら false', () => {
    assert.equal(isSandboxAllowStateFresherThan(null, Date.now()), false);
  });

  test('appliedAt が null なら false', () => {
    assert.equal(isSandboxAllowStateFresherThan({ appliedAt: null }, Date.now()), false);
  });

  test('appliedAt が壊れた日付文字列なら false（fail-closed）', () => {
    assert.equal(isSandboxAllowStateFresherThan({ appliedAt: 'not-a-date' }, Date.now()), false);
  });
});

describe('sandbox-allow-state: decideSandboxAllowWait（SB-2.1.5 の核心: 60秒基本・実行中なら180秒まで延長）', () => {
  function baseWaitInput(overrides = {}) {
    return {
      stateMatched: false,
      stateFresh: false,
      elapsedMs: 0,
      taskState: 'unknown',
      observedRunning: false,
      ...overrides,
    };
  }

  test('一致していれば即 done', () => {
    assert.equal(decideSandboxAllowWait(baseWaitInput({ stateMatched: true, elapsedMs: 999_999 })), 'done');
  });

  test('今回より新しい結果が出たのに不一致なら give-up（待っても変わらない）', () => {
    assert.equal(decideSandboxAllowWait(baseWaitInput({ stateFresh: true, elapsedMs: 1_000 })), 'give-up');
  });

  test('基本待ち（60秒）未満・タスク状態不明なら wait', () => {
    assert.equal(decideSandboxAllowWait(baseWaitInput({ elapsedMs: 30_000 })), 'wait');
  });

  test('基本待ち超過・タスク状態不明なら give-up', () => {
    assert.equal(decideSandboxAllowWait(baseWaitInput({ elapsedMs: SANDBOX_ALLOW_APPLY_WAIT_MS + 1 })), 'give-up');
  });

  test('基本待ち超過でもタスクが実行中なら wait（最大180秒まで延長）', () => {
    assert.equal(
      decideSandboxAllowWait(baseWaitInput({ elapsedMs: SANDBOX_ALLOW_APPLY_WAIT_MS + 1, taskState: 'running' })),
      'wait',
    );
  });

  test('実行中でも最大待ち（180秒）を超えたら give-up', () => {
    assert.equal(
      decideSandboxAllowWait(
        baseWaitInput({ elapsedMs: SANDBOX_ALLOW_APPLY_MAX_WAIT_MS + 1, taskState: 'running' }),
      ),
      'give-up',
    );
  });

  test('タスク終了済み（finished）を実行中観測後に見たら give-up', () => {
    assert.equal(
      decideSandboxAllowWait(baseWaitInput({ elapsedMs: 10_000, taskState: 'finished', observedRunning: true })),
      'give-up',
    );
  });

  test('/Run 直後の猶予内で finished に見えても、実行中を観測していなければ give-up しない（wait）', () => {
    assert.equal(
      decideSandboxAllowWait(
        baseWaitInput({ elapsedMs: SANDBOX_ALLOW_TASK_START_GRACE_MS - 1, taskState: 'finished', observedRunning: false }),
      ),
      'wait',
    );
  });

  test('猶予を過ぎて finished が続くなら、実行中を観測していなくても give-up（タスクが一瞬で終わった場合）', () => {
    assert.equal(
      decideSandboxAllowWait(
        baseWaitInput({ elapsedMs: SANDBOX_ALLOW_TASK_START_GRACE_MS + 1, taskState: 'finished', observedRunning: false }),
      ),
      'give-up',
    );
  });
});

describe('sandbox-allow-state: classifySandboxAllowApplyOutcome', () => {
  function baseOutcomeInput(overrides = {}) {
    return {
      matched: false,
      state: null,
      stateFresh: false,
      taskRunError: null,
      observedRunning: false,
      ...overrides,
    };
  }

  test('一致していれば applied', () => {
    assert.equal(classifySandboxAllowApplyOutcome(baseOutcomeInput({ matched: true })), 'applied');
  });

  test('今回の要求に対して error が新しく記録されていれば failed', () => {
    const state = { result: 'error', appliedAt: '2026-11-24T00:00:00.000Z' };
    assert.equal(classifySandboxAllowApplyOutcome(baseOutcomeInput({ state, stateFresh: true })), 'failed');
  });

  test('今回の要求に対して rejected が新しく記録されていれば failed', () => {
    const state = { result: 'rejected', appliedAt: '2026-11-24T00:00:00.000Z' };
    assert.equal(classifySandboxAllowApplyOutcome(baseOutcomeInput({ state, stateFresh: true })), 'failed');
  });

  test('古い error が残っているだけ（今回より新しくない）なら pending', () => {
    const state = { result: 'error', appliedAt: '2026-11-20T00:00:00.000Z' };
    assert.equal(classifySandboxAllowApplyOutcome(baseOutcomeInput({ state, stateFresh: false })), 'pending');
  });

  test('タスク起動自体が失敗し、実行中を一度も観測していなければ failed', () => {
    assert.equal(
      classifySandboxAllowApplyOutcome(baseOutcomeInput({ taskRunError: 'command not found', observedRunning: false })),
      'failed',
    );
  });

  test('タスク起動エラーがあっても実行中を観測していれば pending（既に動いていて/Runが失敗したケース）', () => {
    assert.equal(
      classifySandboxAllowApplyOutcome(baseOutcomeInput({ taskRunError: 'already running', observedRunning: true })),
      'pending',
    );
  });

  test('結果ファイルが古いまま・実行中のままタイムアウトなら pending', () => {
    assert.equal(classifySandboxAllowApplyOutcome(baseOutcomeInput({ observedRunning: true })), 'pending');
  });
});
