import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SANDBOX_ALLOWLIST,
  resolveSandboxAllowlist,
  isAllowedSandboxConnectTarget,
  hashSandboxAllowlist,
} from '../dist/services/sandbox-allowlist.js';

describe('sandbox-allowlist', () => {
  test('既定の許可リストは SB-1 固定の3件のみ（テレメトリ宛先が含まれない）', () => {
    const hosts = DEFAULT_SANDBOX_ALLOWLIST.map((e) => e.host).sort();
    assert.deepEqual(hosts, ['api.anthropic.com', 'claude.ai', 'downloads.claude.ai'].sort());
    for (const entry of DEFAULT_SANDBOX_ALLOWLIST) {
      assert.deepEqual(entry.ports, [443]);
    }
    // テレメトリ用の宛先（statsig/sentry 等）が意図せず混入していないことを明示的に確認する
    for (const forbidden of ['statsig.anthropic.com', 'sentry.io', 'statsig.com']) {
      assert.equal(hosts.includes(forbidden), false);
    }
  });

  test('configValue 未指定時は既定値を返す', () => {
    const result = resolveSandboxAllowlist(undefined);
    assert.equal(result.ok, true);
    assert.equal(result.allowlist.length, 3);
  });

  test('host:port 形式を解釈できる', () => {
    const result = resolveSandboxAllowlist(['example.com:8443']);
    assert.equal(result.ok, true);
    assert.deepEqual(result.allowlist, [{ host: 'example.com', ports: [8443] }]);
  });

  test('ポート省略時は 443 を既定とする', () => {
    const result = resolveSandboxAllowlist(['example.com']);
    assert.equal(result.ok, true);
    assert.deepEqual(result.allowlist, [{ host: 'example.com', ports: [443] }]);
  });

  test('同一ホストの複数ポートはまとめられる', () => {
    const result = resolveSandboxAllowlist(['example.com:443', 'example.com:8443']);
    assert.equal(result.ok, true);
    assert.deepEqual(result.allowlist, [{ host: 'example.com', ports: [443, 8443] }]);
  });

  test('空配列は拒否する（既定値へフォールバックしない）', () => {
    const result = resolveSandboxAllowlist([]);
    assert.equal(result.ok, false);
  });

  test('不正なホスト名は拒否する', () => {
    const result = resolveSandboxAllowlist(['not a host!!']);
    assert.equal(result.ok, false);
  });

  test('不正なポートは拒否する', () => {
    const result = resolveSandboxAllowlist(['example.com:999999']);
    assert.equal(result.ok, false);
  });

  test('配列でない値は拒否する', () => {
    // @ts-expect-error 意図的に不正な型を渡す
    const result = resolveSandboxAllowlist('not-an-array');
    assert.equal(result.ok, false);
  });

  test('isAllowedSandboxConnectTarget: 完全一致', () => {
    const allowlist = [{ host: 'api.anthropic.com', ports: [443] }];
    assert.equal(isAllowedSandboxConnectTarget(allowlist, 'api.anthropic.com', 443), true);
    assert.equal(isAllowedSandboxConnectTarget(allowlist, 'api.anthropic.com', 80), false);
    assert.equal(isAllowedSandboxConnectTarget(allowlist, 'evil.com', 443), false);
  });

  test('isAllowedSandboxConnectTarget: 大文字小文字を無視する', () => {
    const allowlist = [{ host: 'api.anthropic.com', ports: [443] }];
    assert.equal(isAllowedSandboxConnectTarget(allowlist, 'API.ANTHROPIC.COM', 443), true);
  });

  test('isAllowedSandboxConnectTarget: ワイルドカード *.suffix', () => {
    const allowlist = [{ host: '*.anthropic.com', ports: [443] }];
    assert.equal(isAllowedSandboxConnectTarget(allowlist, 'api.anthropic.com', 443), true);
    assert.equal(isAllowedSandboxConnectTarget(allowlist, 'anthropic.com', 443), false, 'suffix 自体は一致しない');
    assert.equal(isAllowedSandboxConnectTarget(allowlist, 'evil-anthropic.com', 443), false);
  });

  test('hashSandboxAllowlist: 順序に依存せず同じ内容なら同じ値を返す', () => {
    const a = [{ host: 'x.com', ports: [443] }, { host: 'y.com', ports: [443] }];
    const b = [{ host: 'y.com', ports: [443] }, { host: 'x.com', ports: [443] }];
    assert.equal(hashSandboxAllowlist(a), hashSandboxAllowlist(b));
  });

  test('hashSandboxAllowlist: 内容が変われば値も変わる', () => {
    const a = [{ host: 'x.com', ports: [443] }];
    const b = [{ host: 'z.com', ports: [443] }];
    assert.notEqual(hashSandboxAllowlist(a), hashSandboxAllowlist(b));
  });
});
