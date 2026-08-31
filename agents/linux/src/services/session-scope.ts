/**
 * セッションの「一時性」を判定する純関数（#348 層 B: Agent 側の直交化）。
 *
 * クロスプロジェクト連携（ask-member / teamexec-member）や WebUI のプロジェクト説明生成は、
 * 呼び出し元セッションと同じ projectPath 上で **一時的に** 動くだけのセッションであり、
 * 対話セッション（人間が使い続けるセッション）と同じ `.devrelay/claude-session-id` /
 * `.devrelay/conversation.json` を読み書きしてはならない。読み書きすれば同一 projectPath を
 * 複数セッションが同時に read-modify-write することになり、resume 先の取り違えや
 * 会話履歴の lost update（2026-09-01 の輻輳事故で実測: 83→82→81 件と減っていく）を引き起こす。
 *
 * 外部 import ゼロの純関数のみで構成する（#332 `permission-policy.ts` / #337 `progress-timeout.ts` /
 * #339 `claude-login-code.ts` / #348 `cross-query-guard.ts` と同じ流儀）。
 * `agents/linux` と `agents/macos` で byte-for-byte 同一内容を維持すること。
 */

export type SessionScope = 'interactive' | 'crossQuery' | 'teamExec' | 'askDesc';

/**
 * sessionId のプレフィックスからセッションの種別を判定する。
 *
 * - `crossquery_` : ask-member（クロスプロジェクト問い合わせ）
 * - `teamexec_`    : teamexec-member（クロスプロジェクト実行依頼）
 * - `askdesc_`     : WebUI のプロジェクト説明生成（AI に1回だけ聞くだけの使い捨てセッション）
 * - それ以外        : 対話セッション（人間が継続して使うセッション）
 *
 * @param sessionId 判定対象のセッション ID
 */
export function classifySessionScope(sessionId: string): SessionScope {
  if (sessionId.startsWith('crossquery_')) return 'crossQuery';
  if (sessionId.startsWith('teamexec_')) return 'teamExec';
  if (sessionId.startsWith('askdesc_')) return 'askDesc';
  return 'interactive';
}

/**
 * 一時セッション（projectPath 上の永続状態を読み書きしてはいけないセッション）かどうかを判定する。
 *
 * @param sessionId 判定対象のセッション ID
 */
export function isEphemeralSession(sessionId: string): boolean {
  return classifySessionScope(sessionId) !== 'interactive';
}

/**
 * ログ表示用のラベルを返す（既存の `CROSS-QUERY` / `TEAM-EXEC` 表記と互換の大文字ハイフン区切り）。
 *
 * @param scope 表示対象のスコープ
 */
export function sessionScopeLabel(scope: SessionScope): string {
  switch (scope) {
    case 'crossQuery':
      return 'CROSS-QUERY';
    case 'teamExec':
      return 'TEAM-EXEC';
    case 'askDesc':
      return 'ASK-DESC';
    case 'interactive':
      return 'INTERACTIVE';
  }
}
