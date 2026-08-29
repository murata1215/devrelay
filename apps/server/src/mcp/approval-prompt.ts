/**
 * #331: approve_implementation の note を exec プロンプトへ組み込む純粋関数。
 *
 * 外部 import ゼロ（DB/ネットワーク非依存）に保ち、コンパイル済み dist を直接
 * `node --test` から import して単体検証できるようにする（#308 のスタンドアロン
 * スモークテストと同じ流儀）。
 */

/** MCP 承認時の既定 exec プロンプト（従来のハードコード文字列と 1 バイト同一） */
export const DEFAULT_APPROVAL_EXEC_PROMPT = 'プランに従って実装を開始してください。';

/**
 * 承認時の exec プロンプトを組み立てる。
 *
 * note が未指定、または空白のみの場合は既定文字列をそのまま返す
 * （= 呼び出し元から見て従来の挙動と完全同形）。
 * note が指定された場合は、既定文の直後に「人間からの追記」であることが
 * 明確にわかる見出し付きセクションとして追記する。
 *
 * @param note approve_implementation で渡された任意の追記テキスト
 */
export function buildApprovalExecPrompt(note?: string): string {
  const trimmed = note?.trim();
  if (!trimmed) return DEFAULT_APPROVAL_EXEC_PROMPT;
  return `${DEFAULT_APPROVAL_EXEC_PROMPT}\n\n## 承認時の人間からの追記\n${trimmed}`;
}
