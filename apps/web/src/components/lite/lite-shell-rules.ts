/**
 * Lite シェル（`doc/thread-management-spec.md` §0）の純ロジック層。
 *
 * 外部 import ゼロ（`apps/web/src/lib/thread-routing-client.ts` と同じ流儀）。React・api.ts・
 * 型を一切 import しない。L0 時点ではどこからも import されていなかったが、L2（本サイクル）から
 * `ThreadList.tsx` / `LitePage.tsx` が利用を開始する。
 *
 * 設計判断の根拠は read-only 調査 `~/.claude/plans/quizzical-zooming-flute.md` の F1〜F6 / R2〜R9。
 * 特に F1（プロジェクトを変えて送信しても既存スレッドに自動 reuse される）は、UI を書く前に
 * 型と関数へ先に凍結しておかないと後から直しにくい判断であるため、本ファイルの中核になっている。
 *
 * L2 追記: `/lite` ルーティング・モード切替の骨組みを追加。B1（ThreadList は行クリックで必ず
 * サーバー switch を発行してしまう）を解消するための `decideThreadRowAction()` と、
 * プロジェクトセレクタ表示用の `buildProjectSelectorOptions()` を追加する。
 * B2（`/` → `/lite` 自動リダイレクト・localStorage によるモード永続化）は L2 では撤回され、
 * URL のみを状態とする方針になったため、このファイルにモード判定・永続化ロジックは置かない。
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
    /** L3 A2: `filterProjectsByLiveMachines()` の絞り込みキー。optional のため既存 fixture /
     * `buildProjectSelectorOptions` 呼び出しは無改変で通る。 */
    id?: string;
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
 * `components/lite/` でレビュー時に禁止する運用と併用すること
 * （L2 では `containsNamespaceImport()` を併用してこの穴を塞ぐ）。
 *
 * L2: 判定に使う禁止リストを optional 引数に一般化した。省略時は恒久リスト
 * （`FORBIDDEN_LITE_BINDINGS` / `FORBIDDEN_LITE_MODULES`、F5 トリップワイヤ）を使うため、
 * 既存呼び出し元・既存テストの挙動は完全に不変。L2 固有の禁止（`useWebSocket` 等）を検査したい
 * 呼び出し元だけが `L2_FORBIDDEN_LITE_BINDINGS` / `L2_FORBIDDEN_LITE_MODULES` を明示的に渡す。
 */
export function findForbiddenLiteImports(
  source: string,
  bindings: readonly string[] = FORBIDDEN_LITE_BINDINGS,
  modules: readonly string[] = FORBIDDEN_LITE_MODULES
): readonly string[] {
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
      if (bindings.includes(name)) hits.push(name);
    }
    for (const forbiddenModule of modules) {
      if (modulePath.includes(forbiddenModule)) hits.push(modulePath);
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// 7. L2: /lite ルーティング・行選択・プロジェクトセレクタの純ロジック
// ---------------------------------------------------------------------------

/**
 * L2 固有の禁止識別子。恒久リスト（`FORBIDDEN_LITE_BINDINGS`、F5 トリップワイヤ）とは別に持つ。
 *
 * L3 更新: `LitePage.tsx` は WS 受信を実装したため、この定数を `LitePage.tsx` に適用するのをやめた
 * （`lite-source-guards.test.mjs` を参照）。ただし「`useWebSocket` の呼び出し箇所は
 * `LitePage.tsx` の 1 箇所に限定する」という B2 の不変条件は変わらないため、この定数は
 * `LiteHeader.tsx` / `LiteComposer.tsx` / `LiteMessageList.tsx` / `LiteApprovalCard.tsx` の
 * 子コンポーネント側には引き続き適用し、WS 二重接続経路が増えないことを固定する。
 */
export const L2_FORBIDDEN_LITE_BINDINGS: readonly string[] = ['useWebSocket'];

/** 対応する禁止モジュール（import 元パスの部分文字列一致で判定する） */
export const L2_FORBIDDEN_LITE_MODULES: readonly string[] = ['hooks/useWebSocket'];

/**
 * `findForbiddenLiteImports()` の名前付き import 検出の穴（namespace import）を塞ぐ、
 * 独立した静的チェック。`import * as X from '...'` の形が現れたら true。
 * モジュールパスは問わない（Lite 配下では namespace import 自体を禁止する運用のため）。
 */
export function containsNamespaceImport(source: string): boolean {
  return /import\s+\*\s+as\s+\w+\s+from\s+['"][^'"]+['"]/.test(source);
}

/**
 * `new WebSocket(...)` の直接生成を検出する。`useWebSocket` フックの import を経由しない
 * 抜け道（生の `WebSocket` API を直接呼ぶ）を塞ぐための、独立した静的チェック。
 */
export function containsRawWebSocketConstruction(source: string): boolean {
  return /\bnew\s+WebSocket\s*\(/.test(source);
}

/**
 * B1: `ThreadList` の行クリックが常にサーバー `switchThread`（POST）を発行してしまう問題への対処。
 * `readOnly` が true のときは**いかなる入力でも** `'server-switch'` を返してはならない
 * （呼び出し側 `ThreadList.tsx` はこの結果が `'local-select'` のときだけローカル state を更新し、
 * `'server-switch'` のときだけ `sessionsApi.switchThread()` を呼ぶ設計にする。これにより
 * L2 の「行選択はローカル state のみ・サーバー操作は一切発火しない」がこの関数 1 点に集約される）。
 */
export type ThreadRowAction =
  | { kind: 'local-select'; sessionId: string }
  | { kind: 'server-switch'; sessionId: string }
  | { kind: 'noop'; reason: 'already-current' | 'switching' };

export function decideThreadRowAction(input: {
  sessionId: string;
  currentSessionId?: string | null;
  readOnly: boolean;
  switching: boolean;
}): ThreadRowAction {
  if (input.sessionId === input.currentSessionId) return { kind: 'noop', reason: 'already-current' };
  if (input.switching) return { kind: 'noop', reason: 'switching' };
  if (input.readOnly) return { kind: 'local-select', sessionId: input.sessionId };
  return { kind: 'server-switch', sessionId: input.sessionId };
}

/** プロジェクトセレクタの 1 行分の表示情報 */
export interface ProjectSelectorOption {
  projectId: string;
  label: string;
  machineLabel: string;
  online: boolean;
}

/**
 * プロジェクトセレクタの表示行を組み立てる。各要素に既存の `resolveThreadProjectView()`
 * （F2/F3 吸収層、`displayName ?? name` を一本化）をそのまま適用する。新しい displayName 解決
 * ロジックはここには書かない。API の返す並び順をそのまま保持する（呼び出し側でソートしない）。
 */
export function buildProjectSelectorOptions(
  projects: readonly ProjectViewSource[]
): readonly ProjectSelectorOption[] {
  return projects.map((p) => {
    const view = resolveThreadProjectView({
      projectId: p.id,
      projects: new Map([[p.id, p]]),
    });
    return {
      projectId: p.id,
      label: view.projectLabel,
      machineLabel: view.machineLabel,
      online: view.online,
    };
  });
}

// ---------------------------------------------------------------------------
// 8. L3 A2: 削除済みマシンのプロジェクトを除外する（交差案）
// ---------------------------------------------------------------------------

/**
 * `GET /api/projects` を情報源のまま維持し、`GET /api/machines` の id 集合を「生存マシンの許可
 * リスト」として使って絞り込む（S3 の交差案）。`GET /api/projects` の where 句は
 * `machine.deletedAt` を見ておらず、マシンのソフトデリートは名前リネームのみで Project の
 * `deletedAt` を設定しないため、削除済みマシン配下の Project が一覧に残り続ける（`_deleted_` の
 * 真因）。`GET /api/machines` は `where: { userId, deletedAt: null }` で既に除外済みなので、
 * その id 集合を権威ある生存マシン一覧として使う（サーバー変更ゼロ）。
 *
 * `liveMachineIds` の意味論（人間の承認条件 1 により厳密化）:
 * - `null`: `/api/machines` の取得失敗・異常応答・未取得（fetch 自体が信頼できない状態）を表す。
 *   このときのみ fail-open で `projects` をそのまま返す（「プロジェクトが 1 つも無い」という
 *   誤読を防ぐため）。
 * - 空の `Set`（要素数 0）: `/api/machines` が**正常に**取得できて生存マシンが 0 件だったことを
 *   表す。この場合は fail-open にせず、`machine.id` を持つ行はすべて除外する
 *   （成功した取得結果は権威ある情報として扱う）。
 *
 * `machine` 不在 / `machine.id` 不在の行は常に残す（fail-open。判定に必要な情報がそもそも無い
 * ケースであり、`liveMachineIds` の意味論とは独立）。順序は `projects` の並びをそのまま保持する。
 */
export function filterProjectsByLiveMachines<T extends ProjectViewSource>(
  projects: readonly T[],
  liveMachineIds: ReadonlySet<string> | null
): readonly T[] {
  if (liveMachineIds === null) return projects;
  return projects.filter((p) => {
    const machineId = p.machine?.id;
    if (!machineId) return true;
    return liveMachineIds.has(machineId);
  });
}

/**
 * 診断専用ヘルパー（フィルタには使わない）。マシン名が `looksLikeDeletedMachineName` パターン
 * （ソフトデリート時のリネーム規則 `` `${name}__deleted_${Date.now()}` ``、`api.ts:222`）に
 * 一致するかどうかを判定する。
 *
 * **フィルタとして使わない理由**（S3 参照）:
 * 1. `displayName` はリネームされないため、UI に表示したい名前には `_deleted_` は現れない
 *    （`name` のみがリネームされる）
 * 2. 正当なマシン名（例: `foo__deleted_bar` というプロジェクト名）への誤爆が
 *    「無言でプロジェクトが消える」という致命的な退行になる
 * 3. `filterProjectsByLiveMachines()` という権威ある信号（`machine.deletedAt` 由来の id 集合）が
 *    既にあるため、文字列推測を重ねる意味がない
 */
export function looksLikeDeletedMachineName(name: string): boolean {
  return /__deleted_\d+$/.test(name);
}

// ---------------------------------------------------------------------------
// 9. L4 A1: プロジェクトセレクタの並び（マシン名 → プロジェクト名）
// ---------------------------------------------------------------------------

/**
 * `buildProjectSelectorOptions()` 自体は変更しない（`lite-shell-rules.test.mjs:427`
 * 「API の返す並び順をそのまま保持する（ソートしない）」が既にその無変更を固定しているため）。
 * ソートは呼び出し側が別関数として適用する。
 *
 * マシン名 → プロジェクト名の順で安定ソートする（`localeCompare`）。オフライン機も同じ並びに
 * 混ぜる（`online` はソートキーに含めない）。同名衝突時は `projectId` で決定的にする
 * （テストの再現性のため）。入力配列は破壊しない。
 */
export function sortProjectSelectorOptions(
  options: readonly ProjectSelectorOption[]
): readonly ProjectSelectorOption[] {
  return [...options].sort((a, b) => {
    const byMachine = a.machineLabel.localeCompare(b.machineLabel);
    if (byMachine !== 0) return byMachine;
    const byLabel = a.label.localeCompare(b.label);
    if (byLabel !== 0) return byLabel;
    return a.projectId.localeCompare(b.projectId);
  });
}

// ---------------------------------------------------------------------------
// 10. L4 A2: 入力不可時のプレースホルダ理由
// ---------------------------------------------------------------------------

export type ComposerPlaceholderReason = 'connecting' | 'machine-offline' | 'no-project' | 'ready';

/**
 * `decideSendAction()` の `blocked.reason`（または未算出時の `null`）を、Composer が表示すべき
 * プレースホルダの種別へ写す。`'empty'` / `'in-flight'` / `null` は「入力欄自体は使える」状態なので
 * 通常のプレースホルダ（`'ready'`）にまとめる。
 *
 * `'offline'`（`decideSendAction` の `machineOnline` ブロック、R7）は `'disconnected'`（WS 未接続）
 * とは別の `'machine-offline'` に写す（人間の承認条件 4: 「マシンがオフラインです」を独立して
 * 表示するため。`'disconnected'` は「WebSocket 自体が繋がっていない」を表す `'connecting'` のまま）。
 */
export function resolveComposerPlaceholderReason(
  reason: SendBlockedReason | null
): ComposerPlaceholderReason {
  if (reason === 'disconnected') return 'connecting';
  if (reason === 'offline') return 'machine-offline';
  if (reason === 'no-project' || reason === 'no-tab-id') return 'no-project';
  return 'ready';
}

// ---------------------------------------------------------------------------
// 11. L4 A3: プロジェクトセレクタ変更時の URL 遷移 + 新規スレッド告知
// ---------------------------------------------------------------------------

/**
 * プロジェクトセレクタ変更時に URL パラメータへ適用すべき値を決める。
 * `nextProjectId` が現在と異なるときのみ `session` を消す（A3: セレクタ変更でスレッド選択を解除する）。
 * 同一プロジェクトを選び直したときは `session` を維持する（無用な選択解除を避ける）。
 */
export function decideProjectSelectorUrl(input: {
  currentProjectId: string | null;
  currentSessionId: string | null;
  nextProjectId: string;
}): { project: string | null; session: string | null } {
  if (!input.nextProjectId) return { project: null, session: null };
  if (input.nextProjectId === input.currentProjectId) {
    return { project: input.nextProjectId, session: input.currentSessionId };
  }
  return { project: input.nextProjectId, session: null };
}

/**
 * 「送信すると新しいスレッドを作ります」告知の表示可否を決める。`decideSendAction()` の
 * `needsNewThread` 判定と**同じ条件**にすること（単一情報源。テストで一致を固定する）。
 */
export function shouldShowNewThreadNotice(input: {
  selectedProjectId: string | null;
  selectedSessionId: string | null;
  selectedThreadProjectId: string | null;
}): boolean {
  if (!input.selectedProjectId) return false;
  return !input.selectedSessionId || input.selectedThreadProjectId !== input.selectedProjectId;
}

// ---------------------------------------------------------------------------
// 12. L4 B4: 「+ 新規」ボタンの disabled 判定（ThreadList.tsx の純加算 prop 用）
// ---------------------------------------------------------------------------

export interface ThreadCreateButtonState {
  disabled: boolean;
  label: 'creating' | 'new';
}

/**
 * `ThreadList.tsx` の「＋新規」ボタンの状態を決める。`hasRequestCreate === false`（= classic、
 * `onRequestCreate` 未指定）のときに返る `disabled` は、既存の
 * `!createTargetProjectId || creating || readOnly` と**完全一致**すること
 * （テストで classic 8 パターンの真理値表一致を固定する）。
 *
 * `hasRequestCreate === true`（= Lite、`onRequestCreate` 指定）のときは `readOnly` を無視し
 * `createInFlight` を使う（Lite は readOnly のまま「＋新規」だけを有効化するための入口）。
 */
export function decideThreadCreateButton(input: {
  createTargetProjectId: string | null;
  creating: boolean;
  readOnly: boolean;
  hasRequestCreate: boolean;
  createInFlight: boolean;
}): ThreadCreateButtonState {
  if (input.hasRequestCreate) {
    return {
      disabled: !input.createTargetProjectId || input.createInFlight,
      label: input.createInFlight ? 'creating' : 'new',
    };
  }
  return {
    disabled: !input.createTargetProjectId || input.creating || input.readOnly,
    label: input.creating ? 'creating' : 'new',
  };
}

// ---------------------------------------------------------------------------
// 13. L4 R4/C-2: ソース静的走査用のコメント除去ヘルパー
// ---------------------------------------------------------------------------

/**
 * ソース文字列から行コメント（`//...`）とブロックコメント（`/* ... *\/`）を除去する。
 * 文字列リテラル（`'...'` / `"..."` / `` `...` `` ）内の `//` は保持する（誤検出防止）。
 * 静的走査テスト（`lite-source-guards.test.mjs`）が JSDoc 中の文言（例: `//connect` への言及）を
 * 実コードと誤認しないようにするための前処理専用。TS/JS の完全なパーサではない
 * （ネストしたテンプレートリテラル内の `${}` 等の複雑なケースは想定しない。Lite ソースの
 * 既知の範囲で十分な簡易実装）。
 */
export function stripComments(source: string): string {
  let result = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    const two = source.slice(i, i + 2);
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === quote) { j += 1; break; }
        j += 1;
      }
      result += source.slice(i, j);
      i = j;
      continue;
    }
    if (two === '//') {
      let j = i + 2;
      while (j < n && source[j] !== '\n') j += 1;
      result += '\n';
      i = j;
      continue;
    }
    if (two === '/*') {
      let j = i + 2;
      while (j < n && source.slice(j, j + 2) !== '*/') j += 1;
      i = j + 2;
      continue;
    }
    result += ch;
    i += 1;
  }
  return result;
}
