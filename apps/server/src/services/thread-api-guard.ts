/**
 * スレッド管理 cycle1: `/api/threads` `/api/sessions/:id` 系 REST エンドポイントの
 * 所有者チェック・入力検証を行う純関数群。外部 import ゼロ（node:test から dist/ を直接 import する）。
 *
 * 既存規約（`api.ts:1473-1475` の `GET /api/sessions/:id/messages`）に合わせ、
 * 「他人のリソース」は 403 ではなく **404** を返す（存在自体を漏らさない）。
 * この規約を本モジュールの全ガードで統一する。
 */

/** ガード結果の共通形。 */
export type GuardResult =
  | { ok: true }
  | { ok: false; status: 400 | 404 | 409; error: string };

const OK: GuardResult = { ok: true };

/** `evaluateProjectOwnership` の入力。Project は `userId` を持たないため `machine.userId` 経由で判定する。 */
export interface ProjectOwnershipInput {
  project: { machine: { userId: string } } | null;
  requestUserId: string;
}

/**
 * プロジェクトの所有者チェック。
 * - `project` が null（存在しない/ソフトデリート済み） → 404
 * - `project.machine.userId !== requestUserId`（他人のマシンのプロジェクト） → 404
 *   （`Project` テーブル自体には `userId` カラムが無いため、必ず `machine.userId` を経由する。
 *   これを取り違えて `project.userId` 等の存在しないフィールドを参照すると型エラーではなく
 *   常に undefined 比較になり、チェックが素通りする危険がある）
 */
export function evaluateProjectOwnership(input: ProjectOwnershipInput): GuardResult {
  if (!input.project) return { ok: false, status: 404, error: 'Project not found' };
  if (input.project.machine.userId !== input.requestUserId) {
    return { ok: false, status: 404, error: 'Project not found' };
  }
  return OK;
}

/** `evaluateSessionOwnership` の入力。Session は `userId` を直接持つ。 */
export interface SessionOwnershipInput {
  session: { userId: string } | null;
  requestUserId: string;
}

/**
 * セッション（スレッド）の所有者チェック。
 * - `session` が null（存在しない） → 404
 * - `session.userId !== requestUserId`（他人のセッション） → 404
 */
export function evaluateSessionOwnership(input: SessionOwnershipInput): GuardResult {
  if (!input.session) return { ok: false, status: 404, error: 'Session not found' };
  if (input.session.userId !== input.requestUserId) {
    return { ok: false, status: 404, error: 'Session not found' };
  }
  return OK;
}

/** `evaluateThreadCreate`（`POST /api/threads`）の入力。 */
export interface ThreadCreateInput {
  project: { machine: { userId: string; online?: boolean } } | null;
  requestUserId: string;
  /** 対象マシンがオンラインかどうか（別経路で判定した値を渡す。ここでは判定ロジックを持たない） */
  machineOnline: boolean;
}

/**
 * 新規スレッド作成（`POST /api/threads`）の事前ガード。
 * 順序:
 * 1. プロジェクト所有者チェック（`evaluateProjectOwnership` と同じ規約） → 不一致は 404
 * 2. マシンがオフラインなら 409（スレッドは作れるが agent へ scope 開始を伝えられないため、
 *    「一覧には見えるが使えない幽霊スレッド」を作らせない）
 */
export function evaluateThreadCreate(input: ThreadCreateInput): GuardResult {
  const ownership = evaluateProjectOwnership({
    project: input.project,
    requestUserId: input.requestUserId,
  });
  if (!ownership.ok) return ownership;
  if (!input.machineOnline) {
    return { ok: false, status: 409, error: 'Machine is offline' };
  }
  return OK;
}

/** `evaluateThreadSwitch`（`POST /api/sessions/:id/switch`）の入力。 */
export interface ThreadSwitchInput {
  /** body の `tabId`。chatId 復元に必須（web.ts の chatId は `web:${userId}:${tabId}`）。 */
  tabId: string | null | undefined;
  session: { userId: string } | null;
  requestUserId: string;
}

/**
 * スレッド切替（`POST /api/sessions/:id/switch`）の事前ガード。
 *
 * 判定順序が重要: **`tabId` 欠落チェックを所有者チェックより先に行う**。
 * 理由: `tabId` はリクエストの形式的な不備（400 = クライアントのバグ）であり、
 * 「対象セッションが誰のものか」という情報漏洩に関わる判定（404）より先に
 * 弾いてよい・弾くべき。逆順にすると「`tabId` があるかどうかで応答が変わる」ことから
 * セッションの存在を推測できてしまう余地がわずかに生まれるため、常に 400 を先に固定する。
 */
export function evaluateThreadSwitch(input: ThreadSwitchInput): GuardResult {
  if (!input.tabId) {
    return { ok: false, status: 400, error: 'tabId is required' };
  }
  return evaluateSessionOwnership({
    session: input.session,
    requestUserId: input.requestUserId,
  });
}
