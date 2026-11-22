/**
 * Sandbox 実行で許可する外向き接続先の既定値・解決・判定（外部 import ゼロ、純関数）。
 *
 * サイクル SB-1a-1。SB-1 は固定値（D 節）: api.anthropic.com（実行）/ claude.ai・downloads.claude.ai
 * （更新）のみ。テレメトリ用の宛先は意図的に含めない。
 */

export interface SandboxAllowlistEntry {
  host: string;
  ports: number[];
}

/** SB-1 固定の既定許可リスト。呼び出し側は変更せず都度コピーして使うこと。 */
export const DEFAULT_SANDBOX_ALLOWLIST: readonly SandboxAllowlistEntry[] = [
  { host: 'api.anthropic.com', ports: [443] },
  { host: 'claude.ai', ports: [443] },
  { host: 'downloads.claude.ai', ports: [443] },
];

export type SandboxAllowlistResolution =
  | { ok: true; allowlist: SandboxAllowlistEntry[] }
  | { ok: false; reason: string };

const HOST_TOKEN_PATTERN =
  /^(\*\.)?[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/;

function isValidHostToken(token: string): boolean {
  return token.length > 0 && HOST_TOKEN_PATTERN.test(token);
}

/**
 * `host` または `host:port` 形式の文字列配列から許可リストを組み立てる。
 * 1 件でも不正な値があれば**既定値へフォールバックせず拒否する**（fail-closed）。
 * @param configValue `config.yaml` の `sandbox.allowlist`（未指定なら既定値を返す）
 */
export function resolveSandboxAllowlist(configValue?: string[]): SandboxAllowlistResolution {
  if (configValue === undefined) {
    return {
      ok: true,
      allowlist: DEFAULT_SANDBOX_ALLOWLIST.map((e) => ({ host: e.host, ports: [...e.ports] })),
    };
  }
  if (!Array.isArray(configValue) || configValue.length === 0) {
    return { ok: false, reason: 'sandbox.allowlist が空、または配列ではありません' };
  }

  const result: SandboxAllowlistEntry[] = [];
  for (const raw of configValue) {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      return { ok: false, reason: `sandbox.allowlist に不正な値があります: ${JSON.stringify(raw)}` };
    }
    const trimmed = raw.trim();
    const colonIndex = trimmed.lastIndexOf(':');
    let host: string;
    let port: number;
    if (colonIndex > 0 && /^\d+$/.test(trimmed.slice(colonIndex + 1))) {
      host = trimmed.slice(0, colonIndex);
      port = Number(trimmed.slice(colonIndex + 1));
    } else {
      host = trimmed;
      port = 443;
    }
    if (!isValidHostToken(host)) {
      return { ok: false, reason: `sandbox.allowlist のホスト名が不正です: ${JSON.stringify(host)}` };
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, reason: `sandbox.allowlist のポートが不正です: ${port}` };
    }
    const existing = result.find((e) => e.host === host);
    if (existing) {
      if (!existing.ports.includes(port)) existing.ports.push(port);
    } else {
      result.push({ host, ports: [port] });
    }
  }
  return { ok: true, allowlist: result };
}

/**
 * 接続先（host:port）が許可リストに含まれるか判定する。
 * ホストは完全一致、または `*.suffix` 形式のワイルドカード一致。大文字小文字は無視する。
 */
export function isAllowedSandboxConnectTarget(
  allowlist: readonly SandboxAllowlistEntry[],
  host: string,
  port: number,
): boolean {
  const normalizedHost = host.toLowerCase();
  for (const entry of allowlist) {
    if (!entry.ports.includes(port)) continue;
    const entryHost = entry.host.toLowerCase();
    if (entryHost.startsWith('*.')) {
      const suffix = entryHost.slice(1); // ".suffix"
      if (normalizedHost.length > suffix.length && normalizedHost.endsWith(suffix)) return true;
    } else if (normalizedHost === entryHost) {
      return true;
    }
  }
  return false;
}

/**
 * 許可リストの内容からキャッシュキー用の安定したハッシュ文字列を作る（暗号的強度は不要）。
 * 配列順序に依存しないよう host で安定ソートしてから連結する。
 */
export function hashSandboxAllowlist(allowlist: readonly SandboxAllowlistEntry[]): string {
  const normalized = allowlist
    .map((e) => `${e.host.toLowerCase()}:${[...e.ports].sort((a, b) => a - b).join(',')}`)
    .sort()
    .join('|');
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash * 31 + normalized.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}
