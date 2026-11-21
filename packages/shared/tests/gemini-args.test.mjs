// `gemini-args.ts` の単体テスト。
//
// 2026-10-27: Gemini CLI の gemini 分岐が probe 結果を無視して plan ターンでも
// `--approval-mode auto_edit` をハードコードしていたため、`--approval-mode` 自体に
// 非対応の旧 CLI では `Unknown arguments: approval-mode, approvalMode` で会話が
// 一度も成立しなかった（gemini-user 機体）。決定表を fixture ベースで固定する。
//
// 2026-10-27 サイクル2: MCP `approve_implementation` が gemini だけ `planAiSessionMissing` で
// fail-closed する問題の根治（plan→exec resume）。`--session-id` / `--resume` の決定表テストを追加。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseGeminiCapabilities,
  buildGeminiApprovalArgs,
  GEMINI_CAPABILITIES_NONE,
  detectGeminiModelUnavailable,
  isUuidLike,
  buildGeminiSessionArgs,
  resolveGeminiAiSessionId,
  classifyGeminiSessionFailure,
} from '../dist/gemini-args.js';

// fixture A: この母艦で実際に確認した gemini 0.65.0 の --help 全文
// （--approval-mode が choices: default/auto_edit/yolo/plan を持ち、--session-id / --resume にも対応する現行版）
const HELP_CURRENT = `
Usage: gemini [options] [command]

Gemini CLI - Defaults to interactive mode. Use -p/--prompt for non-interactive (headless) mode.

Commands:
  gemini mcp                   Manage MCP servers
  gemini extensions <command>  Manage Gemini CLI extensions.  [aliases: extension]
  gemini skills <command>      Manage agent skills.  [aliases: skill]
  gemini hooks <command>       Manage Gemini CLI hooks.  [aliases: hook]
  gemini gemma                 Manage local Gemma model routing
  gemini [query..]             Launch Gemini CLI  [default]

Positionals:
  query  Initial prompt. Runs in interactive mode by default; use -p/--prompt for non-interactive.

Options:
  -d, --debug                     Run in debug mode (open debug console with F12)  [boolean] [default: false]
  -m, --model                     Model  [string]
  -p, --prompt                    Run in non-interactive (headless) mode with the given prompt. Appended to input on stdin (if any).  [string]
  -i, --prompt-interactive        Execute the provided prompt and continue in interactive mode  [string]
      --skip-trust                Trust the current workspace for this session.  [boolean] [default: false]
  -w, --worktree                  Start Gemini in a new git worktree. If no name is provided, one is generated automatically.  [string]
  -s, --sandbox                   Run in sandbox?  [boolean]
  -y, --yolo                      Automatically accept all actions (aka YOLO mode, see https://www.youtube.com/watch?v=xvFZjo5PgG0 for more details)?  [boolean] [default: false]
      --approval-mode             Set the approval mode: default (prompt for approval), auto_edit (auto-approve edit tools), yolo (auto-approve all tools), plan (read-only mode)  [string] [choices: "default", "auto_edit", "yolo", "plan"]
      --policy                    Additional policy files or directories to load (comma-separated or multiple --policy)  [array]
      --admin-policy              Additional admin policy files or directories to load (comma-separated or multiple --admin-policy)  [array]
      --acp                       Starts the agent in ACP mode  [boolean]
      --experimental-acp          Starts the agent in ACP mode (deprecated, use --acp instead)  [boolean]
      --allowed-mcp-server-names  Allowed MCP server names  [array]
      --allowed-tools              [DEPRECATED: Use Policy Engine instead See https://geminicli.com/docs/core/policy-engine] Tools that are allowed to run without confirmation  [array]
  -e, --extensions                A list of extensions to use. If not provided, all extensions are used.  [array]
  -l, --list-extensions           List all available extensions and exit.  [boolean]
  -r, --resume                    Resume a previous session. Use "latest" for most recent or index number (e.g. --resume 5)  [string]
      --session-file              Load a session from a JSON file  [string]
      --session-id                Start a new session with a manually provided UUID.  [string]
      --list-sessions             List available sessions for the current project and exit.  [boolean]
      --delete-session            Delete a session by index number (use --list-sessions to see available sessions).  [string]
      --include-directories       Additional directories to include in the workspace (comma-separated or multiple --include-directories)  [array]
      --screen-reader              Enable screen reader mode for accessibility.  [boolean]
  -o, --output-format             The format of the CLI output.  [string] [choices: "text", "json", "stream-json"]
      --raw-output                Disable sanitization of model output (e.g. allow ANSI escape sequences). WARNING: This can be a security risk if the model output is untrusted.  [boolean]
      --accept-raw-output-risk    Suppress the security warning when using --raw-output.  [boolean]
  -v, --version                   Show version number  [boolean]
  -h, --help                      Show help  [boolean]
`;

// fixture B: `--approval-mode` 自体が存在しない旧 CLI（gemini-user 機体相当）。
// `-y, --yolo` は残っている想定。`--session-id` / `--resume` も無い。
const HELP_OLD_YOLO_ONLY = `
Options:
  -m, --model      Model  [string]
  -p, --prompt     Run in non-interactive (headless) mode with the given prompt.  [string]
  -y, --yolo       Automatically accept all actions (aka YOLO mode)?  [boolean] [default: false]
  -v, --version    Show version number  [boolean]
  -h, --help       Show help  [boolean]
`;

// fixture C: --approval-mode も --yolo も無い、さらに旧い CLI。--session-id / --resume も無い。
const HELP_VERY_OLD = `
Options:
  -p, --prompt     Run in non-interactive (headless) mode with the given prompt.  [string]
  -v, --version    Show version number  [boolean]
  -h, --help       Show help  [boolean]
`;

test('parseGeminiCapabilities: 現行版は model/approvalMode/autoEdit/yolo/yoloFlag/sessionId/resume 全て true', () => {
  const caps = parseGeminiCapabilities(HELP_CURRENT);
  assert.deepEqual(caps, {
    model: true,
    approvalMode: true,
    approvalModeAutoEdit: true,
    approvalModeYolo: true,
    yoloFlag: true,
    sessionId: true,
    resume: true,
  });
});

test('parseGeminiCapabilities: --approval-mode 非対応の旧 CLI は approvalMode 系・sessionId・resume が全て false', () => {
  const caps = parseGeminiCapabilities(HELP_OLD_YOLO_ONLY);
  assert.deepEqual(caps, {
    model: true,
    approvalMode: false,
    approvalModeAutoEdit: false,
    approvalModeYolo: false,
    yoloFlag: true,
    sessionId: false,
    resume: false,
  });
});

test('parseGeminiCapabilities: --yolo も無い最旧 CLI は yoloFlag・sessionId・resume も false', () => {
  const caps = parseGeminiCapabilities(HELP_VERY_OLD);
  assert.equal(caps.yoloFlag, false);
  assert.equal(caps.approvalMode, false);
  assert.equal(caps.model, false);
  assert.equal(caps.sessionId, false);
  assert.equal(caps.resume, false);
});

// ---- buildGeminiApprovalArgs: 決定表 ----

test('現行版 + exec ターン: --approval-mode yolo', () => {
  const caps = parseGeminiCapabilities(HELP_CURRENT);
  const result = buildGeminiApprovalArgs(caps, { usePlanMode: false, yoloEnabled: true });
  assert.deepEqual(result, { args: ['--approval-mode', 'yolo'], degraded: 'none' });
});

test('現行版 + plan ターン: --approval-mode auto_edit（従来どおり）', () => {
  const caps = parseGeminiCapabilities(HELP_CURRENT);
  const result = buildGeminiApprovalArgs(caps, { usePlanMode: true, yoloEnabled: true });
  assert.deepEqual(result, { args: ['--approval-mode', 'auto_edit'], degraded: 'none' });
});

test('旧版（--approval-mode 非対応, --yolo あり) + exec ターン: --yolo に劣化（警告不要）', () => {
  const caps = parseGeminiCapabilities(HELP_OLD_YOLO_ONLY);
  const result = buildGeminiApprovalArgs(caps, { usePlanMode: false, yoloEnabled: true });
  assert.deepEqual(result, { args: ['--yolo'], degraded: 'execYoloFlag' });
});

test('旧版（--approval-mode 非対応) + plan ターン: フラグ無し + planNoFlag（今回の事故ケースの修正）', () => {
  const caps = parseGeminiCapabilities(HELP_OLD_YOLO_ONLY);
  const result = buildGeminiApprovalArgs(caps, { usePlanMode: true, yoloEnabled: true });
  assert.deepEqual(result, { args: [], degraded: 'planNoFlag' });
});

test('最旧版（--approval-mode も --yolo も無し) + exec ターン: フラグ無し + execNoFlag', () => {
  const caps = parseGeminiCapabilities(HELP_VERY_OLD);
  const result = buildGeminiApprovalArgs(caps, { usePlanMode: false, yoloEnabled: true });
  assert.deepEqual(result, { args: [], degraded: 'execNoFlag' });
});

test('最旧版 + plan ターン: フラグ無し + planNoFlag', () => {
  const caps = parseGeminiCapabilities(HELP_VERY_OLD);
  const result = buildGeminiApprovalArgs(caps, { usePlanMode: true, yoloEnabled: true });
  assert.deepEqual(result, { args: [], degraded: 'planNoFlag' });
});

test('DEVRELAY_GEMINI_YOLO=0（yoloEnabled:false）相当: exec でも plan と同じ auto_edit 経路', () => {
  const caps = parseGeminiCapabilities(HELP_CURRENT);
  const result = buildGeminiApprovalArgs(caps, { usePlanMode: false, yoloEnabled: false });
  assert.deepEqual(result, { args: ['--approval-mode', 'auto_edit'], degraded: 'none' });
});

test('probe 失敗時（GEMINI_CAPABILITIES_NONE）: plan/exec とも常にフラグ無し', () => {
  const planResult = buildGeminiApprovalArgs(GEMINI_CAPABILITIES_NONE, { usePlanMode: true, yoloEnabled: true });
  assert.deepEqual(planResult, { args: [], degraded: 'planNoFlag' });
  const execResult = buildGeminiApprovalArgs(GEMINI_CAPABILITIES_NONE, { usePlanMode: false, yoloEnabled: true });
  assert.deepEqual(execResult, { args: [], degraded: 'execNoFlag' });
});

// ---- Phase 2: droppedFlags（実行時リトライ安全網）----

test('droppedFlags に --approval-mode が入ると、対応していても --yolo にフォールバックする', () => {
  const caps = parseGeminiCapabilities(HELP_CURRENT);
  const result = buildGeminiApprovalArgs(caps, {
    usePlanMode: false,
    yoloEnabled: true,
    droppedFlags: ['--approval-mode'],
  });
  assert.deepEqual(result, { args: ['--yolo'], degraded: 'execYoloFlag' });
});

test('droppedFlags に --yolo も --approval-mode も入ると exec でもフラグ無しになる', () => {
  const caps = parseGeminiCapabilities(HELP_CURRENT);
  const result = buildGeminiApprovalArgs(caps, {
    usePlanMode: false,
    yoloEnabled: true,
    droppedFlags: ['--approval-mode', '--yolo'],
  });
  assert.deepEqual(result, { args: [], degraded: 'execNoFlag' });
});

test('droppedFlags に --approval-mode が入ると plan ターンはフラグ無しになる', () => {
  const caps = parseGeminiCapabilities(HELP_CURRENT);
  const result = buildGeminiApprovalArgs(caps, {
    usePlanMode: true,
    yoloEnabled: true,
    droppedFlags: ['--approval-mode'],
  });
  assert.deepEqual(result, { args: [], degraded: 'planNoFlag' });
});

// ---- isUuidLike: 2026-10-27 サイクル2（plan→exec resume） ----

test('isUuidLike: 正しい UUID 形式は true', () => {
  assert.equal(isUuidLike('1e1513cd-9161-42fb-a895-9b024dcbe7ad'), true);
  assert.equal(isUuidLike('1E1513CD-9161-42FB-A895-9B024DCBE7AD'), true);
});

test('isUuidLike: UUID でない値・undefined・null・空文字は false', () => {
  assert.equal(isUuidLike('not-a-uuid'), false);
  assert.equal(isUuidLike('1e1513cd91614'), false);
  assert.equal(isUuidLike(''), false);
  assert.equal(isUuidLike(undefined), false);
  assert.equal(isUuidLike(null), false);
  // シェルインジェクション対策: セミコロン等を含む値は必ず false
  assert.equal(isUuidLike('1e1513cd-9161-42fb-a895-9b024dcbe7ad; rm -rf /'), false);
});

// ---- buildGeminiSessionArgs: 決定表（resume 優先 → 新規採番 → 何もしない、相互排他） ----

const CAPS_SESSION_OK = parseGeminiCapabilities(HELP_CURRENT); // sessionId: true, resume: true
const CAPS_SESSION_NONE = parseGeminiCapabilities(HELP_OLD_YOLO_ONLY); // sessionId: false, resume: false
const UUID_A = '1e1513cd-9161-42fb-a895-9b024dcbe7ad';
const UUID_B = '99999999-8888-4777-8666-555555555555';

test('buildGeminiSessionArgs: resumeSessionId のみ指定 → --resume', () => {
  const result = buildGeminiSessionArgs({ caps: CAPS_SESSION_OK, resumeSessionId: UUID_A });
  assert.deepEqual(result, { args: ['--resume', UUID_A], resumeId: UUID_A, degraded: 'none' });
});

test('buildGeminiSessionArgs: newSessionId のみ指定 → --session-id', () => {
  const result = buildGeminiSessionArgs({ caps: CAPS_SESSION_OK, newSessionId: UUID_A });
  assert.deepEqual(result, { args: ['--session-id', UUID_A], sessionId: UUID_A, degraded: 'none' });
});

test('buildGeminiSessionArgs: resumeSessionId と newSessionId が両方指定されたら resume を優先する', () => {
  const result = buildGeminiSessionArgs({ caps: CAPS_SESSION_OK, resumeSessionId: UUID_A, newSessionId: UUID_B });
  assert.deepEqual(result, { args: ['--resume', UUID_A], resumeId: UUID_A, degraded: 'none' });
});

test('buildGeminiSessionArgs: どちらも指定なし → フラグ無し（chat ターンの既定、argv 無変化）', () => {
  const result = buildGeminiSessionArgs({ caps: CAPS_SESSION_OK });
  assert.deepEqual(result, { args: [], degraded: 'none' });
});

test('buildGeminiSessionArgs: caps.resume=false で resumeSessionId 指定 → resumeUnsupported', () => {
  const result = buildGeminiSessionArgs({ caps: CAPS_SESSION_NONE, resumeSessionId: UUID_A });
  assert.deepEqual(result, { args: [], degraded: 'resumeUnsupported' });
});

test('buildGeminiSessionArgs: caps.sessionId=false で newSessionId 指定 → sessionIdUnsupported', () => {
  const result = buildGeminiSessionArgs({ caps: CAPS_SESSION_NONE, newSessionId: UUID_A });
  assert.deepEqual(result, { args: [], degraded: 'sessionIdUnsupported' });
});

test('buildGeminiSessionArgs: droppedFlags に --resume が入ると、caps が対応していても resumeUnsupported', () => {
  const result = buildGeminiSessionArgs({ caps: CAPS_SESSION_OK, resumeSessionId: UUID_A, droppedFlags: ['--resume'] });
  assert.deepEqual(result, { args: [], degraded: 'resumeUnsupported' });
});

test('buildGeminiSessionArgs: droppedFlags に --session-id が入ると、caps が対応していても sessionIdUnsupported', () => {
  const result = buildGeminiSessionArgs({ caps: CAPS_SESSION_OK, newSessionId: UUID_A, droppedFlags: ['--session-id'] });
  assert.deepEqual(result, { args: [], degraded: 'sessionIdUnsupported' });
});

test('buildGeminiSessionArgs: UUID 形式でない resumeSessionId は渡さない（invalidId、シェル安全策）', () => {
  const result = buildGeminiSessionArgs({ caps: CAPS_SESSION_OK, resumeSessionId: 'not-a-uuid; rm -rf /' });
  assert.deepEqual(result, { args: [], degraded: 'invalidId' });
});

test('buildGeminiSessionArgs: UUID 形式でない newSessionId は渡さない（invalidId）', () => {
  const result = buildGeminiSessionArgs({ caps: CAPS_SESSION_OK, newSessionId: 'not-a-uuid' });
  assert.deepEqual(result, { args: [], degraded: 'invalidId' });
});

test('buildGeminiSessionArgs: 不変条件 — --resume と --session-id が同時に args に出ることはない', () => {
  const cases = [
    { caps: CAPS_SESSION_OK, resumeSessionId: UUID_A },
    { caps: CAPS_SESSION_OK, newSessionId: UUID_A },
    { caps: CAPS_SESSION_OK, resumeSessionId: UUID_A, newSessionId: UUID_B },
    { caps: CAPS_SESSION_OK },
    { caps: CAPS_SESSION_NONE, resumeSessionId: UUID_A },
    { caps: CAPS_SESSION_NONE, newSessionId: UUID_A },
    { caps: CAPS_SESSION_OK, resumeSessionId: 'bad-id' },
  ];
  for (const c of cases) {
    const result = buildGeminiSessionArgs(c);
    const hasResumeFlag = result.args.includes('--resume');
    const hasSessionIdFlag = result.args.includes('--session-id');
    assert.equal(hasResumeFlag && hasSessionIdFlag, false, `both flags present for case ${JSON.stringify(c)}`);
  }
});

// ---- resolveGeminiAiSessionId: 完了報告でエコーバックする aiSessionId の決定 ----

test('resolveGeminiAiSessionId: 出力が1バイトも無ければ常に undefined（fail-closed）', () => {
  assert.equal(resolveGeminiAiSessionId({ producedOutput: false, newSessionId: UUID_A }), undefined);
  assert.equal(resolveGeminiAiSessionId({ producedOutput: false, resumeSessionId: UUID_A }), undefined);
  assert.equal(resolveGeminiAiSessionId({ producedOutput: false }), undefined);
});

test('resolveGeminiAiSessionId: 出力あり + newSessionId のみ → newSessionId', () => {
  assert.equal(resolveGeminiAiSessionId({ producedOutput: true, newSessionId: UUID_A }), UUID_A);
});

test('resolveGeminiAiSessionId: 出力あり + resumeSessionId のみ → resumeSessionId', () => {
  assert.equal(resolveGeminiAiSessionId({ producedOutput: true, resumeSessionId: UUID_B }), UUID_B);
});

test('resolveGeminiAiSessionId: 出力あり + 両方指定（通常起きないが）→ newSessionId を優先', () => {
  assert.equal(resolveGeminiAiSessionId({ producedOutput: true, newSessionId: UUID_A, resumeSessionId: UUID_B }), UUID_A);
});

test('resolveGeminiAiSessionId: 出力あり + どちらも無し → undefined', () => {
  assert.equal(resolveGeminiAiSessionId({ producedOutput: true }), undefined);
});

// ---- classifyGeminiSessionFailure: 本日実機で確認した exit 42 の stderr 文言 ----

// 実機ログそのまま（gemini-cli 0.65.0、同じ --session-id を再利用した場合）
const STDERR_SESSION_ID_COLLISION = 'Error starting session: Session ID "11111111-2222-4333-8444-555555555555" already exists. Use --resume to resume it, or provide a different ID.';

// 実機ログそのまま（gemini-cli 0.65.0、存在しない --resume 先を指定した場合）
const STDERR_RESUME_INVALID = `Error resuming session: Invalid session identifier "99999999-8888-4777-8666-555555555555".
  Searched for sessions in /home/devrelay/.gemini/tmp/gttfb/chats.
  Use --list-sessions to see available sessions, then use --resume {number}, --resume {uuid}, or --resume latest.`;

test('classifyGeminiSessionFailure: exit 42 + ID 重複の stderr → sessionIdAlreadyExists', () => {
  const result = classifyGeminiSessionFailure({ exitCode: 42, stderr: STDERR_SESSION_ID_COLLISION });
  assert.equal(result, 'sessionIdAlreadyExists');
});

test('classifyGeminiSessionFailure: exit 42 + resume 先なしの stderr → resumeInvalid', () => {
  const result = classifyGeminiSessionFailure({ exitCode: 42, stderr: STDERR_RESUME_INVALID });
  assert.equal(result, 'resumeInvalid');
});

test('classifyGeminiSessionFailure: exit 42 でも該当パターンでなければ none', () => {
  const result = classifyGeminiSessionFailure({ exitCode: 42, stderr: 'some unrelated error' });
  assert.equal(result, 'none');
});

test('classifyGeminiSessionFailure: exit code が 42 以外なら常に none（exit 1 等の既存経路に任せる）', () => {
  assert.equal(classifyGeminiSessionFailure({ exitCode: 1, stderr: STDERR_SESSION_ID_COLLISION }), 'none');
  assert.equal(classifyGeminiSessionFailure({ exitCode: 0, stderr: STDERR_RESUME_INVALID }), 'none');
  assert.equal(classifyGeminiSessionFailure({ exitCode: null, stderr: STDERR_RESUME_INVALID }), 'none');
});

// ---- detectGeminiModelUnavailable: 2026-10-27 gemini-user 機体で発覚したモデル廃止 404 ----

// 実機ログそのまま（`[API Error: ...]` でラップされた二重エスケープ JSON、`--approval-mode` 根治後に発生）
const STDERR_MODEL_RETIRED = '[API Error: {"error":{"message":"{\\n  \\"error\\": {\\n    \\"code\\": 404,\\n    \\"message\\": \\"This model models/gemini-2.5-pro is no longer available to new users. Please update your code to use models/gemini-3.1-pro-preview for the latest features and improvements. We recommend you to use the Interactions API (https://ai.google.dev/gemini-api/docs/get-started).\\",\\n    \\"status\\": \\"NOT_FOUND\\"\\n  }\\n}\\n","code":404,"status":"Not Found"}}]';

// 対話モード（`gemini -m <id> -p ...`）で見られる別形式（存在しないモデル ID を明示指定した場合）
const STDERR_MODEL_NOT_FOUND = `Error when talking to Gemini API Full report available at: /tmp/gemini-client-error-Turn.run-sendMessageStream.json ModelNotFoundError: models/gemini-3.1-pro is not found for API version v1beta, or is not supported for generateContent. Call ModelService.ListModels to see the list of available models and their supported methods.
    at classifyGoogleError (...)`;

test('detectGeminiModelUnavailable: 実機ログ（廃止モデル 404）からモデル名と推奨移行先を抽出する', () => {
  const info = detectGeminiModelUnavailable(STDERR_MODEL_RETIRED);
  assert.deepEqual(info, { model: 'gemini-2.5-pro', recommendedModel: 'gemini-3.1-pro-preview' });
});

test('detectGeminiModelUnavailable: ModelNotFoundError 形式（推奨移行先の案内なし）も検出する', () => {
  const info = detectGeminiModelUnavailable(STDERR_MODEL_NOT_FOUND);
  assert.deepEqual(info, { model: 'gemini-3.1-pro' });
});

test('detectGeminiModelUnavailable: 該当パターンが無ければ null', () => {
  assert.equal(detectGeminiModelUnavailable('some unrelated stderr'), null);
  assert.equal(detectGeminiModelUnavailable(''), null);
});
