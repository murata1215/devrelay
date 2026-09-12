/**
 * スレッド管理 サイクル3（WebUI）: ThreadList の表示ルール（並び順・ラベル導出・既定スレッド判定）を
 * 決定する純関数群。外部 import ゼロ（node:test から dist-test/ を直接 import する。
 * apps/server の thread-routing.ts と同じ流儀）。
 *
 * 表示ルールは `doc/thread-management-spec.md` §6 に準拠する:
 * - 一覧の並びは `lastActiveAt desc`（`GET /api/threads` は既に `sortThreadsDesc` 済みでサーバー側の
 *   `lastActiveAt` は `lastActiveAt ?? startedAt` に解決済み・常に non-null だが、クライアント側でも
 *   同じ規則を独立して保証できるようにする。防御的な再ソート）
 * - 既定スレッド（`agentScopeId = NULL`、API では `isScoped: false`）は「既定」であることを常に判定できる
 *   （ラベル自体は別軸: タイトルがあればタイトルを優先表示し、「既定」は別途バッジとして重ねて示す）
 * - 未命名（`title` が無い）スレッドは `firstUserMessage` の先頭 40 字で代替する
 */

/** ThreadList の1行分の表示に必要な最小情報（GET /api/threads のレスポンス項目の部分集合） */
export interface ThreadListItem {
  sessionId: string;
  title: string | null;
  firstUserMessage: string | null;
  /** 「(無題)」大量発生の根治 サイクルB: `[exec]`/`[w]`/`[teamexec]` タグを剥がしたユーザーメッセージ。
   * 旧サーバー応答には存在しないため optional（`deriveThreadLabel` 側で `??` フォールバックする）。 */
  labelFromUser?: string | null;
  /** 「(無題)」大量発生の根治 サイクルB: 📊 contextInfo / 🔧 進捗マーカー行を除いた AI 応答。同上 optional。 */
  labelFromAi?: string | null;
  /** false の場合は agentScopeId = NULL（既定スレッド） */
  isScoped: boolean;
  /** ISO 文字列。サーバー側で `lastActiveAt ?? startedAt` に解決済み（常に non-null） */
  lastActiveAt: string;
}

/**
 * `lastActiveAt` 降順（新しい順）にソートした新しい配列を返す（非破壊）。
 * パース不能な値（不正な ISO 文字列等）は `NaN` になり比較で最後方に落ちるため、
 * クラッシュせずソート順が乱れるだけに留まる（fail-soft）。
 */
export function sortThreadsDesc<T extends { lastActiveAt: string }>(threads: T[]): T[] {
  return [...threads].sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt));
}

/**
 * サロゲートペア（絵文字等）の境界で文字列が割れないよう安全に先頭 `max` コードポイントへ切り詰める。
 * `#297` の教訓: `str.slice(0, n)` は UTF-16 コード単位で切るため、絵文字の片割れだけが残ることがある。
 */
export function truncateDisplay(text: string, max: number): string {
  const codePoints = Array.from(text);
  if (codePoints.length <= max) return text;
  return codePoints.slice(0, max).join('');
}

/**
 * スレッドの表示ラベルを導出する。
 * 優先順位: `title`（空白のみは無視） → `labelFromUser ?? firstUserMessage` の先頭 `max` 字
 * （既定 40, 空白のみは無視） → `labelFromAi` の先頭 `max` 字 → fallback
 *
 * 「(無題)」大量発生の根治 サイクルB: `labelFromUser`/`labelFromAi` は
 * `[exec]`/`[w]`/`[teamexec]` タグ除去済み・AI 応答ノイズ除去済みのラベル材料
 * （サーバーが都度導出。DB へは非永続化）。旧サーバー応答（`labelFromUser`/`labelFromAi` が
 * 無い）でも `??` により従来どおり `firstUserMessage` にフォールバックするため後方互換。
 *
 * `kind: 'fallback'` の場合 `text` は空文字を返す。この純モジュールは外部 import（i18n 含む）を
 * 一切持てないため、未命名時の表示文字列（例: 日本語「(無題)」/ 英語 "(untitled)"）は
 * `kind` を見た呼び出し側（`ThreadList.tsx`）が `useLanguage().t()` で解決する。
 *
 * 「既定」バッジは `isDefaultThread()` で別途判定する。既定スレッドでも `title` があれば
 * それを優先表示する（ユーザーが明示的に改名した場合はその意図を尊重する）。
 */
export function deriveThreadLabel(
  item: Pick<ThreadListItem, 'title' | 'firstUserMessage' | 'labelFromUser' | 'labelFromAi'>,
  max: number = 40
): { text: string; kind: 'title' | 'firstMessage' | 'aiMessage' | 'fallback' } {
  if (item.title && item.title.trim()) return { text: item.title, kind: 'title' };
  // `labelFromUser` キー自体が無い（旧サーバー応答）場合のみ `firstUserMessage` にフォールバックする。
  // `labelFromUser: null`（コマンドタグ単体などラベルの材料が無いとサーバーが判定済み）のときは
  // `firstUserMessage`（タグ除去前の生テキスト、例: "[exec]"）に巻き戻さず、次点の `labelFromAi` へ進む
  // （`??` だと null も undefined と同様に巻き戻ってしまい、サーバー側の判定が意味を持たなくなる）。
  const userLabel = item.labelFromUser !== undefined ? item.labelFromUser : item.firstUserMessage;
  if (userLabel && userLabel.trim()) {
    return { text: truncateDisplay(userLabel, max), kind: 'firstMessage' };
  }
  if (item.labelFromAi && item.labelFromAi.trim()) {
    return { text: truncateDisplay(item.labelFromAi, max), kind: 'aiMessage' };
  }
  return { text: '', kind: 'fallback' };
}

/**
 * 既定スレッド（`agentScopeId = NULL`）かどうかを判定する。
 * §6: 「既定スレッド（agentScopeId = NULL）は「既定」ラベル付きで常に表示」— 一覧から除外されず
 * 常に表示対象であることと、UI 上で「既定」バッジを出す判定にこの関数を使う。
 */
export function isDefaultThread(item: Pick<ThreadListItem, 'isScoped'>): boolean {
  return !item.isScoped;
}

/**
 * 楽観的リネーム: 指定 `sessionId` の行の `title` を更新した新しい配列を返す（非破壊）。
 * 対象が無ければ元の配列と等価な新しい配列を返す（例外を投げない＝呼び出し側の try/catch を不要にする）。
 * 並び順は変更しない（改名だけなら `lastActiveAt` は動かないため再ソート不要）。
 */
export function applyThreadRename<T extends { sessionId: string; title: string | null }>(
  list: T[],
  sessionId: string,
  title: string
): T[] {
  return list.map((t) => (t.sessionId === sessionId ? { ...t, title } : t));
}

/**
 * 楽観的挿入/更新: 同じ `sessionId` の行があれば置き換え、無ければ先頭に追加し、
 * `lastActiveAt desc` で再ソートした新しい配列を返す（非破壊）。
 * 新規スレッド作成直後の一覧反映（再フェッチ前のちらつき防止）に使う。
 */
export function upsertThread<T extends { sessionId: string; lastActiveAt: string }>(
  list: T[],
  item: T
): T[] {
  const exists = list.some((t) => t.sessionId === item.sessionId);
  const next = exists ? list.map((t) => (t.sessionId === item.sessionId ? item : t)) : [item, ...list];
  return sortThreadsDesc(next);
}

/**
 * Lite シェル L1: `ThreadList` の「＋新規」作成先 projectId を導出する。
 * `projectId`（v1: ChatPage 内タブの projectId）を優先し、無ければ `createProjectId`
 * （v2: Lite シェルが横断一覧のまま作成先だけ指定する場合）にフォールバックする。
 *
 * 両方 `undefined` なら `undefined` を返す（`undefined ?? undefined === undefined`）。
 * これは「`ThreadList` の呼び出し元が `createProjectId` を渡さない限り従来の導出値と数学的に同一」
 * であることの根拠になる（L1 が従来 UI の挙動を変えないことの機械的な保証点）。
 * `??` を使うこと（`||` にしない）: `projectId: ''` のような falsy だが意味を持つ値を
 * `createProjectId` に上書きさせない（意味論を `??` に固定する）。
 */
export function resolveCreateTargetProjectId(
  projectId?: string,
  createProjectId?: string
): string | undefined {
  return projectId ?? createProjectId;
}
