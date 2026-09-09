/**
 * BuildLog AI 要約（build-summarizer.ts）の入力から進捗マーカー行を除去するための
 * 純関数モジュール。外部 import ゼロ（stop-reason.ts / content-truncate.ts / human-text-fence.ts
 * と同じ流儀）。ロジックは `agents/linux/src/services/history-compaction.ts` の
 * `PROGRESS_LINE_PATTERNS` / `isProgressMarkerLine()` / `stripProgressMarkers()` の写し
 * （このファイルはそのサブセットのみを持ち、プラン文脈スライス等の他機能は含まない）。
 *
 * 背景（2026-09-09 調査サイクル）: `get_build_status.summary` が「不明」を返す事象を調査した結果、
 * `build-summarizer.ts` の要約用 AI に渡す exec 完了時の出力テキストが `🔧 Editを使用中...` 等の
 * 進捗マーカー行で埋め尽くされ、8000 文字の予算のうち実質的な内容（完了報告）の前に消費されて
 * しまうことが真因と判明した（#372 が Agent 側の会話履歴圧縮で対処したのと同種の問題が、
 * サーバー側の BuildLog 要約入力にも存在していた）。
 *
 * サーバー側は Agent 側の同名モジュールを import できない（別 workspace・別ランタイム）ため、
 * 判定ロジックのみを複製する。進捗マーカーの文面は `packages/shared/src/i18n.ts` の
 * `progress.usingTool` に由来する（ja: `🔧 {tool}を使用中...` / en: `🔧 Using {tool}...`）。
 */

/**
 * 進捗マーカー行のパターン（ja / en 両対応）。
 * `agents/linux/src/services/history-compaction.ts` の同名定数と論理的に同一。
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
 * テキストから進捗マーカー行を取り除き、除去で生じた連続空行を 1 行に畳む。
 * 前後の空行も落とす。
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
