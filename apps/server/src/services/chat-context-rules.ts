// Phase 0-2: Discord/Telegram の共有チャンネル（グループ/ギルドチャンネル）で複数ユーザーが
// 同じ chatId を使う場合の UserContext 再解決ルール（純関数、外部 import ゼロ）。
//
// 背景: `command-handler.ts` の `userContexts`（in-memory Map）は `${platform}:${chatId}` を
// キーにしており、キャッシュヒット時は渡された userId を一切反映せず「そのキーで最初に
// 作られたときの userId」を返し続けていた。Web は chatId に userId 自体が埋め込まれている
// （`web:${userId}:${tabId}`）ため影響しないが、Discord/Telegram の共有チャンネルでは
// ユーザー A が先に発言した直後に別ユーザー B が発言しても、B の操作が A の userId で解決され、
// A のマシン・A の Team に対して ask/teamexec/exec が実行されてしまう
// （権限モデル・監査・レート制限を一切通らない事実上のクロスユーザー実行）。
//
// この関数は「userId が変わったときに何を引き継ぎ、何を引き継がないか」だけを決める。
// DB 読み書き・Map への読み書きは呼び出し側（command-handler.ts の getUserContext）が行う。

import type { UserContext } from '@devrelay/shared';

/**
 * キルスイッチのデフォルト解決（既定 ON = 修正後の挙動。'0' で旧挙動に戻す）。
 * 既存の `isUpdateBusyGuardEnabled`（update-busy-rules.ts）と同じ `raw !== '0'` 方式。
 */
export function isChatCtxPerUserEnabled(raw: string | undefined): boolean {
  return raw !== '0';
}

/**
 * キャッシュ済み UserContext を、今回の発言者 userId に合わせて再解決する。
 *
 * - `existing` が無い（初回）→ null（呼び出し側が新規作成する。本関数の対象外）
 * - `existing.userId === incomingUserId`（同じ人の発言）→ null（変更不要、既存参照をそのまま使う）
 * - userId が変わった → 前の発言者に紐づく接続状態（マシン/セッション/
 *   teamexec 接続先プロジェクト/一覧キャッシュ）を引き継がない、リセット済みの
 *   新しいコンテキストを返す。platform/chatId は不変、language は呼び出し側が
 *   毎回 `resolveChatLanguage()` で再解決するためここでは保持するだけで良い。
 *
 * @param existing キャッシュ済みコンテキスト（Map から取得した値、無ければ undefined）
 * @param incomingUserId 今回のメッセージの発言者 userId（プラットフォーム側 ID）
 */
export function reconcileUserContext(
  existing: UserContext | undefined,
  incomingUserId: string,
): UserContext | null {
  if (!existing || existing.userId === incomingUserId) {
    return null;
  }

  return {
    userId: incomingUserId,
    platform: existing.platform,
    chatId: existing.chatId,
    // 前の発言者固有の状態は一切引き継がない（他ユーザーのプロジェクトに
    // 接続されたままの状態で操作が実行される事故を防ぐ）
    lastListType: undefined,
    lastListItems: undefined,
    currentMachineId: undefined,
    currentMachineName: undefined,
    currentSessionId: undefined,
    currentProjectName: undefined,
    lastProjectId: undefined,
    lastRemoteProjectId: undefined,
    lastRemoteProjectName: undefined,
    language: existing.language,
  };
}
