// 読取PATのサーバー配布サイクル: 配線（wiring）のソース静的ガード（node:fs、dist/ には依存しない。
// knowledge-wiring.test.mjs / mcp-ask-source-guard.test.mjs と同じ手口）。
//
// これが無いと、将来のリファクタで以下が黙って外れても気づけない:
// - index.ts での agentRepoAuthRoutes 登録漏れ（HTTP が 404 のまま気づかれない）
// - agent-repo-auth-api.ts が authenticateByMachineTokenFull を使わなくなる（認証なしで配布する穴）
// - agent-manager.ts / agent-repo-auth-api.ts が authHeader/PAT の値を console.* に出すようになる
//   （ログに秘密が漏れる事故の再発）
// - routes/api.ts の /token レスポンスに authHeader（真偽値ではない生の値）が混入する

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');

function readServerSource(relPath) {
  return readFileSync(path.join(serverRoot, relPath), 'utf8');
}

describe('index.ts: agentRepoAuthRoutes の登録', () => {
  const source = readServerSource('src/index.ts');

  test('agentRepoAuthRoutes を import している', () => {
    assert.match(source, /import\s*\{\s*agentRepoAuthRoutes\s*\}\s*from\s*['"]\.\/routes\/agent-repo-auth-api\.js['"]/);
  });

  test('app.register(agentRepoAuthRoutes) を呼んでいる', () => {
    assert.match(source, /app\.register\(agentRepoAuthRoutes\)/);
  });
});

describe('agent-repo-auth-api.ts: 認証・ログの配線', () => {
  const source = readServerSource('src/routes/agent-repo-auth-api.ts');

  test('authenticateByMachineTokenFull を使っている（マシントークン認証必須）', () => {
    assert.match(source, /authenticateByMachineTokenFull/);
  });

  test('未認証時に 401 を返す分岐がある', () => {
    assert.match(source, /reply\.status\(401\)/);
  });

  test('HTTPS 以外を拒否する分岐がある（isSecureRequest）', () => {
    assert.match(source, /isSecureRequest/);
  });

  test('レート制限の分岐がある（decideRepoAuthRateLimit / 429）', () => {
    assert.match(source, /decideRepoAuthRateLimit/);
    assert.match(source, /reply\.status\(429\)/);
  });

  test('console.* の呼び出しが authHeader の値をそのまま出していない（!==/=== null の真偽判定以外での参照が無い）', () => {
    const consoleCalls = source.match(/console\.\w+\([^)]*\)/g) || [];
    for (const call of consoleCalls) {
      if (!call.includes('authHeader')) continue;
      assert.match(call, /authHeader\s*(!==|===)\s*null/, `authHeader を参照する console 呼び出しは真偽判定のみであること: ${call}`);
    }
  });

  // インストーラのサーバー配布PAT取得が IIS 経由で 415 になる不具合の修正サイクル:
  // content-type parser の置き換えがこのルートのスコープに限定されたまま配線されているかの静的ガード
  test('applyRepoAuthContentTypeParser を import している', () => {
    assert.match(source, /import\s*\{\s*applyRepoAuthContentTypeParser\s*\}\s*from\s*['"]\.\/repo-auth-content-type\.js['"]/);
  });

  test('applyRepoAuthContentTypeParser(app) を app.post より前で呼んでいる', () => {
    const applyIdx = source.indexOf('applyRepoAuthContentTypeParser(app)');
    const postIdx = source.indexOf("app.post('/api/agent/repo-auth'");
    assert.ok(applyIdx !== -1, 'applyRepoAuthContentTypeParser(app) の呼び出しが見つかること');
    assert.ok(postIdx !== -1, "app.post('/api/agent/repo-auth' の呼び出しが見つかること");
    assert.ok(applyIdx < postIdx, 'applyRepoAuthContentTypeParser(app) は app.post より前で呼ばれていること');
  });
});

describe('repo-auth-content-type.ts / index.ts: content-type parser の置き換えがグローバルに漏れていない', () => {
  // `addContentTypeParser` 単体（既存の `src/mcp/oauth.ts` の
  // 'application/x-www-form-urlencoded' 追加等）は各プラグインスコープへの追加登録であり無害。
  // 危険なのは「既定パーサーを丸ごと消す」`removeAllContentTypeParsers()` の方で、
  // これを呼ぶのは本サイクルの `repo-auth-content-type.ts` だけであること。
  test('removeAllContentTypeParsers を呼ぶのは repo-auth-content-type.ts だけ', () => {
    const srcDir = path.join(serverRoot, 'src');
    const offenders = [];

    function walk(dir) {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) {
          walk(full);
        } else if (entry.endsWith('.ts') && entry !== 'repo-auth-content-type.ts') {
          const content = readFileSync(full, 'utf8');
          if (content.includes('removeAllContentTypeParsers')) {
            offenders.push(full);
          }
        }
      }
    }
    walk(srcDir);
    assert.deepEqual(offenders, [], `removeAllContentTypeParsers を直接呼んでいる意図しないファイル: ${offenders.join(', ')}`);
  });
});

describe('agent-manager.ts: agent:repo:auth:request の配線', () => {
  const source = readServerSource('src/services/agent-manager.ts');

  test('RepoAuthRequestPayload を import している', () => {
    assert.match(source, /type\s+RepoAuthRequestPayload/);
  });

  test("case 'agent:repo:auth:request' がある", () => {
    assert.match(source, /case 'agent:repo:auth:request':/);
  });

  test('handleRepoAuthRequest が resolveAgentRepoAuthFromEnv を呼んでいる', () => {
    assert.match(source, /resolveAgentRepoAuthFromEnv\(/);
  });

  test('console.* の呼び出しが authHeader の値をそのまま出していない（!==/=== null の真偽判定以外での参照が無い）', () => {
    const consoleCalls = source.match(/console\.\w+\([^)]*\)/g) || [];
    for (const call of consoleCalls) {
      if (!call.includes('authHeader')) continue;
      assert.match(call, /authHeader\s*(!==|===)\s*null/, `authHeader を参照する console 呼び出しは真偽判定のみであること: ${call}`);
    }
  });
});

describe('routes/api.ts: /token レスポンスに真偽値のみを含める', () => {
  const source = readServerSource('src/routes/api.ts');

  test('agentRepoTokenConfigured（真偽値）を返している', () => {
    assert.match(source, /agentRepoTokenConfigured/);
  });

  test('isAgentRepoTokenConfigured()（真偽値専用ヘルパー）を使っている（PAT の値を直接読まない）', () => {
    assert.match(source, /isAgentRepoTokenConfigured\(\)/);
  });

  test('process.env.DEVRELAY_AGENT_REPO_TOKEN を直接参照していない', () => {
    assert.ok(!source.includes('DEVRELAY_AGENT_REPO_TOKEN'), '/token ルートは PAT env を直接読まない');
  });
});

describe('DEVRELAY_AGENT_REPO_TOKEN を process.env から直接読むのは agent-repo-rules.ts だけ', () => {
  test('agent-repo-rules.ts 以外のソースに process.env.DEVRELAY_AGENT_REPO_TOKEN の直接参照が無い', () => {
    const srcDir = path.join(serverRoot, 'src');
    const offenders = [];

    function walk(dir) {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) {
          walk(full);
        } else if (entry.endsWith('.ts') && entry !== 'agent-repo-rules.ts') {
          const content = readFileSync(full, 'utf8');
          if (content.includes('DEVRELAY_AGENT_REPO_TOKEN')) {
            offenders.push(full);
          }
        }
      }
    }
    walk(srcDir);
    assert.deepEqual(offenders, [], `DEVRELAY_AGENT_REPO_TOKEN を直接参照している意図しないファイル: ${offenders.join(', ')}`);
  });
});
