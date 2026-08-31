/**
 * #346: Devin CLI 診断表示用の純関数群（`ai-runner.ts` の 3 OS 共通コピーを1箇所に集約）。
 *
 * #345 で導入した劣化通知の診断行（`{detail}`）に `devin devin 3000.6.7 ...` という表記重複バグが
 * あった（`devin --version` の生出力自体が `devin ` で始まるのに、呼び出し側がさらに `devin ` を
 * 前置していたため）。3 OS のローカル関数コピーすべてに同時に存在していた不具合のため、
 * 純関数モジュールへ切り出して `diff` で同一性を担保し、単体テストも書けるようにする
 * （#337 progress-timeout.ts / #339 claude-login-code.ts / #343 control-response.ts /
 * #344 cli-failure.ts と同じ流儀。外部 import ゼロ）。
 */

/**
 * `devin --version` の生出力を診断行用に正規化する。
 * 既に `devin ` で始まっていれば（大小問わず）そのまま使い、二重前置を防ぐ。
 * 空文字・空白のみの場合は `devin unknown` を返す。**例外を投げない。**
 * @param version `devin --version` の生出力（例: "devin 3000.6.7 (260a97c8)"）
 * @returns 診断行用に正規化した文字列（例: "devin 3000.6.7 (260a97c8)"）
 */
export function formatDevinVersion(version: string): string {
  const trimmed = (version ?? '').trim();
  if (!trimmed) return 'devin unknown';
  return /^devin\s/i.test(trimmed) ? trimmed : `devin ${trimmed}`;
}

/**
 * 劣化通知（`devin.readonlyUnsupported`/`devin.execPermissionUnsupported`/`devin.probeFailed`）の
 * `{detail}` プレースホルダに埋める短い診断行を組み立てる（H-A/H-B 切り分け用、#345 §41 由来）。
 * @param caps probeDevinCapabilities() の戻り値のうち version/helpBytes/ok のみ
 * @returns 例: "devin 3000.6.7 (260a97c8) / help 3652 chars / probe=ok"
 */
export function buildDevinCapabilityDetail(caps: { version: string; helpBytes: number; ok: boolean }): string {
  return `${formatDevinVersion(caps.version)} / help ${caps.helpBytes} chars / probe=${caps.ok ? 'ok' : 'failed'}`;
}

/**
 * `devin --help` から抽出したフラグ一覧をチャット表示用に整形する（`devin.flagList` の `{flags}`）。
 * @param flags `--xxx` 形式のフラグ名一覧（probe 失敗時や検出ゼロ件のときは空配列）
 * @returns 空白区切りの文字列。空配列の場合は固定文字列 `(none)`
 */
export function formatDevinFlagList(flags: string[]): string {
  if (!flags || flags.length === 0) return '(none)';
  return flags.join(' ');
}

/**
 * #347: Devin CLI の初回起動バナー行か判定する。
 * Phase 0 実測（`--config` に `shell.setup_complete` の無いファイルを渡した回）: devin は
 * `--config` に指定したファイルを「セットアップ状態の保存先」とみなし、そのキーが無いと
 * 毎回下記 3 行を stdout に出す。
 *   Welcome to Devin CLI!
 *   Logged in as <account>
 *   You're all set. Run devin to get started.
 * これを AI の回答として扱うと fullOutput に積まれ、「出力ゼロ」を条件にした安全網
 * （#274 devinPlanToolRejected / #329 未知フラグ自動リトライ / classifyCliFailure）が
 * 軒並み無効化されるため、プレーンテキスト出力パスで明示的に除外する。
 * 判定は行全体の完全一致に近い保守的な形にする（AI の回答文が偶然巻き込まれないように、
 * 部分一致は使わない）。
 * @param line trim 済みの 1 行
 * @returns バナー行なら true
 */
export function isDevinBannerLine(line: string): boolean {
  const trimmed = (line ?? '').trim();
  if (!trimmed) return false;
  if (trimmed === 'Welcome to Devin CLI!') return true;
  if (trimmed === "You're all set. Run devin to get started.") return true;
  if (/^Logged in as \S+/.test(trimmed)) return true;
  return false;
}
