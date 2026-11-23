/**
 * Sandbox 実行で直接通信を許可する「IP とポート」の検証・正規化（外部 import ゼロ、純関数）。
 *
 * サイクル SB-2.1。`sandbox-allowlist.ts`（ドメイン宛・中継プロキシ経由）とは別物:
 * こちらはテスト DB 等への直接 TCP 通信を、PC 単位でファイアウォールのルールとして許可する
 * ための設定（`config.yaml` の `sandbox.allowDestinations`）を扱う。
 * 設計・決定事項は `doc/sandbox/SB-2.0_investigation.md` の B 節・D 節・決定0/1/7。
 */

/** 上限 20 件（決定7） */
export const SANDBOX_ALLOW_DESTINATIONS_MAX = 20;

export interface SandboxAllowDestination {
  ip: string;
  port: number;
}

export type SandboxAllowDestinationsResolution =
  | { ok: true; destinations: SandboxAllowDestination[]; canonical: string }
  | { ok: false; reason: string };

/** `/32` の IPv4 のみ（各オクテットは 0-255、先頭 0 のゼロパディングは拒否） */
const IPV4_OCTET_PATTERN = /^(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$/;

function isValidIpv4Octet(token: string): boolean {
  // "0" 自体は許すが "00" "01" のようなゼロパディングは拒否する
  if (token.length > 1 && token.startsWith('0')) return false;
  return IPV4_OCTET_PATTERN.test(token);
}

/** 厳格な `/32` IPv4 判定（CIDR・範囲・ホスト名・IPv6 はすべて拒否） */
function isValidStrictIpv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  return parts.every(isValidIpv4Octet);
}

/** IPv4 文字列を比較・ソート用の 32bit 数値に変換する（事前に isValidStrictIpv4 で検証済みのこと） */
function ipv4ToUint32(ip: string): number {
  const parts = ip.split('.').map((p) => Number(p));
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/**
 * 許可リストという機能自体が意味を持たない・ルール計算が破綻する宛先（安全装置。決定0とは矛盾しない。
 * 詳細は `doc/sandbox/SB-2.0_investigation.md` D-3 節）。
 */
const FORBIDDEN_IPV4_RANGES: ReadonlyArray<{ base: number; maskBits: number }> = [
  { base: ipv4ToUint32('0.0.0.0'), maskBits: 8 }, // 0.0.0.0/8
  { base: ipv4ToUint32('127.0.0.0'), maskBits: 8 }, // 127.0.0.0/8（既に無条件許可）
  { base: ipv4ToUint32('169.254.0.0'), maskBits: 16 }, // リンクローカル
  { base: ipv4ToUint32('224.0.0.0'), maskBits: 4 }, // マルチキャスト
  { base: ipv4ToUint32('240.0.0.0'), maskBits: 4 }, // 予約
];
const FORBIDDEN_IPV4_EXACT = new Set<number>([ipv4ToUint32('255.255.255.255')]);

function isForbiddenIpv4(value: number): boolean {
  if (FORBIDDEN_IPV4_EXACT.has(value)) return true;
  for (const range of FORBIDDEN_IPV4_RANGES) {
    const shift = 32 - range.maskBits;
    const mask = shift >= 32 ? 0 : (0xffffffff << shift) >>> 0;
    if ((value & mask) === (range.base & mask)) return true;
  }
  return false;
}

/**
 * `config.yaml` の `sandbox.allowDestinations`（`"ip:port"` の配列）を検証・正規化する。
 * 1 件でも不正な値があれば**全体を拒否する**（fail-closed。一部だけ適用することはしない）。
 *
 * `resolveSandboxAllowlist()` とは異なり、**未設定/空配列は `ok:true` の空集合を返す**
 * （直接通信の許可は「書かなければ増えない」が安全側の既定であり、ドメイン許可リストの
 * 既定値フォールバックとは意図的に非対称）。
 */
export function resolveSandboxAllowDestinations(
  configValue?: string[],
): SandboxAllowDestinationsResolution {
  if (configValue === undefined) {
    return { ok: true, destinations: [], canonical: '' };
  }
  if (!Array.isArray(configValue)) {
    return { ok: false, reason: 'sandbox.allowDestinations は配列である必要があります' };
  }
  if (configValue.length === 0) {
    return { ok: true, destinations: [], canonical: '' };
  }

  const parsed: SandboxAllowDestination[] = [];
  for (const raw of configValue) {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      return { ok: false, reason: `sandbox.allowDestinations に不正な値があります: ${JSON.stringify(raw)}` };
    }
    const trimmed = raw.trim();
    const colonIndex = trimmed.lastIndexOf(':');
    if (colonIndex <= 0) {
      return { ok: false, reason: `sandbox.allowDestinations は "ip:port" 形式である必要があります: ${JSON.stringify(trimmed)}` };
    }
    const ipPart = trimmed.slice(0, colonIndex);
    const portPart = trimmed.slice(colonIndex + 1);

    if (!isValidStrictIpv4(ipPart)) {
      return { ok: false, reason: `sandbox.allowDestinations の IP が不正です（/32 の IPv4 のみ）: ${JSON.stringify(ipPart)}` };
    }
    if (!/^\d+$/.test(portPart)) {
      return { ok: false, reason: `sandbox.allowDestinations のポートが不正です: ${JSON.stringify(portPart)}` };
    }
    const port = Number(portPart);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, reason: `sandbox.allowDestinations のポートは 1-65535 の範囲である必要があります: ${port}` };
    }
    if (isForbiddenIpv4(ipv4ToUint32(ipPart))) {
      return { ok: false, reason: `sandbox.allowDestinations に許可できない宛先が含まれています: ${JSON.stringify(ipPart)}` };
    }

    parsed.push({ ip: ipPart, port });
  }

  // 重複除去（同じ ip:port の重複指定はエラーにせず 1 件に畳む）
  const seen = new Set<string>();
  const unique: SandboxAllowDestination[] = [];
  for (const dest of parsed) {
    const key = `${dest.ip}:${dest.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(dest);
  }

  if (unique.length > SANDBOX_ALLOW_DESTINATIONS_MAX) {
    return {
      ok: false,
      reason: `sandbox.allowDestinations は上限 ${SANDBOX_ALLOW_DESTINATIONS_MAX} 件です（${unique.length} 件指定されています）`,
    };
  }

  return { ok: true, destinations: unique, canonical: buildCanonicalAllowDestinations(unique) };
}

/**
 * 許可リストから canonical 文字列を組み立てる（IP の数値 → ポートの数値で昇順ソートし、
 * `ip:port` を LF 連結。末尾改行なし、空集合は空文字列）。
 * PowerShell 側の apply スクリプトも同じ規則（数値ソート + LF 連結）で計算し、
 * digest（sha256）がバイト単位で一致することを前提にする。
 */
export function buildCanonicalAllowDestinations(destinations: readonly SandboxAllowDestination[]): string {
  const sorted = [...destinations].sort((a, b) => {
    const diff = ipv4ToUint32(a.ip) - ipv4ToUint32(b.ip);
    if (diff !== 0) return diff;
    return a.port - b.port;
  });
  return sorted.map((d) => `${d.ip}:${d.port}`).join('\n');
}
