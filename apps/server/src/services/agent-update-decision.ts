/**
 * `u`（Agent 更新コマンド）1 回目に何を提示するかを決める判定ロジック（#350）。
 *
 * 背景: git commit は最新でもビルドが失敗し dist/ が再ビルドされないまま古い
 * Agent プロセスが動き続ける「stale dist デッドロック」（#256/#302/#319 で検知のみ実装済み）
 * が発生すると、従来の `handleUpdate()` は `hasUpdate === false` の分岐に入り
 * 「最新です」＋「再ビルドしてください」という警告文だけを返して終わっていた。
 * 再ビルドを実行する手段（`updateAgent()`）自体は既に存在するが、`hasUpdate === true`
 * の分岐からしか呼ばれておらず、stale dist のケースでは呼び出す経路が無かった。
 *
 * この判定関数は「git は最新だが実行中コードが古い」ケースを検出し、
 * `handleUpdate()` が `'update'` と同じ `pendingUpdate` フローに乗せられるようにする
 * （新しい WS メッセージ型・新コマンドは追加しない）。
 *
 * 外部 import ゼロに保ち、コンパイル済み dist を直接 `node --test` から import して
 * 単体検証できるようにする（progress-timeout.ts / cross-query-guard.ts と同じ流儀）。
 */

/** handleUpdate() の 1 回目が提示すべきアクション */
export type AgentUpdateAction = 'update' | 'rebuild' | 'upToDate';

export interface AgentUpdateDecisionInput {
  /** サーバー側 checkAgentVersion() の hasUpdate（リモートコミットと差分があるか） */
  hasUpdate: boolean;
  /**
   * 実行中エントリファイルの mtime がローカルコミットより古いか（#302 の三値分岐）。
   * `undefined` は旧 Agent（この情報を送ってこない）や判定不能を意味し、fail-open で
   * 'upToDate' 側に倒す（既存挙動を壊さない）。
   */
  runningCodeStale?: boolean;
}

/**
 * 判定順（この順序を変えないこと）:
 * 1. hasUpdate === true → 'update'（従来どおり。更新すれば build も走るため stale も同時に解消される）
 * 2. hasUpdate === false && runningCodeStale === true → 'rebuild'（新設: 再ビルドのみ実行）
 * 3. それ以外（runningCodeStale が undefined の旧 Agent 含む）→ 'upToDate'（#302 と同じ fail-open）
 */
export function decideUpdateAction(input: AgentUpdateDecisionInput): AgentUpdateAction {
  if (input.hasUpdate) {
    return 'update';
  }
  if (input.runningCodeStale === true) {
    return 'rebuild';
  }
  return 'upToDate';
}
