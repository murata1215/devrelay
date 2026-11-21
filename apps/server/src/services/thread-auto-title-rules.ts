/**
 * スレッドタイトル自動命名（0033、2026-11-21）の純関数群。
 *
 * 背景: スレッド一覧の表示名は `Session.title` が無いと「最初のユーザー発言」になるため、
 * (1) 最初の一言で決まって話が進んでも変わらない、(2) 引継ぎスレッドは最初の入力 `n` が
 * そのまま題名になる、という問題があった。会話の節目（AI 応答 1・3・8 回目）で AI に短い題名を
 * 付け直させ、`Session.autoTitle`（`title` とは別列）に保存する。
 *
 * 【不変条件】ユーザーが付けた `Session.title` には一切書かない（thread-label-source.ts 冒頭参照）。
 * `title` があるスレッドは生成自体を行わない（表示は常に title 優先のため無駄な課金になる）。
 *
 * 外部 import ゼロ（node:test から dist/ を直接 import する。thread-title.ts と同じ流儀）。
 */

/** キルスイッチ。既定 ON（'0' が明示されたときのみ無効）。 */
export function isThreadAutoTitleEnabled(raw: string | undefined): boolean {
  return raw !== '0';
}

/** 題名を付け直す節目（このスレッドの AI 応答数）。毎回は変えず、話題が固まるにつれ 2 回だけ見直す。 */
export const AUTO_TITLE_TURNS: readonly number[] = [1, 3, 8];

/** 生成する題名の最大長（コードポイント数）。一覧の表示幅（40 字切り詰め）に収まる長さ。 */
export const AUTO_TITLE_MAX_LENGTH = 40;

/**
 * この AI 応答の直後に題名を生成すべきか。
 * - `title`（ユーザー命名）があるなら生成しない
 * - AI 応答数が節目（1・3・8）のときだけ
 * - 同じ節目で既に生成済み（`autoTitleTurns >= aiTurnCount`）なら生成しない（二重発火・再送対策）
 */
export function shouldGenerateAutoTitle(input: {
  aiTurnCount: number;
  title: string | null;
  autoTitleTurns: number | null;
}): boolean {
  if (input.title && input.title.trim()) return false;
  if (!AUTO_TITLE_TURNS.includes(input.aiTurnCount)) return false;
  if (input.autoTitleTurns !== null && input.autoTitleTurns >= input.aiTurnCount) return false;
  return true;
}

/**
 * AI に渡すユーザー発言を選ぶ。コマンドだけの発言（`n` / `n 1` / `e` 等）は呼び出し側で除外済みの前提。
 * 先頭 2 件（最初の依頼）と直近 3 件（今の話題）を重複なく時系列順で返す。
 */
export function pickTitleSourceMessages(messages: readonly string[]): string[] {
  if (messages.length <= 5) return [...messages];
  return [...messages.slice(0, 2), ...messages.slice(-3)];
}

function clip(text: string, max: number): string {
  const cps = Array.from(text);
  return cps.length <= max ? text : cps.slice(0, max).join('') + '…';
}

export const AUTO_TITLE_SYSTEM_PROMPT = [
  'あなたはチャットスレッドの一覧に表示する短いタイトルを付ける係です。',
  '与えられた会話の「いま何の作業・相談をしているスレッドか」が一目で分かるタイトルを 1 つ作ってください。',
  '規則:',
  '- 会話と同じ言語で書く（日本語の会話なら日本語）。日本語なら 12〜25 文字程度。',
  '- 体言止め。「〜について」「〜の件」「スレッド」などの冗長な語や、引用符・絵文字・句点は付けない。',
  '- 最初の依頼だけでなく、話が移っていれば直近の話題を優先する。',
  '- 引継ぎメモがある場合はその作業内容を踏まえる。',
  '出力は JSON のみ: {"title":"..."}',
].join('\n');

/** AI に渡すユーザープロンプトを組み立てる（各要素は切り詰めて入力トークンを抑える）。 */
export function buildAutoTitleUserPrompt(input: {
  handoverNote: string | null;
  userMessages: readonly string[];
  aiExcerpt: string | null;
}): string {
  const parts: string[] = [];
  if (input.handoverNote && input.handoverNote.trim()) {
    parts.push(`## 引継ぎメモ（前のスレッドからの続き）\n${clip(input.handoverNote.trim(), 600)}`);
  }
  if (input.userMessages.length > 0) {
    parts.push(
      `## ユーザーの発言（古い順）\n${input.userMessages.map((m, i) => `${i + 1}. ${clip(m.trim().replace(/\s+/g, ' '), 300)}`).join('\n')}`,
    );
  }
  if (input.aiExcerpt && input.aiExcerpt.trim()) {
    parts.push(`## 直近の AI の応答（冒頭）\n${clip(input.aiExcerpt.trim(), 600)}`);
  }
  return parts.join('\n\n');
}

/** 材料が何も無い（AI に聞いても意味が無い）か。 */
export function hasAutoTitleMaterial(input: { handoverNote: string | null; userMessages: readonly string[] }): boolean {
  return (!!input.handoverNote && input.handoverNote.trim().length > 0) || input.userMessages.some((m) => m.trim().length > 0);
}

/**
 * AI の応答から題名を取り出して整形する。解釈できなければ null。
 * JSON（`{"title":"..."}`、コードフェンス付きも可）を優先し、JSON でなければ 1 行目をそのまま使う。
 */
export function parseAutoTitle(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    const obj = JSON.parse(text);
    text = obj && typeof obj.title === 'string' ? obj.title : '';
  } catch {
    text = text.split('\n')[0] ?? '';
  }
  return normalizeAutoTitle(text);
}

/** 題名の整形: 改行・引用符・括弧・末尾の句点を除き、最大長で切る。空になれば null。 */
export function normalizeAutoTitle(raw: string): string | null {
  let t = raw.replace(/\s+/g, ' ').trim();
  t = t.replace(/^(?:タイトル|title)\s*[:：]\s*/i, '');
  // 「"題名"。」のように引用符と句点が入れ子になっても剥がしきれるよう、変化が無くなるまで繰り返す
  for (let prev = ''; prev !== t; ) {
    prev = t;
    t = t.replace(/^["'「『【`]+/, '').replace(/["'」』】`]+$/, '').replace(/[。．.]+$/, '').trim();
  }
  if (!t) return null;
  const cps = Array.from(t);
  return cps.length <= AUTO_TITLE_MAX_LENGTH ? t : cps.slice(0, AUTO_TITLE_MAX_LENGTH).join('');
}
