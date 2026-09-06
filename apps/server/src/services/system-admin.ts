/**
 * システム管理者（このホストの運用者）判定（#367）。
 *
 * 「システム管理者」は組織ロール（OrganizationMember.role）とは別軸の概念である。
 * 組織ロールは「テナント内の権限」であり、pm2 restart のようなホスト操作の権限とは
 * スコープが異なる（実測: このDBには組織が1つしか無く、その admin はホストの運用者本人
 * ではない顧客テナントの管理者であり、逆にホストの運用者自身は OrganizationMember 行を
 * 持たない。組織ロールで判定すると両方向で誤る）。
 *
 * 判定は環境変数 `DEVRELAY_SYSTEM_ADMIN_EMAILS`（カンマ区切りのメールアドレス allowlist）
 * のみで行う。DB マイグレーション・ブートストラップ問題を避けつつ、`.env` を編集できる権限と
 * 付与される権限が一致するため権限昇格が構造的に起きない設計とした。
 *
 * 【fail-closed が必須】allowlist が未設定・空文字列のときは常に false を返すこと。
 * fail-open にすると「未設定の環境では全員が管理者操作を実行できる」という、
 * 今回まさに修正しようとしている脆弱性をそのまま再現してしまう。
 *
 * 外部 import ゼロ（DB/ネットワーク非依存）に保ち、コンパイル済み dist を直接
 * `node --test` から import して単体検証できるようにする
 * （#332 permission-policy.ts / #334 human-text-fence.ts / #348 cross-query-guard.ts と同じ流儀）。
 */

/** requireSystemAdmin() が要求する最小限の Fastify リクエスト形（fastify を import しないための構造的型付け） */
export interface MinimalRequest {
  user?: { email?: string | null } | null;
}

/** requireSystemAdmin() が要求する最小限の Fastify リプライ形 */
export interface MinimalReply {
  status(code: number): { send(body: unknown): unknown };
}

/**
 * カンマ区切りのメールアドレス allowlist 文字列をパースする。
 *
 * 前後の空白除去・小文字化・空要素の除去を行う。未設定（undefined）や空文字列は
 * 空配列を返す（＝ fail-closed の起点）。
 *
 * @param raw `DEVRELAY_SYSTEM_ADMIN_EMAILS` の生の値
 */
export function parseSystemAdminEmails(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/**
 * 現在の環境変数からシステム管理者 allowlist を読み出す。
 *
 * モジュールロード時にキャッシュせず、呼び出しごとに `process.env` を読む
 * （`.env` は `dotenv/config` によりプロセス起動のたびにディスクから読み直されるため、
 * サーバー再起動のみで allowlist の更新が反映される想定 — #340 と同じ考え方）。
 */
export function getSystemAdminAllowlist(): string[] {
  return parseSystemAdminEmails(process.env.DEVRELAY_SYSTEM_ADMIN_EMAILS);
}

/**
 * 指定したメールアドレスがシステム管理者 allowlist に含まれるかを判定する。
 *
 * allowlist が空配列の場合は常に false を返す（fail-closed。#332 の permissionPolicy 等と
 * 同じく「判定不能・未設定は許可しない」方針）。大小文字は無視して比較する。
 *
 * @param email 判定対象のメールアドレス（null/undefined/空文字列は false）
 * @param allowlist getSystemAdminAllowlist() 等で取得した allowlist（小文字化済み想定）
 */
export function isSystemAdminEmail(
  email: string | null | undefined,
  allowlist: string[]
): boolean {
  if (allowlist.length === 0) return false;
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  if (normalized.length === 0) return false;
  return allowlist.includes(normalized);
}

/**
 * Fastify ルートハンドラの冒頭で呼び出し、システム管理者でなければ 403 を送って false を返す。
 *
 * 呼び出し側は `if (!requireSystemAdmin(request, reply)) return;` の形で使うこと
 * （`requireOrgAdmin`/`requireOrgManagerOrAdmin` と同じ「ガードが false を返したら即 return」規約）。
 *
 * @param request `request.user.email` を持つ Fastify リクエスト（authenticate 済みを前提とする）
 * @param reply 403 を送信するための Fastify リプライ
 */
export function requireSystemAdmin(request: MinimalRequest, reply: MinimalReply): boolean {
  const email = request.user?.email;
  if (!isSystemAdminEmail(email, getSystemAdminAllowlist())) {
    reply.status(403).send({ error: 'システム管理者権限が必要です' });
    return false;
  }
  return true;
}
