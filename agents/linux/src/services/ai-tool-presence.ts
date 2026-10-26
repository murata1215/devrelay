/**
 * AI ツールの「実在判定」に使う純関数群（Devin 専用端末で `a 1` しないと devin が選ばれない問題の対策）。
 *
 * 背景: 従来の `getAvailableAiTools()`（`connection.ts`）は **config.yaml に `aiTools.<tool>` の
 * エントリがあるか** だけで「インストール済み」と判定していた。インストーラは AI CLI を 1 つも検出
 * できないと（Linux で devin が `~/.local/bin` にあり PATH に無い／Windows で devin を入れた直後の
 * 同じ PowerShell で PATH 未反映 等）従来互換のため `default: claude` + `claude:` エントリを書くため、
 * 起動時の自動検出が devin を追加しても claude エントリが残り、available=[claude, devin] と申告される。
 * その結果、要求 'claude'（Project.defaultAi の既定）が「実在」と判定されて尊重され、Claude 未ログインで
 * 止まり `a 1` が必要になっていた。
 *
 * 本モジュールは外部 import ゼロ（同じく外部 import ゼロの locator 2 本のみ）に保ち、コンパイル済み dist を
 * 直接 `node --test` から import して単体検証できるようにする（claude-locator.ts / devin-locator.ts と同じ流儀）。
 * `agents/macos` は本ファイルと byte-identical。
 */
import { claudeFallbackCandidates } from './claude-locator.js';
import { devinFallbackCandidates } from './devin-locator.js';

/** インストーラ（install-agent.sh / .ps1）と同じ優先順。default の自動差し替えに使う。 */
export const AI_TOOL_PRIORITY = ['claude', 'devin', 'gemini', 'codex', 'aider'] as const;

/**
 * PATH で見つからなかったときに試す絶対パス候補を返す。
 * claude / devin は既存の locator の候補をそのまま使い、それ以外は `~/.local/bin`（Windows は npm グローバル）を見る。
 * @param tool AI ツール名（'claude' | 'devin' | 'gemini' | 'codex' | 'aider'）
 * @param command config.yaml の `aiTools.<tool>.command`（通常はツール名と同じ）
 * @param platform `process.platform` の値
 * @param home ホームディレクトリ
 * @param execDir 2026-10-26 追加: Agent 自身を起動している node（`process.execPath`）の bin
 *   ディレクトリ。nvm 等でグローバルインストールした AI CLI（codex 等）はその node バージョン
 *   専用の bin にしかないため、他の候補より先に見る（省略可。既存呼び出し元との後方互換用）。
 */
export function aiToolFallbackCandidates(tool: string, command: string, platform: string, home: string, execDir?: string): string[] {
  const execCandidate = execDir ? [platform === 'win32' ? `${execDir}\\${command}.cmd` : `${execDir}/${command}`] : [];
  if (tool === 'claude' && command === 'claude') return [...execCandidate, ...claudeFallbackCandidates(platform, home)];
  // macOS の launchd 起動では PATH に Homebrew が入らないことがあるため /opt/homebrew/bin も見る
  const homebrew = platform === 'darwin' ? [`/opt/homebrew/bin/${command}`] : [];
  if (tool === 'devin' && command === 'devin') return [...execCandidate, ...devinFallbackCandidates(platform, home), ...homebrew];
  if (platform === 'win32') {
    return [
      ...execCandidate,
      `${home}\\AppData\\Roaming\\npm\\${command}.cmd`,
      `${home}\\.local\\bin\\${command}.exe`,
    ];
  }
  return [...execCandidate, `${home}/.local/bin/${command}`, ...homebrew, `/usr/local/bin/${command}`];
}

/**
 * コマンド文字列が絶対パス（またはパス区切りを含む相対パス）かどうか。
 * true の場合は PATH 検索せず、そのパスの存在確認だけで判定する。
 */
export function isPathLikeCommand(command: string): boolean {
  return command.includes('/') || command.includes('\\');
}

/**
 * config に書かれたツールのうち実在するものだけを残す。
 * 1 つも実在しない場合は **config のまま返す**（判定ミスで全ツールが消えて何も起動できなくなる事故を防ぐ後方互換）。
 * @param configured config.yaml にエントリのあるツール（順序は保持される）
 * @param isPresent 実在判定関数
 */
export function filterPresentAiTools<T extends string>(configured: readonly T[], isPresent: (tool: T) => boolean): T[] {
  const present = configured.filter(isPresent);
  return present.length > 0 ? present : [...configured];
}

/**
 * `aiTools.default` を差し替えるべきなら新しい値を返す（不要なら null）。
 * - 現在の default が実在ツールに含まれる → null（ユーザー設定を尊重）
 * - 実在ツールが無い → null（情報が無いのに上書きしない）
 * - それ以外 → 実在ツールのうち AI_TOOL_PRIORITY 順で最初のもの
 * @param currentDefault 現在の `aiTools.default`
 * @param present 実在すると判定されたツール
 */
export function pickReplacementDefaultAiTool(currentDefault: string | undefined, present: readonly string[]): string | null {
  if (present.length === 0) return null;
  if (currentDefault && present.includes(currentDefault)) return null;
  for (const t of AI_TOOL_PRIORITY) {
    if (present.includes(t)) return t;
  }
  return present[0];
}
