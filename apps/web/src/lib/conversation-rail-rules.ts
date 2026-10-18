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

/** 会話履歴レールの既読状態（sessionId → 既読時点の lastAiAt ISO 文字列）を保存する localStorage キー */
export const CONVERSATION_SEEN_STORAGE_KEY = 'devrelay-conversation-seen';

/** 既読マップの保持上限件数（超過分は古い順に破棄し localStorage の無限成長を防ぐ） */
export const CONVERSATION_SEEN_MAX = 200;

/** 既読マップのスキーマバージョン（将来の形式変更時に無条件で initialized:false に倒すための印） */
const SEEN_MAP_VERSION = 1;

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

/** `readSeenMap()` の戻り値 */
export interface SeenMapState {
  /** localStorage に有効な既読マップが保存されていたか（false なら未初期化＝初回起動扱い） */
  initialized: boolean;
  /** sessionId → 既読時点の lastAiAt ISO 文字列 */
  seen: Record<string, string>;
}

/**
 * localStorage の生の文字列から既読マップを復元する。
 * キー無し（`null`）・JSON 不正・`v` 不一致・`seen` が object でない場合は
 * `{ initialized:false, seen:{} }` に潰す（壊れたデータを握ったまま進行しない）。
 * `seen` の各値は文字列であることを確認し、そうでないものは読み捨てる。
 */
export function readSeenMap(raw: string | null): SeenMapState {
  if (raw === null) return { initialized: false, seen: {} };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      (parsed as { v?: unknown }).v !== SEEN_MAP_VERSION ||
      typeof (parsed as { seen?: unknown }).seen !== 'object' ||
      (parsed as { seen?: unknown }).seen === null
    ) {
      return { initialized: false, seen: {} };
    }
    const rawSeen = (parsed as { seen: Record<string, unknown> }).seen;
    const seen: Record<string, string> = {};
    for (const [sessionId, value] of Object.entries(rawSeen)) {
      if (typeof value === 'string') seen[sessionId] = value;
    }
    return { initialized: true, seen };
  } catch {
    return { initialized: false, seen: {} };
  }
}

/** 既読マップを localStorage 保存用の文字列に変換する（`readSeenMap` と往復可能な形式） */
export function serializeSeenMap(seen: Record<string, string>): string {
  return JSON.stringify({ v: SEEN_MAP_VERSION, seen });
}

/** `seedSeenMap()` に渡すスレッド1件分の最小情報 */
export interface ConversationSeedItem {
  sessionId: string;
  lastAiAt?: string | null;
}

/**
 * 初回起動時（`state.initialized === false`）にのみ、取得した全スレッドを既読シードする。
 * これにより「初めて会話履歴レールを開いたら20件全部が緑✓」という最悪の第一印象を回避する。
 * 既に初期化済み（`state.initialized === true`）の場合は既存の `seen` をそのまま返す（恒等）。
 * `lastAiAt` が無い/null のスレッド（AI 応答がまだ無い）はシード対象にしない。
 */
export function seedSeenMap(state: SeenMapState, items: ConversationSeedItem[]): Record<string, string> {
  if (state.initialized) return state.seen;
  const seen: Record<string, string> = {};
  for (const item of items) {
    if (item.lastAiAt) seen[item.sessionId] = item.lastAiAt;
  }
  return seen;
}

/**
 * スレッドを既読にする。`atIso`（クリック時点でサーバーが返していた `lastAiAt`）が
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
 * 既読マップの保持件数を `max` 以下に切り詰める。超過分は「古い順」
 * （= オブジェクトのキー挿入順。JS は文字列キーの挿入順を保持するため、
 * 初めて既読化された順＝先頭ほど古い、という近似で十分機能する）に破棄する。
 * `max` 以下であれば元のオブジェクトをそのまま返す（恒等）。
 */
export function pruneSeenMap(seen: Record<string, string>, max: number): Record<string, string> {
  const keys = Object.keys(seen);
  if (keys.length <= max) return seen;
  const dropCount = keys.length - max;
  const keysToDrop = new Set(keys.slice(0, dropCount));
  const next: Record<string, string> = {};
  for (const key of keys) {
    if (!keysToDrop.has(key)) next[key] = seen[key];
  }
  return next;
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
