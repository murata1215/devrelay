import type { UserCommand } from '@devrelay/shared';

/**
 * WebUI のコマンド応答が消える問題の根治（2026-10-18）。
 *
 * 背景: `apps/server/src/platforms/web.ts` は `executeCommand()` の結果を `web:response` /
 * `web:user_message` で WebSocket 配信するだけで `Message` テーブルに保存していなかった
 * （保存するのは AI ターン系ハンドラのみ）。一方 `apps/web` の `loadHistory()` は DB 履歴を
 * 正として再構成するため、再接続・リロード・スレッド切替のたびに DB に無い WS 専用メッセージが
 * 消える。特に `testflight create` は完了メッセージ返却の 2 秒後に `sudo systemctl reload caddy`
 * で WS を自ら切断するため、この消失が毎回・即座に発生していた
 * （詳細: doc/devlog/2026-10-18_* 参照）。
 *
 * 本モジュールは「WebUI のコマンド往復（ユーザー入力＋応答）を Message に永続化すべきか」を
 * 判定する純関数群。I/O（prisma 呼び出し）は呼び出し元の `platforms/web.ts` が担う。
 * 外部 import は型のみ（`UserCommand`）のため dist 化後は require が残らず、
 * `node --test` から dist を直接 import できる（thread-list-filter.ts / knowledge-rank.ts と同じ流儀）。
 */

/**
 * 永続化キルスイッチ。既定 ON（'0' が明示されたときのみ無効）。
 * `isTestflightEnabled` / `isHideEmptyEndedEnabled` と同じ流儀。
 */
export function isWebCommandPersistEnabled(raw: string | undefined): boolean {
  return raw !== '0';
}

/**
 * 自前で `prisma.message.create` を呼ぶ AI ターン系コマンド type（command-handler.ts の
 * handleExec / handleAgreement / handleAiPrompt / handleAskMember / handleTeamExec）。
 * ここで保存すると二重保存になるため除外する。
 */
const SELF_PERSISTING_TYPES = ['exec', 'agreement', 'ai:prompt', 'ask:member', 'teamexec:member'] satisfies readonly UserCommand['type'][];

/**
 * 保存してはいけないコマンド type。
 * - `login` / `login:code` / `login:cancel`: 認可コードが `Message.content` に残るのを
 *   構造的に禁止する（`redactChatInput` だけに頼らない二重防御）。
 * - `clear` / `quit`: セッション終了系。終了済み（ended）スレッドに行を足すと
 *   `thread-list-filter.ts` の「空の ended を隠す」判定が外れ、「(無題)」スレッドが
 *   一覧に復活してしまう。
 */
const EXCLUDED_TYPES = ['login', 'login:code', 'login:cancel', 'clear', 'quit'] satisfies readonly UserCommand['type'][];

/** `shouldPersistWebCommandTurn()` が保存を見送った理由。 */
export type WebPersistSkipReason = 'disabled' | 'no-session' | 'self-persisting' | 'excluded' | 'empty-text';

/**
 * WebUI のコマンド往復 1 行（ユーザー入力 or 応答）を `Message` へ保存すべきか判定する。
 * 入力行・応答行の両方でこの関数を使う（`userText` には判定対象のテキスト、
 * すなわちユーザー入力 or AI 以外の応答文字列を渡す）。
 */
export function shouldPersistWebCommandTurn(input: {
  enabled: boolean;
  commandType: UserCommand['type'];
  sessionId: string | null;
  userText: string;
}): { persist: boolean; reason: 'ok' | WebPersistSkipReason } {
  if (!input.enabled) return { persist: false, reason: 'disabled' };
  if (!input.sessionId) return { persist: false, reason: 'no-session' };
  if ((SELF_PERSISTING_TYPES as readonly string[]).includes(input.commandType)) {
    return { persist: false, reason: 'self-persisting' };
  }
  if ((EXCLUDED_TYPES as readonly string[]).includes(input.commandType)) {
    return { persist: false, reason: 'excluded' };
  }
  if (!input.userText.trim()) return { persist: false, reason: 'empty-text' };
  return { persist: true, reason: 'ok' };
}

/** 応答テキストが保存対象か（未定義・空文字・空白のみは保存しない）。 */
export function shouldPersistWebResponse(responseText: string | undefined | null): boolean {
  return !!responseText && responseText.trim().length > 0;
}

/** `createWebMessageRow()`（platforms/web.ts）に渡す Message 行の形。 */
export interface WebMessageRow {
  sessionId: string;
  role: 'user' | 'system';
  content: string;
  platform: 'web';
  createdAt: Date;
}

/**
 * ユーザー入力行を組み立てる。`createdAt` はコマンド受信時刻（`receivedAt`）をそのまま使う。
 * 送信者タブの楽観表示時刻とほぼ一致させることで、`ChatPage.tsx` の「role+content が
 * 60 秒以内なら重複」判定に確実に乗せる（既定 now() にすると実行に時間がかかるコマンド
 * （testflight 等）で窓を外れ、二重表示になりうる）。
 */
export function buildWebUserMessageRow(input: { sessionId: string; content: string; receivedAt: Date }): WebMessageRow {
  return { sessionId: input.sessionId, role: 'user', content: input.content, platform: 'web', createdAt: input.receivedAt };
}

/**
 * 応答行を組み立てる。`createdAt` はユーザー入力行より必ず後になるよう
 * `max(completedAt, receivedAt + 1ms)` にする（時計の巻き戻り・同時刻でも前後関係を保証し、
 * `loadHistory` のソートや重複排除を壊さない）。
 */
export function buildWebResponseMessageRow(input: { sessionId: string; content: string; receivedAt: Date; completedAt: Date }): WebMessageRow {
  const createdAt = new Date(Math.max(input.completedAt.getTime(), input.receivedAt.getTime() + 1));
  return { sessionId: input.sessionId, role: 'system', content: input.content, platform: 'web', createdAt };
}
