/**
 * Voice Assist（音声会話モード）ハンドラ
 *
 * Flutter アプリからの音声発話を受け取り、マルチプロバイダーの AI で
 * 構造化 JSON レスポンスを生成して返す。
 *
 * フロー:
 *   1. ユーザー発話 + 会話履歴 + 下書きを受信
 *   2. ChatProvider で AI に送信（JSON モード）
 *   3. needLookup があれば 2 ホップ目（v1 はスタブ）
 *   4. 構造化レスポンスを返却
 */

import type { VoiceAssistRequestPayload, VoiceAssistResponsePayload } from '@devrelay/shared';
import { getApiKeyForVoiceAssist } from './user-settings.js';
import { resolveChatProvider } from './chat-provider.js';

/** Voice Assist 用のシステムプロンプト */
const VOICE_ASSIST_SYSTEM = `あなたは DevRelay の音声アシスタントです。
開発者がハンズフリーで AI コーディングツールへの指示を組み立てるのを手助けします。

## ルール
1. ユーザーの発話を聞き、プロジェクトへの指示（draft）を組み立てる
2. 曖昧な場合は質問して明確にする
3. 十分に明確になったら ready_to_submit にする
4. spoken は TTS で読み上げるための短い応答（1-2文、日本語）
5. draft は Markdown 形式の指示文（AI コーディングツールに送信される）

## 出力形式（JSON）
{
  "spoken": "TTS用の短い応答（1-2文）",
  "draft": "更新後の下書き全文（Markdown）",
  "questions": ["確認したい質問があれば1つ"],
  "intent": "refining | question | ready_to_submit",
  "targetProject": "推定されたプロジェクト名 or null",
  "needLookup": null
}

## intent の判定基準
- refining: ユーザーが指示を追加・修正している途中
- question: こちらから確認が必要（questions に質問を入れる）
- ready_to_submit: 指示が十分に明確で、送信可能な状態

## 注意
- needLookup は将来の Web 検索用フィールド。v1 では常に null を返す
- spoken は簡潔に。長い説明は draft に書く
- draft が空の場合は新規作成。既存の場合は追記・修正`;

/**
 * Voice Assist リクエストを処理する
 *
 * @param userId 認証済みユーザー ID
 * @param payload クライアントからのリクエスト
 * @returns 構造化レスポンス
 * @throws API キー未設定、AI 応答エラー等
 */
export async function handleVoiceAssist(
  userId: string,
  payload: VoiceAssistRequestPayload,
): Promise<VoiceAssistResponsePayload> {
  // プロバイダーを解決
  const providerInfo = await getApiKeyForVoiceAssist(userId);
  if (!providerInfo) {
    throw new Error('Voice Assist の AI プロバイダーが設定されていません。Settings → AI Provider Settings で設定してください。');
  }

  const chatProvider = await resolveChatProvider(userId, providerInfo.provider, providerInfo.apiKey);

  // 会話履歴を構築（draft がある場合はコンテキストに含める）
  const messages = [...payload.history];
  let userContent = payload.utterance;
  if (payload.draft) {
    userContent = `[現在の下書き]\n${payload.draft}\n\n[ユーザー発話]\n${payload.utterance}`;
  }
  if (payload.targetProjectId) {
    userContent += `\n\n[対象プロジェクト ID: ${payload.targetProjectId}]`;
  }
  messages.push({ role: 'user', content: userContent });

  // 1 ホップ目: AI に送信
  console.log(`🎙️ [voice-assist] (${providerInfo.provider}) processing utterance: "${payload.utterance.slice(0, 50)}..." (history: ${payload.history.length} turns)`);

  const result = await chatProvider.chat({
    system: VOICE_ASSIST_SYSTEM,
    messages,
    jsonMode: true,
    maxTokens: 1024,
    temperature: 0.3,
  });

  // JSON パース（コードブロック wrapper 対応 + 1 回リトライ）
  let parsed: Record<string, unknown>;
  try {
    const jsonStr = result.text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
    parsed = JSON.parse(jsonStr);
  } catch {
    // 1 回リトライ: 「JSON だけで返して」を追加
    console.warn(`⚠️ [voice-assist] JSON parse failed, retrying...`);
    const retryMessages = [...messages, {
      role: 'assistant' as const,
      content: result.text,
    }, {
      role: 'user' as const,
      content: '出力が JSON として不正でした。上記の内容を正しい JSON 形式で再出力してください。',
    }];

    const retryResult = await chatProvider.chat({
      system: VOICE_ASSIST_SYSTEM,
      messages: retryMessages,
      jsonMode: true,
      maxTokens: 1024,
      temperature: 0.1,
    });

    const retryStr = retryResult.text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
    parsed = JSON.parse(retryStr);
  }

  // 監査ログ（v1: console.log のみ）
  const intent = (parsed.intent as string) || 'refining';
  if (intent === 'ready_to_submit') {
    console.log(`📋 [voice-assist] AUDIT: userId=${userId}, provider=${providerInfo.provider}, intent=ready_to_submit, draft=${(parsed.draft as string || '').slice(0, 100)}...`);
  }

  const response: VoiceAssistResponsePayload = {
    sessionId: payload.sessionId,
    spoken: (parsed.spoken as string) || '',
    draft: (parsed.draft as string) || payload.draft || '',
    questions: Array.isArray(parsed.questions) ? parsed.questions as string[] : [],
    intent: intent as VoiceAssistResponsePayload['intent'],
    targetProject: (parsed.targetProject as string) || null,
    lookups: undefined,  // v1: web search は未実装
  };

  console.log(`🎙️ [voice-assist] response: intent=${response.intent}, spoken="${response.spoken.slice(0, 50)}...", draft=${response.draft.length} chars`);

  return response;
}
