/**
 * FCM（Firebase Cloud Messaging）プッシュ通知サービス
 *
 * Firebase Admin SDK を使用してモバイルアプリ（iOS/Android）にプッシュ通知を送信
 * FIREBASE_SERVICE_ACCOUNT_PATH 環境変数が未設定の場合は無効化（エラーにしない）
 *
 * 2026-10-22 の事故（アプリ再インストールで通知許可がリセット → 新トークンが未登録 →
 * サーバーには配信先の無い古いトークンだけが残り、エラーも出ないまま無音で壊れた）の
 * 再発防止策（2026-10-23）: 送信結果を必ずログに残し、削除条件を安全化した。
 * 判定ロジックは `fcm-token-rules.ts`（純粋関数）、永続化は `fcm-token-store.ts`、
 * プロセス内メトリクスは `fcm-metrics.ts` に分離してある。
 */

import { prisma } from '../db/client.js';
import { getFcmTokens, saveFcmTokens, withFcmTokens } from './fcm-token-store.js';
import {
  classifyFcmError,
  decideTokenRemovals,
  maskFcmToken,
  resolveFcmPolicy,
  summarizeSendResult,
  upsertFcmTokenRecord,
  type FcmSendOutcome,
  type FcmSendSummary,
} from './fcm-token-rules.js';
import {
  getFcmMetrics,
  recordFcmDropNoToken,
  recordFcmPersist,
  recordFcmSendResult,
} from './fcm-metrics.js';

/** 送信理由（ログ・メトリクスでの分類用） */
export type FcmSendReason = 'response' | 'tool_approval' | 'test' | 'other';

/** `sendFcmNotification` の追加オプション */
export interface FcmSendOptions {
  reason?: FcmSendReason;
  /** 'never' を指定すると、削除条件を満たしてもトークンを削除しない（テスト送信専用） */
  removalPolicy?: 'auto' | 'never';
}

/** `sendFcmNotification` の戻り値（診断 API から参照するため、端末ごとの結果も含める） */
export interface FcmSendResultForCaller {
  summary: FcmSendSummary;
  outcomes: (FcmSendOutcome & { tokenPrefix: string })[];
}

/** トークン保存を 60 秒に 1 回へ抑制する閾値（全件成功時のみ適用） */
const PERSIST_THROTTLE_MS = 60_000;
/** 未初期化時の警告ログを間引く間隔（呼び出し回数） */
const UNINITIALIZED_WARN_INTERVAL = 50;

/** Firebase Admin のメッセージング型（動的 import のため any） */
let messaging: any = null;

/** FCM 初期化済みフラグ */
let fcmInitialized = false;

/** 未初期化時の警告を間引くためのカウンタ（プロセス寿命のみ） */
let uninitializedWarnCount = 0;

/**
 * Firebase Admin SDK を初期化
 * FIREBASE_SERVICE_ACCOUNT_PATH が未設定の場合はスキップ（FCM 無効化）
 */
export async function initFcm(): Promise<boolean> {
  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;

  if (!serviceAccountPath) {
    console.log('⚠️ FIREBASE_SERVICE_ACCOUNT_PATH not configured, FCM push notifications disabled');
    return false;
  }

  try {
    // 動的 import で firebase-admin をロード（パッケージ未インストール時もエラーにしない）
    const admin = await import('firebase-admin');
    const fs = await import('fs');

    if (!fs.existsSync(serviceAccountPath)) {
      console.log(`⚠️ Firebase service account file not found: ${serviceAccountPath}, FCM disabled`);
      return false;
    }

    const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf-8'));

    // 既に初期化済みの場合はスキップ
    if (admin.default.apps?.length === 0 || !admin.default.apps) {
      admin.default.initializeApp({
        credential: admin.default.credential.cert(serviceAccount),
      });
    }

    messaging = admin.default.messaging();
    fcmInitialized = true;
    console.log('🔔 FCM (Firebase Cloud Messaging) initialized');
    return true;
  } catch (err: any) {
    console.error('⚠️ FCM initialization failed:', err.message);
    return false;
  }
}

/**
 * FCM が利用可能かどうか
 */
export function isFcmEnabled(): boolean {
  return fcmInitialized;
}

/**
 * FCM トークンを登録
 * 同じトークンが既にあれば `lastRegisteredAt` のみ更新、なければ追加
 * （`registeredAt` は初回登録時刻として保持する。以前は再 subscribe のたびに
 * 上書きしていたため「最後にいつ登録されたか」が分からなかった）
 */
export async function saveFcmToken(
  userId: string,
  fcmToken: string,
  platform: 'ios' | 'android'
): Promise<void> {
  const nowIso = new Date().toISOString();
  await withFcmTokens(userId, (list) => {
    const { next, action } = upsertFcmTokenRecord({ list, token: fcmToken, platform, nowIso });
    console.log(`🔔 FCM token saved for user ${userId} (${platform}, total: ${next.length}, ${action})`);
    return { next, result: undefined };
  });
}

/**
 * FCM トークンを削除
 */
export async function removeFcmToken(userId: string, fcmToken: string): Promise<void> {
  await withFcmTokens(userId, (list) => {
    const filtered = list.filter((t) => t.token !== fcmToken);
    console.log(`🔔 FCM token removed for user ${userId} (remaining: ${filtered.length})`);
    return { next: filtered, result: undefined };
  });
}

/**
 * ユーザーに FCM プッシュ通知を送信
 * 全登録済みトークンに送信し、無効なトークンは自動削除（安全化済みポリシー。
 * `fcm-token-rules.ts` の `decideTokenRemovals` を参照）。
 *
 * 2026-10-22 事故の再発防止: トークン 0 件・未初期化で無言 return していた箇所を
 * 全て `DEVRELAY_PUSH_DIAG`（既定 ON）配下で可視化する。
 */
export async function sendFcmNotification(
  userId: string,
  title: string,
  body: string,
  data?: Record<string, string>,
  options?: FcmSendOptions
): Promise<FcmSendResultForCaller | null> {
  const nowIso = new Date().toISOString();
  const reason = options?.reason ?? 'other';
  const policy = resolveFcmPolicy(process.env);

  if (!fcmInitialized || !messaging) {
    // FIREBASE_SERVICE_ACCOUNT_PATH が未設定なのは意図的な無効化なので静かなまま。
    // 設定済みなのに初期化に失敗している場合だけ間引きつつ警告する。
    if (policy.diagEnabled && process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
      uninitializedWarnCount += 1;
      if (uninitializedWarnCount === 1 || uninitializedWarnCount % UNINITIALIZED_WARN_INTERVAL === 0) {
        console.warn(
          `⚠️ FCM: 未初期化のため通知を破棄 (reason=${reason}, count=${uninitializedWarnCount})`
        );
      }
    }
    return null;
  }

  const records = await getFcmTokens(userId);
  if (records.length === 0) {
    const m = recordFcmDropNoToken(userId, nowIso);
    if (policy.diagEnabled) {
      console.warn(
        `⚠️ FCM: 配信先トークン 0 件のため破棄 user=${userId} reason=${reason}（累計 ${m.dropNoToken} 件）`
      );
    }
    return { summary: { total: 0, success: 0, failed: 0, byCode: {} }, outcomes: [] };
  }

  const outcomes: FcmSendOutcome[] = await Promise.all(
    records.map(async (record): Promise<FcmSendOutcome> => {
      try {
        await messaging.send({
          token: record.token,
          notification: {
            title,
            body: body.length > 200 ? body.slice(0, 200) + '...' : body,
          },
          data: data || {},
          // iOS 固有設定
          apns: {
            payload: {
              aps: {
                sound: 'default',
                badge: 1,
              },
            },
          },
          // Android 固有設定
          android: {
            priority: 'high' as const,
            notification: {
              sound: 'default',
              channelId: 'devrelay_default',
            },
          },
        });
        return { token: record.token, ok: true };
      } catch (err: any) {
        return { token: record.token, ok: false, code: err.code };
      }
    })
  );

  const summary = summarizeSendResult(outcomes);
  recordFcmSendResult(userId, nowIso, summary);

  if (policy.diagEnabled) {
    console.log(
      `🔔 FCM send user=${userId} reason=${reason} tokens=${summary.total} ok=${summary.success} ` +
        `fail=${summary.failed} codes=${JSON.stringify(summary.byCode)}`
    );
  }

  // environment / unknown 分類は「個々のトークンの問題ではない」可能性が高いので、
  // DEVRELAY_PUSH_DIAG の設定に関わらず常に目立つログを出す（旧実装の console.error を引き継ぐ）
  for (const o of outcomes) {
    if (o.ok) continue;
    const cls = classifyFcmError(o.code);
    if (cls === 'environment') {
      console.error(
        `🔔 FCM: environment mismatch (code=${o.code}) token=${maskFcmToken(o.token)} user=${userId} ` +
          `— 別 Firebase プロジェクト/サービスアカウントの可能性があるためトークンは削除しません`
      );
    } else if (cls === 'unknown') {
      console.error(`🔔 FCM notification failed: ${o.code}`);
    }
  }

  const allowRemoval = options?.removalPolicy !== 'never';
  const allSucceeded = summary.failed === 0;

  // 書き込みスロットル: 全件成功で直近 60 秒以内に保存済みなら永続化をスキップする
  // （削除・失敗の記録は「失うと困る情報」なので、全件成功時のみ適用する）
  let shouldPersist = true;
  if (allSucceeded) {
    const metrics = getFcmMetrics(userId);
    if (metrics.lastPersistAt) {
      const sinceMs = new Date(nowIso).getTime() - new Date(metrics.lastPersistAt).getTime();
      if (sinceMs < PERSIST_THROTTLE_MS) shouldPersist = false;
    }
  }

  if (shouldPersist) {
    await withFcmTokens(userId, (list) => {
      const removal = decideTokenRemovals({
        records: list,
        outcomes,
        nowIso,
        strictDelete: policy.strictDelete,
        allowRemoval,
      });

      if (removal.loud) {
        console.error(
          `🔔 FCM: 全滅ガード発動 user=${userId} reason=${reason} — 全トークンが同一エラーで失敗したため ` +
            `削除を中止しました（codes=${JSON.stringify(summary.byCode)}）`
        );
      }
      for (const r of removal.removals) {
        console.log(`🔔 FCM token expired/invalid (${r.code}), removing: ${maskFcmToken(r.token)}`);
      }

      return { next: removal.next, result: undefined };
    });
    recordFcmPersist(userId, nowIso);
  }

  return {
    summary,
    outcomes: outcomes.map((o) => ({ ...o, tokenPrefix: maskFcmToken(o.token) })),
  };
}

/**
 * セッション完了時の FCM プッシュ通知送信
 * session テーブルから userId を取得して通知
 */
export async function sendFcmNotificationForSession(
  sessionId: string,
  message: string
): Promise<void> {
  if (!fcmInitialized) return;

  try {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: { project: true },
    });
    if (!session) return;

    const projectName = session.project?.name || 'Unknown';
    const body = message.length > 100 ? message.slice(0, 100) + '...' : message;

    await sendFcmNotification(
      session.userId,
      `✅ ${projectName}`,
      body,
      { sessionId, projectId: session.projectId },
      { reason: 'response' }
    );
  } catch (err: any) {
    console.error('🔔 FCM notification for session failed:', err.message);
  }
}

/**
 * ツール承認待ちの FCM プッシュ通知送信
 */
export async function sendFcmNotificationForToolApproval(
  userId: string,
  toolName: string,
  projectName: string,
  sessionId: string,
  projectId: string
): Promise<void> {
  if (!fcmInitialized) return;

  try {
    await sendFcmNotification(
      userId,
      `🔐 ${projectName}`,
      `ツール承認待ち: ${toolName}`,
      { sessionId, projectId, type: 'tool_approval' },
      { reason: 'tool_approval' }
    );
  } catch (err: any) {
    console.error('🔔 FCM notification for tool approval failed:', err.message);
  }
}

// Phase B（診断 API）向けに再 export（`fcm-token-store.ts` を直接 import させず
// API ルート側は `fcm-service.ts` だけを見れば済むようにする）
export { getFcmTokens, saveFcmTokens };
