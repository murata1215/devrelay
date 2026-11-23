/**
 * Sandbox 実行用の中継プロキシ（127.0.0.1:48711）を参照カウント付きで共有するヘルパ。
 *
 * サイクル SB-1a-2。SB-1a-1.1 の `cli/commands/sandbox.ts` にあった
 * `detectExistingSandboxProxyListener()` / `withSandboxProxy()` をここへ移設し、同一プロセス内の
 * 複数呼び出し（例: selftest の複数プローブ・チャット経路の複数ターン）が同時にプロキシを
 * 必要とした場合でも、48711 の二重起動や「1 件目が終わったら閉じて 2 件目が使えない」を防ぐ
 * ために参照カウントを追加した。
 *
 * selftest の `--network-probe` で「中継プロキシ: 自分で一時起動しました」が複数回表示され、
 * 2 本目のプローブが始まる前にプロキシが閉じてしまっていた既存バグ（SB-1a-1.1 時点で未解決、
 * SB-1a-2 の人間の承認範囲 a）の根治点。呼び出し側（selftest 全体を 1 回で包む）が
 * `withSandboxProxy()` を 1 回だけ呼べば、内部の複数プローブは同じプロキシを共有する。
 */

import * as net from 'node:net';
import { SANDBOX_PROXY_PORT } from './sandbox-protocol.js';
import { resolveSandboxAllowlist } from './sandbox-allowlist.js';
import { decideSandboxProxyMode } from './sandbox-proxy-mode.js';
import { createSandboxConnectProxy, type SandboxProxyDenial, type SandboxProxyHandle } from './sandbox-proxy.js';

export interface SandboxProxySessionOptions {
  /** `config.yaml` の `sandbox.allowlist`（未指定なら既定値） */
  allowlist?: string[];
  /** `config.yaml` の `proxy.url`（上位プロキシ。http/https のみ chain する） */
  upstreamProxyUrl?: string;
  /** 診断用の 1 行ログ出力先（省略可。CLI は `console.log` 相当を渡す） */
  log?: (message: string) => void;
}

export interface SandboxProxySession {
  /** 自分で起動したプロキシが拒否した宛先の記録（既存の待ち受けを再利用した場合は常に空） */
  deniedTargets: SandboxProxyDenial[];
}

/** 48711 への接続試行（500ms タイムアウト）で既存の中継プロキシの待ち受けを検出する */
function detectExistingSandboxProxyListener(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: SANDBOX_PROXY_PORT });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 500);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

interface SharedProxyState {
  handle: SandboxProxyHandle;
  deniedTargets: SandboxProxyDenial[];
  refCount: number;
}

/** モジュール内の共有状態（自分で起動したプロキシのみ追跡。外部の待ち受け利用時は null のまま）。 */
let shared: SharedProxyState | null = null;
/** 起動処理が進行中の間、後続の呼び出しを待たせるためのロック。 */
let starting: Promise<SharedProxyState | null> | null = null;

function upstreamScheme(upstreamProxyUrl?: string): string | undefined {
  if (!upstreamProxyUrl) return undefined;
  try {
    return new URL(upstreamProxyUrl).protocol.replace(/:$/, '');
  } catch {
    return undefined;
  }
}

async function startSharedProxy(options: SandboxProxySessionOptions): Promise<SharedProxyState | null> {
  const listenerDetected = await detectExistingSandboxProxyListener();
  const decision = decideSandboxProxyMode({ listenerDetected, upstreamProxyScheme: upstreamScheme(options.upstreamProxyUrl) });
  options.log?.(decision.message);
  if (decision.mode !== 'start-own') {
    // 既存の待ち受けを再利用、または起動できない（socks）。共有状態は持たない
    // （前者は拒否記録を観測できず、後者は `loopback_probe_failed` 等で拒否される前提）。
    return null;
  }

  const allowlistResolution = resolveSandboxAllowlist(options.allowlist);
  const allowlist = allowlistResolution.ok ? allowlistResolution.allowlist : [];
  const deniedTargets: SandboxProxyDenial[] = [];
  try {
    const handle = await createSandboxConnectProxy({
      port: SANDBOX_PROXY_PORT,
      allowlist,
      upstreamProxyUrl: options.upstreamProxyUrl,
      onDenied: (denial) => {
        deniedTargets.push(denial);
      },
    });
    return { handle, deniedTargets, refCount: 0 };
  } catch (err) {
    options.log?.(`中継プロキシの起動に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * 中継プロキシの利用権を取得する。既に自分で起動済みの共有プロキシがあれば参照カウントを
 * 増やして再利用し、無ければ `startSharedProxy()` で判定・起動する（起動中に他の呼び出しが
 * 来た場合は同じ起動処理を待つ。単一スレッドの Node.js 上では同期区間でロックが効くため、
 * 複数呼び出しが 48711 を二重 bind することはない）。
 *
 * @returns `release()` を呼ぶまで保持し続けること。参照カウントが 0 になった時点でのみ実際に close する。
 */
export async function acquireSandboxProxy(
  options: SandboxProxySessionOptions,
): Promise<{ session: SandboxProxySession; release: () => Promise<void> }> {
  if (!shared) {
    if (!starting) {
      starting = startSharedProxy(options);
    }
    const result = await starting;
    starting = null;
    shared = result;
  }

  if (shared) {
    const state = shared;
    state.refCount += 1;
    let released = false;
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      state.refCount -= 1;
      if (state.refCount <= 0) {
        if (shared === state) shared = null;
        await state.handle.close();
      }
    };
    return { session: { deniedTargets: state.deniedTargets }, release };
  }

  // 既存の待ち受けを再利用、または起動不可。追跡する状態が無いので release は no-op。
  return { session: { deniedTargets: [] }, release: async () => {} };
}

/**
 * `fn()` の実行中だけ中継プロキシを用意する（`acquireSandboxProxy()` + 必ず `release()` する薄い
 * ラッパー）。`fn` の中で複数の非同期処理が同時に `withSandboxProxy()` を呼んでも、参照カウントに
 * より最後の 1 件が閉じるまでプロキシは維持される。
 */
export async function withSandboxProxy<T>(
  options: SandboxProxySessionOptions,
  fn: (session: SandboxProxySession) => Promise<T>,
): Promise<T> {
  const { session, release } = await acquireSandboxProxy(options);
  try {
    return await fn(session);
  } finally {
    await release();
  }
}
