import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSandboxChildEnv,
  redactSandboxSecrets,
  describeSandboxEnvKeys,
  SANDBOX_FORBIDDEN_ENV_KEYS,
} from '../dist/services/sandbox-env.js';

function baseInput(overrides = {}) {
  return {
    oauthToken: 'sk-ant-oat01-SECRET-VALUE',
    proxyUrl: 'http://127.0.0.1:48711',
    homeDir: 'C:\\ProgramData\\devrelay\\sandbox\\home',
    sessionId: 'sess-123',
    projectPath: 'C:\\dev\\repo',
    ...overrides,
  };
}

describe('sandbox-env', () => {
  test('トークンが CLAUDE_CODE_OAUTH_TOKEN に入る', () => {
    const env = buildSandboxChildEnv(baseInput());
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-SECRET-VALUE');
  });

  test('HTTPS_PROXY/HTTP_PROXY が 127.0.0.1 のリテラルになる', () => {
    const env = buildSandboxChildEnv(baseInput());
    assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:48711');
    assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:48711');
    assert.equal(env.https_proxy, 'http://127.0.0.1:48711');
    assert.equal(env.http_proxy, 'http://127.0.0.1:48711');
  });

  test('HOME/USERPROFILE/APPDATA/TEMP が固定ホームディレクトリ配下になる', () => {
    const env = buildSandboxChildEnv(baseInput());
    assert.equal(env.HOME, 'C:\\ProgramData\\devrelay\\sandbox\\home');
    assert.equal(env.USERPROFILE, 'C:\\ProgramData\\devrelay\\sandbox\\home');
    assert.equal(env.APPDATA, 'C:\\ProgramData\\devrelay\\sandbox\\home\\AppData\\Roaming');
    assert.equal(env.TEMP, 'C:\\ProgramData\\devrelay\\sandbox\\home\\Temp');
    assert.equal(env.CLAUDE_CONFIG_DIR, 'C:\\ProgramData\\devrelay\\sandbox\\home\\.claude');
  });

  test('禁止キー（NO_PROXY 等）は extra に渡しても絶対に含まれない', () => {
    const env = buildSandboxChildEnv(
      baseInput({
        extra: {
          NO_PROXY: 'evil.example.com',
          no_proxy: 'evil.example.com',
          ANTHROPIC_BASE_URL: 'http://evil.example.com',
          ANTHROPIC_API_KEY: 'leak',
          ANTHROPIC_AUTH_TOKEN: 'leak',
          SAFE_KEY: 'ok',
        },
      }),
    );
    for (const forbidden of SANDBOX_FORBIDDEN_ENV_KEYS) {
      assert.equal(Object.prototype.hasOwnProperty.call(env, forbidden), false, `${forbidden} が含まれてはいけない`);
    }
    assert.equal(env.SAFE_KEY, 'ok');
  });

  test('process.env をそのまま extra に渡しても禁止キーは漏れない（将来の呼び出し誤りへの防御）', () => {
    const fakeProcessEnv = {
      NO_PROXY: 'localhost',
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'should-not-leak',
    };
    const env = buildSandboxChildEnv(baseInput({ extra: fakeProcessEnv }));
    assert.equal(env.NO_PROXY, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.PATH, '/usr/bin'); // PATH 自体は禁止リストに無いので通る
  });

  test('redactSandboxSecrets: 複数回出現するトークンも全て隠す', () => {
    const text = 'token=SECRET123 and again SECRET123 end';
    const redacted = redactSandboxSecrets(text, ['SECRET123']);
    assert.equal(redacted, 'token=***REDACTED*** and again ***REDACTED*** end');
  });

  test('redactSandboxSecrets: 空文字列・未定義の secret は無視する', () => {
    const text = 'no secret here';
    assert.equal(redactSandboxSecrets(text, ['', undefined ?? '']), 'no secret here');
  });

  test('describeSandboxEnvKeys: キー名のみを返し値を含まない', () => {
    const env = buildSandboxChildEnv(baseInput());
    const keys = describeSandboxEnvKeys(env);
    assert.ok(keys.includes('CLAUDE_CODE_OAUTH_TOKEN'));
    for (const key of keys) {
      assert.equal(typeof key, 'string');
    }
    // 値（トークン本体）が文字列化結果に含まれていないことを確認
    assert.equal(JSON.stringify(keys).includes('SECRET-VALUE'), false);
  });
});
