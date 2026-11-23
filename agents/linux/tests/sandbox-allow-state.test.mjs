import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  SANDBOX_ALLOW_RECONCILER_VERSION,
  digestSandboxAllowDestinations,
  parseSandboxAllowState,
  decideSandboxAllowReconcile,
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
