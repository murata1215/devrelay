import os from 'os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { getClaudeExecutableFallback } from './ai-runner.js';

/**
 * #326 Phase2: Claude OAuth リモート再ログイン（vivid-waddling-boole.md プラン）。
 *
 * `claude_authenticate` / `claude_oauth_callback` は `Query.request()` の生パススルーで
 * 実行する control request の subtype。SDK の型定義（`sdk.d.ts`）には `request()` 自体が
 * 存在しない（型定義漏れ、実行時には存在）ため `as unknown as QueryWithRequest` でキャストする。
 * 実行時に存在することは SDK `@anthropic-ai/claude-agent-sdk@0.2.77` のバンドル `cli.js`
 * （`I6.startOAuthFlow` / `R6.service.handleManualAuthCodeInput`）およびシステム
 * `claude` v2.1.240 の逆アセンブルで確認済み。将来の SDK 更新で消える可能性があるため、
 * 起動直後に `typeof q.request === 'function'` を確認し、無ければ `unsupportedAgent` として扱う。
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
    const response = await q.request({ subtype: 'claude_authenticate', loginWithClaudeAi: true });
    const manualUrl = typeof response?.manualUrl === 'string' ? response.manualUrl : undefined;
    // automaticUrl はリモート機の localhost を指すため参照すらしない（受け取った時点で捨てる）
    if (!manualUrl) {
      console.error(`❌ [claude-login] claude_authenticate response missing manualUrl`);
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
    const response = await flow.q.request({ subtype: 'claude_oauth_callback', authorizationCode, state });
    teardownActiveFlow('claude_oauth_callback completed');
    const account = formatAccountLabel(response?.account);
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
