import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  interpretSandboxDirectBlockProbe,
  interpretSandboxProxyDenyProbe,
  interpretSandboxKnownBypassProbe,
  interpretSandboxDirListProbe,
  interpretSandboxFileReadProbe,
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

  // サイクル SB-1a-2（a 対応）: プロキシ経由の陽性対照（許可リスト内ホストへの到達確認）
  test('proxyControlReachable=false のときは exit コードに関わらず inconclusive（プロキシ自体への未到達を拒否と混同しない）', () => {
    const result = interpretSandboxProxyDenyProbe({ exitCode: 7, timedOut: false, spawnFailed: false, proxyControlReachable: false });
    assert.equal(result.outcome, 'inconclusive');
    assert.match(result.evidence, /陽性対照/);
  });

  test('proxyControlReachable=true のときは従来どおり exit=56 を blocked と判定する', () => {
    const result = interpretSandboxProxyDenyProbe({ exitCode: 56, timedOut: false, spawnFailed: false, proxyControlReachable: true });
    assert.equal(result.outcome, 'blocked');
  });

  test('proxyControlReachable 未指定（プローブしていない）なら従来どおりの判定になる', () => {
    const result = interpretSandboxProxyDenyProbe({ exitCode: 56, timedOut: false, spawnFailed: false });
    assert.equal(result.outcome, 'blocked');
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

describe('sandbox-probe-interpret: interpretSandboxDirListProbe（C1: --acl-audit のディレクトリ列挙）', () => {
  test('exit=0 は readable', () => {
    assert.equal(interpretSandboxDirListProbe(0).outcome, 'readable');
  });

  test('exit=1 は not-readable', () => {
    assert.equal(interpretSandboxDirListProbe(1).outcome, 'not-readable');
  });

  test('未知の exit・null は inconclusive', () => {
    assert.equal(interpretSandboxDirListProbe(99).outcome, 'inconclusive');
    assert.equal(interpretSandboxDirListProbe(null).outcome, 'inconclusive');
  });
});

// サイクル SB-1a-2（b 対応）: ファイル単位の読み取り確認（存在確認・対照ファイルで区別する）
describe('sandbox-probe-interpret: interpretSandboxFileReadProbe（C1/b: --acl-audit のファイル確認）', () => {
  test('対象が存在しない場合は inconclusive（「存在しない」を ACL 拒否と混同しない）', () => {
    const result = interpretSandboxFileReadProbe({ exitCode: 1, targetExists: false, controlReadable: true });
    assert.equal(result.outcome, 'inconclusive');
    assert.match(result.evidence, /存在しない/);
  });

  test('対照が読めなかった場合は全体を inconclusive（ACL の効果か切り分けできない）', () => {
    const result = interpretSandboxFileReadProbe({ exitCode: 1, targetExists: true, controlReadable: false });
    assert.equal(result.outcome, 'inconclusive');
    assert.match(result.evidence, /対照/);
  });

  test('対象が存在し対照も読める状態で exit=1 なら not-readable（ACL による拒否と判定）', () => {
    const result = interpretSandboxFileReadProbe({ exitCode: 1, targetExists: true, controlReadable: true });
    assert.equal(result.outcome, 'not-readable');
  });

  test('対象が存在し対照も読める状態で exit=0 なら readable', () => {
    const result = interpretSandboxFileReadProbe({ exitCode: 0, targetExists: true, controlReadable: true });
    assert.equal(result.outcome, 'readable');
  });

  test('未知の exit コードは inconclusive', () => {
    const result = interpretSandboxFileReadProbe({ exitCode: 99, targetExists: true, controlReadable: true });
    assert.equal(result.outcome, 'inconclusive');
  });
});
