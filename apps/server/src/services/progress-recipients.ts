/**
 * サイクルS1（C4）: `web:progress` の配信先を「ターン開始時スナップショット」ではなく
 * 「フレーム送信のたびに live 評価」に揃えるための純関数群。
 * 外部 import は型のみ（`@devrelay/shared` の `Platform`）。node:test から
 * dist/ を直接 import して検証する（thread-reestablish.ts / thread-routing.ts と同じ流儀）。
 *
 * 背景（doc/flutter-thread-api-contract.md §3.3.1(c) 参照）:
 * `session-manager.ts` の `updateProgressMessages()` は従来、`startProgressTracking()` が
 * ターン開始時に 1 回だけ作った `tracker.messages`（chatId → messageId のスナップショット）を
 * 8 秒周期でそのまま回していた。そのため、ターン開始後に参加した（または開始直前に再接続が
 * 完了していなかった）Web タブは、そのターンの `web:progress` を 1 通も受け取れなかった。
 * 一方 `web:response` / `web:user_message` / `finalizeProgress()`（最終応答）はいずれも
 * 送信時点の `sessionParticipants` を live 評価しており、progress だけが取り残されていた。
 *
 * `resolveProgressRecipients()` は `finalizeProgress()` が既に採っているパターン
 * 「live participants を回して tracker から messageId を引く」と完全に同型にする:
 * - web: 常に含める（`editWebMessage()` は `messageId` を実際には使わないため、
 *   ターン開始後に参加したタブでも messageId 無し（null）で問題なく送れる）
 * - discord/telegram: tracker に該当 chatId の messageId が **ある場合のみ** 含める
 *   （編集対象のメッセージが存在しない chatId に対して 8 秒ごとに新規投稿することは絶対にしない）
 * - live participants に含まれない chatId は、tracker に残っていても除外する
 *   （セッション参加を外れたら以降のフレームは届かない）
 */

import type { Platform } from '@devrelay/shared';

/** 現在のセッション参加者（`sessionParticipants` の要素と同形）。 */
export interface LiveParticipant {
  platform: Platform;
  chatId: string;
}

/** `tracker.messages`（`Map<chatId, { messageId, platform }>`）の 1 エントリをタプル化したもの。 */
export type TrackerMessageEntry = readonly [string, { messageId: string | number; platform: Platform }];

/** `resolveProgressRecipients()` の入力。 */
export interface ResolveProgressRecipientsInput {
  /** 送信時点で `sessionParticipants.get(sessionId)` から取得した現在の参加者一覧。 */
  liveParticipants: ReadonlyArray<LiveParticipant>;
  /** `tracker.messages` の中身（`[...tracker.messages]` で渡す）。ターン開始時点の messageId 記録。 */
  trackerMessages: ReadonlyArray<TrackerMessageEntry>;
}

/** `resolveProgressRecipients()` が返す配信先の 1 件。 */
export interface ProgressRecipient {
  platform: Platform;
  chatId: string;
  /**
   * Discord/Telegram の編集対象メッセージ ID。
   * web は常に `messageId` の値を無視して新規フレームを送るため、
   * tracker に記録が無ければ `null` になる（呼び出し側はそのまま渡してよい）。
   */
  messageId: string | number | null;
}

/**
 * `updateProgressMessages()` の配信先を、ターン開始時スナップショットではなく
 * 現在の生存参加者（`liveParticipants`）から live 評価して返す。
 *
 * - `liveParticipants` の順序を保って走査する（= 送信時点の live 評価）
 * - `platform === 'web'` は常に含める。messageId は `trackerMessages` にあればそれ、無ければ `null`
 * - `platform` が discord/telegram の場合は `trackerMessages` に該当 chatId の記録がある場合のみ含める
 *   （記録が無い chatId への新規投稿は行わない設計のため、ここで弾く）
 * - `platform + chatId` の重複は初出を優先して除去する
 * - `liveParticipants` に存在しない chatId は、`trackerMessages` に残っていても一切含めない
 */
export function resolveProgressRecipients(
  input: ResolveProgressRecipientsInput
): ProgressRecipient[] {
  const trackerMap = new Map<string, { messageId: string | number; platform: Platform }>(
    input.trackerMessages
  );
  const seen = new Set<string>();
  const recipients: ProgressRecipient[] = [];

  for (const { platform, chatId } of input.liveParticipants) {
    const dedupeKey = `${platform}:${chatId}`;
    if (seen.has(dedupeKey)) continue;

    const tracked = trackerMap.get(chatId);

    if (platform === 'web') {
      seen.add(dedupeKey);
      recipients.push({ platform, chatId, messageId: tracked?.messageId ?? null });
      continue;
    }

    if (platform === 'discord' || platform === 'telegram') {
      if (!tracked) continue;
      seen.add(dedupeKey);
      recipients.push({ platform, chatId, messageId: tracked.messageId });
      continue;
    }

    // 未知の platform（将来追加分）は tracker に記録がある場合のみ踏襲する（fail-safe）
    if (tracked) {
      seen.add(dedupeKey);
      recipients.push({ platform, chatId, messageId: tracked.messageId });
    }
  }

  return recipients;
}
