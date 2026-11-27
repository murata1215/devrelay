/**
 * スレッド状態バッジ（プラン作成済み / 実行済み / 回答済み）: 外部 import ゼロの純関数モジュール
 * （`thread-activity.ts` / `thread-label-source.ts` と同じ流儀。node:test から `dist/` を
 * 直接 import して検証する）。
 *
 * 設計の要点（AI の文章を解釈して判定することを避ける）:
 * - 「実行済み」はサーバー自身が exec ターンの完了を検知した事実（`agent-manager.ts` の
 *   `isExec`）をその場で `Session.execCompletedAt` に記録するだけで判定できる。
 *   `Message.content` の文字列パターンマッチは一切使わない。
 * - 「プラン作成済み」はサーバーには原理的に分からない（plan ターンが「計画の提示」か
 *   「質問への回答」かという意味は DB に残らない）。そこで AI 自身に機械可読な印
 *   （`PLAN_MARKER_LINE`）を書かせる契約にし、サーバーはその印の「有無」だけを見る
 *   （印の前後の自然文は一切読まない）。
 * - 印は `agent-manager.ts` が AI 応答を DB に保存する直前に本文から取り除く
 *   （`stripPlanMarkerLine`）。表示経路（WebUI/Discord/Telegram/MCP/共有ページ）に
 *   生の HTML コメント行がそのまま出ることは無い。
 * - 優先順位は「到達した最上位」。一度 `executed` になったスレッドは、後で雑談や質問を
 *   しても `planned`/`answered` に後退しない（`execCompletedAt` を一度立てたら
 *   呼び出し側は上書きしない運用にする。本モジュール自体は読み取り専用の判定のみ）。
 */

/** キルスイッチ（既定 ON）。`'0'` のときだけ無効。`DEVRELAY_THREAD_STATE_BADGE`。 */
export function isThreadStateBadgeEnabled(raw: string | undefined): boolean {
  return raw !== '0';
}

/**
 * AI が「この返信はコードを変更せず計画だけを提案している（ユーザーの `exec` 待ち）」ことを
 * 示すために書く行（単独の1行・前後の空白は許容）。表示前に必ず取り除かれる。
 */
export const PLAN_MARKER_LINE = '<!-- devrelay:plan -->';

/**
 * `sendPromptToAgent`（plan ターン経路: チャット/MCP submit_instruction/ask）が前置する、
 * プラン印の指示文。exec ターン（`execConversation`）には前置しない
 * （exec は常に `executed` を上書きなしで記録するため、印は不要）。
 */
export const PLAN_MARKER_PROMPT_LINE =
  `【状態の記録】この返信がコードを変更せず計画だけを提案している（ユーザーの \`exec\` 待ち）場合は、` +
  `本文の末尾に単独の1行で ${PLAN_MARKER_LINE} を書いてください（説明のためにこの記法を例示する場合は` +
  `コードブロックの中に書いてください）。質問に答えるだけの返信や雑談では書かないでください。`;

/** 1行が指定したマーカーと完全一致するか（前後の空白は許容）。 */
function isMarkerLine(line: string, marker: string): boolean {
  return line.trim() === marker;
}

/**
 * `raw` 本文に（コードフェンス外の）プラン印の行が含まれているかを判定する（非破壊）。
 * コードブロック（```）内に書かれた印は「記法の例示」として無視する
 * （`response-split-rules.ts` の境界行検出と同じフェンス判定の考え方）。
 */
export function hasPlanMarkerLine(raw: string): boolean {
  if (typeof raw !== 'string') return false;
  let inFence = false;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && isMarkerLine(line, PLAN_MARKER_LINE)) return true;
  }
  return false;
}

/**
 * `raw` 本文からプラン印の行を取り除く。コードフェンス内の行は対象にせず温存する。
 * DB 保存・表示の前に必ず適用する（生の HTML コメント行がユーザーに見えないようにするため）。
 */
export function stripPlanMarkerLine(raw: string): string {
  if (typeof raw !== 'string') return raw;
  let inFence = false;
  const kept: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      inFence = !inFence;
      kept.push(line);
      continue;
    }
    if (!inFence && isMarkerLine(line, PLAN_MARKER_LINE)) continue;
    kept.push(line);
  }
  // 印の除去で末尾に空行が残ることがあるため、末尾の空行だけ畳む
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
  return kept.join('\n');
}

export type ThreadTurnState = 'executed' | 'planned' | 'answered';

/**
 * スレッドの状態バッジを判定する。優先順位は「到達した最上位」:
 * `executed`（exec 実行済み） > `planned`（プラン提示済み・exec 待ち） > `answered`（質問に答えただけ）。
 * AI 応答が1件も無ければ `null`（バッジなし。新規スレッド等）。
 *
 * `enabled=false`（キルスイッチ OFF）のときは常に `undefined` を返す（`running`/`lastAiAt` と
 * 同じ「キー省略」方式。`GET /api/threads` 側で `turnState: resolveThreadState(...)` としたとき
 * `undefined` が JSON シリアライズでキーごと消えるため、OFF 時のレスポンスが旧実装と構造的に同一になる）。
 */
export function resolveThreadState(args: {
  enabled: boolean;
  hasAiMessage: boolean;
  execCompletedAt: Date | null;
  planReadyAt: Date | null;
}): ThreadTurnState | null | undefined {
  if (!args.enabled) return undefined;
  if (args.execCompletedAt !== null) return 'executed';
  if (args.planReadyAt !== null) return 'planned';
  if (args.hasAiMessage) return 'answered';
  return null;
}
