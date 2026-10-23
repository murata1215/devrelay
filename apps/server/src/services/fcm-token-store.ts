/**
 * FCM トークンの永続化層。
 *
 * トークンは専用テーブルではなく `UserSettings`（key='fcm_tokens'）の JSON 配列に保存する
 * （2026-10-23 の設計判断: `PushDevice` テーブル新設は DDL 手順の重さに対して得るものが
 * 小さいため見送り。フィールド名は将来の移行に備えて `PushDevice` のカラム名と 1:1 対応させてある
 * — `fcm-token-rules.ts` の `FcmTokenRecord` 参照）。
 *
 * `getFcmTokens`/`saveFcmTokens` は元 `fcm-service.ts` から移設。read-modify-write の競合
 * （2 セッション同時完了で削除が互いを巻き戻す）を、DDL なしで実用上潰すため
 * userId ごとの Promise チェーンで直列化する（`withFcmTokens`）。
 *
 * ⚠️ 単一プロセス前提。マルチプロセス化（pm2 cluster 等）すると直列化は破れる。
 *    その場合は `PushDevice` テーブル + 行レベル update への移行を検討すること。
 */

import { getUserSetting, setUserSetting, SettingKeys } from './user-settings.js';
import { normalizeFcmTokenList, type FcmTokenRecord } from './fcm-token-rules.js';

/** ユーザーの FCM トークン一覧を取得（不正値は正規化で除去） */
export async function getFcmTokens(userId: string): Promise<FcmTokenRecord[]> {
  const raw = await getUserSetting(userId, SettingKeys.FCM_TOKENS);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  return normalizeFcmTokenList(parsed, new Date().toISOString());
}

/** ユーザーの FCM トークン一覧を保存 */
export async function saveFcmTokens(userId: string, tokens: FcmTokenRecord[]): Promise<void> {
  await setUserSetting(userId, SettingKeys.FCM_TOKENS, JSON.stringify(tokens));
}

/** userId ごとの直列化キュー（進行中の Promise チェーン） */
const userMutexes = new Map<string, Promise<unknown>>();

/**
 * userId をキーに read-modify-write を直列化して実行する。
 * `mutator` は現在のトークン一覧を受け取り、`{ next, result }` を返す。
 * `next` が省略された場合は書き込みをスキップする（純粋な読み取りにも使える）。
 */
export async function withFcmTokens<T>(
  userId: string,
  mutator: (list: FcmTokenRecord[]) => Promise<{ next?: FcmTokenRecord[]; result: T }> | { next?: FcmTokenRecord[]; result: T }
): Promise<T> {
  const previous = userMutexes.get(userId) ?? Promise.resolve();

  const run = previous
    .catch(() => {
      // 前回の操作が失敗していても、このユーザーのチェーンを止めない
    })
    .then(async () => {
      const list = await getFcmTokens(userId);
      const outcome = await mutator(list);
      if (outcome.next) {
        await saveFcmTokens(userId, outcome.next);
      }
      return outcome.result;
    });

  // Map に積むのは「このユーザーの直列化チェーンの末尾」。
  // 失敗を次のオペレーションに伝播させないよう catch 済みの Promise を保持する。
  userMutexes.set(
    userId,
    run.catch(() => {})
  );

  return run;
}
