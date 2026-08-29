/**
 * #332: plan モードの canUseTool 判定を切り出した純関数群。
 * 外部 import ゼロ（node:test から直接 dist/ を import してテストするため）。
 * ai-runner.ts はこのモジュールをインポートして使用し、ロジックの重複を作らない。
 */

/**
 * 単一のルール文字列がツール呼び出しにマッチするかを判定する。
 * ルール形式:
 * - "ToolName": ツール名完全一致（Edit, Read, Write, Glob, Grep 等）
 * - "Bash(cmd)": Bash コマンドの完全一致
 * - "Bash(cmd *)": Bash コマンドの前方一致（cmd 自体、または "cmd " で始まるコマンド）
 * @returns マッチした場合 true
 */
export function matchesToolRule(rule: string, toolName: string, input: Record<string, unknown>): boolean {
  // "ToolName" 形式: ツール名完全一致
  if (!rule.includes('(')) {
    return toolName === rule;
  }

  // "Bash(cmd *)" / "Bash(cmd)" 形式: Bash コマンドのパターンマッチ
  const match = rule.match(/^(\w+)\((.+)\)$/);
  if (!match) return false;
  const [, ruleToolName, rulePattern] = match;
  if (toolName !== ruleToolName) return false;

  if (toolName === 'Bash' && typeof input.command === 'string') {
    const command = input.command.trim();
    if (rulePattern.endsWith(' *')) {
      const prefix = rulePattern.slice(0, -2);
      return command === prefix || command.startsWith(prefix + ' ');
    }
    return command === rulePattern;
  }
  return false;
}

/**
 * ルール配列（plan モードの allowedTools 等）に対してツール呼び出しがマッチするかを判定する。
 * @returns マッチした場合 true
 */
export function isAllowedByRules(rules: string[] | undefined, toolName: string, input: Record<string, unknown>): boolean {
  if (!rules || rules.length === 0) return false;
  for (const rule of rules) {
    if (matchesToolRule(rule, toolName, input)) return true;
  }
  return false;
}

/** decidePlanPermission の判定結果 */
export type PlanPermissionDecision =
  | { behavior: 'allow' }
  | { behavior: 'deny'; reason: string };

/**
 * plan モードの canUseTool 相当の判定（AskUserQuestion / ExitPlanMode の特別扱いは
 * 呼び出し側で先に処理する前提。この関数はそれ以外の通常ツールのみを対象とする）。
 *
 * - strictReadonly=true: readonlyTools（PLAN_READONLY_TOOLS 相当）または allowedTools（Bash パターン）
 *   にマッチしないツールは、skipPermissions の値に関係なく deny する（reason: 'planPolicy'）
 * - strictReadonly=false: 従来どおり allow（skipPermissions の値に関係なく plan モードのデフォルト動作。
 *   実際の SDK 側では allowedTools が別途 --allowedTools として渡され、UI 上でのプロンプト有無に影響するが、
 *   canUseTool のフォールスルー自体は allow のまま。詳細は ai-runner.ts のコメント参照）
 */
export function decidePlanPermission(params: {
  toolName: string;
  input: Record<string, unknown>;
  strictReadonly: boolean;
  allowedTools?: string[];
  readonlyTools?: string[];
  skipPermissions: boolean;
}): PlanPermissionDecision {
  if (params.strictReadonly) {
    const allowed =
      (params.readonlyTools ?? []).includes(params.toolName) ||
      isAllowedByRules(params.allowedTools, params.toolName, params.input);
    return allowed ? { behavior: 'allow' } : { behavior: 'deny', reason: 'planPolicy' };
  }
  return { behavior: 'allow' };
}
