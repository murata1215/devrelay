import os from 'os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { getClaudeExecutableFallback } from './ai-runner.js';
import { unwrapControlResponse } from './control-response.js';

/**
 * #326 Phase2: Claude OAuth リモート再ログイン（vivid-waddling-boole.md プラン）。
 *
 * `claude_authenticate` / `claude_oauth_callback` は `Query.request()` の生パススルーで
 * 実行する control request の subtype。SDK の型定義（`sdk.d.ts`）には `request()` 自体が
 * 存在しない（型定義漏れ、実行時には存在）ため `as unknown as QueryWithRequest` でキャストする。
 * 実行時に存在することは SDK `@anthropic-ai/claude-agent-sdk@0.2.77`/`0.2.80`（両方で実測確認、
 * `request()` の封筒構造・subtype とも同一）のバンドル `cli.js`（`I6.startOAuthFlow` /
 * `R6.service.handleManualAuthCodeInput`）およびシステム `claude` v2.1.240 の逆アセンブルで
 * 確認済み。将来の SDK 更新で消える可能性があるため、起動直後に `typeof q.request === 'function'`
 * を確認し、無ければ `unsupportedAgent` として扱う。
 *
 * **重要**: `q.request()` が resolve するのは `{ subtype, request_id, response }` という
 * control_response の「封筒」であり、`manualUrl`/`account` 等の中身は1段下の `response` の下にある
 * （SDK 自身も内部で `(await this.request(x)).response` と1段剥がしている、`sdk.mjs` 実測）。
 * これを見落として封筒をそのまま読むと常に `undefined` になり `unsupportedAgent` に落ちる
 * バグが #341 直後の実チャットで発覚した（#343）。`unwrapControlResponse()` で必ず1段剥がすこと。
 */
type QueryWithRequest = Query & {
  request(req: unknown): Promise<Record<string, unknown>>;
};

interface ActiveFlow {
  requestId: string;
  q: QueryWithRequest;
  abort: AbortController;
  timer: NodeJS.Timeout;
}

/**
 * 進行中の OAuth フロー（cli.js 側が singleton のため Agent 側も 1 本に限定する）。
 * `claude_authenticate` と `claude_oauth_callback` は同一サブプロセスに届く必要があるため、
 * 短命クエリ 2 本ではなく 1 本の `query()` を `login cancel` / タイムアウト / 次の `login` まで
 * 生かし続ける設計。
 */
let activeFlow: ActiveFlow | null = null;

/** OAuth フローの最大生存時間（10 分）。cli.js 側の認可コード有効期限に合わせる。 */
const FLOW_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * `claude_authenticate` control request のタイムアウト（60 秒）。
 * #341: 元々タイムアウトが無く、control チャネルがハングすると FLOW_TIMEOUT_MS（10 分）まで
 * 無音になっていた（ユーザー報告「リモートでログインできない」の原因の一つ）。
 */
const AUTHENTICATE_TIMEOUT_MS = 60_000;

/** `claude_oauth_callback` control request のタイムアウト（2 分）。認可コード検証はネットワーク往復を伴うため authenticate より長めに取る。 */
const OAUTH_CALLBACK_TIMEOUT_MS = 120_000;

/**
 * Promise にタイムアウトを付ける（外部 import ゼロの純関数、#337 progress-timeout.ts / #339
 * claude-login-code.ts と同じ流儀）。タイムアウト時は Error(`${label} timed out (${ms}ms)`) で reject する。
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out (${Math.round(ms / 1000)}s)`));
    }, ms);
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * 何も yield しない永久 AsyncGenerator。
 * SDK は `prompt` が `AsyncIterable<SDKUserMessage>` のときだけストリーミング入力モードで
 * control channel を開き、CLI サブプロセスを生かし続ける。ユーザーメッセージは一切送らず、
 * `claude_authenticate`/`claude_oauth_callback` の control request だけをこのプロセスに送る。
 */
async function* neverEndingAsyncGenerator(): AsyncGenerator<SDKUserMessage> {
  await new Promise<void>(() => {
    // 意図的に永久に resolve しない（abort されるまでサブプロセスを生かし続けるため）
  });
  // 到達不能。TypeScript の async generator 型を満たすためだけの yield。
  yield undefined as unknown as SDKUserMessage;
}

/** 進行中のフローを破棄する（abort + drain ループの終了 + タイマー解除）。 */
function teardownActiveFlow(reason: string): void {
  if (!activeFlow) return;
  console.log(`🔐 [claude-login] Tearing down flow ${activeFlow.requestId}: ${reason}`);
  clearTimeout(activeFlow.timer);
  try {
    activeFlow.abort.abort();
  } catch {
    // ignore
  }
  activeFlow = null;
}

/** `account` オブジェクトから表示用の "email / plan" 文字列を組み立てる。 */
function formatAccountLabel(account: unknown): string | undefined {
  if (!account || typeof account !== 'object') return undefined;
  const a = account as Record<string, unknown>;
  const email = typeof a.email === 'string' ? a.email : undefined;
  const plan = typeof a.subscriptionType === 'string' ? a.subscriptionType : undefined;
  if (email && plan) return `${email} / ${plan}`;
  return email;
}

/**
 * OAuth 再ログインフローを開始する。
 * ストリーミング入力モードで `query()` を起動し、`claude_authenticate` control request を送って
 * `manualUrl` を取得する（`automaticUrl` はリモート機の localhost を指すため受け取った時点で捨てる）。
 *
 * @param requestId サーバー発行のフロー識別子（`login cancel`/コード投入時の照合に使う）
 */
export async function startClaudeLogin(
  requestId: string
): Promise<{ ok: true; manualUrl: string } | { ok: false; error: string }> {
  // 二重起動は前のフローを abort してから開始（singleton なので競合させない）
  if (activeFlow) {
    teardownActiveFlow('superseded by new startClaudeLogin');
  }

  const abort = new AbortController();
  let q: QueryWithRequest;
  try {
    const claudeFallback = getClaudeExecutableFallback();
    const sdkOptions: Parameters<typeof query>[0]['options'] = {
      cwd: os.homedir(),
      abortController: abort,
      settingSources: [],
    };
    if (claudeFallback) {
      sdkOptions.pathToClaudeCodeExecutable = claudeFallback;
    }
    q = query({ prompt: neverEndingAsyncGenerator(), options: sdkOptions }) as unknown as QueryWithRequest;
  } catch (err) {
    console.error(`❌ [claude-login] Failed to start query():`, err);
    return { ok: false, error: 'unsupportedAgent' };
  }

  if (typeof q.request !== 'function') {
    console.error(`❌ [claude-login] Query.request() is not a function (SDK version mismatch?)`);
    try {
      abort.abort();
    } catch {
      // ignore
    }
    return { ok: false, error: 'unsupportedAgent' };
  }

  // 背景で drain ループを回す（SDK の読み取りは遅延評価。drain しないと request() が永久にハングする）
  void (async () => {
    try {
      for await (const _m of q) {
        // 何もしない。読み取りループを回し続けて control request の応答を流させるだけ。
      }
    } catch (err) {
      if (!abort.signal.aborted) {
        console.error(`⚠️ [claude-login] drain loop ended with error:`, err);
      }
    }
  })();

  const timer = setTimeout(() => {
    console.log(`⏱️ [claude-login] Flow timed out after 10 min (${requestId})`);
    teardownActiveFlow('timeout');
  }, FLOW_TIMEOUT_MS);

  activeFlow = { requestId, q, abort, timer };

  try {
    const rawResponse = await withTimeout(
      q.request({ subtype: 'claude_authenticate', loginWithClaudeAi: true }),
      AUTHENTICATE_TIMEOUT_MS,
      'claude_authenticate request'
    );
    const response = unwrapControlResponse(rawResponse);
    const manualUrl = typeof response.manualUrl === 'string' ? response.manualUrl : undefined;
    // automaticUrl はリモート機の localhost を指すため参照すらしない（受け取った時点で捨てる）
    if (!manualUrl) {
      // #343: manualUrl/automaticUrl の値自体はログに出さない（リスク7、機外に漏らさない方針をログにも適用）
      console.error(`❌ [claude-login] claude_authenticate response missing manualUrl (keys: ${Object.keys(response).join(', ') || '(none)'})`);
      teardownActiveFlow('no manualUrl in response');
      return { ok: false, error: 'unsupportedAgent' };
    }
    return { ok: true, manualUrl };
  } catch (err) {
    console.error(`❌ [claude-login] claude_authenticate failed:`, err);
    teardownActiveFlow('claude_authenticate failed');
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * `login <code#state>` で投入された認可コードをアクティブなフローに送る。
 * `handleManualAuthCodeInput` は失敗するとフロー自体が死ぬ（リトライ不可）ため、
 * 成功・失敗いずれの場合もこの呼び出し後にフローを破棄する。
 */
export async function submitClaudeLoginCode(
  requestId: string,
  authorizationCode: string,
  state: string
): Promise<{ ok: true; account?: string } | { ok: false; error: string }> {
  if (!activeFlow || activeFlow.requestId !== requestId) {
    return { ok: false, error: 'noFlow' };
  }
  const flow = activeFlow;
  try {
    const rawResponse = await withTimeout(
      flow.q.request({ subtype: 'claude_oauth_callback', authorizationCode, state }),
      OAUTH_CALLBACK_TIMEOUT_MS,
      'claude_oauth_callback request'
    );
    const response = unwrapControlResponse(rawResponse);
    teardownActiveFlow('claude_oauth_callback completed');
    const account = formatAccountLabel(response.account);
    return { ok: true, account };
  } catch (err) {
    console.error(`❌ [claude-login] claude_oauth_callback failed:`, err);
    teardownActiveFlow('claude_oauth_callback failed');
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** `login cancel` またはタイムアウトによりアクティブなフローを中断する。 */
export function cancelClaudeLogin(requestId: string, reason: string): { ok: true } | { ok: false; error: string } {
  if (!activeFlow || activeFlow.requestId !== requestId) {
    return { ok: false, error: 'noFlow' };
  }
  teardownActiveFlow(reason);
  return { ok: true };
}
