/**
 * #300: トークン高止まり警告
 *
 * AI 応答の完了時に、そのプロジェクトの直近会話のトークン使用トレンドを見て、
 * 高止まりしていれば「`w` で記録・コミット → `x` で履歴クリア」を促す警告を返す。
 *
 * 背景: Claude SDK の resume 経路では会話が継続し、毎ターン `cache_read_input_tokens`（累積
 * コンテキスト）を読み直すためコストが膨らむ。実際にコンテキストを消して token を下げるのは
 * `x`（clear）。`w`（wrap up）は記録・コミットのみでコンテキストは切らないため、両方を促す。
 *
 * 判定は純関数 `evaluateTokenBloat()` に分離（単体検証しやすくするため）。
 */

import { Prisma } from '@prisma/client';
import type { AiUsageData } from '@devrelay/shared';
import { prisma } from '../db/client.js';

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/** 連続判定に見る会話数 */
const CONSEC_COUNT = envInt('DEVRELAY_TOKEN_WARN_CONSEC_COUNT', 3);
/** 連続判定のしきい値（各会話がこの値以上）。既定 3000k = 300 万トークン */
const CONSEC_TOKENS = envInt('DEVRELAY_TOKEN_WARN_CONSEC_TOKENS', 3_000_000);
/** 平均判定に見る会話数 */
const AVG_COUNT = envInt('DEVRELAY_TOKEN_WARN_AVG_COUNT', 10);
/** 平均判定のしきい値（直近 AVG_COUNT 会話の平均がこの値以上）。既定 2000k = 200 万トークン */
const AVG_TOKENS = envInt('DEVRELAY_TOKEN_WARN_AVG_TOKENS', 2_000_000);
/** 同一プロジェクトへの再警告を抑止するクールダウン（分） */
const COOLDOWN_MS = envInt('DEVRELAY_TOKEN_WARN_COOLDOWN_MIN', 60) * 60_000;

const isDisabled = (): boolean => process.env.DEVRELAY_TOKEN_WARN_DISABLED === '1';

/** プロジェクトごとの最終警告時刻（プロセス内メモリ。再起動で消えてよい） */
const lastWarnedAt = new Map<string, number>();

/**
 * 1 会話（1 AI メッセージ）の合計トークンを算出する
 * Conversations の "Tokens" 列と同じ定義（input + output + cache_read + cache_creation）
 */
export function extractTotalTokens(usageData: AiUsageData | null | undefined): number {
  const u = usageData?.usage;
  if (!u) return 0;
  return (
    (u.input_tokens ?? 0) +
    (u.output_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0)
  );
}

export interface TokenBloatResult {
  warn: boolean;
  reason: 'consec' | 'avg' | null;
  /** 平均（直近 AVG_COUNT 会話）の k 単位（表示用） */
  avgK: number;
  /** 平均算出に使った会話数 */
  count: number;
}

/**
 * トークン高止まりを判定する純関数
 *
 * @param totals 新しい順のトークン合計配列（index 0 = 今回の会話を含む最新）
 */
export function evaluateTokenBloat(totals: number[]): TokenBloatResult {
  // 連続: 直近 CONSEC_COUNT 会話がすべてしきい値以上
  const consec =
    totals.length >= CONSEC_COUNT &&
    totals.slice(0, CONSEC_COUNT).every(t => t >= CONSEC_TOKENS);

  // 平均: 直近 AVG_COUNT 会話がそろっていて、その平均がしきい値以上
  const avgSlice = totals.slice(0, AVG_COUNT);
  const avg = avgSlice.length > 0 ? avgSlice.reduce((a, b) => a + b, 0) / avgSlice.length : 0;
  const avgWarn = avgSlice.length >= AVG_COUNT && avg >= AVG_TOKENS;

  const reason: 'consec' | 'avg' | null = consec ? 'consec' : avgWarn ? 'avg' : null;
  return { warn: consec || avgWarn, reason, avgK: Math.round(avg / 1000), count: avgSlice.length };
}

/**
 * セッション完了時にトークン高止まり警告文を返す（発火しなければ空文字）
 *
 * @param sessionId 対象セッション
 * @param currentUsage 今回の会話の usageData（まだ DB 未保存なので引数で受け取る）
 * @returns 警告文（末尾改行つき）または ''
 */
export async function maybeTokenBloatWarning(
  sessionId: string,
  currentUsage: AiUsageData | null | undefined
): Promise<string> {
  try {
    if (isDisabled()) return '';

    // プロジェクトを解決
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { projectId: true, project: { select: { name: true, displayName: true } } },
    });
    if (!session) return '';
    const projectId = session.projectId;

    // クールダウン中は判定・クエリすらせず抜ける
    const last = lastWarnedAt.get(projectId);
    if (last && Date.now() - last < COOLDOWN_MS) return '';

    // 同プロジェクトの直近 AI メッセージ（今回分はまだ未保存なので AVG_COUNT-1 件取得して先頭に足す）
    const recent = await prisma.message.findMany({
      where: { role: 'ai', usageData: { not: Prisma.DbNull }, session: { projectId } },
      orderBy: { createdAt: 'desc' },
      take: Math.max(AVG_COUNT - 1, CONSEC_COUNT - 1),
      select: { usageData: true },
    });
    const totals = [
      extractTotalTokens(currentUsage),
      ...recent.map(m => extractTotalTokens(m.usageData as unknown as AiUsageData)),
    ];

    const result = evaluateTokenBloat(totals);
    if (!result.warn) return '';

    lastWarnedAt.set(projectId, Date.now());
    const projectName = session.project?.displayName || session.project?.name || 'このプロジェクト';
    console.log(
      `📊 [token-warn] ${projectName}: reason=${result.reason}, avg=${result.avgK}k over ${result.count} convos`
    );
    return (
      `⚠️ トークンが高止まりしています（${projectName}: 直近${result.count}会話 平均${result.avgK}k）。` +
      '`w` で作業を記録・コミットしてから `x` で履歴をクリアするとコスト・応答速度が改善します。\n'
    );
  } catch (err) {
    // 警告の失敗は応答本体を壊さない
    console.warn('⚠️ [token-warn] failed:', (err as Error).message);
    return '';
  }
}
