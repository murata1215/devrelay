import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  interpretSandboxDirectBlockProbe,
  interpretSandboxProxyDenyProbe,
  interpretSandboxKnownBypassProbe,
  interpretSandboxReadProbe,
} from '../dist/services/sandbox-probe-interpret.js';

describe('sandbox-probe-interpret: interpretSandboxDirectBlockProbe（B6 確認1: プロキシ無し直結）', () => {
  test('exit=0（到達できた）は reachable', () => {
    const result = interpretSandboxDirectBlockProbe({ exitCode: 0, timedOut: false, spawnFailed: false });
    assert.equal(result.outcome, 'reachable');
  });

  test('exit=7（CURLE_COULDNT_CONNECT）は blocked', () => {
    const result = interpretSandboxDirectBlockProbe({ exitCode: 7, timedOut: false, spawnFailed: false });
    assert.equal(result.outcome, 'blocked');
    assert.match(result.evidence, /exit=7/);
  });

  test('未知の exit コードは inconclusive（blocked と断定しない）', () => {
    const result = interpretSandboxDirectBlockProbe({ exitCode: 28, timedOut: false, spawnFailed: false });
    assert.equal(result.outcome, 'inconclusive');
  });

  test('タイムアウトは inconclusive', () => {
    const result = interpretSandboxDirectBlockProbe({ exitCode: null, timedOut: true, spawnFailed: false });
    assert.equal(result.outcome, 'inconclusive');
  });

  test('spawn 失敗は inconclusive', () => {
    const result = interpretSandboxDirectBlockProbe({ exitCode: null, timedOut: false, spawnFailed: true });
    assert.equal(result.outcome, 'inconclusive');
  });
});

describe('sandbox-probe-interpret: interpretSandboxProxyDenyProbe（B6 確認2: プロキシ経由で許可外拒否）', () => {
  test('exit=0（到達できた）は reachable', () => {
    const result = interpretSandboxProxyDenyProbe({ exitCode: 0, timedOut: false, spawnFailed: false });
    assert.equal(result.outcome, 'reachable');
  });

  test('exit=56（CURLE_RECV_ERROR、プロキシの非200応答）は blocked', () => {
    const result = interpretSandboxProxyDenyProbe({ exitCode: 56, timedOut: false, spawnFailed: false });
    assert.equal(result.outcome, 'blocked');
  });

  test('proxyDeniedObserved=true のときは根拠が強いことを示す文言になる', () => {
    const result = interpretSandboxProxyDenyProbe({ exitCode: 56, timedOut: false, spawnFailed: false, proxyDeniedObserved: true });
    assert.match(result.evidence, /拒否記録あり/);
  });

  test('proxyDeniedObserved=false（既存の待ち受けを使った場合）は根拠が弱いことを示す文言になる', () => {
    const result = interpretSandboxProxyDenyProbe({ exitCode: 56, timedOut: false, spawnFailed: false, proxyDeniedObserved: false });
    assert.match(result.evidence, /根拠弱/);
  });

  test('未知の exit コードは inconclusive', () => {
    const result = interpretSandboxProxyDenyProbe({ exitCode: 1, timedOut: false, spawnFailed: false });
    assert.equal(result.outcome, 'inconclusive');
  });
});

describe('sandbox-probe-interpret: interpretSandboxKnownBypassProbe（既知の回避経路は blocked と言わない）', () => {
  test('exit=0 は reachable（到達した可能性がある）', () => {
    const result = interpretSandboxKnownBypassProbe({ exitCode: 0, timedOut: false, spawnFailed: false });
    assert.equal(result.outcome, 'reachable');
  });

  test('exit!=0 でも blocked にはならない（inconclusive のまま）', () => {
    const result = interpretSandboxKnownBypassProbe({ exitCode: 1, timedOut: false, spawnFailed: false });
    assert.equal(result.outcome, 'inconclusive');
    assert.notEqual(result.outcome, 'blocked');
  });

  test('タイムアウト・spawn失敗でも blocked にはならない', () => {
    assert.equal(interpretSandboxKnownBypassProbe({ exitCode: null, timedOut: true, spawnFailed: false }).outcome, 'inconclusive');
    assert.equal(interpretSandboxKnownBypassProbe({ exitCode: null, timedOut: false, spawnFailed: true }).outcome, 'inconclusive');
  });
});

describe('sandbox-probe-interpret: interpretSandboxReadProbe（C1: --acl-audit）', () => {
  test('exit=0 は readable', () => {
    assert.equal(interpretSandboxReadProbe(0).outcome, 'readable');
  });

  test('exit=1 は not-readable', () => {
    assert.equal(interpretSandboxReadProbe(1).outcome, 'not-readable');
  });

  test('未知の exit・null は inconclusive', () => {
    assert.equal(interpretSandboxReadProbe(99).outcome, 'inconclusive');
    assert.equal(interpretSandboxReadProbe(null).outcome, 'inconclusive');
  });
});
