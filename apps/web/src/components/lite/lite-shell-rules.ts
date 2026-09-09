/**
 * Lite シェル（`doc/thread-management-spec.md` §0）の純ロジック層。
 *
 * 外部 import ゼロ（`apps/web/src/lib/thread-routing-client.ts` と同じ流儀）。React・api.ts・
 * 型を一切 import しない。呼び出し元は L2 以降（`LitePage.tsx` 等、次サイクル）で追加される予定で、
 * 本サイクル（L0）時点ではどこからも import されていない（純ロジック + テストのみ）。
 *
 * 設計判断の根拠は read-only 調査 `~/.claude/plans/quizzical-zooming-flute.md` の F1〜F6 / R2〜R9。
 * 特に F1（プロジェクトを変えて送信しても既存スレッドに自動 reuse される）は、UI を書く前に
 * 型と関数へ先に凍結しておかないと後から直しにくい判断であるため、本ファイルの中核になっている。
 */

// ---------------------------------------------------------------------------
// 1. F1 / R8: 作成リクエストは tabId を必須にした型でしか作れない
// ---------------------------------------------------------------------------

/**
 * `POST /api/threads` に渡す作成リクエスト記述子。`buildThreadCreateRequest()` の戻り値としてのみ
 * 得られる（`__liteThreadCreate` はこのモジュール内の判定にのみ使うマーカーで、他所からの直接構築が
 * 型上不自然になるようにする意図。TS の構造的型付けを完全には封じないが、レビューで検出しやすくする）。
 *
 * R8: `tabId` が無い状態で `threads.create()` を呼ぶと `api.ts` の `if (tabId)` 分岐を通らず
 * `lastProjectId` / `currentSessionId` が更新されないまま 201 が返り、UI 上は成功に見えるのに
 * 直後の送信が F1 の罠（既存スレッドへの意図しない合流）に落ちる。この型はその経路を塞ぐための唯一の入口。
 */
export interface ThreadCreateRequest {
  readonly projectId: string;
  readonly tabId: string;
  readonly __liteThreadCreate: true;
}

/**
 * `ThreadCreateRequest` を構築する唯一の factory。`projectId` / `tabId` のいずれかが
 * 空文字・未指定なら `null` を返す（実行時にも R8 を塞ぐ）。
 */
export function buildThreadCreateRequest(input: { projectId: string; tabId: string }): ThreadCreateRequest | null {
  if (!input.projectId || !input.tabId) return null;
  return { projectId: input.projectId, tabId: input.tabId, __liteThreadCreate: true };
}

// ---------------------------------------------------------------------------
// 2. 送信時の判定（F1 の 3 ケースをここに封じ込める）
// ---------------------------------------------------------------------------

export type SendBlockedReason =
  | 'no-project'
  | 'no-tab-id'
  | 'offline'
  | 'disconnected'
  | 'in-flight'
  | 'empty';

export type SendAction =
  | { kind: 'create-then-send'; request: ThreadCreateRequest; sendProjectIdHint: string }
  | { kind: 'send-existing'; sessionId: string; sendProjectIdHint: string }
  | { kind: 'blocked'; reason: SendBlockedReason };

export interface DecideSendActionInput {
  /** 現在選択中のスレッド。未選択なら null/undefined（F1 ケース 1） */
  selectedSessionId?: string | null;
  /** 選択中スレッドが実際に属するプロジェクト（サーバー側の実データ。F1 ケース 2 の判定に必須） */
  selectedThreadProjectId?: string | null;
  /** Composer で選択中の送信先プロジェクト */
  selectedProjectId?: string | null;
  tabId?: string | null;
  machineOnline: boolean;
  connected: boolean;
  hasText: boolean;
  hasFiles: boolean;
  inFlight: boolean;
}

/**
 * 送信操作時にとるべき行動を決める。F1（`sendCommand` の projectId をプロジェクト切替手段に使うと
 * ユーザーの知らない既存スレッドに合流する）をここに封じ込める:
 *
 *   1. スレッド未選択（`selectedSessionId` が無い） → 必ず `create-then-send`
 *   2. スレッド選択中だが送信先プロジェクトが選択中スレッドのプロジェクトと異なる → 必ず `create-then-send`
 *      （既存 active スレッドへの reuse 合流を型と分岐の両方で禁止する）
 *   3. スレッド選択中で送信先プロジェクトが同一 → `send-existing`
 *
 * blocked の優先順位: `no-project` → `no-tab-id` → `offline` → `disconnected` → `in-flight` → `empty`。
 * 前 4 つは「設定/環境の障害」で利用者の操作による復帰が必要な状態、後 2 つは「入力の一時状態」。
 * `in-flight` を `empty` より先に判定するのは、送信直後に入力欄が空になり両方が真になりうるため
 * （「送信中」であることを優先して伝えたい）。
 *
 * R3: `sendProjectIdHint` は必ず「送信完了後に current になっているプロジェクト」と同じ値を返す
 * （`create-then-send` では `request.projectId` と同一）。呼び出し側はこの値をプロジェクト切替の
 * 手段として使ってはならず、一致確認専用として扱うこと。
 */
export function decideSendAction(input: DecideSendActionInput): SendAction {
  if (!input.selectedProjectId) return { kind: 'blocked', reason: 'no-project' };
  if (!input.tabId) return { kind: 'blocked', reason: 'no-tab-id' };
  if (!input.machineOnline) return { kind: 'blocked', reason: 'offline' };
  if (!input.connected) return { kind: 'blocked', reason: 'disconnected' };
  if (input.inFlight) return { kind: 'blocked', reason: 'in-flight' };
  if (!input.hasText && !input.hasFiles) return { kind: 'blocked', reason: 'empty' };

  const needsNewThread =
    !input.selectedSessionId || input.selectedThreadProjectId !== input.selectedProjectId;

  if (needsNewThread) {
    const request = buildThreadCreateRequest({ projectId: input.selectedProjectId, tabId: input.tabId });
    // ここには到達しない想定（tabId は直前でチェック済み）だが、buildThreadCreateRequest の
    // シグネチャ上 null がありうるため型の整合のためにフォールバックを用意する。
    if (!request) return { kind: 'blocked', reason: 'no-tab-id' };
    return { kind: 'create-then-send', request, sendProjectIdHint: input.selectedProjectId };
  }

  return {
    kind: 'send-existing',
    sessionId: input.selectedSessionId as string,
    sendProjectIdHint: input.selectedProjectId,
  };
}

// ---------------------------------------------------------------------------
// 3. プロジェクト変更（D4: ここでは絶対に作成しない）
// ---------------------------------------------------------------------------

export type ProjectChangeAction =
  | { kind: 'select-only'; projectId: string }
  | { kind: 'noop'; reason: 'same-project' | 'no-project' };

/**
 * Composer のプロジェクトセレクタ変更時の行動を決める。**ここでは絶対に作成しない**
 * （作成は必ず送信時 `decideSendAction()` の `create-then-send` のみを経由する。これにより
 * 作成リクエストは常に `buildThreadCreateRequest` を通り、tabId 必須という R8 の保証が破れない）。
 * 選択操作だけでスレッドが増えないようにするための決定。
 */
export function decideProjectChange(input: {
  currentProjectId?: string | null;
  nextProjectId?: string | null;
}): ProjectChangeAction {
  if (!input.nextProjectId) return { kind: 'noop', reason: 'no-project' };
  if (input.nextProjectId === input.currentProjectId) return { kind: 'noop', reason: 'same-project' };
  return { kind: 'select-only', projectId: input.nextProjectId };
}

// ---------------------------------------------------------------------------
// 4. F2 / F3 吸収層: displayName 解決をクライアント側で一本化する
// ---------------------------------------------------------------------------

/**
 * `projects.list()` 由来の最小構造型。`api.ts` の `Project` を直接 import しない
 * （このモジュールの「外部 import ゼロ」を保つため、構造的に互換な最小型をここに独自定義する）。
 */
export interface ProjectViewSource {
  id: string;
  name: string;
  displayName?: string | null;
  machine?: {
    name: string;
    displayName?: string | null;
    online: boolean;
  } | null;
}

export interface ThreadProjectView {
  projectId: string;
  projectLabel: string;
  machineLabel: string;
  online: boolean;
}

/**
 * F2（`POST /api/threads` の応答に machine 情報が無い）/ F3（`GET`/`POST /api/threads` が返す
 * `projectName` は `project.name` であり `displayName` ではない）の吸収層。
 *
 * `projects.list()` の Map を単一情報源にし、`displayName ?? name` をコードベース全体の既存規約
 * （`ChatPage.tsx:2697` 等、トリムしない）と揃える。API 返り値を state にコピーせず、呼び出し側で
 * 毎レンダー導出することを前提にした設計（F2/F3 の不整合が焼き付かない）。
 */
export function resolveThreadProjectView(input: {
  projectId?: string | null;
  projects: ReadonlyMap<string, ProjectViewSource>;
  /** `projects` に該当が無い場合のみ使う（`GET /api/threads` が返す `project.name`） */
  fallbackProjectName?: string | null;
}): ThreadProjectView {
  const projectId = input.projectId ?? '';
  const source = projectId ? input.projects.get(projectId) : undefined;
  if (!source) {
    return {
      projectId,
      projectLabel: input.fallbackProjectName ?? '',
      machineLabel: '',
      online: false,
    };
  }
  return {
    projectId,
    projectLabel: source.displayName ?? source.name,
    machineLabel: source.machine ? source.machine.displayName ?? source.machine.name : '',
    online: source.machine?.online ?? false,
  };
}

// ---------------------------------------------------------------------------
// 5. R5: fail-open 原則の唯一の例外
// ---------------------------------------------------------------------------

/**
 * 承認/質問カードを表示するかどうかを決める。R2 の fail-open 原則の**唯一の例外**（fail-closed）。
 * WS 接続時にサーバーは `context.currentSessionId`（前回 switch した値）の保留カードを送るため
 * （`apps/server/src/platforms/web.ts:97-107`）、Lite 起動直後に未選択スレッドのカードが届きうる。
 * 誤って別スレッドの承認カードを出すほうが害が大きく、取りこぼしても `requestId` ベースなので
 * 従来 UI 側で応答できるため、`viewSessionId` が無いときは表示しない。
 */
export function shouldShowApprovalCard(input: {
  viewSessionId?: string | null;
  payloadSessionId?: string | null;
}): boolean {
  if (!input.viewSessionId) return false;
  if (!input.payloadSessionId) return true;
  return input.viewSessionId === input.payloadSessionId;
}

// ---------------------------------------------------------------------------
// 6. F5 トリップワイヤ: Lite は Layout / useOrganization() に依存してはならない
// ---------------------------------------------------------------------------

/**
 * `/lite` 配下のファイルで使用してはならない識別子。`useOrganization()` は `OrganizationProvider`
 * の外で呼ぶと throw する（`contexts/OrganizationContext.tsx:53-55`）。`OrganizationProvider` は
 * `ProtectedContent` の内側にしかなく、`Layout.tsx` がこれを呼ぶため、Lite で `Layout` や
 * `useOrganization()` を使うと #310 と同型の「全画面真っ白」になる。
 */
export const FORBIDDEN_LITE_BINDINGS: readonly string[] = ['useOrganization', 'OrganizationProvider', 'Layout'];

/** 対応する禁止モジュール（import 元パスの部分文字列一致で判定する） */
export const FORBIDDEN_LITE_MODULES: readonly string[] = ['contexts/OrganizationContext', 'components/Layout'];

/**
 * Lite 配下のファイルのソース文字列から禁止 import を検出する（静的 grep 相当の純関数）。
 * L2 以降で `components/lite/*` 全ファイルのソースを読ませる回帰テストへ昇格させる想定。
 *
 * 既知の限界: `import * as X from '...'` の namespace import は検出できない（禁止識別子の名前が
 * ソースの import 文に直接現れないため）。この検出方式を採用する場合は、namespace import 自体を
 * `components/lite/` でレビュー時に禁止する運用と併用すること。
 */
export function findForbiddenLiteImports(source: string): readonly string[] {
  const hits: string[] = [];
  const importBlockPattern = /import\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = importBlockPattern.exec(source)) !== null) {
    const bindingsRaw = match[1];
    const modulePath = match[2];
    const bindingNames = bindingsRaw
      .split(',')
      .map((b) => b.trim().split(/\s+as\s+/)[0].trim())
      .filter((b) => b.length > 0);
    for (const name of bindingNames) {
      if (FORBIDDEN_LITE_BINDINGS.includes(name)) hits.push(name);
    }
    for (const forbiddenModule of FORBIDDEN_LITE_MODULES) {
      if (modulePath.includes(forbiddenModule)) hits.push(modulePath);
    }
  }
  return hits;
}
