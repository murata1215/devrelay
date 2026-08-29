/**
 * #332: MCP plan / チャット / exec の経路ごとに permissionPolicy を組み立てる純関数群。
 * 外部 import ゼロ（node:test から直接 dist/ を import してテストするため）。
 * mcp/tools.ts・command-handler.ts・agent-manager.ts はこのモジュールをインポートして使用し、
 * リテラル文字列をそれぞれの呼び出し箇所に直書きしない（ロジックの重複・食い違いを防ぐ）。
 */

/**
 * permissionPolicy を決める送信経路。
 * - 'mcp': MCP submit_instruction 経由の指示投入（チャット参加者がいないため strictReadonly）
 * - 'chat': ユーザーのチャットメッセージ経由（従来どおり Machine.skipPermissions に従う）
 * - 'exec': approve_implementation / e,exec 等の承認後の実装実行（人間承認済みでフル権限が仕様）
 */
export type PermissionPolicySource = 'mcp' | 'chat' | 'exec';

/**
 * 送信経路から permissionPolicy 文字列を解決する。
 * - 'mcp' → 'strictReadonly'（plan モードで allowlist 外のツールを聞かずに deny）
 * - 'chat' / 'exec' → 'interactive'（従来どおり Machine.skipPermissions に従う）
 */
export function resolvePermissionPolicy(source: PermissionPolicySource): string {
  if (source === 'mcp') return 'strictReadonly';
  return 'interactive';
}
