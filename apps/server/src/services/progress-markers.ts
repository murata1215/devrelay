/**
 * BuildLog AI 要約（build-summarizer.ts）の入力、および MCP `get_answer`/`get_plan` の
 * 返却値から進捗マーカー行を除去するための純関数モジュール。外部 import ゼロ
 * （stop-reason.ts / content-truncate.ts / human-text-fence.ts と同じ流儀）。
 * `isProgressMarkerLine()` / `stripProgressMarkers()` は
 * `agents/linux/src/services/history-compaction.ts` の同名関数の写し
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
 *
 * 追加背景（2026-09-26 サイクル: get_answer/get_plan の進捗表示除外）: MCP `get_answer` の
 * `answer` / `get_plan` の `planMarkdown`・`summary` に、上記 🔧 行に加えて
 * `📊 Rate Limit: 5h: 0%` のようなレートリミット前置情報が混入していた（音声クライアント等が
 * そのまま読み上げてしまう）。生成元は `agents/{linux,macos}/src/services/connection.ts` の
 * `` `📊 Rate Limit: ${parts.join(' | ')}\n` ``（i18n を通らない英語ハードコード）。
 * `thread-label-source.ts` の `/^[📊📝].+$/` は本文中の正当な `📊`/`📝` 始まりの行
 * （例: `📊 集計結果は以下のとおり`）まで消してしまうため採用せず、`isContextInfoLine()` は
 * `Rate Limit:` 込みの厳密パターンのみを対象にする。
 * あわせて、terminal-mode（linux のみ）の心拍表示 `` `\n⏳ [${elapsedSec}s 経過] ...\n` ``
 * （`agents/linux/src/services/terminal-runner.ts`）は「⏳ 始まりのチャンクは最終回答から除外する」
 * という #276 規約の対象だが、先頭に `\n` を付けて送出されるため
 * `connection.ts` の `output.startsWith('⏳')` 判定を素通りして `Message.content` に混入する
 * （Agent 側の根治は別サイクル）。`isEphemeralProgressLine()` は行単位でこれを回収する。
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
 * contextInfo 行（📊 Rate Limit）のパターン。
 * 生成元は `agents/{linux,macos}/src/services/connection.ts` の
 * `` `📊 Rate Limit: ${parts.join(' | ')}\n` ``。
 * 意図的に `Rate Limit:` 込みの厳密一致のみとし、`📊 Context: ...`（output-parser.ts、
 * console.log のみで本文には混入しない）や本文中の正当な `📊`/`📝` 始まりの行は対象外にする。
 */
const CONTEXT_INFO_LINE_PATTERNS: readonly RegExp[] = [
  /^📊\s*Rate Limit:\s*\S.*$/u,
];

/**
 * #276 規約（⏳ 始まりのチャンクは最終回答から除外）が terminal-mode の心拍表示
 * （先頭に `\n` が付くため元のチャンク単位判定を素通りする）で崩れている分を、行単位で回収する。
 * 生成元は `agents/linux/src/services/terminal-runner.ts` の
 * `` `\n⏳ [${elapsedSec}s 経過] ...\n` ``。
 */
const EPHEMERAL_LINE_PATTERNS: readonly RegExp[] = [
  /^⏳\s/u,
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
 * 1 行が contextInfo 行（📊 Rate Limit）かどうかを判定する。
 * @param line 判定対象の行（改行を含まない想定）
 * @returns contextInfo 行なら true
 */
export function isContextInfoLine(line: string): boolean {
  if (typeof line !== 'string') return false;
  const trimmed = line.trim();
  if (trimmed === '') return false;
  return CONTEXT_INFO_LINE_PATTERNS.some((re) => re.test(trimmed));
}

/**
 * 1 行が terminal-mode 心拍表示等の ⏳ 始まり行（#276 規約の行版）かどうかを判定する。
 * @param line 判定対象の行（改行を含まない想定）
 * @returns ⏳ 始まり行なら true
 */
export function isEphemeralProgressLine(line: string): boolean {
  if (typeof line !== 'string') return false;
  const trimmed = line.trim();
  if (trimmed === '') return false;
  return EPHEMERAL_LINE_PATTERNS.some((re) => re.test(trimmed));
}

/**
 * `text` の各行に `shouldDrop` を適用して除去し、除去で生じた連続空行を 1 行に畳む。
 * 前後の空行も落とす。`stripProgressMarkers()` / `stripAiProgressNoise()` の共通実装。
 * @param text 元テキスト
 * @param shouldDrop 行（trim 前）を渡され、除去すべきなら true を返す述語
 * @returns 除去後のテキスト（入力が空なら空文字）
 */
function stripLines(text: string, shouldDrop: (line: string) => boolean): string {
  if (typeof text !== 'string' || text === '') return '';

  const kept: string[] = [];
  let blankRun = 0;
  for (const line of text.split('\n')) {
    if (shouldDrop(line)) continue;
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

/**
 * テキストから進捗マーカー行を取り除き、除去で生じた連続空行を 1 行に畳む。
 * 前後の空行も落とす。
 *
 * @param text 元テキスト
 * @returns 進捗マーカーを除いたテキスト（入力が空なら空文字）
 */
export function stripProgressMarkers(text: string): string {
  return stripLines(text, isProgressMarkerLine);
}

/**
 * テキストから 🔧 進捗マーカー行・📊 Rate Limit 行・⏳ 始まり行（terminal-mode 心拍表示）を
 * まとめて除去する。MCP `get_answer`/`get_plan` など外向けフィールドの整形用
 * （DB 保存内容やアプリ内表示は変えず、返却直前にのみ適用する）。
 *
 * @param text 元テキスト
 * @returns 除去後のテキスト（入力が空なら空文字）
 */
export function stripAiProgressNoise(text: string): string {
  return stripLines(
    text,
    (line) => isProgressMarkerLine(line) || isContextInfoLine(line) || isEphemeralProgressLine(line)
  );
}

/**
 * MCP `get_answer.answer` / `get_plan.planMarkdown` 用のサニタイズ。
 * 進捗ノイズを除去した結果が空文字になる場合（進捗表示しか無かった場合）は、
 * 空文字を返さず元テキストの trim にフォールバックする
 * （`state === 'answered'` で `answer: ""` を返すとツール説明と矛盾し、
 * 音声クライアント等が無言になるため。`agents/linux/src/services/connection.ts` の
 * `stripProgressMarkers(responseText).trim() || responseText.trim()` と同じ流儀）。
 *
 * @param raw 元の `Message.content`（非文字列なら空文字を返す）
 * @returns サニタイズ後のテキスト
 */
export function sanitizeAiAnswer(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const cleaned = stripAiProgressNoise(raw).trim();
  return cleaned || raw.trim();
}

/**
 * MCP `get_answer`/`get_plan` のサニタイズを無効化するキルスイッチ判定。
 * `DEVRELAY_MCP_ANSWER_RAW=1` のときのみ true（既定 `0` = サニタイズ有効）。
 * `ask-guard.ts` の `isMcpAskEnabled()` と同じ流儀の純関数（env オブジェクトを引数で受け取る）。
 *
 * @param env 環境変数オブジェクト（通常は `process.env`）
 * @returns サニタイズを無効化すべきなら true
 */
export function isMcpAnswerRawMode(env: Record<string, string | undefined>): boolean {
  return env?.DEVRELAY_MCP_ANSWER_RAW === '1';
}
