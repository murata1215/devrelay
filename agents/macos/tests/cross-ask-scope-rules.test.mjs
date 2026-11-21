// サイクルS2a: クロスユーザー ask の読める範囲・使えるツール制限（cross-ask-scope-rules.ts）の
// 単体テスト。外部 import ゼロの純粋関数をコンパイル済み dist から直接 import する
// （plan-permission.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CROSS_ASK_TOOLS,
  CROSS_ASK_DISALLOWED_TOOLS,
  isSafeRelativeGlobArgument,
  isDeniedProjectRelativePath,
  decideCrossAskToolPermission,
  buildCrossAskSdkOverrides,
  buildCrossAskEnv,
  decideCrossAskInitAssertion,
  CROSS_ASK_AUTO_MEMORY_DIR,
} from '../dist/services/cross-ask-scope-rules.js';

const ALWAYS_ALLOW_PATH = () => true;
const ALWAYS_DENY_PATH = () => false;

// --- isSafeRelativeGlobArgument ---

test('isSafeRelativeGlobArgument: 相対パスは許可', () => {
  assert.equal(isSafeRelativeGlobArgument('src/**/*.ts'), true);
  assert.equal(isSafeRelativeGlobArgument('*.md'), true);
  assert.equal(isSafeRelativeGlobArgument('./docs/*.md'), true);
});

test('isSafeRelativeGlobArgument: 絶対パス・ホーム展開・traversal・変数展開は拒否', () => {
  assert.equal(isSafeRelativeGlobArgument('/etc/passwd'), false);
  assert.equal(isSafeRelativeGlobArgument('/home/other/.claude/**'), false);
  assert.equal(isSafeRelativeGlobArgument('~/.claude/**'), false);
  assert.equal(isSafeRelativeGlobArgument('../../secret/**'), false);
  assert.equal(isSafeRelativeGlobArgument('$HOME/**'), false);
  assert.equal(isSafeRelativeGlobArgument('C:\\Users\\x\\**'), false);
  assert.equal(isSafeRelativeGlobArgument(''), false);
});

// --- isDeniedProjectRelativePath ---

test('isDeniedProjectRelativePath: .devrelay 配下・.env・秘密鍵・.git 全体を deny する', () => {
  assert.equal(isDeniedProjectRelativePath('.devrelay/sessions/x/conversation.json'), true);
  assert.equal(isDeniedProjectRelativePath('.devrelay-output/report.pdf'), true);
  assert.equal(isDeniedProjectRelativePath('.devrelay-files/upload.png'), true);
  assert.equal(isDeniedProjectRelativePath('.env'), true);
  assert.equal(isDeniedProjectRelativePath('.env.production'), true);
  assert.equal(isDeniedProjectRelativePath('config/.env'), true);
  assert.equal(isDeniedProjectRelativePath('.git/config'), true);
  assert.equal(isDeniedProjectRelativePath('.git/hooks/pre-commit'), true);
  assert.equal(isDeniedProjectRelativePath('.git/logs/HEAD'), true);
  assert.equal(isDeniedProjectRelativePath('id_rsa'), true);
  assert.equal(isDeniedProjectRelativePath('ssh/id_ed25519.pub'), true);
  assert.equal(isDeniedProjectRelativePath('server.pem'), true);
  assert.equal(isDeniedProjectRelativePath('creds/credentials.json'), true);
  assert.equal(isDeniedProjectRelativePath('devrelay-245f6-firebase-adminsdk-fbsvc-18e764c480.json'), true);
  assert.equal(isDeniedProjectRelativePath('.aws/credentials'), true);
  assert.equal(isDeniedProjectRelativePath('.ssh/config'), true);
  assert.equal(isDeniedProjectRelativePath('.gnupg/pubring.kbx'), true);
  assert.equal(isDeniedProjectRelativePath('.config/gcloud/credentials.db'), true);
  assert.equal(isDeniedProjectRelativePath('.claude/settings.local.json'), true);
  assert.equal(isDeniedProjectRelativePath('.claude/.credentials.json'), true);
  assert.equal(isDeniedProjectRelativePath('.mcp.json'), true);
  assert.equal(isDeniedProjectRelativePath('db.sqlite3'), true);
  assert.equal(isDeniedProjectRelativePath('.terraform/terraform.tfstate'), true);
  assert.equal(isDeniedProjectRelativePath('.venv/bin/python'), true);
  assert.equal(isDeniedProjectRelativePath('.git-credentials'), true);
  assert.equal(isDeniedProjectRelativePath('.npmrc'), true);
  assert.equal(isDeniedProjectRelativePath('.netrc'), true);
  assert.equal(isDeniedProjectRelativePath('.pgpass'), true);
  assert.equal(isDeniedProjectRelativePath('.htpasswd'), true);
});

test('isDeniedProjectRelativePath: 通常のソースファイルは deny しない', () => {
  assert.equal(isDeniedProjectRelativePath('src/index.ts'), false);
  assert.equal(isDeniedProjectRelativePath('README.md'), false);
  assert.equal(isDeniedProjectRelativePath('CLAUDE.md'), false);
  assert.equal(isDeniedProjectRelativePath('package.json'), false);
  assert.equal(isDeniedProjectRelativePath('docs/environment.md'), false); // "environment" に "env" を含むが拡張子一致は要求
  assert.equal(isDeniedProjectRelativePath('.gitignore'), false); // .git/ ディレクトリではない
});

// --- decideCrossAskToolPermission ---

test('decideCrossAskToolPermission: Read/Grep/Glob はプロジェクト配下なら allow', () => {
  assert.deepEqual(
    decideCrossAskToolPermission({ toolName: 'Read', input: { file_path: '/proj/src/index.ts' }, hasMcpServer: false, hasAgentId: false, isPathAllowed: ALWAYS_ALLOW_PATH }),
    { behavior: 'allow' },
  );
  assert.deepEqual(
    decideCrossAskToolPermission({ toolName: 'Grep', input: { pattern: 'foo', path: 'src' }, hasMcpServer: false, hasAgentId: false, isPathAllowed: ALWAYS_ALLOW_PATH }),
    { behavior: 'allow' },
  );
  assert.deepEqual(
    decideCrossAskToolPermission({ toolName: 'Glob', input: { pattern: '**/*.ts' }, hasMcpServer: false, hasAgentId: false, isPathAllowed: ALWAYS_ALLOW_PATH }),
    { behavior: 'allow' },
  );
});

test('decideCrossAskToolPermission: パスがプロジェクト外なら deny', () => {
  const decision = decideCrossAskToolPermission({ toolName: 'Read', input: { file_path: '/etc/passwd' }, hasMcpServer: false, hasAgentId: false, isPathAllowed: ALWAYS_DENY_PATH });
  assert.equal(decision.behavior, 'deny');
  assert.equal(decision.reason, 'crossAskPolicy:pathOutsideProject');
});

test('decideCrossAskToolPermission: Bash/WebFetch/WebSearch/Task/Agent/ToolSearch/Skill/NotebookRead は deny', () => {
  for (const toolName of ['Bash', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'ToolSearch', 'Skill', 'NotebookRead', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'BashOutput', 'KillShell', 'TodoWrite', 'ExitPlanMode', 'AskUserQuestion']) {
    const decision = decideCrossAskToolPermission({ toolName, input: {}, hasMcpServer: false, hasAgentId: false, isPathAllowed: ALWAYS_ALLOW_PATH });
    assert.equal(decision.behavior, 'deny', `${toolName} should be denied`);
    assert.equal(decision.reason, 'crossAskPolicy:notInAllowlist');
  }
});

test('decideCrossAskToolPermission: MCP 経由は常に deny（Read でも）', () => {
  const decision = decideCrossAskToolPermission({ toolName: 'Read', input: { file_path: '/proj/a.ts' }, hasMcpServer: true, hasAgentId: false, isPathAllowed: ALWAYS_ALLOW_PATH });
  assert.equal(decision.behavior, 'deny');
  assert.equal(decision.reason, 'crossAskPolicy:mcpServer');
});

test('decideCrossAskToolPermission: サブエージェント発は常に deny（Read でも）', () => {
  const decision = decideCrossAskToolPermission({ toolName: 'Read', input: { file_path: '/proj/a.ts' }, hasMcpServer: false, hasAgentId: true, isPathAllowed: ALWAYS_ALLOW_PATH });
  assert.equal(decision.behavior, 'deny');
  assert.equal(decision.reason, 'crossAskPolicy:subagent');
});

test('decideCrossAskToolPermission: 未知の引数キーは deny（NotebookRead 風の notebook_path 等）', () => {
  const decision = decideCrossAskToolPermission({ toolName: 'Read', input: { file_path: '/proj/a.ts', notebook_path: '/proj/b.ipynb' }, hasMcpServer: false, hasAgentId: false, isPathAllowed: ALWAYS_ALLOW_PATH });
  assert.equal(decision.behavior, 'deny');
  assert.equal(decision.reason, 'crossAskPolicy:unknownArgument');
});

test('decideCrossAskToolPermission: Glob の pattern が絶対パスなら deny', () => {
  const decision = decideCrossAskToolPermission({ toolName: 'Glob', input: { pattern: '/home/other/.claude/projects/**/*.jsonl' }, hasMcpServer: false, hasAgentId: false, isPathAllowed: ALWAYS_ALLOW_PATH });
  assert.equal(decision.behavior, 'deny');
  assert.equal(decision.reason, 'crossAskPolicy:unsafeGlobPattern');
});

test('decideCrossAskToolPermission: Grep の glob（フィルタ）が .. を含むなら deny', () => {
  const decision = decideCrossAskToolPermission({ toolName: 'Grep', input: { pattern: 'foo', glob: '../**/*.env' }, hasMcpServer: false, hasAgentId: false, isPathAllowed: ALWAYS_ALLOW_PATH });
  assert.equal(decision.behavior, 'deny');
  assert.equal(decision.reason, 'crossAskPolicy:unsafeGlobPattern');
});

test('decideCrossAskToolPermission: Grep の pattern（検索対象の正規表現）は相対パス検査の対象外', () => {
  // pattern は「検索する内容」であり「読むパス」ではないため、"/" や ".." を含んでいても deny しない
  const decision = decideCrossAskToolPermission({ toolName: 'Grep', input: { pattern: '\\.\\./secret' }, hasMcpServer: false, hasAgentId: false, isPathAllowed: ALWAYS_ALLOW_PATH });
  assert.deepEqual(decision, { behavior: 'allow' });
});

test('decideCrossAskToolPermission: path 未指定（既定 cwd）の Grep/Glob は allow', () => {
  assert.deepEqual(
    decideCrossAskToolPermission({ toolName: 'Grep', input: { pattern: 'foo' }, hasMcpServer: false, hasAgentId: false, isPathAllowed: ALWAYS_DENY_PATH }),
    { behavior: 'allow' },
  );
  assert.deepEqual(
    decideCrossAskToolPermission({ toolName: 'Glob', input: { pattern: '*.ts' }, hasMcpServer: false, hasAgentId: false, isPathAllowed: ALWAYS_DENY_PATH }),
    { behavior: 'allow' },
  );
});

// --- 非関与の固定: 通常利用（crossAskScope でない）には一切影響しないこと ---
// decideCrossAskToolPermission 自体は常に判定するため、呼び出し側（ai-runner.ts）が
// options.crossAskScope の条件内でのみ呼ぶことが重要（wiring テストで固定）。
// ここでは関数自体が「クロス ask 以外の呼び出し元から呼ばれても安全」であることを示す:
// 通常利用で使われる全ツール名を allow 判定できることを確認する（deny-only 設計の健全性確認）。
test('decideCrossAskToolPermission: 既定の allowlist（Read/Grep/Glob）はプロジェクト配下なら必ず allow', () => {
  for (const toolName of CROSS_ASK_TOOLS) {
    const decision = decideCrossAskToolPermission({ toolName, input: {}, hasMcpServer: false, hasAgentId: false, isPathAllowed: ALWAYS_ALLOW_PATH });
    assert.deepEqual(decision, { behavior: 'allow' }, `${toolName} should allow with no path args`);
  }
});

// --- buildCrossAskSdkOverrides / buildCrossAskEnv ---

test('buildCrossAskSdkOverrides: tools は Read/Grep/Glob のみ、mcpServers は空、settingSources は空', () => {
  const overrides = buildCrossAskSdkOverrides(CROSS_ASK_AUTO_MEMORY_DIR);
  assert.deepEqual([...overrides.tools].sort(), ['Glob', 'Grep', 'Read']);
  assert.deepEqual(overrides.mcpServers, {});
  assert.equal(overrides.strictMcpConfig, true);
  assert.deepEqual(overrides.skills, []);
  assert.deepEqual(overrides.settingSources, []);
  assert.equal(overrides.settings.autoMemoryEnabled, false);
  assert.equal(overrides.settings.disableClaudeAiConnectors, true);
  assert.equal(overrides.settings.disableBundledSkills, true);
  assert.deepEqual(overrides.settings.enabledPlugins, {});
  for (const t of CROSS_ASK_DISALLOWED_TOOLS) {
    assert.ok(!overrides.tools.includes(t), `disallowedTools 由来の ${t} が tools に含まれてはいけない`);
  }
});

test('buildCrossAskEnv: 既存の env を保持しつつ auto-memory 遮断用の env を上書きする', () => {
  const base = { PATH: '/usr/bin', CUSTOM: 'x' };
  const merged = buildCrossAskEnv(base);
  assert.equal(merged.PATH, '/usr/bin');
  assert.equal(merged.CUSTOM, 'x');
  assert.equal(merged.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
  assert.equal(merged.CLAUDE_CODE_DISABLE_TERMINAL_TITLE, '1');
  assert.equal(merged.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS, '1');
  // 呼び出し元のオブジェクトは変更しない
  assert.equal(base.CLAUDE_CODE_DISABLE_AUTO_MEMORY, undefined);
});

// --- decideCrossAskInitAssertion ---

test('decideCrossAskInitAssertion: 想定どおりの init は ok', () => {
  const result = decideCrossAskInitAssertion(
    { tools: ['Read', 'Grep', 'Glob'], mcp_servers: [], permissionMode: 'plan', cwd: '/proj' },
    '/proj',
  );
  assert.deepEqual(result, { ok: true });
});

test('decideCrossAskInitAssertion: tools に想定外のツール（Bash）があれば ng', () => {
  const result = decideCrossAskInitAssertion(
    { tools: ['Read', 'Bash'], mcp_servers: [], permissionMode: 'plan', cwd: '/proj' },
    '/proj',
  );
  assert.equal(result.ok, false);
});

test('decideCrossAskInitAssertion: mcp_servers が空でなければ ng', () => {
  const result = decideCrossAskInitAssertion(
    { tools: ['Read'], mcp_servers: [{ name: 'context7' }], permissionMode: 'plan', cwd: '/proj' },
    '/proj',
  );
  assert.equal(result.ok, false);
});

test('decideCrossAskInitAssertion: permissionMode が plan でなければ ng', () => {
  const result = decideCrossAskInitAssertion(
    { tools: ['Read'], mcp_servers: [], permissionMode: 'auto', cwd: '/proj' },
    '/proj',
  );
  assert.equal(result.ok, false);
});

test('decideCrossAskInitAssertion: cwd がプロジェクトルートと異なれば ng', () => {
  const result = decideCrossAskInitAssertion(
    { tools: ['Read'], mcp_servers: [], permissionMode: 'plan', cwd: '/other' },
    '/proj',
  );
  assert.equal(result.ok, false);
});

test('decideCrossAskInitAssertion: cwd 未提供（SDK バージョン差）なら cwd 検査をスキップする', () => {
  const result = decideCrossAskInitAssertion(
    { tools: ['Read'], mcp_servers: [], permissionMode: 'plan' },
    '/proj',
  );
  assert.deepEqual(result, { ok: true });
});
