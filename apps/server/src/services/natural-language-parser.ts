/**
 * 自然言語コマンドパーサー
 *
 * AI API を使ってユーザーの自然言語入力をコマンドに変換
 * マルチプロバイダー対応: OpenAI / Anthropic / Gemini
 * ユーザーの CHAT_AI_PROVIDER 設定に基づいてプロバイダーを選択する
 */

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import type { AiProvider } from '@devrelay/shared';
import { getApiKeyForChatAi } from './user-settings.js';

// パース結果の型定義
export interface ParsedCommand {
  type: 'message' | 'select_project' | 'select_option' | 'continue' | 'clear' | 'quit' | 'help' | 'unknown';
  message?: string;          // type: 'message' の場合のメッセージ内容
  projectName?: string;      // type: 'select_project' の場合のプロジェクト名
  optionNumber?: number;     // type: 'select_option' の場合の選択番号
  originalInput: string;     // 元の入力
  confidence: number;        // 解釈の信頼度 (0-1)
}

// システムプロンプト
const SYSTEM_PROMPT = `あなたはDevRelayというAI開発支援ツールのコマンドパーサーです。
ユーザーの自然言語入力を解析し、適切なコマンドに変換してください。

利用可能なコマンド:
- message: AIにメッセージを送信する（開発タスク、質問、依頼など）
- select_project: プロジェクトを選択する
- select_option: 番号で選択肢を選ぶ
- continue: 前回のプロジェクトに再接続
- clear: 会話履歴をクリア
- quit: セッションを終了
- help: ヘルプを表示

JSON形式で回答してください:
{
  "type": "message" | "select_project" | "select_option" | "continue" | "clear" | "quit" | "help" | "unknown",
  "message": "AIに送るメッセージ（type: messageの場合）",
  "projectName": "プロジェクト名（type: select_projectの場合）",
  "optionNumber": 数字（type: select_optionの場合）,
  "confidence": 0.0〜1.0の信頼度
}

例:
- "バグを直して" → {"type": "message", "message": "バグを直して", "confidence": 0.95}
- "AnimeChaosMapに接続" → {"type": "select_project", "projectName": "AnimeChaosMap", "confidence": 0.9}
- "1番を選んで" → {"type": "select_option", "optionNumber": 1, "confidence": 0.95}
- "前回の続き" → {"type": "continue", "confidence": 0.9}
- "履歴クリア" → {"type": "clear", "confidence": 0.95}
- "終了" → {"type": "quit", "confidence": 0.9}
- "ヘルプ" → {"type": "help", "confidence": 0.95}

注意:
- 開発に関する具体的な指示（「〜を実装して」「〜を修正して」など）はすべて message タイプ
- プロジェクト名が明示されている場合は select_project
- 数字だけの入力は select_option
- 曖昧な場合は confidence を低くして message として処理`;

/**
 * unknown 結果を返すヘルパー
 */
function unknownResult(input: string): ParsedCommand {
  return { type: 'unknown', originalInput: input, confidence: 0 };
}

/**
 * コンテキスト情報の文字列を構築
 */
function buildContextInfo(context?: {
  currentSession?: boolean;
  availableProjects?: string[];
  pendingSelection?: boolean;
}): string {
  if (!context) return '';
  let info = '';
  if (context.currentSession) {
    info += '\n現在セッション中です（AIに接続済み）。';
  } else {
    info += '\n現在セッション外です（まだAIに接続していません）。';
  }
  if (context.availableProjects && context.availableProjects.length > 0) {
    info += `\n利用可能なプロジェクト: ${context.availableProjects.join(', ')}`;
  }
  if (context.pendingSelection) {
    info += '\n選択肢を待っている状態です。数字での選択が期待されています。';
  }
  return info;
}

/**
 * JSON レスポンスをパースして ParsedCommand に変換
 */
function parseJsonResponse(content: string, input: string): ParsedCommand {
  // JSON ブロックが ```json ... ``` で囲まれている場合に対応
  let jsonStr = content.trim();
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

  const parsed = JSON.parse(jsonStr);
  return {
    type: parsed.type || 'unknown',
    message: parsed.message,
    projectName: parsed.projectName,
    optionNumber: parsed.optionNumber,
    originalInput: input,
    confidence: parsed.confidence || 0.5,
  };
}

/**
 * OpenAI (gpt-4o-mini) でコマンドをパース
 */
async function parseWithOpenAI(
  apiKey: string,
  input: string,
  contextInfo: string,
): Promise<ParsedCommand> {
  const openai = new OpenAI({ apiKey });
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT + contextInfo },
      { role: 'user', content: input },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.1,
    max_tokens: 256,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error('Empty response from OpenAI');
  return parseJsonResponse(content, input);
}

/**
 * Anthropic (Claude Haiku) でコマンドをパース
 * Anthropic にはネイティブ JSON モードがないため、システムプロンプトで JSON 出力を指示
 */
async function parseWithAnthropic(
  apiKey: string,
  input: string,
  contextInfo: string,
): Promise<ParsedCommand> {
  const anthropic = new Anthropic({ apiKey });
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    system: SYSTEM_PROMPT + contextInfo + '\n\n必ず JSON のみを返してください。他のテキストは含めないでください。',
    messages: [{ role: 'user', content: input }],
  });

  const textBlock = response.content.find((block) => block.type === 'text');
  const content = textBlock && 'text' in textBlock ? textBlock.text : null;
  if (!content) throw new Error('Empty response from Anthropic');
  return parseJsonResponse(content, input);
}

/**
 * Gemini (2.0 Flash) でコマンドをパース
 * responseMimeType: 'application/json' で JSON 出力を強制
 */
async function parseWithGemini(
  apiKey: string,
  input: string,
  contextInfo: string,
): Promise<ParsedCommand> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash',
    generationConfig: {
      responseMimeType: 'application/json',
      maxOutputTokens: 256,
      temperature: 0.1,
    },
  });

  const prompt = `${SYSTEM_PROMPT}${contextInfo}\n\nユーザー入力: ${input}`;
  const result = await model.generateContent(prompt);
  const content = result.response.text();
  if (!content) throw new Error('Empty response from Gemini');
  return parseJsonResponse(content, input);
}

/** プロバイダー別のパース関数マッピング */
const PARSER_MAP: Record<string, (apiKey: string, input: string, contextInfo: string) => Promise<ParsedCommand>> = {
  openai: parseWithOpenAI,
  anthropic: parseWithAnthropic,
  gemini: parseWithGemini,
};

/**
 * 自然言語入力をコマンドに変換
 *
 * ユーザーの CHAT_AI_PROVIDER 設定に基づいてプロバイダーを選択。
 * 未設定の場合は後方互換のため OpenAI キーがあれば OpenAI を使用。
 */
export async function parseNaturalLanguage(
  userId: string,
  input: string,
  context?: {
    currentSession?: boolean;     // セッション中かどうか
    availableProjects?: string[]; // 利用可能なプロジェクト一覧
    pendingSelection?: boolean;   // 選択待ちかどうか
  }
): Promise<ParsedCommand> {
  // Chat AI 用のプロバイダーと API キーを取得
  const config = await getApiKeyForChatAi(userId);
  if (!config) {
    console.log('🧠 NLP: No API key available, skipping');
    return unknownResult(input);
  }

  const { provider, apiKey } = config;
  const parser = PARSER_MAP[provider];
  if (!parser) {
    console.log(`🧠 NLP: Unknown provider "${provider}", skipping`);
    return unknownResult(input);
  }

  console.log(`🧠 NLP: Parsing "${input}" with ${provider}`);

  try {
    const contextInfo = buildContextInfo(context);
    const result = await parser(apiKey, input, contextInfo);
    console.log(`🧠 NLP: Result: ${JSON.stringify(result)}`);
    return result;
  } catch (error) {
    console.error(`Natural language parsing failed (${provider}):`, error);
    return unknownResult(input);
  }
}

/**
 * 従来のコマンド形式かどうかをチェック
 */
export function isTraditionalCommand(input: string): boolean {
  const trimmed = input.trim().toLowerCase();

// 単一文字コマンド (s=status, r=recent も含む)
  if (/^[mpqhcxeaosrwb]$/i.test(trimmed)) return true;

  // m から始まるメッセージ
  if (/^m\s+/i.test(trimmed)) return true;

  // 数字のみ
  if (/^\d+$/.test(trimmed)) return true;

  // 「e, 〜」「exec, 〜」パターン（カンマ付きプロンプト）
  if (/^(?:e|exec)\s*,\s*.+/i.test(trimmed)) return true;

  // その他のコマンド: exec, link, agreement, log, sum, storage
  if (/^(exec|link|agreement|build|log\d*|sum\d*d?|storage(\s+(list|(get|delete)\s+.+))?)$/i.test(trimmed)) return true;

  return false;
}

/**
 * ParsedCommand を従来のコマンド形式に変換
 */
export function toTraditionalCommand(parsed: ParsedCommand): string | null {
  switch (parsed.type) {
    case 'message':
      return parsed.message ? `m ${parsed.message}` : null;
    case 'select_project':
      return 'p'; // プロジェクト選択メニューを表示
    case 'select_option':
      return parsed.optionNumber?.toString() || null;
    case 'continue':
      return 'c';
    case 'clear':
      return 'x';
    case 'quit':
      return 'q';
    case 'help':
      return 'h';
    default:
      return null;
  }
}
