/**
 * core#383: 端末モード（PTY）の Claude セッション ID にまつわる決定ロジックを切り出した
 * 純関数モジュール（外部 import ゼロ）。resume-priority.ts / running-code-stale.ts と同じ流儀。
 *
 * 背景: `terminal-runner.ts` は完了報告に AI セッション ID を一切載せておらず、
 * `Session.planAiSessionId` が NULL のままとなって `approve_implementation` が
 * `planAiSessionMissing` で fail-closed していた（#383 の真因）。
 * 修正方針は「resume するなら --resume、しないなら必ず UUID を採番して --session-id」。
 *
 * **重要: このファイルは agents/linux 専用。** `terminal-runner.ts` が agents/linux にしか
 * 存在しないため（macOS/Windows Agent は PTY 経路自体を持たない）、他 OS 向けの
 * twin ファイルは存在しない。resume-priority.ts のように 3 OS へコピーしてはいけない。
 */

/** `runTerminalClaude` の argv に渡すべきフラグの決定結果 */
export interface TerminalSessionArgs {
  /** '--resume' / '--session-id' のどちらを渡すか。両方省略時は新規セッション（CLI 任せ）で null */
  flag: '--resume' | '--session-id' | null;
  /** flag が null でない場合の値 */
  value?: string;
}

/**
 * argv に渡す `--resume` / `--session-id` を決定する（相互排他）。
 *
 * Claude CLI は「--session-id can only be used with --continue or --resume if
 * --fork-session is also specified.」で両方の同時指定を拒否するため、
 * `resumeSessionId` を優先し、それが無い場合のみ `newSessionId` を使う。
 *
 * @param input.resumeSessionId resume 先セッション ID（decideResume() の結果）
 * @param input.newSessionId 新規セッション用に事前採番した UUID
 */
export function decideTerminalSessionArgs(input: {
  resumeSessionId?: string;
  newSessionId?: string;
}): TerminalSessionArgs {
  if (input.resumeSessionId) {
    return { flag: '--resume', value: input.resumeSessionId };
  }
  if (input.newSessionId) {
    return { flag: '--session-id', value: input.newSessionId };
  }
  return { flag: null };
}

/**
 * 完了報告でサーバーへエコーバックする aiSessionId を決定する。
 *
 * 優先順位: 「採番した ID（--session-id で確実に使われた）」→「resume 指定した ID
 * （CLI が維持する）」→「画面スクレイプで拾えた ID（旧 CLI 用フォールバック）」。
 * `promptSent === false`（起動失敗等）の場合は常に undefined を返す
 * （#237 の「壊れたセッション ID 残留」防止と同じ理由で fail-closed にする）。
 *
 * @param input.promptSent プロンプトが実際に Claude CLI へ送信されたか
 * @param input.newSessionId 今回 --session-id で渡した UUID（渡していなければ省略）
 * @param input.resumeSessionId 今回 --resume で渡したセッション ID（渡していなければ省略）
 * @param input.scrapedSessionId 画面スクレイプ（extractClaudeSessionIdFromBuffer）で拾えた ID
 */
export function resolveTerminalAiSessionId(input: {
  promptSent: boolean;
  newSessionId?: string;
  resumeSessionId?: string;
  scrapedSessionId?: string;
}): string | undefined {
  if (!input.promptSent) {
    return undefined;
  }
  return input.newSessionId || input.resumeSessionId || input.scrapedSessionId || undefined;
}

/** classifyTerminalStartupFailure() の分類結果 */
export type TerminalStartupFailureKind =
  /** 旧 CLI（--session-id 未対応）が unknown option 等でフラグ自体を拒否した */
  | 'legacy-session-id-unsupported'
  /** 採番した UUID が既に使用中（クラッシュ後の再送信など、通常はリトライで別 UUID を採番すれば自己修復する） */
  | 'session-id-already-in-use'
  /** 上記以外の失敗（判別不能。通常の早期 exit リトライ経路に任せる） */
  | 'other';

/**
 * PTY の画面出力（またはプロセスの stderr 相当）から、`--session-id` 起因の起動失敗かどうかを分類する。
 *
 * `promptSent === false` かつ `--session-id` を渡していた場合にのみ呼び出す想定
 * （呼び出し側で `newSessionId` を渡したかどうかのガードを行う）。
 * 旧 CLI 判定時、呼び出し側は以後のターンで legacy argv（`--session-id` を渡さない）に
 * フォールバックすることで自己修復する。
 *
 * @param screenOutput PTY の最終画面バッファ（finalOutput）
 */
export function classifyTerminalStartupFailure(screenOutput: string): TerminalStartupFailureKind {
  const text = screenOutput || '';
  // Claude CLI 実測（v2.1.263）の検証文言: 排他違反 / 未知フラグ拒否
  if (
    /unknown option ['"]?--session-id['"]?/i.test(text) ||
    /unknown option ['"]?--fork-session['"]?/i.test(text) ||
    /--session-id can only be used with --continue or --resume/i.test(text)
  ) {
    return 'legacy-session-id-unsupported';
  }
  // Claude CLI 実測: 既存 ID の再指定エラー
  if (/is already in use/i.test(text)) {
    return 'session-id-already-in-use';
  }
  return 'other';
}

/**
 * 文字列が UUID v4 形式（大まかな構文チェックのみ、バージョン/バリアントビットまでは検証しない）かを判定する。
 * `crypto.randomUUID()` の出力形式検証や、テストでの入力バリデーションに使う。
 */
export function isUuidV4Like(value: string | undefined | null): boolean {
  if (!value || typeof value !== 'string') {
    return false;
  }
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
