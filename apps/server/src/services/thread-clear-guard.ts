/**
 * スレッド管理 cycle2: `x`（会話クリア）を agent に送ってよいかどうかを判定する純関数群。
 * 外部 import は同ディレクトリの `thread-scope.js` のみ（`node:test` から dist/ を直接 import する
 * cycle1 の流儀を踏襲）。
 *
 * 背景: cycle1（`93b0e91`）で `Session.agentScopeId` によるスレッド化を導入したが、
 * agent 側の `handleConversationClear` が `agentScopeId` を解釈できるようになるまでは、
 * scoped スレッドで `x` を実行すると agent が `.devrelay/` 直下（無関係な既定スレッドの状態）を
 * 消してしまう事故が起きる（cycle1 の暫定 fail-closed ガードの理由）。
 * cycle2 で agent 側が対応したため、ここでは「agent がその対応版かどうか（capability 申告）」を
 * 見て、対応済みなら scoped クリアを許可し、未対応なら引き続き fail-closed にする。
 */

import { resolveOutboundAgentScopeId } from './thread-scope.js';

/** `decideClearDispatch` の判定結果。 */
export type ClearDispatchDecision =
  | { allowed: true; outboundAgentScopeId: string | undefined }
  | { allowed: false; reason: 'agent-capability-missing' };

/** `decideClearDispatch` の入力。 */
export interface DecideClearDispatchInput {
  /** DB に保存されている Session.agentScopeId（既定スレッドは null） */
  storedAgentScopeId: string | null | undefined;
  /** 接続中の agent が 'scoped-clear' capability を申告しているか */
  agentSupportsScopedClear: boolean;
}

/**
 * `x`（会話クリア）を agent に送ってよいかと、載せる agentScopeId を決める。
 *
 * - 既定スレッド（stored=null/undefined）: capability の有無に関わらず常に許可する
 *   （agent 側は agentScopeId 未指定を「.devrelay/ 直下」と解釈するため、未対応の
 *   旧 agent に送っても従来どおり動作し、何も壊れない）。
 * - scoped スレッド + capability あり: 許可し、その scope を載せる。
 * - scoped スレッド + capability なし: fail-closed で拒否する
 *   （未更新の agent にそのまま送ると agentScopeId を無視して既定スレッドを巻き添えにするため）。
 *
 * `outboundAgentScopeId` の算出は既存の `resolveOutboundAgentScopeId()` を再利用する
 * （「DB の NULL → wire 上で送らない」という不変条件の唯一の実装点を迂回しないため）。
 */
export function decideClearDispatch(input: DecideClearDispatchInput): ClearDispatchDecision {
  const { storedAgentScopeId, agentSupportsScopedClear } = input;

  if (storedAgentScopeId === null || storedAgentScopeId === undefined) {
    return { allowed: true, outboundAgentScopeId: resolveOutboundAgentScopeId(storedAgentScopeId) };
  }

  if (!agentSupportsScopedClear) {
    return { allowed: false, reason: 'agent-capability-missing' };
  }

  return { allowed: true, outboundAgentScopeId: resolveOutboundAgentScopeId(storedAgentScopeId) };
}
