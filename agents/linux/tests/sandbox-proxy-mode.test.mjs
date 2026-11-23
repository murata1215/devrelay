import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decideSandboxProxyMode } from '../dist/services/sandbox-proxy-mode.js';

describe('sandbox-proxy-mode: decideSandboxProxyMode', () => {
  test('既存の待ち受けがあれば reuse-existing', () => {
    const result = decideSandboxProxyMode({ listenerDetected: true });
    assert.equal(result.mode, 'reuse-existing');
    assert.match(result.message, /既存の待ち受け/);
  });

  test('待ち受けが無く上位プロキシも無ければ start-own', () => {
    const result = decideSandboxProxyMode({ listenerDetected: false });
    assert.equal(result.mode, 'start-own');
    assert.match(result.message, /自分で一時起動/);
  });

  test('待ち受けが無く上位プロキシが http なら start-own', () => {
    const result = decideSandboxProxyMode({ listenerDetected: false, upstreamProxyScheme: 'http' });
    assert.equal(result.mode, 'start-own');
  });

  test('待ち受けが無く上位プロキシが https なら start-own', () => {
    const result = decideSandboxProxyMode({ listenerDetected: false, upstreamProxyScheme: 'HTTPS' });
    assert.equal(result.mode, 'start-own');
  });

  test('待ち受けが無く上位プロキシが socks なら cannot-start-socks（起動しない）', () => {
    const result = decideSandboxProxyMode({ listenerDetected: false, upstreamProxyScheme: 'socks5' });
    assert.equal(result.mode, 'cannot-start-socks');
    assert.match(result.message, /socks/);
  });

  test('listenerDetected=true が upstreamProxyScheme より優先される（既存を使う）', () => {
    const result = decideSandboxProxyMode({ listenerDetected: true, upstreamProxyScheme: 'socks5' });
    assert.equal(result.mode, 'reuse-existing');
  });
});
