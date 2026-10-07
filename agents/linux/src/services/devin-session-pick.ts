/**
 * Devin セッション継続サイクル: 「今回のターンの Devin セッション ID」を確定する純関数群。
 *
 * 【背景】旧実装は毎ターン `devin list --format json` の「working_directory 一致・
 * last_activity_at 最新」の 1 件を無条件にそのスレッドの scope dir へ保存していた。
 * これは以下 3 点で他スレッドのセッション ID を誤って保存しうる構造的な欠陥だった
 * （実機報告: スレッド A で会話後、スレッド B に切り替えて会話すると A の文脈を引きずる）。
 *
 * 1. フィルタが `working_directory` 一致のみ＝プロジェクト全体で、スレッド
 *    （`agentScopeId`）を識別する情報がどこにも無い。
 * 2. `last_activity_at` が ISO8601 文字列の場合、旧ソート比較器
 *    `(b.last_activity_at || 0) - (a.last_activity_at || 0)` は NaN になりソートが
 *    実質無効化される（`devin list --format json` の JSON スキーマは Devin 公式
 *    ドキュメントに記載が無く、数値である保証がない）。
 * 3. タイムスタンプが正しく数値でも、同一プロジェクトの複数スレッドが並行実行すれば
 *    先に close した側が相手の ID を拾う。
 *
 * 【新方式】
 * - resume（`-r`）したターンは今回のセッション ID が既に判明しているため、
 *   `devin list` の結果を一切見ない（`reason: 'resumed'`）。
 * - 新規セッションのターンは spawn 前後の ID 集合の差分で「新しく現れた ID」を特定する
 *   （`reason: 'newlyAppeared'`）。差分が取れない（`beforeIds === null`）場合のみ、
 *   従来のタイムスタンプ最新フォールバックを使う（`reason: 'latestFallback'`、
 *   ただし比較器は #2 の NaN 問題を修正済み）。差分が複数件なら「どれが自分のものか
 *   判別不能」として保存しない（`reason: 'ambiguous'`）。
 * - 採用候補が既に別スレッド（別スコープ）の scope dir に記録済みなら保存しない
 *   （`reason: 'ownedByOtherScope'`）。誤った ID を固定化するより未保存のほうが安全
 *   （次ターンは新規セッションになるが、Devin は会話履歴を常にプロンプトへ注入する
 *   ため文脈自体は維持される）。
 *
 * 外部 import ゼロの純関数（`devin-atif.ts` / `devin-diagnostics.ts` / `cli-failure.ts` /
 * `plan-permission.ts` と同じ流儀。`node --test` から `dist/` を直接 import してテストする）。
 *
 * `agents/linux` と `agents/macos` と `agents/windows` で byte-for-byte 同一内容を維持すること。
 */

/** `devin list --format json` の 1 エントリを正規化した形 */
export interface DevinSessionEntry {
  id: string;
  /** `last_activity_at` を数値 epoch ミリ秒へ正規化した値。正規化不能なら `-Infinity` */
  lastActivityMs: number;
}

export type DevinSessionPickReason =
  | 'resumed'
  | 'newlyAppeared'
  | 'latestFallback'
  | 'ambiguous'
  | 'ownedByOtherScope'
  | 'none';

export interface DevinSessionPickResult {
  /** 採用すべきセッション ID。保存を見送る場合は null */
  id: string | null;
  reason: DevinSessionPickReason;
}

/**
 * `last_activity_at` の生値を比較可能な数値へ正規化する。
 * `devin list --format json` の型は公式ドキュメント未記載のため、数値 epoch と
 * ISO8601 文字列のどちらでも正しく比較できるようにする（旧実装の NaN バグの修正）。
 * @param value `last_activity_at` の生値
 * @returns 正規化できた数値。できなければ `-Infinity`（最新候補から外れる方向に倒す）
 */
function normalizeActivityMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return -Infinity;
}

/**
 * `devin list --format json` の生出力を `projectPath` の working_directory 一致で絞り込み、
 * 比較可能な形へ正規化する。
 * @param raw `devin list --format json` の stdout 全体
 * @param projectPath 絞り込み対象のプロジェクトパス（大小文字・区切り文字を正規化して比較）
 * @returns 正規化済みエントリ配列。パース不能・配列でない・各要素が不正等は黙って除外する（例外を投げない）
 */
export function parseDevinSessionList(raw: string, projectPath: string): DevinSessionEntry[] {
  if (!raw || typeof raw !== 'string') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const normalizedPath = (projectPath ?? '').replace(/\\/g, '/').toLowerCase();
  const entries: DevinSessionEntry[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const id = typeof obj.id === 'string' && obj.id ? obj.id : null;
    if (!id) continue;
    const workingDirectory = typeof obj.working_directory === 'string'
      ? obj.working_directory.replace(/\\/g, '/').toLowerCase()
      : null;
    if (workingDirectory !== normalizedPath) continue;
    entries.push({ id, lastActivityMs: normalizeActivityMs(obj.last_activity_at) });
  }
  return entries;
}

/** `afterEntries` の中で `lastActivityMs` が最大のエントリの ID を返す（空配列は null） */
function pickLatestId(entries: DevinSessionEntry[]): string | null {
  if (entries.length === 0) return null;
  let best = entries[0];
  for (const entry of entries) {
    if (entry.lastActivityMs > best.lastActivityMs) best = entry;
  }
  return best.id;
}

/**
 * 今回のターンで保存すべき Devin セッション ID を決定する（I/O を一切行わない純関数）。
 *
 * @param input.resumedId 今回のターンが `-r` で resume した場合のセッション ID（既知）。
 *   新規セッションのターンでは null
 * @param input.beforeIds spawn 直前に取得した当該プロジェクトのセッション ID 一覧。
 *   スナップショット自体の取得に失敗した場合は null（`latestFallback` へ）
 * @param input.afterEntries close 後に取得した当該プロジェクトのセッション一覧（正規化済み）
 * @param input.ownedByOtherScope 候補 ID が既に別スコープ（別スレッド）の scope dir に
 *   保存済みかどうかを判定する関数
 * @returns 採用すべき ID（無ければ null）と、その判断理由
 */
export function pickDevinSessionId(input: {
  resumedId: string | null;
  beforeIds: string[] | null;
  afterEntries: DevinSessionEntry[];
  ownedByOtherScope: (id: string) => boolean;
}): DevinSessionPickResult {
  const { resumedId, beforeIds, afterEntries, ownedByOtherScope } = input;

  // resume したターンは今回のセッション ID が既知。list の結果は一切見ない。
  if (resumedId) {
    return { id: resumedId, reason: 'resumed' };
  }

  if (afterEntries.length === 0) {
    return { id: null, reason: 'none' };
  }

  let candidateId: string | null;
  let reason: DevinSessionPickReason;

  if (beforeIds) {
    const beforeSet = new Set(beforeIds);
    const newlyAppeared = afterEntries.filter((entry) => !beforeSet.has(entry.id));
    if (newlyAppeared.length === 1) {
      candidateId = newlyAppeared[0].id;
      reason = 'newlyAppeared';
    } else if (newlyAppeared.length === 0) {
      // 新しく現れたものが無い（devin 側が既存 ID を再利用した等）→ タイムスタンプ最新へフォールバック
      candidateId = pickLatestId(afterEntries);
      reason = 'latestFallback';
    } else {
      // 複数件が同時に新規出現（並行実行等）→ どれが自分のものか判別不能。保存しない。
      return { id: null, reason: 'ambiguous' };
    }
  } else {
    // スナップショット取得自体に失敗した → 従来のタイムスタンプ最新フォールバック（比較器は修正済み）
    candidateId = pickLatestId(afterEntries);
    reason = 'latestFallback';
  }

  if (candidateId && ownedByOtherScope(candidateId)) {
    return { id: null, reason: 'ownedByOtherScope' };
  }

  return { id: candidateId, reason };
}
