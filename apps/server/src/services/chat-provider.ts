/**
 * マルチプロバイダー Chat インターフェース
 *
 * マルチターン会話 + JSON 構造化出力をプロバイダー非依存で提供する。
 * Voice Assist（音声会話モード）を始め、将来のマルチターン AI 機能に汎用利用可能。
 *
 * 各プロバイダーの JSON 出力強制方法の差異を吸収:
 *   - OpenAI: response_format: { type: "json_object" }
 *   - Anthropic: system プロンプトで JSON 指示 + assistant プレフィル "{"
 *   - Gemini: generationConfig.responseMimeType: "application/json"
 */

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import type { AiProvider } from '@devrelay/shared';
import { getApiKeyForProvider } from './user-settings.js';

/** Chat パラメータ */
export interface ChatParams {
  /** システムプロンプト */
  system: string;
  /** 会話履歴（マルチターン） */
  messages: { role: 'user' | 'assistant'; content: string }[];
  /** true: JSON 厳格出力を強制 */
  jsonMode: boolean;
  /** 最大出力トークン数 */
  maxTokens?: number;
  /** 温度（0.0-1.0） */
  temperature?: number;
}

/** Chat レスポンス */
export interface ChatResult {
  /** AI の応答テキスト（jsonMode 時は JSON 文字列） */
  text: string;
  /** トークン使用量 */
  usage?: { input: number; output: number };
}

/** ChatProvider インターフェース */
export interface ChatProvider {
  chat(params: ChatParams): Promise<ChatResult>;
}

// ============================================================
// OpenAI 実装
// ============================================================

class OpenAIChatProvider implements ChatProvider {
  constructor(private apiKey: string, private model = 'gpt-4o-mini') {}

  async chat(params: ChatParams): Promise<ChatResult> {
    const openai = new OpenAI({ apiKey: this.apiKey });
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: params.system },
      ...params.messages.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    ];

    const response = await openai.chat.completions.create({
      model: this.model,
      messages,
      response_format: params.jsonMode ? { type: 'json_object' as const } : undefined,
      max_tokens: params.maxTokens ?? 1024,
      temperature: params.temperature ?? 0.3,
    });

    const text = response.choices[0]?.message?.content ?? '';
    return {
      text,
      usage: response.usage ? {
        input: response.usage.prompt_tokens,
        output: response.usage.completion_tokens,
      } : undefined,
    };
  }
}

// ============================================================
// Anthropic 実装
// ============================================================

class AnthropicChatProvider implements ChatProvider {
  constructor(private apiKey: string, private model = 'claude-haiku-4-5-20251001') {}

  async chat(params: ChatParams): Promise<ChatResult> {
    const anthropic = new Anthropic({ apiKey: this.apiKey });

    // JSON モード: system に JSON 指示を追加
    const system = params.jsonMode
      ? params.system + '\n\nRespond with valid JSON only. No markdown, no extra text.'
      : params.system;

    // Anthropic の messages 形式に変換
    const messages: Anthropic.MessageParam[] = params.messages.map(m => ({
      role: m.role,
      content: m.content,
    }));

    // JSON モード時は assistant プレフィル "{" で JSON 開始を固定
    if (params.jsonMode) {
      messages.push({ role: 'assistant', content: '{' });
    }

    const response = await anthropic.messages.create({
      model: this.model,
      max_tokens: params.maxTokens ?? 1024,
      system,
      messages,
      temperature: params.temperature ?? 0.3,
    });

    const textBlock = response.content.find(b => b.type === 'text');
    let text = textBlock && 'text' in textBlock ? textBlock.text : '';

    // プレフィル分の "{" を復元
    if (params.jsonMode && text && !text.startsWith('{')) {
      text = '{' + text;
    }

    return {
      text,
      usage: response.usage ? {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
      } : undefined,
    };
  }
}

// ============================================================
// Gemini 実装
// ============================================================

class GeminiChatProvider implements ChatProvider {
  constructor(private apiKey: string, private model = 'gemini-2.0-flash') {}

  async chat(params: ChatParams): Promise<ChatResult> {
    const genAI = new GoogleGenerativeAI(this.apiKey);
    const generationConfig: Record<string, unknown> = {
      maxOutputTokens: params.maxTokens ?? 1024,
      temperature: params.temperature ?? 0.3,
    };
    if (params.jsonMode) {
      generationConfig.responseMimeType = 'application/json';
    }

    const model = genAI.getGenerativeModel({
      model: this.model,
      systemInstruction: params.system,
      generationConfig,
    });

    // Gemini は role: "model"（"assistant" → "model" 変換）
    const history = params.messages.slice(0, -1).map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const chat = model.startChat({ history });
    const lastMessage = params.messages[params.messages.length - 1];
    const result = await chat.sendMessage(lastMessage?.content ?? '');
    const text = result.response.text();

    return {
      text,
      usage: result.response.usageMetadata ? {
        input: result.response.usageMetadata.promptTokenCount ?? 0,
        output: result.response.usageMetadata.candidatesTokenCount ?? 0,
      } : undefined,
    };
  }
}

// ============================================================
// ファクトリ
// ============================================================

/**
 * ユーザー設定に基づいて ChatProvider を生成する
 *
 * @param userId ユーザー ID
 * @param settingKey UserSettings のプロバイダーキー（例: 'voice_assist_provider'）
 * @returns ChatProvider インスタンス。API キー未設定の場合は null
 */
export async function resolveChatProvider(
  userId: string,
  provider: AiProvider,
  apiKey: string,
): Promise<ChatProvider> {
  switch (provider) {
    case 'openai':
      return new OpenAIChatProvider(apiKey);
    case 'anthropic':
      return new AnthropicChatProvider(apiKey);
    case 'gemini':
      return new GeminiChatProvider(apiKey);
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}
