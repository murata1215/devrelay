/**
 * 高辻ナレッジ サイクル4.5: `AnswerGuardState`（流量制御・同時実行制御の状態）をプロセス内で
 * 1 個だけ保持する（D7: 追い質問も MCP `ask_knowledge` も同じ 5 回/分・100 回/日・同時 1 を共有する）。
 *
 * サイクル4 では `routes/knowledge-api.ts` がこの state をモジュールスコープで保持していたが、
 * `mcp/tools.ts`（REST とは別の呼び出し元）からも同じ state を参照する必要が生じたため、
 * 本ファイルに切り出した。`knowledge-answer-rules.ts` は引き続きこの state を内部に隠し持たない
 * （`createAnswerGuardState()` の呼び出しは本ファイルで 1 回だけ）。
 */

import { createAnswerGuardState } from './knowledge-answer-rules.js';

export const answerGuardState = createAnswerGuardState();
