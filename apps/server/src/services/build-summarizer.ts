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
import { getApiKeyForBuildSummary } from './user-settings.js';

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
const MAX_OUTPUT_LENGTH = 8000;

/** 要約テキストの最大長 */
const MAX_SUMMARY_LENGTH = 200;

/**
 * ユーザーメッセージを構築
 * exec プロンプト（あれば）と実行結果テキストを組み合わせる
 */
function buildUserMessage(output: string, execPrompt?: string): string {
  const trimmedOutput = output.length > MAX_OUTPUT_LENGTH
    ? output.substring(0, MAX_OUTPUT_LENGTH) + '\n\n[...truncated...]'
    : output;

  let message = '';
  if (execPrompt) {
    message += `実行プロンプト: ${execPrompt}\n\n`;
  }
  message += `実行結果:\n${trimmedOutput}`;
  return message;
}

/**
 * 要約テキストを正規化（長さ制限 + トリム）
 */
function normalizeSummary(summary: string | null | undefined): string | null {
  if (!summary || summary.trim().length === 0) return null;
  const trimmed = summary.trim();
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
    model: 'claude-haiku-4-5-20251001',
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
