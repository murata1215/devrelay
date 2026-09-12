/**
 * #332: MCP plan / チャット / exec の経路ごとに permissionPolicy を組み立てる純関数群。
 * 外部 import ゼロ（node:test から直接 dist/ を import してテストするため）。
 * mcp/tools.ts・command-handler.ts・agent-manager.ts はこのモジュールをインポートして使用し、
 * リテラル文字列をそれぞれの呼び出し箇所に直書きしない（ロジックの重複・食い違いを防ぐ）。
 */

/**
 * permissionPolicy を決める送信経路。
 * - 'mcp': MCP submit_instruction 経由の指示投入（チャット参加者がいないため strictReadonly）
 * - 'chat': ユーザーのチャットメッセージ経由（プランターンは既定で strictReadonly。#根治サイクルで interactive から変更）
 * - 'exec': approve_implementation / e,exec 等の承認後の実装実行（人間承認済みでフル権限が仕様）
 * - 'ask': executeCrossProjectQuery（他プロジェクトへの ask/teamexec）経由のプロンプト投入。
 *   chat 同様チャット参加者による明示的な exec 承認を経ていないため strictReadonly。
 */
export type PermissionPolicySource = 'mcp' | 'chat' | 'exec' | 'ask';

/**
 * resolvePermissionPolicy の追加オプション。
 * - strictChatPlan: 'chat' 経路のみに作用するキルスイッチ。false を渡すと 'chat' は
 *   旧来の 'interactive' に戻る（fail-safe な既定値は変えず、明示的にオプトアウトしたときのみ弱める）。
 *   'mcp' を弱めることはできず、'exec' を強めることもできない（意図的にリテラル比較で分岐）。
 *   このモジュール自体は process.env を読まない（外部 import ゼロ・純関数を維持するため。
 *   キルスイッチの判定は呼び出し元 (command-handler.ts) の責務）。
 */
export interface ResolvePermissionPolicyOptions {
  strictChatPlan?: boolean;
}

/**
 * 送信経路から permissionPolicy 文字列を解決する。
 * - 'mcp' → 'strictReadonly'（plan モードで allowlist 外のツールを聞かずに deny）
 * - 'chat' → 'strictReadonly'（既定。options.strictChatPlan === false のときのみ 'interactive'）
 * - 'ask' → 'strictReadonly'（クロスプロジェクトクエリも chat と同じくチャット参加者による exec 承認を経ない）
 * - 'exec' → 'interactive'（従来どおり Machine.skipPermissions に従う。人間が exec/approve 済み）
 */
export function resolvePermissionPolicy(
  source: PermissionPolicySource,
  options?: ResolvePermissionPolicyOptions,
): string {
  if (source === 'mcp') return 'strictReadonly';
  if (source === 'ask') return 'strictReadonly';
  if (source === 'chat') {
    return options?.strictChatPlan === false ? 'interactive' : 'strictReadonly';
  }
  return 'interactive';
}
