/**
 * 開発レポート生成サービス
 *
 * Conversations の会話履歴を AI で分析・要約し、
 * セクション分割された開発記レポートを生成する。
 *
 * マルチプロバイダー対応: OpenAI / Anthropic / Gemini
 * build-summarizer.ts と同じパターンを踏襲。
 */

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import type { AiProvider } from '@devrelay/shared';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/client.js';
import { getApiKeyForDevReport } from './user-settings.js';

// ========================================
// 型定義
// ========================================

/** 会話データ（AI 要約用に整形済み） */
interface ConversationData {
  messageId: string;
  sessionId: string;
  projectName: string;
  userMessage: string;
  aiMessage: string;
  createdAt: string;
  imageFileIds: string[];
}

/** セクション分割結果（AI レスポンス） */
interface DivisionPlan {
  title: string;
  sections: {
    title: string;
    messageIds: string[];
  }[];
}

/** セクション要約結果（AI レスポンス） */
interface SectionSummary {
  summary: string;
  imageRefs: {
    fileId: string;
    caption: string;
  }[];
}

/** レポート content JSON の構造 */
export interface ReportContent {
  title: string;
  projectName: string;
  periodStart: string;
  periodEnd: string;
  sections: {
    title: string;
    summary: string;
    conversations: {
      messageId: string;
      userMessage: string;
      aiMessagePreview: string;
      createdAt: string;
    }[];
    imageRefs: {
      fileId: string;
      filename: string;
      caption: string;
    }[];
  }[];
}

// ========================================
// AI プロンプト
// ========================================

/** セクション分割用システムプロンプト */
const DIVISION_SYSTEM_PROMPT = `あなたはソフトウェア開発のドキュメントアシスタントです。
開発中の会話履歴を、ブログ記事や開発記のセクション（章立て）に分割してください。

要件:
- 関連する作業（同じ機能、同じバグ修正など）をひとつのセクションにまとめる
- 時系列順に並べる
- セクションタイトルは「何を実装/修正したか」が分かる具体的なもの
- 1つの会話が複数セクションにまたがる場合は、最も関連の深いセクションに含める
- レポート全体のタイトルも生成する（日付 + プロジェクト名 + 概要）

必ず以下の JSON 形式で返してください（他のテキストは不要）:
{
  "title": "レポートタイトル",
  "sections": [
    { "title": "セクションタイトル", "messageIds": ["id1", "id2"] }
  ]
}`;

/** セクション要約用システムプロンプト */
const SUMMARY_SYSTEM_PROMPT = `あなたはソフトウェア開発のドキュメントライターです。
開発中の会話履歴を、開発記（開発ブログ）として読みやすくまとめてください。

要件:
- Markdown 形式で記述
- 何を実装/修正したか、どう解決したか、重要なポイントを含める
- 技術的な詳細（変更したファイル、使用した技術）を含む
- 添付画像がある場合は、画像の内容を説明するキャプションを付ける
- 冗長な会話のやり取りは省略し、要点をまとめる
- 日本語で記述

添付画像がある場合は imageRefs に含めてください。

必ず以下の JSON 形式で返してください（他のテキストは不要）:
{
  "summary": "## セクション内容（Markdown）",
  "imageRefs": [
    { "fileId": "ファイルID", "caption": "画像の説明" }
  ]
}`;

// ========================================
// プロバイダー別 AI 呼び出し
// ========================================

/** AI メッセージ用の共通インターフェース */
type AiCaller = (apiKey: string, systemPrompt: string, userMessage: string) => Promise<string>;

/** OpenAI でテキスト生成 */
const callOpenAI: AiCaller = async (apiKey, systemPrompt, userMessage) => {
  const openai = new OpenAI({ apiKey });
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.3,
    max_tokens: 4096,
  });
  return response.choices[0]?.message?.content || '';
};

/** Anthropic でテキスト生成 */
const callAnthropic: AiCaller = async (apiKey, systemPrompt, userMessage) => {
  const anthropic = new Anthropic({ apiKey });
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });
  const textBlock = response.content.find((block) => block.type === 'text');
  return textBlock && 'text' in textBlock ? textBlock.text : '';
};

/** Gemini でテキスト生成 */
const callGemini: AiCaller = async (apiKey, systemPrompt, userMessage) => {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash',
    generationConfig: {
      maxOutputTokens: 4096,
      temperature: 0.3,
    },
  });
  const prompt = `${systemPrompt}\n\n${userMessage}`;
  const result = await model.generateContent(prompt);
  return result.response.text();
};

/** プロバイダー別の呼び出し関数マッピング */
const CALLER_MAP: Record<string, AiCaller> = {
  openai: callOpenAI,
  anthropic: callAnthropic,
  gemini: callGemini,
};

// ========================================
// ユーティリティ
// ========================================

/** AI レスポンスから JSON を抽出 */
function extractJson(text: string): string {
  // ```json ... ``` ブロックから抽出を試みる
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) return codeBlockMatch[1].trim();

  // { ... } で囲まれた部分を抽出
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) return jsonMatch[0];

  return text;
}

/** 会話テキストのプレビュー（トークン節約用） */
function previewText(text: string, maxLen: number = 300): string {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen) + '...';
}

// ========================================
// メイン処理
// ========================================

/**
 * 未処理の会話データを取得
 * DevReportEntry に含まれない AI Message（usageData 付き）が対象
 */
export async function getUnprocessedConversations(
  userId: string,
  projectName: string,
): Promise<ConversationData[]> {
  // 既にレポートに含まれている messageId を取得
  const processedEntries = await prisma.devReportEntry.findMany({
    where: {
      report: { userId, projectName },
    },
    select: { messageId: true },
  });
  const processedIds = new Set(processedEntries.map((e) => e.messageId));

  // AI メッセージ（usageData 付き）を取得
  const aiMessages = await prisma.message.findMany({
    where: {
      role: 'ai',
      usageData: { not: Prisma.DbNull },
      session: {
        userId,
        project: {
          name: projectName,
          machine: { deletedAt: null },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      sessionId: true,
      content: true,
      createdAt: true,
      session: {
        select: {
          project: { select: { name: true } },
        },
      },
      files: {
        where: { mimeType: { startsWith: 'image/' } },
        select: { id: true },
      },
    },
  });

  // 未処理のものだけフィルタ
  const unprocessed = aiMessages.filter((m) => !processedIds.has(m.id));
  if (unprocessed.length === 0) return [];

  // 関連する user メッセージをバッチ取得
  const sessionIds = [...new Set(unprocessed.map((m) => m.sessionId))];
  const userMessages = await prisma.message.findMany({
    where: {
      sessionId: { in: sessionIds },
      role: 'user',
    },
    orderBy: { createdAt: 'asc' },
    select: {
      sessionId: true,
      content: true,
      createdAt: true,
      files: {
        where: { mimeType: { startsWith: 'image/' } },
        select: { id: true },
      },
    },
  });

  // sessionId → user メッセージ配列のマップ
  const userMsgMap = new Map<string, typeof userMessages>();
  for (const msg of userMessages) {
    const arr = userMsgMap.get(msg.sessionId) || [];
    arr.push(msg);
    userMsgMap.set(msg.sessionId, arr);
  }

  // 会話データを構築
  return unprocessed.map((aiMsg) => {
    const sessionUserMsgs = userMsgMap.get(aiMsg.sessionId) || [];
    let userContent = '';
    let inputImageIds: string[] = [];
    for (let i = sessionUserMsgs.length - 1; i >= 0; i--) {
      if (sessionUserMsgs[i].createdAt <= aiMsg.createdAt) {
        userContent = sessionUserMsgs[i].content;
        inputImageIds = sessionUserMsgs[i].files.map((f) => f.id);
        break;
      }
    }

    return {
      messageId: aiMsg.id,
      sessionId: aiMsg.sessionId,
      projectName: aiMsg.session.project.name,
      userMessage: userContent,
      aiMessage: aiMsg.content,
      createdAt: aiMsg.createdAt.toISOString(),
      imageFileIds: [...inputImageIds, ...aiMsg.files.map((f) => f.id)],
    };
  });
}

/**
 * プロジェクト別の未処理会話数を取得
 */
export async function getUnprocessedCounts(
  userId: string,
): Promise<{ projectName: string; count: number }[]> {
  // 全 AI メッセージをプロジェクト名でグループ
  const allAiMessages = await prisma.message.findMany({
    where: {
      role: 'ai',
      usageData: { not: Prisma.DbNull },
      session: {
        userId,
        project: {
          machine: { deletedAt: null },
        },
      },
    },
    select: {
      id: true,
      session: {
        select: { project: { select: { name: true } } },
      },
    },
  });

  // 処理済み messageId を取得
  const processedEntries = await prisma.devReportEntry.findMany({
    where: { report: { userId } },
    select: { messageId: true },
  });
  const processedIds = new Set(processedEntries.map((e) => e.messageId));

  // プロジェクト名ごとにカウント
  const countMap = new Map<string, number>();
  for (const msg of allAiMessages) {
    if (!processedIds.has(msg.id)) {
      const name = msg.session.project.name;
      countMap.set(name, (countMap.get(name) || 0) + 1);
    }
  }

  return Array.from(countMap.entries())
    .map(([projectName, count]) => ({ projectName, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * レポートを生成する（バックグラウンド処理）
 *
 * Step 1: AI にセクション分割を依頼
 * Step 2: 各セクションの会話を AI で要約
 * Step 3: DB にレポート内容を保存
 */
export async function generateReport(reportId: string, userId: string, projectName: string): Promise<void> {
  try {
    // AI プロバイダー設定を取得
    const config = await getApiKeyForDevReport(userId);
    if (!config) {
      throw new Error('AI プロバイダーが設定されていません。Settings ページで API キーを設定してください。');
    }

    const { provider, apiKey } = config;
    const caller = CALLER_MAP[provider];
    if (!caller) {
      throw new Error(`未対応のプロバイダー: ${provider}`);
    }

    console.log(`📝 DevReport [${reportId}]: 生成開始 (${provider}, project: ${projectName})`);

    // 未処理の会話を取得
    const conversations = await getUnprocessedConversations(userId, projectName);
    if (conversations.length === 0) {
      throw new Error('レポート対象の会話がありません。');
    }

    console.log(`📝 DevReport [${reportId}]: ${conversations.length} 件の会話を処理`);

    // --- Step 1: セクション分割 ---
    const divisionInput = conversations.map((c, i) => (
      `[${i + 1}] ID: ${c.messageId}\n日時: ${c.createdAt}\nユーザー: ${previewText(c.userMessage, 200)}\nAI応答: ${previewText(c.aiMessage, 300)}\n画像: ${c.imageFileIds.length}枚`
    )).join('\n---\n');

    const divisionPrompt = `プロジェクト「${projectName}」の開発会話 ${conversations.length} 件をセクションに分割してください。\n\n${divisionInput}`;

    console.log(`📝 DevReport [${reportId}]: セクション分割を AI に依頼中...`);
    const divisionRaw = await caller(apiKey, DIVISION_SYSTEM_PROMPT, divisionPrompt);
    const divisionJson = extractJson(divisionRaw);

    let plan: DivisionPlan;
    try {
      plan = JSON.parse(divisionJson);
    } catch {
      console.error(`📝 DevReport [${reportId}]: セクション分割の JSON パース失敗:`, divisionJson);
      // フォールバック: 全会話を1セクションにまとめる
      plan = {
        title: `${projectName} 開発記 - ${new Date().toISOString().split('T')[0]}`,
        sections: [{
          title: `${projectName} の開発作業`,
          messageIds: conversations.map((c) => c.messageId),
        }],
      };
    }

    // messageId → ConversationData のマップ
    const convMap = new Map(conversations.map((c) => [c.messageId, c]));

    // --- Step 2: 各セクションを要約 ---
    const sections: ReportContent['sections'] = [];

    for (let i = 0; i < plan.sections.length; i++) {
      const section = plan.sections[i];
      const sectionConvs = section.messageIds
        .map((id) => convMap.get(id))
        .filter((c): c is ConversationData => c !== undefined);

      if (sectionConvs.length === 0) continue;

      // セクション内の会話をフルテキストで送信
      const sectionInput = sectionConvs.map((c, j) => {
        const imgInfo = c.imageFileIds.length > 0
          ? `\n添付画像ID: ${c.imageFileIds.join(', ')}`
          : '';
        return `[会話 ${j + 1}] 日時: ${c.createdAt}\nユーザー: ${previewText(c.userMessage, 500)}\nAI応答: ${previewText(c.aiMessage, 1500)}${imgInfo}`;
      }).join('\n---\n');

      const summaryPrompt = `セクション「${section.title}」の会話内容をまとめてください。\n\n${sectionInput}`;

      console.log(`📝 DevReport [${reportId}]: セクション ${i + 1}/${plan.sections.length} 「${section.title}」を要約中...`);
      const summaryRaw = await caller(apiKey, SUMMARY_SYSTEM_PROMPT, summaryPrompt);
      const summaryJson = extractJson(summaryRaw);

      let sectionSummary: SectionSummary;
      try {
        sectionSummary = JSON.parse(summaryJson);
      } catch {
        // フォールバック: AI の生テキストをそのまま使用
        sectionSummary = { summary: summaryRaw, imageRefs: [] };
      }

      // 画像ファイルの情報を取得
      const allImageIds = sectionConvs.flatMap((c) => c.imageFileIds);
      const imageFiles = allImageIds.length > 0
        ? await prisma.messageFile.findMany({
            where: { id: { in: allImageIds } },
            select: { id: true, filename: true },
          })
        : [];
      const imageFileMap = new Map(imageFiles.map((f) => [f.id, f.filename]));

      // imageRefs にファイル名を追加（AI が返した fileId が有効か確認）
      const validImageRefs = sectionSummary.imageRefs
        .filter((ref) => imageFileMap.has(ref.fileId))
        .map((ref) => ({
          fileId: ref.fileId,
          filename: imageFileMap.get(ref.fileId) || ref.fileId,
          caption: ref.caption,
        }));

      // AI が参照しなかった画像も含める
      const referencedIds = new Set(validImageRefs.map((r) => r.fileId));
      const unreferencedImages = allImageIds
        .filter((id) => !referencedIds.has(id) && imageFileMap.has(id))
        .map((id) => ({
          fileId: id,
          filename: imageFileMap.get(id) || id,
          caption: '',
        }));

      sections.push({
        title: section.title,
        summary: sectionSummary.summary,
        conversations: sectionConvs.map((c) => ({
          messageId: c.messageId,
          userMessage: previewText(c.userMessage, 200),
          aiMessagePreview: previewText(c.aiMessage, 200),
          createdAt: c.createdAt,
        })),
        imageRefs: [...validImageRefs, ...unreferencedImages],
      });
    }

    // 期間を計算
    const dates = conversations.map((c) => c.createdAt).sort();
    const periodStart = dates[0];
    const periodEnd = dates[dates.length - 1];

    // レポート内容を構築
    const content: ReportContent = {
      title: plan.title,
      projectName,
      periodStart,
      periodEnd,
      sections,
    };

    // --- Step 3: DB 更新 ---
    // レポート本体を更新
    await prisma.devReport.update({
      where: { id: reportId },
      data: {
        title: plan.title,
        content: content as any,
        status: 'completed',
      },
    });

    // 処理した会話エントリを登録
    const entryData = plan.sections.flatMap((section, sectionIndex) =>
      section.messageIds
        .filter((id) => convMap.has(id))
        .map((messageId) => ({
          reportId,
          messageId,
          section: sectionIndex,
        })),
    );

    if (entryData.length > 0) {
      await prisma.devReportEntry.createMany({ data: entryData });
    }

    console.log(`📝 DevReport [${reportId}]: 完了！ ${sections.length} セクション, ${entryData.length} 会話`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`❌ DevReport [${reportId}]: 生成失敗:`, errorMessage);

    await prisma.devReport.update({
      where: { id: reportId },
      data: {
        status: 'failed',
        error: errorMessage,
      },
    });
  }
}

// ========================================
// HTML レポート生成
// ========================================

/**
 * レポートの HTML を生成
 * self-contained（CSS 内蔵）で画像は相対パス参照
 */
export function generateReportHtml(content: ReportContent): string {
  const periodStart = content.periodStart.split('T')[0];
  const periodEnd = content.periodEnd.split('T')[0];

  const sectionsHtml = content.sections.map((section, i) => {
    // 画像
    const imagesHtml = section.imageRefs.map((img) => {
      const caption = img.caption ? `<figcaption>${escapeHtml(img.caption)}</figcaption>` : '';
      return `<figure><img src="images/${escapeHtml(img.filename)}" alt="${escapeHtml(img.caption || img.filename)}" />${caption}</figure>`;
    }).join('\n');

    // 元会話（折りたたみ）
    const convsHtml = section.conversations.map((conv) => {
      const date = conv.createdAt.split('T')[0];
      return `<div class="conversation">
        <div class="conv-date">${escapeHtml(date)}</div>
        <div class="conv-user"><strong>User:</strong> ${escapeHtml(conv.userMessage)}</div>
        <div class="conv-ai"><strong>AI:</strong> ${escapeHtml(conv.aiMessagePreview)}</div>
      </div>`;
    }).join('\n');

    return `
    <section>
      <h2>${i + 1}. ${escapeHtml(section.title)}</h2>
      <div class="summary">${markdownToHtml(section.summary)}</div>
      ${imagesHtml ? `<div class="images">${imagesHtml}</div>` : ''}
      <details>
        <summary>元の会話を表示（${section.conversations.length}件）</summary>
        <div class="conversations">${convsHtml}</div>
      </details>
    </section>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(content.title)}</title>
  <style>
    :root {
      --bg: #1a1a2e;
      --surface: #16213e;
      --text: #e0e0e0;
      --text-muted: #a0a0a0;
      --accent: #0f3460;
      --highlight: #e94560;
      --border: #2a2a4a;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.7;
      max-width: 900px;
      margin: 0 auto;
      padding: 2rem 1.5rem;
    }
    h1 {
      font-size: 1.8rem;
      color: #fff;
      margin-bottom: 0.5rem;
      border-bottom: 2px solid var(--highlight);
      padding-bottom: 0.5rem;
    }
    .meta { color: var(--text-muted); margin-bottom: 2rem; font-size: 0.9rem; }
    h2 {
      font-size: 1.4rem;
      color: #fff;
      margin: 2rem 0 1rem;
      padding-left: 0.8rem;
      border-left: 4px solid var(--highlight);
    }
    section { margin-bottom: 2.5rem; }
    .summary {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1.2rem;
      margin-bottom: 1rem;
    }
    .summary p { margin-bottom: 0.8rem; }
    .summary code {
      background: var(--accent);
      padding: 0.15rem 0.4rem;
      border-radius: 3px;
      font-size: 0.9em;
    }
    .summary pre {
      background: var(--accent);
      padding: 1rem;
      border-radius: 6px;
      overflow-x: auto;
      margin: 0.8rem 0;
    }
    .summary ul, .summary ol { padding-left: 1.5rem; margin-bottom: 0.8rem; }
    .images { display: flex; flex-wrap: wrap; gap: 1rem; margin: 1rem 0; }
    figure {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
      max-width: 100%;
    }
    figure img { max-width: 100%; height: auto; display: block; }
    figcaption {
      padding: 0.5rem 0.8rem;
      font-size: 0.85rem;
      color: var(--text-muted);
    }
    details {
      margin-top: 1rem;
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
    }
    details summary {
      background: var(--surface);
      padding: 0.8rem 1rem;
      cursor: pointer;
      font-size: 0.9rem;
      color: var(--text-muted);
    }
    details summary:hover { color: var(--text); }
    .conversations { padding: 0.5rem 1rem; }
    .conversation {
      padding: 0.8rem 0;
      border-bottom: 1px solid var(--border);
      font-size: 0.85rem;
    }
    .conversation:last-child { border-bottom: none; }
    .conv-date { color: var(--text-muted); font-size: 0.8rem; margin-bottom: 0.3rem; }
    .conv-user { margin-bottom: 0.3rem; }
    .conv-ai { color: var(--text-muted); }
    .footer {
      margin-top: 3rem;
      padding-top: 1rem;
      border-top: 1px solid var(--border);
      color: var(--text-muted);
      font-size: 0.8rem;
      text-align: center;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f5f5f5;
        --surface: #ffffff;
        --text: #333333;
        --text-muted: #666666;
        --accent: #e8e8e8;
        --highlight: #e94560;
        --border: #dddddd;
      }
      h1, h2 { color: #222; }
    }
  </style>
</head>
<body>
  <h1>${escapeHtml(content.title)}</h1>
  <div class="meta">
    <p>Project: ${escapeHtml(content.projectName)} | Period: ${periodStart} ~ ${periodEnd}</p>
    <p>Generated by DevRelay</p>
  </div>
  ${sectionsHtml}
  <div class="footer">
    <p>Generated by DevRelay on ${new Date().toISOString().split('T')[0]}</p>
  </div>
</body>
</html>`;
}

/** HTML エスケープ */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 簡易 Markdown → HTML 変換 */
function markdownToHtml(md: string): string {
  return md
    // コードブロック
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    // インラインコード
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // 見出し（## のみ → h3 に変換）
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    // 太字
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    // リスト
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
    // 段落
    .replace(/\n\n/g, '</p><p>')
    .replace(/^(?!<)(.+)/gm, '<p>$1</p>')
    // 連続 <p> タグ整理
    .replace(/<p><\/p>/g, '')
    .replace(/<\/p><p>/g, '</p>\n<p>');
}
