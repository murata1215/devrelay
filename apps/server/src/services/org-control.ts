import { prisma } from '../db/client.js';

/**
 * エンタープライズ統制（#268）: コマンド発行の可否判定。
 *
 * ルール:
 * - 組織未所属ユーザー … 統制対象外（常に許可）
 * - role が admin / manager … 常に許可
 * - role が member … 自分を担当する manager（ManagerAssignment）が1人以上いる場合のみ許可。
 *   0 人なら「マネージャー未割当」としてコマンド発行を拒否する（deny-by-default）。
 *
 * admin は暗黙的に全 member を監督するが、この判定では数えない
 * （必ず明示的に manager を割り当てる統制を厳密に守るため）。
 */

/** 統制によりブロックされた際にユーザーへ返すメッセージ */
export const ORG_CONTROL_BLOCK_MESSAGE =
  '🔒 組織の統制設定により、あなたにマネージャーが割り当てられるまでコマンドを実行できません。組織の管理者にお問い合わせください。';

export interface CommandPermission {
  /** コマンド発行を許可してよいか */
  allowed: boolean;
  /** 拒否理由（allowed=false のときユーザーへ提示するメッセージ） */
  reason?: string;
}

/**
 * 指定ユーザーがコマンドを発行できるかを判定する。
 * @param userId DB User.id（プラットフォーム ID ではなく解決済みの User.id を渡すこと）
 */
export async function checkCommandPermission(userId: string): Promise<CommandPermission> {
  // 組織メンバーシップを取得（未所属なら統制対象外）
  const membership = await prisma.organizationMember.findUnique({
    where: { userId },
    select: { role: true, organizationId: true },
  });
  if (!membership) {
    return { allowed: true };
  }

  // admin / manager は常に許可
  if (membership.role === 'admin' || membership.role === 'manager') {
    return { allowed: true };
  }

  // member は担当 manager が1人以上いる場合のみ許可
  const managerCount = await prisma.managerAssignment.count({
    where: { organizationId: membership.organizationId, memberUserId: userId },
  });
  if (managerCount > 0) {
    return { allowed: true };
  }

  return { allowed: false, reason: ORG_CONTROL_BLOCK_MESSAGE };
}

/**
 * 統制 v3（#270）: 閲覧者が対象ユーザーの会話履歴・活動を閲覧できるかを判定する。
 *
 * ルール:
 * - 本人（viewer === target）… 常に許可
 * - 同一組織の admin … 許可
 * - 同一組織の manager で、対象 member を担当（ManagerAssignment あり）… 許可
 * - それ以外 … 拒否
 *
 * @param viewerUserId 閲覧しようとするユーザーの User.id
 * @param targetUserId 閲覧対象ユーザーの User.id
 */
export async function canViewMemberHistory(
  viewerUserId: string,
  targetUserId: string,
): Promise<boolean> {
  // 本人の履歴は常に閲覧可
  if (viewerUserId === targetUserId) {
    return true;
  }

  const [viewerMembership, targetMembership] = await Promise.all([
    prisma.organizationMember.findUnique({
      where: { userId: viewerUserId },
      select: { role: true, organizationId: true },
    }),
    prisma.organizationMember.findUnique({
      where: { userId: targetUserId },
      select: { organizationId: true },
    }),
  ]);

  // 同一組織に所属していることが前提
  const sameOrg =
    !!viewerMembership &&
    !!targetMembership &&
    viewerMembership.organizationId === targetMembership.organizationId;
  if (!sameOrg || !viewerMembership) {
    return false;
  }

  if (viewerMembership.role === 'admin') {
    return true;
  }

  if (viewerMembership.role === 'manager') {
    const assignment = await prisma.managerAssignment.findUnique({
      where: {
        managerUserId_memberUserId: {
          managerUserId: viewerUserId,
          memberUserId: targetUserId,
        },
      },
    });
    return !!assignment;
  }

  return false;
}

/* ==========================================================================
 * IP アクセス制限（#285）
 * 組織 admin が許可 CIDR レンジを設定すると、その組織のユーザーは許可レンジ
 * からのみ接続できる。組織未所属 or レンジ未設定なら常に許可（制限なし）。
 * ========================================================================== */

/** IP チェックがブロックされた際にユーザーへ返すメッセージ */
export const ORG_IP_BLOCK_MESSAGE =
  '🔒 組織のIPアクセス制限により接続が拒否されました。社内ネットワークから接続してください。';

/** IP レンジ設定の 60 秒メモリキャッシュ（userId → { ranges, expires }） */
const ipRangeCache = new Map<string, { ranges: string[]; expires: number }>();
const IP_CACHE_TTL_MS = 60 * 1000;

/** IP レンジキャッシュを全消去する（設定更新時に呼ぶ） */
export function clearIpRangeCache(): void {
  ipRangeCache.clear();
}

/**
 * IPv4 アドレス文字列を 32bit 符号なし整数に変換する。
 * 変換不能なら null。
 */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255 || !/^\d+$/.test(part)) return null;
    result = (result << 8) | n;
  }
  return result >>> 0;
}

/**
 * クライアント IP を正規化する。
 * IPv4-mapped IPv6（::ffff:192.168.0.1）は IPv4 部分へ、
 * IPv6 ループバック ::1 は 127.0.0.1 として扱う。
 */
export function normalizeIp(ip: string): string {
  let s = (ip || '').trim().toLowerCase();
  // ゾーン識別子（fe80::1%eth0）を除去
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct);
  if (s === '::1') return '127.0.0.1';
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  return s;
}

/**
 * IP が指定 CIDR に含まれるか判定する。
 * IPv4 は CIDR（例 192.168.0.0/24）と単一 IP（例 203.0.113.5）に対応。
 * IPv6 は完全一致 or プレフィックス前方一致（簡易）に対応。
 */
export function isIpInRange(ip: string, cidr: string): boolean {
  const target = normalizeIp(ip);
  const range = cidr.trim().toLowerCase();
  if (!target || !range) return false;

  // IPv4 判定
  const targetInt = ipv4ToInt(target);
  if (targetInt !== null) {
    const [net, prefixStr] = range.split('/');
    const netInt = ipv4ToInt(net);
    if (netInt === null) return false;
    const prefix = prefixStr === undefined ? 32 : Number(prefixStr);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
    if (prefix === 0) return true;
    const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
    return (targetInt & mask) === (netInt & mask);
  }

  // IPv6 簡易判定（完全一致 or プレフィックスなしの前方一致）
  const [net6, prefix6] = range.split('/');
  if (prefix6 === undefined) {
    return target === net6;
  }
  // /128 は完全一致
  if (Number(prefix6) === 128) return target === net6;
  // それ以外の IPv6 プレフィックスは簡易に前方一致（正確な圧縮展開は非対応）
  const netTrim = net6.replace(/::.*$/, '');
  return target.startsWith(netTrim);
}

/**
 * IP がいずれかの CIDR レンジに含まれるか。
 * ranges が空なら「制限なし」として true。
 */
export function isIpAllowed(ip: string, ranges: string[]): boolean {
  if (!ranges || ranges.length === 0) return true;
  return ranges.some((r) => isIpInRange(ip, r));
}

/**
 * CIDR / 単一 IP 文字列の形式が妥当か検証する（IPv4 CIDR・IPv4・IPv6 簡易）。
 */
export function isValidCidr(cidr: string): boolean {
  const s = (cidr || '').trim();
  if (!s) return false;
  const [addr, prefix] = s.split('/');
  // IPv4
  if (ipv4ToInt(addr) !== null) {
    if (prefix === undefined) return true;
    const p = Number(prefix);
    return Number.isInteger(p) && p >= 0 && p <= 32;
  }
  // IPv6（簡易: コロンを含み、プレフィックスがあれば 0-128）
  if (addr.includes(':')) {
    if (prefix === undefined) return true;
    const p = Number(prefix);
    return Number.isInteger(p) && p >= 0 && p <= 128;
  }
  return false;
}

/**
 * 指定ユーザーの組織 IP 制限に照らして、clientIp からの接続を許可してよいか判定する。
 * - 組織未所属 or レンジ未設定 … 常に許可
 * - レンジ設定あり … clientIp がいずれかに含まれれば許可
 * DB 負荷を抑えるため userId ごとに 60 秒キャッシュする。
 *
 * @param userId DB User.id
 * @param clientIp クライアント IP（request.ip 等）
 */
export async function checkIpAllowed(
  userId: string,
  clientIp: string,
): Promise<{ allowed: boolean; reason?: string }> {
  let ranges: string[] | undefined;
  const cached = ipRangeCache.get(userId);
  if (cached && cached.expires > Date.now()) {
    ranges = cached.ranges;
  } else {
    const membership = await prisma.organizationMember.findUnique({
      where: { userId },
      select: { organization: { select: { allowedIpRanges: true } } },
    });
    ranges = parseIpRanges(membership?.organization?.allowedIpRanges ?? null);
    ipRangeCache.set(userId, { ranges, expires: Date.now() + IP_CACHE_TTL_MS });
  }

  if (!ranges || ranges.length === 0) {
    return { allowed: true };
  }
  if (isIpAllowed(clientIp, ranges)) {
    return { allowed: true };
  }
  return { allowed: false, reason: ORG_IP_BLOCK_MESSAGE };
}

/**
 * allowedIpRanges の JSON 文字列を string[] にパースする。
 * 不正・null なら空配列。
 */
export function parseIpRanges(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  } catch {
    return [];
  }
}

/**
 * ユーザーが「IP 制限が有効な組織」に所属しているか（Discord/Telegram など
 * IP 判定不能な経路をブロックすべきかの判定に使う）。
 * @param userId DB User.id
 */
export async function hasIpRestriction(userId: string): Promise<boolean> {
  const cached = ipRangeCache.get(userId);
  if (cached && cached.expires > Date.now()) {
    return cached.ranges.length > 0;
  }
  const membership = await prisma.organizationMember.findUnique({
    where: { userId },
    select: { organization: { select: { allowedIpRanges: true } } },
  });
  const ranges = parseIpRanges(membership?.organization?.allowedIpRanges ?? null);
  ipRangeCache.set(userId, { ranges, expires: Date.now() + IP_CACHE_TTL_MS });
  return ranges.length > 0;
}

/** 監査ログの操作種別 */
export type SupervisionAction = 'view_sessions' | 'view_messages' | 'summarize';

/**
 * 統制 v3（#270）: 監視監査ログを記録する（fire-and-forget）。
 *
 * admin/manager が他ユーザーの会話履歴を閲覧・要約した操作を記録する。
 * 本人が自分の履歴を見る場合（viewer === target）は記録しない。
 * 記録失敗は致命的でないため握りつぶす（レスポンスをブロックしない）。
 *
 * @param viewerUserId 閲覧した User.id
 * @param targetUserId 閲覧対象の User.id
 * @param action 操作種別
 * @param detail 補足情報（検索クエリや sessionId 等、任意の JSON 文字列）
 */
export function recordSupervisionAudit(
  viewerUserId: string,
  targetUserId: string,
  action: SupervisionAction,
  detail?: string,
): void {
  // 本人操作は監査対象外
  if (viewerUserId === targetUserId) {
    return;
  }
  // 閲覧対象の組織 ID を解決してから記録（fire-and-forget）
  prisma.organizationMember
    .findUnique({
      where: { userId: targetUserId },
      select: { organizationId: true },
    })
    .then((membership) => {
      if (!membership) return;
      return prisma.supervisionAuditLog.create({
        data: {
          organizationId: membership.organizationId,
          viewerUserId,
          targetUserId,
          action,
          detail: detail ?? null,
        },
      });
    })
    .catch(() => {
      /* 監査ログ記録失敗は致命的でない */
    });
}
