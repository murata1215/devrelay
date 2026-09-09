/**
 * BuildLog AI 要約サービス
 *
 * exec 完了時の Claude Code 出力テキストを AI で要約し、
 * 「何を実装/修正したか」を簡潔な1-2文にまとめる。
 *
 * マルチプロバイダー対応: OpenAI (gpt-4o-mini) / Anthropic (Claude Haiku) / Gemini (2.0 Flash)
 * ユーザーの BUILD_SUMMARY_PROVIDER 設定に基づいてプロバイダーを選択する。
 */

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import type { AiProvider } from '@devrelay/shared';
import { UTILITY_MODEL_ANTHROPIC } from '@devrelay/shared';
import { getApiKeyForBuildSummary } from './user-settings.js';
import { truncateOnLineBoundary } from './content-truncate.js';
import { stripProgressMarkers } from './progress-markers.js';

/** 要約用システムプロンプト */
const SUMMARY_SYSTEM_PROMPT = `あなたはソフトウェア開発のビルドログ要約アシスタントです。
Claude Code（AI コーディングツール）の実行結果を読み、「何を実装/修正したか」を日本語で簡潔に要約してください。

要件:
- 1-2文で簡潔に（最大200文字）
- 主要な変更内容（何を追加/修正/削除したか）を含む
- 変更したファイル名や技術的な変更点があれば含む
- 「プランに従って実装を開始します」「まず〇〇を修正します」のような冗長な前置きは除外
- 結果が不明確な場合は「不明」と返す

出力例:
- "agent-manager.ts に BuildLog の AI 要約機能を追加。gpt-4o-mini で exec 完了後の出力を要約して summary フィールドに保存する"
- "MachinesPage.tsx のテーブル表示を名前順ソートに変更し、モバイル向けカードレイアウトを追加"
- "WebSocket 再接続時の Race Condition を修正。stale 接続の判定ロジックを handleAgentDisconnect に追加"`;

/** 出力テキストの最大長（トークン節約のため切り詰め） */
export const MAX_OUTPUT_LENGTH = 8000;

/**
 * head+tail 分割時に先頭へ割り当てる文字数。
 * 残り（MAX_OUTPUT_LENGTH - OUTPUT_HEAD_LENGTH = 6000）は末尾に割り当てる。
 * 完了報告は末尾に来ることが多いため、末尾側を手厚く残す非対称配分にしている
 * （2026-09-09 調査サイクル: 「不明」の真因＝先頭 8000 文字のみ残す head 切りが
 * 完了報告を丸ごと捨てていたことへの対処）。
 */
export const OUTPUT_HEAD_LENGTH = 2000;

/** head+tail 分割時に末尾へ割り当てる文字数 */
export const OUTPUT_TAIL_LENGTH = MAX_OUTPUT_LENGTH - OUTPUT_HEAD_LENGTH;

/** 要約テキストの最大長 */
export const MAX_SUMMARY_LENGTH = 200;

/**
 * AI が「結果が不明確」と回答した際に返す定型文の集合（検疫対象）。
 * trim 後の完全一致・大小無視で判定する。
 * 2026-09-09 調査サイクル: この文字列がそのまま DB に保存され `get_build_status.summary`
 * へ透過していた事象（#849 等）への対処。null を返すことで呼び出し元
 * （`updateBuildLogSummaryAsync` の `if (aiSummary)` ガード）が
 * より有用なフォールバック要約を上書きしないようにする。
 */
const UNKNOWN_SUMMARY_VALUES = new Set(['不明', '「不明」', 'unknown']);

/**
 * ユーザーメッセージを構築
 * exec プロンプト（あれば）と実行結果テキストを組み合わせる
 *
 * 出力テキストはまず進捗マーカー行（`🔧 Editを使用中...` 等）を除去し、
 * それでも MAX_OUTPUT_LENGTH を超える場合は先頭 OUTPUT_HEAD_LENGTH 文字と
 * 末尾 OUTPUT_TAIL_LENGTH 文字を行境界で安全に切り出して連結する
 * （head のみだと末尾にある完了報告が構造的に失われるため）。
 *
 * export: `apps/server/tests/build-summarizer.test.mjs` から `node --test` で直接検証するため
 * （このモジュール自体は openai/anthropic/google-generative-ai を import するが、いずれも
 * モジュール読み込み時に副作用は無い＝コンストラクタ呼び出しは各 summarizeWithXxx() 内のみ
 * なので dist を直接 import してもネットワークアクセスは発生しない）。
 */
export function buildUserMessage(output: string, execPrompt?: string): string {
  const cleaned = stripProgressMarkers(output);

  let trimmedOutput: string;
  if (cleaned.length > MAX_OUTPUT_LENGTH) {
    const head = truncateOnLineBoundary(cleaned, OUTPUT_HEAD_LENGTH, 'head');
    const tail = truncateOnLineBoundary(cleaned, OUTPUT_TAIL_LENGTH, 'tail');
    trimmedOutput = `${head.content}\n\n[...omitted...]\n\n${tail.content}`;
  } else {
    trimmedOutput = cleaned;
  }

  let message = '';
  if (execPrompt) {
    message += `実行プロンプト: ${execPrompt}\n\n`;
  }
  message += `実行結果:\n${trimmedOutput}`;
  return message;
}

/**
 * 要約テキストを正規化（長さ制限 + トリム + 「不明」検疫）
 *
 * AI が「結果が不明確」の定型文（UNKNOWN_SUMMARY_VALUES）を返した場合は null を返す。
 * これにより呼び出し元は「AI 要約が得られなかった」ケースと同様にフォールバック
 * （extractBuildSummary の末尾抜粋）を維持できる。
 *
 * export: buildUserMessage 同様、テストから直接呼べるようにするため。
 */
export function normalizeSummary(summary: string | null | undefined): string | null {
  if (!summary || summary.trim().length === 0) return null;
  const trimmed = summary.trim();
  if (UNKNOWN_SUMMARY_VALUES.has(trimmed.toLowerCase())) {
    return null;
  }
  return trimmed.length > MAX_SUMMARY_LENGTH
    ? trimmed.substring(0, MAX_SUMMARY_LENGTH) + '...'
    : trimmed;
}

/**
 * OpenAI (gpt-4o-mini) で要約を生成
 */
async function summarizeWithOpenAI(apiKey: string, output: string, execPrompt?: string): Promise<string | null> {
  const openai = new OpenAI({ apiKey });
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
      { role: 'user', content: buildUserMessage(output, execPrompt) },
    ],
    temperature: 0.2,
    max_tokens: 256,
  });
  return normalizeSummary(response.choices[0]?.message?.content);
}

/**
 * Anthropic (Claude Haiku) で要約を生成
 */
async function summarizeWithAnthropic(apiKey: string, output: string, execPrompt?: string): Promise<string | null> {
  const anthropic = new Anthropic({ apiKey });
  const response = await anthropic.messages.create({
    model: UTILITY_MODEL_ANTHROPIC,
    max_tokens: 256,
    system: SUMMARY_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserMessage(output, execPrompt) }],
  });
  const textBlock = response.content.find((block) => block.type === 'text');
  return normalizeSummary(textBlock && 'text' in textBlock ? textBlock.text : null);
}

/**
 * Gemini (2.0 Flash) で要約を生成
 */
async function summarizeWithGemini(apiKey: string, output: string, execPrompt?: string): Promise<string | null> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash',
    generationConfig: {
      maxOutputTokens: 256,
      temperature: 0.2,
    },
  });
  const prompt = `${SUMMARY_SYSTEM_PROMPT}\n\n${buildUserMessage(output, execPrompt)}`;
  const result = await model.generateContent(prompt);
  return normalizeSummary(result.response.text());
}

/** プロバイダー別の要約関数マッピング */
const SUMMARIZER_MAP: Record<string, (apiKey: string, output: string, execPrompt?: string) => Promise<string | null>> = {
  openai: summarizeWithOpenAI,
  anthropic: summarizeWithAnthropic,
  gemini: summarizeWithGemini,
};

/**
 * exec 実行結果を AI で要約する
 *
 * ユーザーの BUILD_SUMMARY_PROVIDER 設定に基づいて適切なプロバイダーで要約を生成。
 * プロバイダーが 'none' またはキー未設定の場合は null を返す（フォールバック用）。
 *
 * @param userId ユーザーID（設定取得に使用）
 * @param output Claude Code の出力テキスト
 * @param execPrompt exec 時のカスタムプロンプト（コンテキスト情報として使用）
 * @returns 要約テキスト。生成できない場合は null
 */
export async function summarizeBuildOutput(
  userId: string,
  output: string,
  execPrompt?: string,
): Promise<string | null> {
  // ユーザーのプロバイダー設定と API キーを取得
  const config = await getApiKeyForBuildSummary(userId);
  if (!config) {
    console.log('📋 BuildLog summary: No provider configured, skipping AI summary');
    return null;
  }

  const { provider, apiKey } = config;
  const summarizer = SUMMARIZER_MAP[provider];
  if (!summarizer) {
    console.log(`📋 BuildLog summary: Unknown provider "${provider}", skipping`);
    return null;
  }

  try {
    console.log(`📋 BuildLog summary: Generating with ${provider}...`);
    const summary = await summarizer(apiKey, output, execPrompt);
    if (summary) {
      console.log(`📋 BuildLog summary (${provider}): ${summary}`);
    }
    return summary;
  } catch (error) {
    console.error(`❌ BuildLog AI summary failed (${provider}):`, error);
    return null;
  }
}
