/**
 * スレッド引継ぎ（`n` コマンド）の純関数群。
 *
 * - `n`   : 同じプロジェクトの他スレッドを最大 9 件、新しい順に一覧表示する
 * - `n 1` : 選んだスレッド（引継ぎ元）の AI に引継ぎ書を書かせ、今のスレッド（引継ぎ先）に設定する
 *
 * 引継ぎ書は `<projectPath>/doc/handover/` に置く（Agent 側 `handover-store.ts` が書く）。
 * ファイル名は `<YYYYMMDD_HHmmss>_<元スレッドID>[_<新スレッドID>].md`（全桁 ID、要約は入れない）。
 *
 * 外部 import ゼロ（DB・WS に依存しない）にしてテストしやすくしている。
 */

/** 一覧に出す引継ぎ元候補の最大件数 */
export const HANDOVER_CANDIDATE_MAX = 9;

/** 引継ぎ書を書かせる裏ターンのタイムアウト（5 分） */
export const HANDOVER_TURN_TIMEOUT_MS = 5 * 60 * 1000;

/** `server:handover:apply` の応答待ちタイムアウト */
export const HANDOVER_APPLY_TIMEOUT_MS = 30 * 1000;

/**
 * キルスイッチ `DEVRELAY_THREAD_HANDOVER`（既定 `1`）。`0` のときだけ無効。
 * 無効時は `n` / `n 1` を従来どおり AI へのプロンプトとして扱う。
 */
export function isThreadHandoverEnabled(raw: string | undefined): boolean {
  return (raw ?? '1').trim() !== '0';
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 引継ぎ書の作成日時スタンプ（ローカル時刻 `YYYYMMDD_HHmmss`） */
export function buildHandoverStamp(date: Date): string {
  return (
    `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}_` +
    `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
  );
}

/** スタンプの形式検証（Agent に渡す前の二重防御） */
export function isValidHandoverStamp(stamp: string): boolean {
  return /^\d{8}_\d{6}$/.test(stamp);
}

/** `Date` → 表示用 `YYYY-MM-DD HH:mm`（ローカル時刻） */
export function formatHandoverDateTime(date: Date): string {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  );
}

/** 未使用 / 使用中のファイル名 */
export function buildHandoverFileName(stamp: string, sourceSessionId: string, targetSessionId?: string): string {
  return targetSessionId
    ? `${stamp}_${sourceSessionId}_${targetSessionId}.md`
    : `${stamp}_${sourceSessionId}.md`;
}

/** 一覧の材料（DB の Session 行から必要なものだけ） */
export interface HandoverThreadRow {
  id: string;
  title: string | null;
  lastActiveAt: Date | null;
  startedAt: Date;
  messageCount: number;
  firstUserMessage?: string | null;
}

/**
 * 引継ぎ元候補を選ぶ: 今のスレッドとメッセージ 0 件のスレッドを除き、新しい順に最大 `max` 件。
 */
export function selectHandoverCandidates(
  rows: HandoverThreadRow[],
  currentSessionId: string,
  max: number = HANDOVER_CANDIDATE_MAX,
): HandoverThreadRow[] {
  return rows
    .filter((r) => r.id !== currentSessionId && r.messageCount > 0)
    .sort((a, b) => (b.lastActiveAt ?? b.startedAt).getTime() - (a.lastActiveAt ?? a.startedAt).getTime())
    .slice(0, max);
}

/** 一覧表示用のスレッド名（title → 先頭ユーザー発言 → ID の順で代替、最大 40 文字） */
export function handoverThreadLabel(row: { id: string; title: string | null; firstUserMessage?: string | null }): string {
  const raw = (row.title?.trim() || row.firstUserMessage?.replace(/\s+/g, ' ').trim() || row.id).trim();
  const chars = Array.from(raw);
  return chars.length > 40 ? chars.slice(0, 40).join('') + '…' : raw;
}

/**
 * 保存済みの引継ぎ書を使い回せるか。
 * 元スレッドで引継ぎ書作成以降に会話（Message）が増えていなければ使い回す（AI は呼ばない）。
 */
export function canReuseHandoverDoc(input: {
  handoverDoc: string | null;
  handoverDocAt: Date | null;
  lastMessageAt: Date | null;
}): boolean {
  if (!input.handoverDoc || !input.handoverDocAt) return false;
  if (!input.lastMessageAt) return true;
  return input.lastMessageAt.getTime() <= input.handoverDocAt.getTime();
}

/**
 * AI の出力から引継ぎ書の本文を取り出して整える。
 * - 進捗ノイズ除去済みのテキストを受け取る想定（呼び出し側で `sanitizeAiAnswer` 済み）
 * - 最初の `# ` 見出しより前の前置き（「以下が引継ぎ書です」等）を落とす
 * - 1 行目の `# タイトル` の直後にメタ行（元スレッド・作成日時・AI ツール）を差し込む
 * - 見出しが無ければ既定タイトルを付ける
 *
 * @returns 整形済み Markdown。本文が空なら null
 */
export function buildHandoverDocument(
  aiOutput: string,
  meta: { sourceSessionId: string; createdAt: Date; aiTool: string; defaultTitle: string },
): string | null {
  const text = aiOutput.replace(/\r\n/g, '\n').trim();
  if (!text) return null;

  const lines = text.split('\n');
  const headingIndex = lines.findIndex((l) => /^#\s+\S/.test(l));
  let title: string;
  let bodyLines: string[];
  if (headingIndex >= 0) {
    title = lines[headingIndex].replace(/^#\s+/, '').trim();
    bodyLines = lines.slice(headingIndex + 1);
  } else {
    title = meta.defaultTitle;
    bodyLines = lines;
  }
  const body = bodyLines.join('\n').trim();
  if (!body) return null;

  const metaLine =
    `- 元スレッド: ${meta.sourceSessionId} / 作成: ${formatHandoverDateTime(meta.createdAt)} / AI: ${meta.aiTool}`;
  return `# ${title}\n${metaLine}\n\n${body}\n`;
}

/** 引継ぎ書のタイトル（1 行目の `# ` 見出し）。無ければ null */
export function extractHandoverTitle(doc: string | null | undefined): string | null {
  if (!doc) return null;
  const first = doc.split('\n').find((l) => /^#\s+\S/.test(l));
  return first ? first.replace(/^#\s+/, '').trim() : null;
}

/** 完了メッセージに添えるプレビュー（見出し・メタ行を除いた先頭 `maxLines` 行） */
export function buildHandoverPreview(doc: string, maxLines: number = 6): string {
  const lines = doc.split('\n').filter((l, i) => !(i === 0 && /^#\s/.test(l)) && !/^- 元スレッド: /.test(l));
  const nonEmpty = lines.filter((l) => l.trim() !== '');
  const head = nonEmpty.slice(0, maxLines);
  return head.map((l) => `> ${l}`).join('\n') + (nonEmpty.length > maxLines ? '\n> …' : '');
}
