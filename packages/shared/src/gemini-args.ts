/**
 * Gemini CLI の承認モード関連フラグ（`--approval-mode` / `--yolo` / `-m,--model`）および
 * セッション関連フラグ（`--session-id` / `-r,--resume`）の対応可否判定と、
 * plan/exec ターンに応じた argv 決定を行う純粋関数群。
 *
 * 2026-10-27: `agents/{linux,macos,windows}/src/services/ai-runner.ts` の gemini 分岐が、
 * `probeGeminiCapabilities()` で `--approval-mode` の対応可否を判定しているにもかかわらず、
 * plan ターン（および yolo 系フラグに非対応の場合）の else 節では判定結果を一切見ずに
 * `--approval-mode auto_edit` をハードコードしていた。`--approval-mode` 自体が存在しない
 * 旧 CLI ではこれが `Unknown arguments: approval-mode, approvalMode`（yargs strict）で
 * exit 1・stdout 空となり、会話が一度も成立しなかった（gemini-user 機体で発覚）。
 *
 * 2026-10-27 サイクル2: MCP `approve_implementation` が gemini だけ `planAiSessionMissing` で
 * fail-closed する問題の根治（真因: gemini 分岐が AI セッション ID の概念を一切持たず、
 * `result.extractedSessionId` を一度も設定しない）。claude 端末モード core#383 と同じ
 * 「resume するなら --resume、しないなら UUID を事前採番して --session-id」パターンを
 * `buildGeminiSessionArgs()` / `resolveGeminiAiSessionId()` / `classifyGeminiSessionFailure()` として追加した。
 *
 * ここでは Node API に依存しない純粋関数として切り出し、3 エージェントでのコピペ実装を解消し、
 * `node --test` で実ヘルプ fixture ベースの決定表テストを可能にする
 * （`capability-rules.ts` / `service-path-rules.ts` と同じ「純粋 rules モジュール」方針）。
 */

/** `gemini --help` 出力から判定した、承認モード関連フラグの対応可否 */
export type GeminiCapabilities = {
  /** `-m, --model` フラグに対応しているか */
  model: boolean;
  /** `--approval-mode` フラグ自体が存在するか */
  approvalMode: boolean;
  /** `--approval-mode` の choices に `auto_edit` を含むか */
  approvalModeAutoEdit: boolean;
  /** `--approval-mode` の choices に `yolo` を含むか */
  approvalModeYolo: boolean;
  /** `-y, --yolo` フラグに対応しているか */
  yoloFlag: boolean;
  /**
   * 2026-10-27 サイクル2（plan→exec resume）: `--session-id` フラグ（新規セッションを UUID 事前採番で
   * 開始する）に対応しているか。
   */
  sessionId: boolean;
  /** `-r, --resume` フラグ（既存セッションを再開する）に対応しているか */
  resume: boolean;
};

/** 対応不可時（probe 失敗等）に使う全 false のキャパビリティ */
export const GEMINI_CAPABILITIES_NONE: GeminiCapabilities = {
  model: false,
  approvalMode: false,
  approvalModeAutoEdit: false,
  approvalModeYolo: false,
  yoloFlag: false,
  sessionId: false,
  resume: false,
};

/**
 * `gemini --help` の出力テキストから対応フラグを判定する。
 * `--approval-mode` の choices 判定は、ヘルプ全体に対する緩い正規表現（`-y, --yolo` 行にも
 * マッチしてしまう等）を避け、`--approval-mode` の出現位置から次のオプション行（またはテキスト末尾）
 * までのスパンを切り出した上でその中だけを見る。
 */
export function parseGeminiCapabilities(help: string): GeminiCapabilities {
  const model = /(^|\s)(-m,?\s*)?--model\b/.test(help);
  const yoloFlag = /(^|\s)(-y,?\s*)?--yolo\b/.test(help);
  // 2026-10-27 サイクル2: `--session-id` / `-r, --resume` の対応可否。
  // `--session-file`（JSON ファイルからセッション読み込み）と誤マッチしないよう `--session-id\b` で区切る。
  const sessionId = /(^|\s)--session-id\b/.test(help);
  const resume = /(^|\s)(-r,?\s*)?--resume\b/.test(help);

  const approvalModeIdx = help.search(/--approval-mode\b/);
  let approvalMode = false;
  let approvalModeAutoEdit = false;
  let approvalModeYolo = false;
  if (approvalModeIdx >= 0) {
    approvalMode = true;
    // 次のオプション行（行頭が空白+`-`で始まる）の開始位置、無ければ末尾まで
    const rest = help.slice(approvalModeIdx);
    const nextOptionMatch = rest.slice(1).match(/\n\s{0,4}-/);
    const span = nextOptionMatch ? rest.slice(0, nextOptionMatch.index! + 1) : rest;
    approvalModeAutoEdit = /"?auto_edit"?/.test(span);
    approvalModeYolo = /"?yolo"?/.test(span);
  }

  return { model, approvalMode, approvalModeAutoEdit, approvalModeYolo, yoloFlag, sessionId, resume };
}

/** `buildGeminiApprovalArgs()` が希望どおりに動けなかった場合の劣化理由（#325 静かなフォールバック禁止） */
export type GeminiDegradeReason =
  | 'none'          // 希望どおり（exec で yolo / plan で auto_edit 等）
  | 'execYoloFlag'  // exec で --approval-mode yolo ではなく旧 --yolo フラグを使った（警告不要の正常劣化）
  | 'execAutoEdit'  // exec なのに yolo 系フラグが使えず auto_edit に留まった
  | 'execNoFlag'    // exec なのに承認モードフラグを一切渡せなかった
  | 'planNoFlag';   // plan で --approval-mode 非対応のためフラグ無しで起動（今回の事故ケース）

export type GeminiApprovalArgsResult = {
  args: string[];
  degraded: GeminiDegradeReason;
};

/**
 * plan/exec ターンとキャパビリティから、Gemini CLI に渡す承認モード関連の argv を決定する。
 * `droppedFlags`（Phase 2: 実行時に `Unknown arguments` で拒否されたフラグの自動リトライ用）に
 * 含まれるフラグは、probe が対応と判定していても候補から除外する。
 */
export function buildGeminiApprovalArgs(
  caps: GeminiCapabilities,
  opts: { usePlanMode: boolean; yoloEnabled: boolean; droppedFlags?: string[] },
): GeminiApprovalArgsResult {
  const dropped = new Set(opts.droppedFlags ?? []);
  const canApprovalMode = caps.approvalMode && !dropped.has('--approval-mode');
  const canYoloFlag = caps.yoloFlag && !dropped.has('--yolo');
  const wantYolo = !opts.usePlanMode && opts.yoloEnabled;

  if (wantYolo) {
    if (canApprovalMode && caps.approvalModeYolo) {
      return { args: ['--approval-mode', 'yolo'], degraded: 'none' };
    }
    if (canYoloFlag) {
      return { args: ['--yolo'], degraded: 'execYoloFlag' };
    }
    if (canApprovalMode && caps.approvalModeAutoEdit) {
      return { args: ['--approval-mode', 'auto_edit'], degraded: 'execAutoEdit' };
    }
    return { args: [], degraded: 'execNoFlag' };
  }

  // plan ターン、または DEVRELAY_GEMINI_YOLO=0
  if (canApprovalMode && caps.approvalModeAutoEdit) {
    return { args: ['--approval-mode', 'auto_edit'], degraded: 'none' };
  }
  return { args: [], degraded: 'planNoFlag' };
}

/**
 * 文字列が UUID 形式（大まかな構文チェックのみ）かを判定する。
 * `terminal-session-id.ts` の `isUuidV4Like()` と同じ正規表現（バージョン/バリアントビットまでは検証しない）。
 * gemini は `spawn(..., { shell: true })` で起動するため、ID はこの関数を通してからでないと argv に渡さない
 * （`-m` を `safeModelArg()` に通しているのと同じ理由、シェルインジェクション対策）。
 */
export function isUuidLike(value: string | undefined | null): boolean {
  if (!value || typeof value !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** `buildGeminiSessionArgs()` が希望どおりに動けなかった場合の劣化理由（#325 静かなフォールバック禁止） */
export type GeminiSessionDegradeReason =
  | 'none'               // 希望どおり（resume または新規セッション採番ができた）
  | 'resumeUnsupported'  // resume したいが CLI が --resume 非対応
  | 'sessionIdUnsupported' // 新規セッション採番したいが CLI が --session-id 非対応
  | 'invalidId';         // 渡された ID が UUID 形式でない（安全側でフラグを渡さない）

export type GeminiSessionArgsResult = {
  args: string[];
  /** 実際に `--session-id` で渡した ID（渡していなければ undefined） */
  sessionId?: string;
  /** 実際に `--resume` で渡した ID（渡していなければ undefined） */
  resumeId?: string;
  degraded: GeminiSessionDegradeReason;
};

/**
 * 2026-10-27 サイクル2（plan→exec resume）: `--resume` / `--session-id` の argv を決定する。
 * `decideTerminalSessionArgs()`（`agents/linux/src/services/terminal-session-id.ts`）と同形の
 * 相互排他ロジック（resume 優先 → 新規採番 → 何もしない）。
 *
 * 呼び出し側の契約（D1/D2、`agents/*\/src/services/ai-runner.ts` のサイクル2 変更箇所が担保する）:
 * - `resumeSessionId` はサーバーが明示指定した ID（`decideResume()` の `source === 'explicit'`）のときのみ渡すこと。
 *   チャットの前ターン保存 ID（`source === 'stored'`）を渡すと、同一チャットで他ツールと行き来した場合に
 *   別ツールの ID を `gemini --resume` に渡してしまい exit 42 になる。
 * - `newSessionId` は MCP plan ターン（`options.turnId` がある場合）のみ渡すこと。chat ターンの argv を
 *   変えないため。
 *
 * @param droppedFlags 実行時に `Unknown arguments` で拒否されたフラグ名のリスト（probe 誤判定の自己修復用）。
 *   `--session-id` / `--resume` が含まれていれば、probe が対応と判定していても候補から除外する。
 */
export function buildGeminiSessionArgs(input: {
  caps: GeminiCapabilities;
  resumeSessionId?: string;
  newSessionId?: string;
  droppedFlags?: string[];
}): GeminiSessionArgsResult {
  const dropped = new Set(input.droppedFlags ?? []);
  const canResume = input.caps.resume && !dropped.has('--resume');
  const canSessionId = input.caps.sessionId && !dropped.has('--session-id');

  if (input.resumeSessionId) {
    if (!isUuidLike(input.resumeSessionId)) {
      return { args: [], degraded: 'invalidId' };
    }
    if (!canResume) {
      return { args: [], degraded: 'resumeUnsupported' };
    }
    return { args: ['--resume', input.resumeSessionId], resumeId: input.resumeSessionId, degraded: 'none' };
  }

  if (input.newSessionId) {
    if (!isUuidLike(input.newSessionId)) {
      return { args: [], degraded: 'invalidId' };
    }
    if (!canSessionId) {
      return { args: [], degraded: 'sessionIdUnsupported' };
    }
    return { args: ['--session-id', input.newSessionId], sessionId: input.newSessionId, degraded: 'none' };
  }

  return { args: [], degraded: 'none' };
}

/**
 * 完了報告でサーバーへエコーバックする aiSessionId を決定する。
 * `resolveTerminalAiSessionId()`（`terminal-session-id.ts`）と同形。
 *
 * 優先順位: 「採番した ID（--session-id で確実に使われた）」→「resume 指定した ID（CLI が維持する）」。
 * `producedOutput === false`（応答が 1 バイトも出ていない = 起動失敗・早期終了等）の場合は常に undefined を返す
 * （壊れた ID を `Session.planAiSessionId` に残さない。core#383 の `resolveTerminalAiSessionId()` と同じ
 * fail-closed 方針）。
 *
 * @param input.producedOutput このターンで何か出力が得られたか（fullOutput.trim().length > 0）
 * @param input.newSessionId 今回 `--session-id` で渡した UUID（渡していなければ省略）
 * @param input.resumeSessionId 今回 `--resume` で渡した ID（渡していなければ省略）
 */
export function resolveGeminiAiSessionId(input: {
  producedOutput: boolean;
  newSessionId?: string;
  resumeSessionId?: string;
}): string | undefined {
  if (!input.producedOutput) {
    return undefined;
  }
  return input.newSessionId || input.resumeSessionId || undefined;
}

/** `classifyGeminiSessionFailure()` の分類結果 */
export type GeminiSessionFailureKind =
  /** 採番した ID が既に使用中だった（クラッシュ後の再送信等。別 ID を採番し直せば自己修復する） */
  | 'sessionIdAlreadyExists'
  /** resume 先セッションが見つからなかった（壊れた/古い ID 等） */
  | 'resumeInvalid'
  /** 上記以外（セッション起因ではない失敗。通常の `ai.cliFailed` 経路に任せる） */
  | 'none';

/**
 * Gemini CLI がセッション関連のエラー（exit code 42）で終了したかどうかを stderr から分類する。
 * 本日の実機検証で確認した実際の stderr 文言（gemini-cli 0.65.0）:
 *   - 採番した ID の重複: `Error starting session: Session ID "<uuid>" already exists. Use --resume to resume it, or provide a different ID.`
 *   - resume 先が存在しない: `Error resuming session: Invalid session identifier "<uuid>".`
 * どちらも stdout 空・exit code 42 で終了する。
 * @param exitCode 子プロセスの終了コード（シグナル終了時は null）
 * @param stderr 子プロセスの stderr 全文
 */
export function classifyGeminiSessionFailure(input: { exitCode: number | null; stderr: string }): GeminiSessionFailureKind {
  const stderr = input.stderr ?? '';
  if (input.exitCode !== 42) return 'none';
  if (/Error starting session:.*already exists/i.test(stderr)) return 'sessionIdAlreadyExists';
  if (/Error resuming session/i.test(stderr)) return 'resumeInvalid';
  return 'none';
}

/**
 * Gemini API が「このモデルは廃止/提供終了」と返した 404 を stderr から検出する
 * （2026-10-27: `--approval-mode` 根治後に `gemini-user` 機体で発覚。旧 CLI の既定モデル
 * `gemini-2.5-pro` が Google 側で提供終了されており、生の二重エスケープ JSON がそのまま
 * ユーザーに届いていた。`AI_MODEL_CATALOG.gemini` の `gemini-3.1-pro` が実は 404 だった
 * 事故の調査中に発見）。
 *
 * 想定する stderr の実例（今回の実機ログ、`[API Error: ...]` でラップされた二重エスケープ JSON）:
 *   "This model models/gemini-2.5-pro is no longer available to new users.
 *    Please update your code to use models/gemini-3.1-pro-preview for the latest features..."
 * および対話モード（`gemini --skip-trust -m <id> -p ...`）で見られる別形式:
 *   "ModelNotFoundError: models/gemini-3.1-pro is not found for API version v1beta, ..."
 *
 * @param stderr 子プロセスの収集済み stderr 全文
 * @returns 廃止/未検出だったモデル名と、メッセージから読み取れた推奨移行先（無ければ undefined）。
 *   該当パターンに一致しなければ null。
 */
export function detectGeminiModelUnavailable(stderr: string): { model: string; recommendedModel?: string } | null {
  if (!stderr) return null;
  const retiredMatch = stderr.match(/models\/([A-Za-z0-9_.\-]+)\s+is no longer available/i);
  const notFoundMatch = stderr.match(/models\/([A-Za-z0-9_.\-]+)\s+is not found for API version/i);
  const model = retiredMatch?.[1] ?? notFoundMatch?.[1];
  if (!model) return null;
  const recommendedMatch = stderr.match(/use\s+models\/([A-Za-z0-9_.\-]+)/i);
  return recommendedMatch ? { model, recommendedModel: recommendedMatch[1] } : { model };
}
