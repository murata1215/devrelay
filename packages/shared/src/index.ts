export * from './types.js';
// #309/#310: constants.js は `export *` ではなく明示的な named export にする。
// tsc の CJS 出力（`export *` → `__exportStar` ヘルパーの実行時ループ）は
// Rollup/Vite の commonjs プラグインが静的解析できず、named import が
// "not exported by ..." で消えることがある（dist(CJS) を直接バンドルする経路向けの保険）。
// ただし apps/web の実際の障害の真因はこれではなく、pnpm workspace のシンボリックリンクが
// node_modules の外を指すため Vite の commonjsOptions.include（既定 [/node_modules/]）に
// 掛からず CJS が一切変換されず require() がそのまま残ったことだった（#310 で判明）。
// apps/web 側は vite.config.ts の resolve.alias で src（TS ソース）を直接参照する方式に
// 変更済みなのでこの問題自体を回避しているが、将来 dist(CJS) を直接バンドルする経路が
// 増えた場合に備え、named export 化はそのまま残す。
export {
  SHORTCUTS,
  AI_TOOL_NAMES,
  type ModelOption,
  type ModelSelectableAiTool,
  AI_MODEL_CATALOG,
  UTILITY_MODEL_ANTHROPIC,
  isUnsafeModelId,
  isModelSelectableAiTool,
  STATUS_EMOJI,
  DEFAULT_ALLOWED_TOOLS_LINUX,
  DEFAULT_ALLOWED_TOOLS_WINDOWS,
  PLAN_READONLY_TOOLS,
  PLAN_READONLY_BASH_COMMANDS,
  PLAN_WRITE_BASH_COMMANDS,
  PLAN_WRITE_TOOLS,
  type ScaffoldTemplateOs,
  type ScaffoldTemplateDef,
  SCAFFOLD_TEMPLATE_DEFS,
  getScaffoldTemplateDef,
  DEFAULTS,
} from './constants.js';
export * from './token.js';
export * from './text.js';
export { redactChatInput } from './redact.js';
// #316: i18n.ts も #309/#310 と同じ理由で明示的 named export にする（export * の CJS 変換問題を回避）
export {
  type Language,
  DEFAULT_CHAT_LANGUAGE,
  isLanguage,
  chatMessages,
  type ChatMessageKey,
  tChat,
  getWCommandPrompt,
  W_COMMAND_PROMPT_PREFIXES,
} from './i18n.js';
// manager.devrelay.io へのログイン後リダイレクト用純粋関数（同じ理由で明示的 named export）
export {
  type ManagerRedirectTarget,
  resolveNextTarget,
  buildManagerTokenUrl,
  isManagerRedirectEnabled,
} from './manager-redirect.js';
