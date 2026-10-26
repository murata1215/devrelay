/**
 * Gemini CLI の承認モード関連フラグ（`--approval-mode` / `--yolo` / `-m,--model`）の
 * 対応可否判定と、plan/exec ターンに応じた argv 決定を行う純粋関数群。
 *
 * 2026-10-27: `agents/{linux,macos,windows}/src/services/ai-runner.ts` の gemini 分岐が、
 * `probeGeminiCapabilities()` で `--approval-mode` の対応可否を判定しているにもかかわらず、
 * plan ターン（および yolo 系フラグに非対応の場合）の else 節では判定結果を一切見ずに
 * `--approval-mode auto_edit` をハードコードしていた。`--approval-mode` 自体が存在しない
 * 旧 CLI ではこれが `Unknown arguments: approval-mode, approvalMode`（yargs strict）で
 * exit 1・stdout 空となり、会話が一度も成立しなかった（gemini-user 機体で発覚）。
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
};

/** 対応不可時（probe 失敗等）に使う全 false のキャパビリティ */
export const GEMINI_CAPABILITIES_NONE: GeminiCapabilities = {
  model: false,
  approvalMode: false,
  approvalModeAutoEdit: false,
  approvalModeYolo: false,
  yoloFlag: false,
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

  return { model, approvalMode, approvalModeAutoEdit, approvalModeYolo, yoloFlag };
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
