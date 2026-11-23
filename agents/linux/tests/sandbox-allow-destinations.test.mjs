import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  SANDBOX_ALLOW_DESTINATIONS_MAX,
  resolveSandboxAllowDestinations,
  buildCanonicalAllowDestinations,
} from '../dist/services/sandbox-allow-destinations.js';

describe('sandbox-allow-destinations', () => {
  test('configValue 未指定時は空集合を返す（既定値へのフォールバックはしない）', () => {
    const result = resolveSandboxAllowDestinations(undefined);
    assert.equal(result.ok, true);
    assert.deepEqual(result.destinations, []);
    assert.equal(result.canonical, '');
  });

  test('空配列も空集合として受理する（ドメイン許可リストの空配列拒否とは非対称）', () => {
    const result = resolveSandboxAllowDestinations([]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.destinations, []);
  });

  test('"ip:port" 形式を解釈できる', () => {
    const result = resolveSandboxAllowDestinations(['10.1.200.1:1521']);
    assert.equal(result.ok, true);
    assert.deepEqual(result.destinations, [{ ip: '10.1.200.1', port: 1521 }]);
    assert.equal(result.canonical, '10.1.200.1:1521');
  });

  test('重複エントリは 1 件にまとめる', () => {
    const result = resolveSandboxAllowDestinations(['10.1.200.1:1521', '10.1.200.1:1521']);
    assert.equal(result.ok, true);
    assert.deepEqual(result.destinations, [{ ip: '10.1.200.1', port: 1521 }]);
  });

  test('CIDR 表記は拒否する', () => {
    const result = resolveSandboxAllowDestinations(['10.1.200.0/24:1521']);
    assert.equal(result.ok, false);
  });

  test('ホスト名は拒否する', () => {
    const result = resolveSandboxAllowDestinations(['example.com:443']);
    assert.equal(result.ok, false);
  });

  test('IPv6 は拒否する', () => {
    const result = resolveSandboxAllowDestinations(['::1:443']);
    assert.equal(result.ok, false);
  });

  test('先頭 0 のゼロパディングは拒否する', () => {
    const result = resolveSandboxAllowDestinations(['10.1.200.01:1521']);
    assert.equal(result.ok, false);
  });

  test('オクテットが 255 を超えると拒否する', () => {
    const result = resolveSandboxAllowDestinations(['10.1.200.256:1521']);
    assert.equal(result.ok, false);
  });

  test('ポート 0 は拒否する', () => {
    const result = resolveSandboxAllowDestinations(['10.1.200.1:0']);
    assert.equal(result.ok, false);
  });

  test('ポート 65536 は拒否する', () => {
    const result = resolveSandboxAllowDestinations(['10.1.200.1:65536']);
    assert.equal(result.ok, false);
  });

  test('ポート 65535 は受理する（境界値）', () => {
    const result = resolveSandboxAllowDestinations(['10.1.200.1:65535']);
    assert.equal(result.ok, true);
  });

  test('ポート 1 は受理する（境界値）', () => {
    const result = resolveSandboxAllowDestinations(['10.1.200.1:1']);
    assert.equal(result.ok, true);
  });

  test('コロンが無い値は拒否する', () => {
    const result = resolveSandboxAllowDestinations(['10.1.200.1']);
    assert.equal(result.ok, false);
  });

  for (const forbidden of [
    '0.0.0.1:443',
    '127.0.0.1:443',
    '169.254.1.1:443',
    '224.0.0.1:443',
    '240.0.0.1:443',
    '255.255.255.255:443',
  ]) {
    test(`安全床で拒否する宛先: ${forbidden}`, () => {
      const result = resolveSandboxAllowDestinations([forbidden]);
      assert.equal(result.ok, false);
    });
  }

  test('上限 20 件を超えると拒否する', () => {
    const entries = Array.from({ length: SANDBOX_ALLOW_DESTINATIONS_MAX + 1 }, (_, i) => `10.1.200.${i + 1}:1521`);
    const result = resolveSandboxAllowDestinations(entries);
    assert.equal(result.ok, false);
  });

  test('上限 20 件はちょうど受理する（境界値）', () => {
    const entries = Array.from({ length: SANDBOX_ALLOW_DESTINATIONS_MAX }, (_, i) => `10.1.200.${i + 1}:1521`);
    const result = resolveSandboxAllowDestinations(entries);
    assert.equal(result.ok, true);
    assert.equal(result.destinations.length, SANDBOX_ALLOW_DESTINATIONS_MAX);
  });

  test('配列でない値は拒否する', () => {
    // @ts-expect-error 意図的に不正な型を渡す
    const result = resolveSandboxAllowDestinations('not-an-array');
    assert.equal(result.ok, false);
  });

  test('canonical は IP の数値順でソートされる（入力順には依存しない）', () => {
    const result = resolveSandboxAllowDestinations(['10.1.200.2:1521', '10.1.200.1:1521']);
    assert.equal(result.ok, true);
    assert.equal(result.canonical, '10.1.200.1:1521\n10.1.200.2:1521');
  });

  test('canonical は同一 IP ならポート順でソートされる', () => {
    const result = resolveSandboxAllowDestinations(['10.1.200.1:1522', '10.1.200.1:1521']);
    assert.equal(result.ok, true);
    assert.equal(result.canonical, '10.1.200.1:1521\n10.1.200.1:1522');
  });

  test('buildCanonicalAllowDestinations: 空集合は空文字列', () => {
    assert.equal(buildCanonicalAllowDestinations([]), '');
  });
});
