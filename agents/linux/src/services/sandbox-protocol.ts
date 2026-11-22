/**
 * Sandbox Host（Windows サービス、別リポジトリパス `agents/sandbox-host/`）と Agent 間の
 * 名前付きパイプ通信プロトコル定数（外部 import ゼロ、純粋な定数・型のみ）。
 *
 * サイクル SB-1a-1（`doc/sandbox/SB-0_investigation.md` の設計、改訂版 Plan のレビュー反映）。
 * Windows 専用機能だが、定数定義自体に OS 依存は無いため、テストでは unix domain socket 経由で
 * 同じ値を使って検証できる（`net.connect()` は Windows の named pipe と unix socket の両方を
 * 同じ API で扱える）。
 */

/** プロトコル版（ハンドシェイクで一致しなければ fail-closed で拒否する） */
export const SANDBOX_PROTOCOL_VERSION = 1;

/** Windows の名前付きパイプ名（Sandbox Host がこの名前で listen する） */
export const SANDBOX_PIPE_NAME = `devrelay-sandbox-v${SANDBOX_PROTOCOL_VERSION}`;

/** Windows の名前付きパイプの完全パスを組み立てる */
export function buildSandboxPipePath(): string {
  return `\\\\.\\pipe\\${SANDBOX_PIPE_NAME}`;
}

/** Sandbox Host が名乗るべきサービス名（仮想アカウント、`sc config obj=` で設定する値） */
export const EXPECTED_SANDBOX_SERVICE_NAME = 'NT SERVICE\\devrelay-sandbox';

/** サービス SID（`S-1-5-80-...`）の接頭辞。仮想アカウントの SID は必ずこれで始まる */
export const SANDBOX_SERVICE_SID_PREFIX = 'S-1-5-80-';

/**
 * 既知の特権 SID（LocalSystem / LocalService / NetworkService）。
 * Sandbox Host の身元がこれらに一致していたら権限拡大とみなし必ず拒否する
 * （サービスが誤って、または悪意を持って LocalSystem 等で再作成された場合の最後の砦）。
 */
export const SANDBOX_KNOWN_PRIVILEGED_SIDS: readonly string[] = [
  'S-1-5-18', // LocalSystem
  'S-1-5-19', // LocalService
  'S-1-5-20', // NetworkService
];

/** フレーム種別（1 バイト、ワイヤー上の値）。 */
export const SandboxFrameType = {
  HANDSHAKE_REQUEST: 1,
  HANDSHAKE_RESPONSE: 2,
  SPAWN_REQUEST: 3,
  SPAWN_RESPONSE: 4,
  STDIN_DATA: 5,
  STDIN_EOF: 6,
  STDOUT_DATA: 7,
  STDERR_DATA: 8,
  EXIT: 9,
  KILL: 10,
  ERROR: 11,
} as const;

export type SandboxFrameTypeValue = (typeof SandboxFrameType)[keyof typeof SandboxFrameType];

/** 既知のフレーム種別の集合（デコーダが未知種別を致命エラーにするための参照用） */
export const SANDBOX_KNOWN_FRAME_TYPES: ReadonlySet<number> = new Set(Object.values(SandboxFrameType));

/** 1 フレームの最大長（バイト）。これを超えるフレームは致命エラーとして接続を切る */
export const SANDBOX_MAX_FRAME_BYTES = 16 * 1024 * 1024; // 16MiB

/** ハンドシェイクのタイムアウト（ミリ秒） */
export const SANDBOX_HANDSHAKE_TIMEOUT_MS = 5_000;

/** プローブ（遮断確認）のタイムアウト（ミリ秒） */
export const SANDBOX_PROBE_TIMEOUT_MS = 10_000;

/** 実行前確認の結果キャッシュ TTL（ミリ秒、10 分）。構造判定・身元・プロトコル版は毎ターン再確認し、
 *  ここでキャッシュするのは「実通信プローブ」「ACL/読み取りプローブ」のみ（E 節参照） */
export const SANDBOX_PROBE_CACHE_TTL_MS = 10 * 60 * 1000;

/** CONNECT 中継プロキシの固定ポート（127.0.0.1 のみ bind。キャッシュキーに使うため固定する） */
export const SANDBOX_PROXY_PORT = 48711;

/** ループバック到達確認プローブで使う陽性対照ホスト（許可リストの実ホストを直結で試す） */
export const SANDBOX_POSITIVE_CONTROL_HOST = 'api.anthropic.com';
export const SANDBOX_POSITIVE_CONTROL_PORT = 443;
