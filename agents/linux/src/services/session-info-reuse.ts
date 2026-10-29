/**
 * `server:session:start` 受信時に、既存の SessionInfo を使い回すかの判定（2026-10-29 Devin 記憶喪失事故の再発防止）。
 *
 * サーバーは Agent の WS 再接続を検知すると、次のプロンプト直前に `server:session:start` を再送する
 * （apps/server/src/services/agent-manager.ts の needsSessionRestart）。Agent プロセスが再起動しておらず
 * 同じ sessionId の SessionInfo が既にメモリにある場合、従来は handleSessionStart が
 * ファイルから読み直した履歴で SessionInfo を丸ごと置き換えていた。
 * 直後に並行で走る handleAiPrompt と競合すると、書きかけのファイルを読んで履歴 0 件の SessionInfo に
 * 差し替わり、次のターンで Devin 等に履歴が渡らない（＋ 2 件で上書きされる）事故になった。
 *
 * 既存の SessionInfo が同じ会話（同じ projectPath・同じ agentScopeId）を指している場合は
 * 置き換えずに使い回す。一時セッション（crossquery_/teamexec_/askdesc_）は従来どおり毎回作り直す。
 */
export interface ReusableSessionInfoLike {
  projectPath: string;
  agentScopeId?: string;
}

export function canReuseSessionInfo(
  existing: ReusableSessionInfoLike | undefined,
  request: { projectPath: string; agentScopeId?: string; isEphemeral: boolean },
): boolean {
  if (!existing) return false;
  if (request.isEphemeral) return false;
  if (existing.projectPath !== request.projectPath) return false;
  if ((existing.agentScopeId ?? undefined) !== (request.agentScopeId ?? undefined)) return false;
  return true;
}
