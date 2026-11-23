import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSandboxChildEnv,
  redactSandboxSecrets,
  describeSandboxEnvKeys,
  SANDBOX_FORBIDDEN_ENV_KEYS,
  buildSandboxSpawnEnv,
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

// サイクル SB-1a-2: buildSandboxSpawnEnv（SDK が足した env のうち安全なものだけ merge する）
describe('sandbox-env: buildSandboxSpawnEnv', () => {
  const base = buildSandboxChildEnv({
    oauthToken: 'sk-ant-oat01-SECRET-VALUE',
    proxyUrl: 'http://127.0.0.1:48711',
    homeDir: 'C:\\ProgramData\\devrelay\\sandbox\\home',
    sessionId: 'sess-123',
    projectPath: 'C:\\dev\\repo',
  });

  test('SDK が足しても禁止キー（ANTHROPIC_API_KEY 等）は絶対に通らない', () => {
    const agentEnv = { PATH: '/usr/bin' };
    const sdkEnv = { ...agentEnv, ANTHROPIC_API_KEY: 'sdk-leaked-key', NO_PROXY: 'evil.example.com' };
    const result = buildSandboxSpawnEnv({ base, sdkEnv, agentEnv });
    assert.equal(result.ANTHROPIC_API_KEY, null);
    assert.equal(result.NO_PROXY, null);
  });

  test('プロキシ・トークンは base 側が常に優先される（SDK が書き換えても上書きされない）', () => {
    const agentEnv = {};
    const sdkEnv = {
      HTTPS_PROXY: 'http://attacker.example.com:9999',
      CLAUDE_CODE_OAUTH_TOKEN: 'sdk-overwritten-token',
    };
    const result = buildSandboxSpawnEnv({ base, sdkEnv, agentEnv });
    assert.equal(result.HTTPS_PROXY, 'http://127.0.0.1:48711');
    assert.equal(result.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-SECRET-VALUE');
  });

  test('SDK が追加した CLAUDE_CODE_* キー（Agent の process.env には無い新規キー）は通る', () => {
    const agentEnv = { PATH: '/usr/bin' };
    const sdkEnv = { ...agentEnv, CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' };
    const result = buildSandboxSpawnEnv({ base, sdkEnv, agentEnv });
    assert.equal(result.CLAUDE_CODE_ENTRYPOINT, 'sdk-cli');
  });

  test('Agent の process.env 由来のキー（接頭辞が合っていても agentEnv と同値）は通らない', () => {
    const agentEnv = { CLAUDE_CODE_SOMETHING: 'same-value', PATH: '/usr/bin' };
    const sdkEnv = { ...agentEnv };
    const result = buildSandboxSpawnEnv({ base, sdkEnv, agentEnv });
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'CLAUDE_CODE_SOMETHING'), false);
  });

  test('接頭辞が合わないキー（Agent の process.env 由来の一般的な変数）は通らない', () => {
    const agentEnv = { PATH: '/usr/bin' };
    const sdkEnv = { ...agentEnv, PATH: '/usr/bin:/sdk/bin', RANDOM_ENV_VAR: 'leak' };
    const result = buildSandboxSpawnEnv({ base, sdkEnv, agentEnv });
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'PATH'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'RANDOM_ENV_VAR'), false);
  });

  test('sdkEnv の値が undefined のキーは無視される', () => {
    const agentEnv = {};
    const sdkEnv = { CLAUDE_CODE_UNSET: undefined };
    const result = buildSandboxSpawnEnv({ base, sdkEnv, agentEnv });
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'CLAUDE_CODE_UNSET'), false);
  });

  test('base のキーは全て結果に含まれる（トークン・プロキシ・HOME 固定等）', () => {
    const result = buildSandboxSpawnEnv({ base, sdkEnv: {}, agentEnv: {} });
    for (const key of Object.keys(base)) {
      assert.equal(result[key], base[key]);
    }
  });
});
