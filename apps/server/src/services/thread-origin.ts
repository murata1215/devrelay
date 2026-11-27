/**
 * スレッドの作成元を正規化する。外部 import を持たず、HTTP 入力の検証と DB 条件の
 * 組み立てを一箇所に集約する。
 */
export type ThreadOrigin = 'interactive' | 'mcp';

/** 未指定は全件。未知の値は API で 400 にするため null を返す。 */
export function parseThreadOrigin(value: string | undefined): ThreadOrigin | undefined | null {
  if (value === undefined) return undefined;
  if (value === 'interactive' || value === 'mcp') return value;
  return null;
}
