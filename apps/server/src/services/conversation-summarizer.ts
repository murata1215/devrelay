/**
 * 会話活動 AI 要約サービス（統制 v3 #270）
 *
 * 組織の admin/manager が配下メンバーの開発セッションを俯瞰できるよう、
 * セッション内の会話（user/ai メッセージ）を AI で要約し
 * 「この人はこの時、こんな事をしていた」を 2-3 文にまとめる。
 *
 * マルチプロバイダー対応: OpenAI (gpt-4o-mini) / Anthropic (Claude Haiku) / Gemini (2.0 Flash)。
 * 要約に使う API キーは**閲覧者（admin/manager）自身**のもの
 * （ORG_SUMMARY_PROVIDER、未設定なら BUILD_SUMMARY_PROVIDER にフォールバック）。
 */

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import type { AiProvider } from '@devrelay/shared';
import { getApiKeyForOrgSummary } from './user-settings.js';

/** 要約用システムプロンプト */
const SUMMARY_SYSTEM_PROMPT = `あなたはソフトウェア開発チームの活動を管理者向けに要約するアシスタントです。
1つの開発セッション（ユーザーの指示と AI の応答のやりとり）を読み、そのメンバーが「いつ・何をしていたか」を日本語で簡潔に要約してください。

要件:
- 2-3文で簡潔に（最大250文字）
- そのセッションで何に取り組んだか（実装/修正/調査した機能・内容、対象ファイルや技術）を含める
- 管理者が一覧で活動を把握できるよう、事実ベースで客観的に記述する
- 「〜しました」調で、対象メンバーの作業内容として記述する
- 冗長な前置きや推測は避ける。内容が乏しく判断できない場合は「短いやりとりのみで、具体的な作業内容は不明」と返す

出力例:
- "決済 API のエラーハンドリングを調査し、タイムアウト時のリトライ処理を stripe-service.ts に追加しました。あわせてテストケースを2件追加しています。"
- "ログイン画面の UI について相談し、パスワードリセットのリンク配置を変更しました。"
- "短いやりとりのみで、具体的な作業内容は不明。"`;

/** 会話全体の最大長（トークン節約のため切り詰め） */
const MAX_CONVERSATION_LENGTH = 8000;

/** 要約テキストの最大長 */
const MAX_SUMMARY_LENGTH = 250;

/** 要約対象セッションのメタ情報 */
export interface SessionMetaForSummary {
  projectName: string;
  machineName: string;
  startedAt: Date;
  endedAt: Date | null;
}

/** 要約対象の会話メッセージ */
export interface MessageForSummary {
  role: string; // 'user' | 'ai' | 'system'
  content: string;
  createdAt: Date;
}

/**
 * ユーザーメッセージ（AI へ渡すプロンプト本文）を構築する。
 * セッションのメタ情報 + 会話を時系列で並べ、合計長を上限に切り詰める。
 */
function buildUserMessage(meta: SessionMetaForSummary, messages: MessageForSummary[]): string {
  const header =
    `プロジェクト: ${meta.projectName}\n` +
    `マシン: ${meta.machineName}\n` +
    `開始: ${meta.startedAt.toISOString()}\n` +
    `終了: ${meta.endedAt ? meta.endedAt.toISOString() : '（継続中）'}\n\n` +
    `--- 会話 ---\n`;

  // system メッセージは要約に不要なため除外
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const speaker = m.role === 'user' ? 'ユーザー' : 'AI';
    lines.push(`[${speaker}] ${m.content}`);
  }
  let body = lines.join('\n');

  // 全体を上限で切り詰め（先頭を優先して残す）
  const budget = MAX_CONVERSATION_LENGTH - header.length;
  if (body.length > budget) {
    body = body.substring(0, Math.max(0, budget)) + '\n\n[...truncated...]';
  }
  return header + body;
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

/** OpenAI (gpt-4o-mini) で要約を生成 */
async function summarizeWithOpenAI(apiKey: string, userMessage: string): Promise<string | null> {
  const openai = new OpenAI({ apiKey });
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.2,
    max_tokens: 320,
  });
  return normalizeSummary(response.choices[0]?.message?.content);
}

/** Anthropic (Claude Haiku) で要約を生成 */
async function summarizeWithAnthropic(apiKey: string, userMessage: string): Promise<string | null> {
  const anthropic = new Anthropic({ apiKey });
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 320,
    system: SUMMARY_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });
  const textBlock = response.content.find((block) => block.type === 'text');
  return normalizeSummary(textBlock && 'text' in textBlock ? textBlock.text : null);
}

/** Gemini (2.0 Flash) で要約を生成 */
async function summarizeWithGemini(apiKey: string, userMessage: string): Promise<string | null> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash',
    generationConfig: { maxOutputTokens: 320, temperature: 0.2 },
  });
  const prompt = `${SUMMARY_SYSTEM_PROMPT}\n\n${userMessage}`;
  const result = await model.generateContent(prompt);
  return normalizeSummary(result.response.text());
}

/** プロバイダー別の要約関数マッピング */
const SUMMARIZER_MAP: Record<string, (apiKey: string, userMessage: string) => Promise<string | null>> = {
  openai: summarizeWithOpenAI,
  anthropic: summarizeWithAnthropic,
  gemini: summarizeWithGemini,
};

/** 要約結果（キー未設定などの理由も呼び出し側に伝える） */
export interface SummarizeResult {
  summary: string | null;
  /** キー未設定・プロバイダー none の場合 true（呼び出し側で設定を促すため） */
  notConfigured?: boolean;
}

/**
 * 1 セッションの会話を AI で要約する。
 *
 * @param viewerUserId 閲覧者（admin/manager）の User.id。この人のキー・設定を使う
 * @param meta セッションのメタ情報
 * @param messages セッション内の会話（時系列）
 * @returns 要約テキスト。設定がない場合は notConfigured=true
 */
export async function summarizeSessionActivity(
  viewerUserId: string,
  meta: SessionMetaForSummary,
  messages: MessageForSummary[],
): Promise<SummarizeResult> {
  const config = await getApiKeyForOrgSummary(viewerUserId);
  if (!config) {
    return { summary: null, notConfigured: true };
  }

  const provider: AiProvider = config.provider;
  const summarizer = SUMMARIZER_MAP[provider];
  if (!summarizer) {
    return { summary: null, notConfigured: true };
  }

  try {
    const userMessage = buildUserMessage(meta, messages);
    const summary = await summarizer(config.apiKey, userMessage);
    return { summary };
  } catch (error) {
    console.error(`❌ Conversation summary failed (${provider}):`, error);
    return { summary: null };
  }
}
