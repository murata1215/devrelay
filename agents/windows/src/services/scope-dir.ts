import { resolve, sep } from 'path';

/**
 * core#336: MCP submission 単位の会話セッション境界を実現するスコープディレクトリ解決モジュール。
 *
 * `submit_instruction`（MCP）は毎回新規セッションを作るが、Agent 側の状態（`.devrelay/` 直下の
 * `claude-session-id` / `conversation.json` 等）はプロジェクト単位で共有されている。そのため
 * 同一プロジェクトへの並行 submission が resume 先や会話履歴を取り違える事故が起きる
 * （2026-09-01 の輻輳事故と同根、`session-scope.ts` の JSDoc も参照）。
 *
 * 対策として `agentScopeId`（= MCP submissionId）が指定された場合のみ
 * `<projectPath>/.devrelay/sessions/<agentScopeId>/` という専用ディレクトリを使う。
 * `agentScopeId` 未指定（対話経路 = WebUI/Discord/Telegram/LINE）は従来どおり
 * `<projectPath>/.devrelay/` 直下のまま＝挙動無変更。
 *
 * `session-scope.ts` は「外部 import ゼロの純関数のみで構成する」という既存の強い規約
 * （#332 `plan-permission.ts` 等と同じ流儀）を持つため、`path` モジュールを要する本モジュールは
 * あえて別ファイルに分離した（session-scope.ts の既存 3 関数は無変更を維持するため）。
 *
 * `agents/linux` と `agents/macos` と `agents/windows` で byte-for-byte 同一内容を維持すること。
 */

/** スコープ用ディレクトリ名（`.devrelay/` の下に作る） */
const SCOPED_SESSIONS_DIR = 'sessions';

/**
 * agentScopeId が安全な識別子かどうかを検証する。
 * 英数字・アンダースコア・ハイフンのみ、1〜128 文字。
 * この文字集合には `/` `\` `.` が含まれないため、この時点で単純なパストラバーサル
 * （`../` 等）は構文的に不可能になる。
 *
 * @param agentScopeId 検証対象の文字列
 */
export function isValidAgentScopeId(agentScopeId: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(agentScopeId);
}

/**
 * プロジェクトパスと agentScopeId から、実際に読み書きに使うディレクトリを解決する。
 *
 * - `agentScopeId` 未指定 → `<projectPath>/.devrelay/`（従来どおり。対話経路はここに落ちる）
 * - `agentScopeId` 指定あり → `<projectPath>/.devrelay/sessions/<agentScopeId>/`
 *
 * 検証は二重に行う（正規表現だけに依存しないパストラバーサル防御）:
 * 1. `isValidAgentScopeId()` に一致しなければ `throw`
 * 2. `resolve()` 後のパスが `<projectPath>/.devrelay/sessions/` 配下に収まっていることを検証
 *
 * @param projectPath プロジェクトのルートパス
 * @param agentScopeId MCP submissionId 等のスコープ識別子（省略時は従来のプロジェクト単位スコープ）
 * @throws agentScopeId が不正な形式、またはトラバーサルにより配下から逸脱する場合
 */
export function resolveScopeDir(projectPath: string, agentScopeId?: string): string {
  if (agentScopeId === undefined) {
    return resolve(projectPath, '.devrelay');
  }

  if (!isValidAgentScopeId(agentScopeId)) {
    throw new Error(`resolveScopeDir: invalid agentScopeId (must match ^[A-Za-z0-9_-]{1,128}$): ${agentScopeId}`);
  }

  const scopedRoot = resolve(projectPath, '.devrelay', SCOPED_SESSIONS_DIR);
  const scopedDir = resolve(scopedRoot, agentScopeId);

  // 正規表現だけに依存しない traversal 防御（resolve 後のパスが scopedRoot 配下にあるかを確認）
  if (scopedDir !== scopedRoot && !scopedDir.startsWith(scopedRoot + sep)) {
    throw new Error(`resolveScopeDir: agentScopeId resolves outside of scoped root: ${agentScopeId}`);
  }

  return scopedDir;
}
