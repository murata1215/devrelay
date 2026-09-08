/**
 * #372: 会話履歴の圧縮ユーティリティ（外部 import ゼロの純関数モジュール）。
 *
 * 2026-09-07、`/opt/devrelay` の exec が「ToolSearch を 1 回呼んで
 * 『Ready — the tool set is loaded.』だけ返して終わる」状態に陥った。
 * 根因は Claude Code の自動メモリ `~/.claude/projects/<slug>/memory/MEMORY.md` が
 * 330KB（約 118,000 トークン）まで肥大し、セッション開始時点で auto-compact しきい値
 * （Sonnet 5 で 167,000）の目前まで埋まっていたこと。MEMORY.md 側は別途圧縮したが、
 * exec 時に注入される `Previous conversation` ブロックにも 2 種類の無駄があった:
 *
 * 1. **進捗マーカー行**（`🔧 Bashを使用中...` 等）が assistant メッセージの大半を占める。
 *    実測: conversation.json 全体の 26.6%（55,053B / 206,741B）。これはチャット表示用の
 *    装飾であって、次の AI に渡す文脈としての価値はゼロ。
 * 2. **プラン文脈のスライスが exec マーカーを跨いで遡る**。従来は
 *    `history.slice(0, execIndex)` の直近 10 件を無条件に取っていたため、前サイクルの
 *    実装報告まで丸ごと注入されていた。実測（exec マーカー 19 点）で中央値 26KB。
 *    「直前の exec 以降」に限定すると中央値 6.7KB まで落ちる。
 *
 * 設計上の罠（テストで固定する）:
 * - `e` を 2 回送ると exec マーカーの間に「Ready」だけの無内容ターンが挟まり、
 *   素朴に「直前の exec 以降」で切るとプラン本体が消える（実際に exec#90 で 156B になった）。
 *   そのため **実質的な assistant メッセージが無いスライスは 1 つ前の exec まで遡る**。
 * - 進捗マーカーの文面は `packages/shared/src/i18n.ts` の `progress.usingTool` に由来する。
 *   ここではハードコードするが、テスト側で `tChat()` の出力とマッチすることを assert して
 *   i18n が変わったら落ちるようにする。
 * - このモジュールは引数を破壊的に変更しない。例外も投げない。
 */

/** 会話履歴 1 件の最小型（`conversation-store.ts` の `ConversationEntry` と構造互換） */
export interface HistoryLike {
  role: string;
  content: string;
}

/** プランスライスに含める最大メッセージ数の既定値 */
export const DEFAULT_MAX_PLAN_MESSAGES = 10;

/**
 * 「実質的な assistant メッセージ」と見なす最小文字数（進捗マーカー除去後で判定）。
 * 「Ready — the tool set is loaded. What would you like me to do next?」= 66 文字なので、
 * 500 文字あれば無内容ターンとプラン本体を確実に区別できる。
 */
export const DEFAULT_MIN_SUBSTANTIVE_CHARS = 500;

/** MEMORY.md（自動メモリ索引）の肥大警告しきい値（バイト） */
export const MEMORY_INDEX_WARN_BYTES = 100 * 1024;

/**
 * 進捗マーカー行のパターン（ja / en 両対応）。
 * 由来: `packages/shared/src/i18n.ts` の `progress.usingTool`
 *   ja: `🔧 {tool}を使用中...` / en: `🔧 Using {tool}...`
 */
const PROGRESS_LINE_PATTERNS: readonly RegExp[] = [
  /^🔧\s*.+を使用中\.\.\.$/u,
  /^🔧\s*Using\s+.+\.\.\.$/u,
];

/**
 * 1 行が進捗マーカー行かどうかを判定する。
 * @param line 判定対象の行（改行を含まない想定）
 * @returns 進捗マーカー行なら true
 */
export function isProgressMarkerLine(line: string): boolean {
  if (typeof line !== 'string') return false;
  const trimmed = line.trim();
  if (trimmed === '') return false;
  return PROGRESS_LINE_PATTERNS.some((re) => re.test(trimmed));
}

/**
 * assistant メッセージから進捗マーカー行を取り除き、除去で生じた連続空行を 1 行に畳む。
 * 前後の空行も落とす。ユーザーへ送る表示用テキストには適用しない（保存・注入時のみ）。
 *
 * @param text 元テキスト
 * @returns 進捗マーカーを除いたテキスト（入力が空なら空文字）
 */
export function stripProgressMarkers(text: string): string {
  if (typeof text !== 'string' || text === '') return '';

  const kept: string[] = [];
  let blankRun = 0;
  for (const line of text.split('\n')) {
    if (isProgressMarkerLine(line)) continue;
    if (line.trim() === '') {
      blankRun += 1;
      // 連続空行は 1 行だけ残す（先頭の空行は捨てる）
      if (blankRun > 1 || kept.length === 0) continue;
      kept.push('');
      continue;
    }
    blankRun = 0;
    kept.push(line);
  }
  // 末尾の空行を落とす
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
  return kept.join('\n');
}

/** 進捗マーカーを除いたうえで「実質的な内容がある」assistant メッセージか判定する */
function isSubstantiveAssistant(entry: HistoryLike, minChars: number): boolean {
  if (entry.role !== 'assistant') return false;
  return stripProgressMarkers(entry.content).length >= minChars;
}

/** `selectPlanMessages` のオプション */
export interface PlanSliceOptions {
  /** 返す最大件数（既定 {@link DEFAULT_MAX_PLAN_MESSAGES}） */
  maxPlanMessages?: number;
  /** 実質的な assistant メッセージと見なす最小文字数（既定 {@link DEFAULT_MIN_SUBSTANTIVE_CHARS}） */
  minSubstantiveChars?: number;
}

/**
 * exec マーカー直前の「今回のプラン会話」だけを取り出す。
 *
 * 基本は「直前の exec マーカー以降 〜 今回の exec マーカーの手前」。
 * ただしそのスライスに実質的な assistant メッセージが無い場合（`e` の連打で
 * 「Ready」だけのターンが挟まったケース）は、1 つ前の exec マーカーまで遡る。
 * 遡りは最大件数に達するか、遡れる exec マーカーが尽きるまで。
 *
 * @param history 会話履歴（破壊的変更はしない）
 * @param execIndex 今回の exec マーカーの位置。負値なら空配列を返す
 * @param options 件数・判定しきい値
 * @returns プラン文脈として注入すべき user/assistant メッセージ（時系列順）
 */
export function selectPlanMessages<T extends HistoryLike>(
  history: readonly T[],
  execIndex: number,
  options: PlanSliceOptions = {}
): T[] {
  if (!Array.isArray(history) || history.length === 0) return [];
  if (!Number.isInteger(execIndex) || execIndex < 0) return [];

  const maxPlanMessages = options.maxPlanMessages ?? DEFAULT_MAX_PLAN_MESSAGES;
  const minSubstantiveChars = options.minSubstantiveChars ?? DEFAULT_MIN_SUBSTANTIVE_CHARS;
  if (maxPlanMessages <= 0) return [];

  const upper = Math.min(execIndex, history.length);
  /** `upper` より前にある exec マーカーの位置（新しい順） */
  const priorExecIndexes: number[] = [];
  for (let i = upper - 1; i >= 0; i--) {
    if (history[i].role === 'exec') priorExecIndexes.push(i);
  }

  const collect = (from: number): T[] =>
    history.slice(from, upper).filter((h) => h.role === 'user' || h.role === 'assistant');

  // 境界候補を新しい順に試す（直前の exec → その前の exec → ... → 履歴の先頭）
  const boundaries = [...priorExecIndexes.map((i) => i + 1), 0];
  let selected: T[] = [];
  for (const from of boundaries) {
    selected = collect(from);
    if (selected.some((h) => isSubstantiveAssistant(h, minSubstantiveChars))) break;
    if (selected.length >= maxPlanMessages) break;
  }

  return selected.slice(-maxPlanMessages);
}

/**
 * プロジェクトパスから Claude Code の `~/.claude/projects/` 配下のディレクトリ名を求める。
 * 実測（この機体の実ディレクトリ）: `/opt/devrelay` → `-opt-devrelay`、
 * `/tmp/claude-1001/-home-devrelay/<uuid>/scratchpad` → `-tmp-claude-1001--home-devrelay-<uuid>-scratchpad`。
 *
 * @param projectPath 絶対パス
 * @returns スラッグ（英数字以外を `-` に置換したもの）
 */
export function claudeProjectSlug(projectPath: string): string {
  if (typeof projectPath !== 'string') return '';
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Claude Code の自動メモリ索引ファイル（毎セッション全文がコンテキストに載る）のパスを組み立てる。
 * `path.join` を使わないのは、このモジュールを外部 import ゼロに保つため（POSIX 前提）。
 *
 * @param configDir Claude Code の設定ディレクトリ（既定は `~/.claude`）
 * @param projectPath プロジェクトの絶対パス
 * @returns MEMORY.md の絶対パス
 */
export function claudeMemoryIndexPath(configDir: string, projectPath: string): string {
  const base = configDir.replace(/\/+$/, '');
  return `${base}/projects/${claudeProjectSlug(projectPath)}/memory/MEMORY.md`;
}

/**
 * MEMORY.md 肥大の警告を出すべきか判定する（1 セッション 1 回まで）。
 *
 * @param bytes MEMORY.md のバイト数。ファイルが無い場合は 0 を渡す
 * @param alreadyWarned このセッションで既に警告済みか
 * @returns 警告すべきなら true
 */
export function shouldWarnMemoryIndex(bytes: number, alreadyWarned: boolean): boolean {
  if (alreadyWarned) return false;
  if (!Number.isFinite(bytes)) return false;
  return bytes > MEMORY_INDEX_WARN_BYTES;
}
