/**
 * 自然言語コマンドパーサー
 *
 * OpenAI API を使ってユーザーの自然言語入力をコマンドに変換
 */

import OpenAI from 'openai';
import { getUserSetting, SettingKeys } from './user-settings.js';

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
 * 自然言語入力をコマンドに変換
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
  // OpenAI API キーを取得（ユーザー設定のみ、環境変数へのフォールバックなし）
  const apiKey = await getUserSetting(userId, SettingKeys.OPENAI_API_KEY);

  if (!apiKey) {
    // API キーがない場合は unknown を返す（従来のコマンドパーサーにフォールバック）
    console.log('🧠 NLP: No API key available, skipping');
    return {
      type: 'unknown',
      originalInput: input,
      confidence: 0,
    };
  }

  console.log(`🧠 NLP: Parsing "${input}" with OpenAI`)

  try {
    const openai = new OpenAI({ apiKey });

    // コンテキスト情報を追加
    let contextInfo = '';
    if (context) {
      if (context.currentSession) {
        contextInfo += '\n現在セッション中です（AIに接続済み）。';
      } else {
        contextInfo += '\n現在セッション外です（まだAIに接続していません）。';
      }
      if (context.availableProjects && context.availableProjects.length > 0) {
        contextInfo += `\n利用可能なプロジェクト: ${context.availableProjects.join(', ')}`;
      }
      if (context.pendingSelection) {
        contextInfo += '\n選択肢を待っている状態です。数字での選択が期待されています。';
      }
    }

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT + contextInfo },
        { role: 'user', content: input },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1, // 低い温度で安定した出力
      max_tokens: 256,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('Empty response from OpenAI');
    }

    const parsed = JSON.parse(content);

    const result = {
      type: parsed.type || 'unknown',
      message: parsed.message,
      projectName: parsed.projectName,
      optionNumber: parsed.optionNumber,
      originalInput: input,
      confidence: parsed.confidence || 0.5,
    };
    console.log(`🧠 NLP: Result: ${JSON.stringify(result)}`);
    return result;
  } catch (error) {
    console.error('Natural language parsing failed:', error);
    // エラー時は unknown を返す
    return {
      type: 'unknown',
      originalInput: input,
      confidence: 0,
    };
  }
}

/**
 * 従来のコマンド形式かどうかをチェック
 */
export function isTraditionalCommand(input: string): boolean {
  const trimmed = input.trim().toLowerCase();

  // 単一文字コマンド
  if (/^[mpqhcxeao]$/i.test(trimmed)) return true;

  // m から始まるメッセージ
  if (/^m\s+/i.test(trimmed)) return true;

  // 数字のみ
  if (/^\d+$/.test(trimmed)) return true;

  // その他のコマンド: exec, link, agreement, log, sum, st, storage, se, session
  if (/^(exec|link|agreement|log\d*|sum\d*d?|st|storage(\s+(list|(get|delete)\s+.+))?|se|session)$/i.test(trimmed)) return true;

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
