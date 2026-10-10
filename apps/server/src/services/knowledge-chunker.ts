/**
 * 高辻ナレッジ サイクル1: 会話ターン（AI 応答＋直前の人間入力）から
 * `KnowledgeChunk.textContent` に保存するチャンク本文を作る純関数モジュール。
 *
 * `progress-markers.ts`（同じく外部 import ゼロの純関数モジュール）だけを import する。
 * `thread-clear-guard.ts` が `thread-scope.ts` を import しているのと同じ範囲に収める
 * （DB/ネットワーク非依存を保ち、`node --test` から dist を直接 import して単体検証できるようにする）。
 *
 * チャンク化の方針（高辻ナレッジ サイクル1 指示書 §3.3）:
 * 1. AI 本文から進捗ノイズ（🔧 使用中... / 📊 Rate Limit / ⏳ 心拍表示）を除去する
 * 2. 除去後が 20 文字未満なら対象外（空応答・エラーのみ）
 * 3. 各チャンクの先頭に「プロジェクト名・スレッド名・指示/質問・回答」の固定ヘッダを付ける
 * 4. AI 本文を行境界で 4,500 文字以下の窓に分割する（1 行が窓を超える場合は文字数で強制分割）
 * 5. 各窓にヘッダを前置して 1 チャンクとする
 */

import { stripAiProgressNoise } from './progress-markers.js';

/** `KnowledgeChunk.sourceType` の値（会話ターン）。将来 'document' 等を追加する想定。 */
export const KNOWLEDGE_SOURCE_TYPE_TURN = 'turn';

/** 進捗ノイズ除去後の AI 本文がこの文字数未満なら対象外（空応答・エラーのみ）とする */
const MIN_AI_BODY_LENGTH = 20;

/** ヘッダの【指示/質問】行に載せる user 本文の最大文字数 */
const USER_EXCERPT_LENGTH = 1000;

/** ヘッダ全体（プロジェクト名・スレッド名・指示/質問・【回答】ラベル込み）の最大文字数 */
const HEADER_MAX_LENGTH = 1200;

/** ヘッダに載せる projectName / threadTitle の最大文字数（暴走防止の安全弁） */
const PROJECT_NAME_MAX_LENGTH = 100;
const THREAD_TITLE_MAX_LENGTH = 200;

/** AI 本文を分割する窓サイズ（行境界で分割。オーバーラップ無し） */
const BODY_WINDOW_LENGTH = 4500;

/** 1 チャンク（ヘッダ + 本文窓 + 結合の改行 1 文字）の最大文字数の目安（4500+1200+1 <= 6000） */
export const MAX_CHUNK_LENGTH = 6000;

/** `buildTurnChunks` の入力。 */
export interface BuildTurnChunksInput {
  /** プロジェクト表示名（`project.displayName ?? project.name`） */
  projectName: string;
  /** スレッドタイトル（`Session.title`、未設定なら null） */
  threadTitle: string | null;
  /** 対になった直前の user メッセージ本文（見つからなければ null） */
  userContent: string | null;
  /** AI メッセージ本文（`Message.content`。進捗ノイズ除去前） */
  aiContent: string;
}

/** 上位サロゲート（サロゲートペアの1文字目）か。`content-truncate.ts` と同じ判定（外部 import せず複製）。 */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** 文字数で先頭から切り詰める（行境界は見ない単純カット。ヘッダの各フィールド用）。 */
function truncateSimple(text: string, maxLength: number): string {
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

/**
 * チャンク先頭に付ける固定ヘッダを作る。
 *
 * ヘッダ全体が `HEADER_MAX_LENGTH` を超える場合は、`【回答】` 行を残したまま
 * `【指示/質問】` の本文側だけを削って収める（スニペット生成が `【回答】` の存在に
 * 依存するため、末尾の `【回答】` 行を削ることはしない）。
 */
export function buildTurnHeader(input: {
  projectName: string;
  threadTitle: string | null;
  userContent: string | null;
}): string {
  const projectName = truncateSimple(input.projectName ?? '', PROJECT_NAME_MAX_LENGTH);
  const threadTitle = truncateSimple(input.threadTitle ?? '', THREAD_TITLE_MAX_LENGTH);
  const userExcerptFull = truncateSimple(input.userContent ?? '', USER_EXCERPT_LENGTH);

  const line1 = `【プロジェクト】${projectName}`;
  const line2 = `【スレッド】${threadTitle}`;
  const line4 = '【回答】';
  const label3 = '【指示/質問】';

  // 【指示/質問】行に残せる文字数の予算を計算し、超えていれば userExcerpt をさらに削る。
  // （+3 は行間の改行 3 本）
  const fixedLength = line1.length + line2.length + label3.length + line4.length + 3;
  const budget = Math.max(0, HEADER_MAX_LENGTH - fixedLength);
  const userExcerpt = userExcerptFull.length > budget ? userExcerptFull.slice(0, budget) : userExcerptFull;

  return [line1, line2, `${label3}${userExcerpt}`, line4].join('\n');
}

/**
 * テキストを行境界で非オーバーラップに分割する。1 行自体が `windowSize` を超える場合は
 * その行を文字数で強制分割する（サロゲートペアは割らない）。
 *
 * @param text 分割対象テキスト
 * @param windowSize 1 窓あたりの最大文字数
 * @returns 窓（文字列）の配列。`text` が空文字なら `[]`
 */
export function splitOnLineBoundaries(text: string, windowSize: number): string[] {
  if (text.length === 0) return [];

  const lines = text.split('\n');
  const windows: string[] = [];
  let current = '';

  const flush = () => {
    if (current.length > 0) {
      windows.push(current);
      current = '';
    }
  };

  for (const line of lines) {
    if (line.length > windowSize) {
      // 1 行自体が窓を超える → それまでの蓄積を確定し、この行を文字数で強制分割する
      flush();
      let rest = line;
      while (rest.length > windowSize) {
        let cut = windowSize;
        if (isHighSurrogate(rest.charCodeAt(cut - 1))) cut--;
        windows.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      // 残り（windowSize 以下）は次の行との結合判定に乗せる
      current = rest;
      continue;
    }

    const candidateLength = current.length === 0 ? line.length : current.length + 1 + line.length;
    if (candidateLength > windowSize) {
      flush();
      current = line;
    } else {
      current = current.length === 0 ? line : `${current}\n${line}`;
    }
  }
  flush();
  return windows;
}

/**
 * 会話ターン（AI 応答＋直前の人間入力）からチャンク本文の配列を作る。
 *
 * @returns チャンク本文の配列（`chunkIndex` の順）。進捗ノイズ除去後の AI 本文が
 *          `MIN_AI_BODY_LENGTH` 未満なら `[]`（対象外。KnowledgeChunk 行は作らない）
 */
export function buildTurnChunks(input: BuildTurnChunksInput): string[] {
  const cleanedBody = stripAiProgressNoise(input.aiContent ?? '').trim();
  if (cleanedBody.length < MIN_AI_BODY_LENGTH) return [];

  const header = buildTurnHeader({
    projectName: input.projectName,
    threadTitle: input.threadTitle,
    userContent: input.userContent,
  });

  const windows = splitOnLineBoundaries(cleanedBody, BODY_WINDOW_LENGTH);
  return windows.map((window) => `${header}\n${window}`);
}
