/**
 * 会話履歴レール（右レール第3タブ・Servers/Agents の隣）の表示ルールを決定する純関数群。
 * 外部 import ゼロ（node:test から dist-test/ を直接 import する。
 * thread-list-rules.ts / right-rail-rules.ts と同じ流儀）。
 *
 * 目的: `Servers`/`Agents` タブの隣に、全プロジェクト横断で直近スレッドを新しい順に並べ、
 * 各行の左に状態アイコン（実行中=スピナー / 未確認=緑✓ / 確認済み=マークなし）を出す。
 * 既存の `ThreadList.tsx`（プロジェクト内の全履歴・改名・新規作成が中核）とは別の、
 * 「最新を追う」ための軽量な表示専用コンポーネント（`ConversationRail.tsx`）から使われる。
 */

/** 会話履歴レールが一覧表示するスレッド件数の上限 */
export const CONVERSATION_RAIL_LIMIT = 20;

/** 会話履歴レールの再取得ポーリング間隔（ms）。`machineList` の既存10秒ポーリングと同じ値 */
export const CONVERSATION_RAIL_POLL_MS = 10_000;

/** Sidebar（Servers/Agents/会話）のモード選択を保存する localStorage キー */
export const SIDEBAR_MODE_STORAGE_KEY = 'devrelay-sidebar-mode';

/** Sidebar の表示モード（`Servers`/`Agents` タブに「会話」タブが加わった3値） */
export type SidebarMode = 'agents' | 'servers' | 'conversations';

/** 会話履歴レールの1行が取りうる状態 */
export type ConversationStatus = 'running' | 'unread' | 'seen';

/**
 * localStorage の生の文字列から Sidebar の表示モードを復元する。
 * 3値のいずれでもない（`null`・未知の文字列・空文字）場合は既定の `'servers'` にフォールバックする
 * （`sidebarMode` の現行の初期値と同じ）。
 */
export function readSidebarMode(raw: string | null): SidebarMode {
  if (raw === 'agents' || raw === 'servers' || raw === 'conversations') return raw;
  return 'servers';
}

/**
 * スレッド1件の表示状態（実行中・未確認・確認済み）を決定する。
 *
 * 優先順位:
 * 1. `running`（サーバー由来）または `localRunning`（自ブラウザの `tab.progress` 由来。
 *    ポーリング間隔より速く反映するための即時性の補完）のいずれかが true なら `'running'`
 * 2. `lastAiAt` が明示的に渡されている（新サーバー応答）場合はそれを比較対象にする。
 *    `null`（まだ AI 応答が無いスレッド）は確認すべきものが無いため `'seen'`。
 *    キー自体が無い（`undefined`＝旧サーバー応答）場合だけ `lastActiveAt` にフォールバックする
 *    （`lastActiveAt` は AI 応答到着時に更新される保証が無いため、新サーバーでは使わない。
 *    `thread-activity.ts` のサーバー側コメント参照）。
 * 3. `seenAt`（既読時点の ISO 文字列）が無ければ一度も見ていない＝`'unread'`。
 * 4. 比較対象の時刻が `seenAt` より新しければ `'unread'`、そうでなければ `'seen'`。
 * 5. 日時のパースに失敗した場合は `'seen'`（fail-safe: 緑✓の誤爆より見逃しを選ぶ）。
 */
export function resolveConversationStatus(args: {
  /** サーバー由来の実行中フラグ（`GET /api/threads` の `running`） */
  running?: boolean;
  /** 自ブラウザの `tab.progress` 由来の実行中フラグ（即時性の補完） */
  localRunning?: boolean;
  /** サーバー由来の最新 AI 応答時刻（`role='ai'` の最新 createdAt）。新サーバーのみ存在 */
  lastAiAt?: string | null;
  /** 旧サーバー互換フォールバック用（`lastAiAt` が無い場合のみ使う） */
  lastActiveAt: string;
  /** このブラウザでの既読時点の ISO 文字列（未読なら `null`/`undefined`） */
  seenAt?: string | null;
}): ConversationStatus {
  if (args.running || args.localRunning) return 'running';

  const compareTarget = args.lastAiAt !== undefined ? args.lastAiAt : args.lastActiveAt;
  if (compareTarget === null) return 'seen';

  if (!args.seenAt) return 'unread';

  const targetMs = Date.parse(compareTarget);
  const seenMs = Date.parse(args.seenAt);
  if (Number.isNaN(targetMs) || Number.isNaN(seenMs)) return 'seen';

  return targetMs > seenMs ? 'unread' : 'seen';
}

/**
 * 会話既読状態のサーバー管理化（端末・ブラウザ間同期）に伴い、既読マップの localStorage
 * 永続化（旧 `readSeenMap`/`serializeSeenMap`/`seedSeenMap`/`pruneSeenMap`/
 * `CONVERSATION_SEEN_STORAGE_KEY`/`CONVERSATION_SEEN_MAX`）は廃止した。
 * 既読の出どころは `GET /api/threads` の `seenAt`（= サーバー側 `Session.lastSeenAiAt`）に一本化され、
 * 「初回起動時に全件シード」のような特別扱いも不要になった（サーバーが導入時に
 * 既存行をバックフィル済みのため、初回表示から正しい既読状態が返る）。
 * `markSeen` だけは、ポーリング間隔中の楽観的 UI 反映（`useConversationFeed.ts` の
 * `localSeenOverrides`）に引き続き使うため残す。
 */

/**
 * スレッドを既読にする。`atIso`（`POST /api/sessions/:id/seen` のレスポンス `seenAt`）が
 * 無ければ何もしない（比較対象が無いなら既読化できない＝恒等）。
 * 既存の既読時刻より新しい場合のみ更新し、**巻き戻さない**
 * （ポーリング結果の順序入れ替わりで既読が未読に戻るレースを防ぐ）。
 */
export function markSeen(
  seen: Record<string, string>,
  sessionId: string,
  atIso: string | null | undefined
): Record<string, string> {
  if (!atIso) return seen;
  const existing = seen[sessionId];
  if (existing !== undefined) {
    const existingMs = Date.parse(existing);
    const nextMs = Date.parse(atIso);
    if (!Number.isNaN(existingMs) && !Number.isNaN(nextMs) && nextMs <= existingMs) {
      return seen;
    }
  }
  return { ...seen, [sessionId]: atIso };
}

/**
 * サーバー由来の `seenAt`（`GET /api/threads` の `seenAt`、複数端末間で同期される真実の情報源）と、
 * このブラウザが直近で行った楽観的な既読更新（`POST /api/sessions/:id/seen` 応答の
 * ローカル上書き。次回ポーリングでサーバー値が追いつくまでのつなぎ）をマージする。
 *
 * - `localOverride` が無ければサーバー値をそのまま返す（恒等）
 * - サーバー値が `null`/`undefined`（未既読 or 旧サーバー応答）でも `localOverride` があればそちらを使う
 * - 両方あれば新しい方を採用する（巻き戻さない。`markSeen` と同じ方針）
 * - 日時パース不能な側は無視してもう一方を採用する
 */
export function resolveEffectiveSeenAt(
  serverSeenAt: string | null | undefined,
  localOverride: string | undefined
): string | null | undefined {
  if (localOverride === undefined) return serverSeenAt;
  if (serverSeenAt === null || serverSeenAt === undefined) return localOverride;

  const serverMs = Date.parse(serverSeenAt);
  const overrideMs = Date.parse(localOverride);
  if (Number.isNaN(serverMs)) return localOverride;
  if (Number.isNaN(overrideMs)) return serverSeenAt;
  return overrideMs > serverMs ? localOverride : serverSeenAt;
}

/**
 * 「現在開いているスレッドに新しい AI 応答が来たとき、かつウィンドウが可視」の場合に
 * 自動で既読化すべきかを判定する。自分が今まさに見ているスレッドが緑✓のままになるのを防ぐ。
 * 一覧に表示されただけでは既読にしない（要望「未確認を羅列して最新を追う」の趣旨を壊すため）。
 */
export function decideAutoSeen(args: {
  /** 判定対象のスレッド sessionId */
  sessionId: string;
  /** 現在アクティブなタブが参照している sessionId */
  activeSessionId: string | null;
  /** ウィンドウ（タブ）が可視状態か（`document.visibilityState === 'visible'`） */
  visible: boolean;
}): boolean {
  return args.visible && args.activeSessionId === args.sessionId;
}

/**
 * 2026-10-22 見た目改修: `ThreadSummary.machineName` は常に `エイリアス(ホスト名)/ユーザー名` の
 * 2セグメント（`agent-manager.ts` の自動 displayName 計算も `alias/username` 形式を維持する。
 * 例: `x220-158-18-103/devrelay`）。会話履歴レールの行で「エージェント名」として見せたいのは
 * 先頭セグメント（ホスト名側）のみで、末尾のユーザー名セグメントは不要（`formatConversationScope`
 * 側でプロジェクト名と連結するため、そのまま繋ぐと `ubuntu-prod/devrelay/pixtalk` のように
 * 3セグメントになってしまう）。
 *
 * - スラッシュが無ければそのまま返す（旧データ・異常値への fail-open）
 * - 空・null・undefined は `''`
 * - 前後の空白は trim する
 */
export function deriveAgentLabel(machineName: string | null | undefined): string {
  if (!machineName) return '';
  const trimmed = machineName.trim();
  if (!trimmed) return '';
  const slashIdx = trimmed.indexOf('/');
  if (slashIdx === -1) return trimmed;
  return trimmed.slice(0, slashIdx).trim();
}

/**
 * 会話履歴レールの行1行目（主役）に出す「エージェント名/プロジェクト名」を組み立てる。
 * 要望: 「右上 Servers/Agents タブの隣」という置き場所の性質上、全プロジェクト横断の一覧では
 * どのエージェントのどのプロジェクトの会話かが先に分かるべき（会話タイトルより優先度が高い）。
 *
 * - エージェント名が空 → プロジェクト名のみ
 * - プロジェクト名が空 → エージェント名のみ
 * - 両方空 → `''`（呼び出し側が `thread.untitled` 等へフォールバックする）
 */
export function formatConversationScope(args: {
  /** `deriveAgentLabel()` 適用後の値を渡すこと（`machineName` をそのまま渡さない） */
  agentLabel: string;
  /** `resolveProjectLabel` 解決後のプロジェクト表示名 */
  projectLabel: string;
}): string {
  const agent = args.agentLabel.trim();
  const project = args.projectLabel.trim();
  if (agent && project) return `${agent}/${project}`;
  return agent || project;
}
