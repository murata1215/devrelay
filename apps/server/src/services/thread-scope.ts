/**
 * スレッド管理 cycle1: Session 行 = スレッドの agent scope（`.devrelay/sessions/<agentScopeId>/`）
 * 解決ロジックを1箇所に集約する純関数群。外部 import ゼロ（node:test から dist/ を直接 import する）。
 *
 * 【最重要不変条件】`Session.agentScopeId` は既存行に対して絶対にバックフィルしない。
 * - DB 列が NULL の Session は「従来の共有 `.devrelay/` 直下」を指す
 * - `resolveOutboundAgentScopeId(null)` は必ず `undefined` を返す（wire 上に一切載せない）
 * - この関数だけが「DB の NULL → wire 上で送らない」の変換点。将来ここを書き換えて
 *   NULL を id 等で埋めると、既存セッションが全て空の state dir を指す重大な破壊的変更になる。
 *   （rules/project.md にも明文化する）
 */

/**
 * 一時セッション ID プレフィックス（`GET /api/threads` 等のスレッド一覧から除外する対象）。
 * - `teamexec_` / `crossquery_`: MCP・チャットコマンド経由のクロスプロジェクト実行（HTTP リクエスト寿命）
 * - `askdesc_`: `POST /api/projects/:id/description` の内部ジョブ（api.ts）。
 *   user メッセージを持たず assistant 1 件だけの「タイトル無しスレッド」になるため一覧に出さない。
 * ここを増やす前に `isEphemeralSessionId` の全呼び出し元を確認すること
 * （現在: api.ts のスレッド一覧 where と session-manager.ts の touchSessionActivity の2箇所のみ）。
 */
const EPHEMERAL_SESSION_ID_PREFIXES = ['teamexec_', 'crossquery_', 'askdesc_'] as const;

/**
 * セッション ID が teamexec / crossquery / askdesc 等の一時セッション（スレッド一覧に出すべきでない）かどうかを判定する。
 * `sessionId` が null/undefined の場合は false（判定不能 = 一時扱いしない、fail-open ではなく単に対象外）。
 */
export function isEphemeralSessionId(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  return EPHEMERAL_SESSION_ID_PREFIXES.some((prefix) => sessionId.startsWith(prefix));
}

/** `buildEphemeralSessionIdExclusion()` の戻り値型。Prisma の `SessionWhereInput` は import せず、
 * 構造的に代入可能な最小形だけを宣言する（本モジュールの「外部 import ゼロ」規約を維持するため。
 * node:test が dist/ を直接 import するため、依存を増やすとテストが動かなくなる）。 */
export interface EphemeralSessionIdExclusion {
  NOT: { OR: Array<{ id: { startsWith: string } }> };
}

/**
 * `EPHEMERAL_SESSION_ID_PREFIXES` を Prisma の `where` にそのままスプレッドできる除外フィルタへ変換する
 * （`GET /api/threads` 等の一覧クエリ用）。生成される SQL は
 * `NOT (id LIKE 'teamexec_%' OR id LIKE 'crossquery_%' OR id LIKE 'askdesc_%')`。
 *
 * 【なぜ取得後フィルタではダメか】`sessions.filter(s => !isEphemeralSessionId(s.id))` のように
 * LIMIT の後で削ると「除外された件数だけ一覧が短くなる」欠落バグになる。
 * 一覧クエリでは必ず本関数を where に入れ、`isEphemeralSessionId` は
 * 「手元にある1件の id を判定する」用途にだけ使うこと。
 *
 * 呼び出しごとに新しいオブジェクトを返す（呼び出し側が where に混ぜて変形しても
 * プレフィックス定義が共有ミュータブル状態として壊れないようにするため）。
 */
export function buildEphemeralSessionIdExclusion(): EphemeralSessionIdExclusion {
  return {
    NOT: { OR: EPHEMERAL_SESSION_ID_PREFIXES.map((prefix) => ({ id: { startsWith: prefix } })) },
  };
}

/** 対話経路でのスレッド新規作成時に agentScopeId をどう決めるかの入力。 */
export interface DecideNewSessionScopeIdInput {
  /** 新規作成される Session 自身の id（scope dir 名として使う） */
  newSessionId: string;
  /** 対話経路の scope 採番を有効にするかのキルスイッチ（`DEVRELAY_THREADS_SCOPE_INTERACTIVE`） */
  interactiveScopeEnabled: boolean;
}

/**
 * 対話経路（`//connect` 等）で新規スレッドを作るときの `agentScopeId`（DB 保存値）を決定する。
 * - キルスイッチ OFF なら常に null（従来どおり `.devrelay/` 直下を共有する既定スレッド）
 * - ON なら新規 Session 自身の id を scope として採用する（spec §1: 1 スレッド = 1 scope dir）
 *
 * 既存セッションの再開・復元にはこの関数を使わない
 * （`inheritScopeForReestablishedSession` を使うこと。新規採番と継承を混同すると
 * 「agent 再起動のたびに scope が変わりスレッドが分裂する」バグ（R2）を作り込む）。
 */
export function decideNewSessionScopeId(input: DecideNewSessionScopeIdInput): string | null {
  if (!input.interactiveScopeEnabled) return null;
  return input.newSessionId;
}

/**
 * DB に保存されている `agentScopeId`（string | null）を、agent へ送る wire payload の
 * `agentScopeId` フィールド（string | undefined）に変換する。
 *
 * `null`（既存行・従来スレッド）は `undefined` にする。JSON payload では `undefined` の
 * プロパティは送出時に落ちる（あるいは明示的に省略される）ため、agent 側は「フィールドが無い」
 * ことを従来どおり「`.devrelay/` 直下を使え」と解釈できる。
 *
 * これが「NULL を推測で埋めない」不変条件の唯一の実装点。
 */
export function resolveOutboundAgentScopeId(
  storedAgentScopeId: string | null | undefined
): string | undefined {
  if (storedAgentScopeId === null || storedAgentScopeId === undefined) return undefined;
  return storedAgentScopeId;
}

/** agent 再起動等でセッションを再確立するときの scope 継承の入力。 */
export interface InheritScopeForReestablishedSessionInput {
  /** 再確立前の（元の）Session の `agentScopeId` */
  oldAgentScopeId: string | null;
}

/**
 * agent 再起動時にセッションを再作成する経路（`command-handler.ts` の resumeFailed 再作成箇所等）で、
 * 新しい Session 行に引き継ぐべき `agentScopeId` を決定する。
 *
 * 常に「元の値をそのまま引き継ぐ」。新規採番は絶対に行わない
 * （新規採番してしまうと、同じスレッドの会話が agent 再起動のたびに別の state dir に分裂する = R2）。
 * `oldAgentScopeId` が null（従来スレッド）なら null のまま引き継ぐ
 * （= 「NULL から非NULLへ移行させない」というバックフィル禁止の不変条件を、
 * 再確立の経路でも同じ関数で担保する）。
 */
export function inheritScopeForReestablishedSession(
  input: InheritScopeForReestablishedSessionInput
): string | null {
  return input.oldAgentScopeId;
}
