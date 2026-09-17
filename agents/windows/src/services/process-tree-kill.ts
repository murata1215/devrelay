/**
 * Devin 等の子プロセスを段階的に停止するための純関数群（今サイクル）。
 *
 * 背景: devin CLI は `shell: true` で spawn される（直接の子は Windows では cmd.exe）。
 * `proc.kill('SIGTERM')` は Windows では `TerminateProcess(cmd.exe)` にしかならず、
 * cmd.exe が起動した devin.exe や、devin がさらに起動した Gradle/Kotlin デーモン等の
 * 孫プロセスは生き残る（実測: 2026-09-17、`./gradlew assembleDebug` 実行後に
 * `⏸️ Runtime limit 15min reached, killing process` のログの後もハートビートが
 * 92 分まで継続した実害）。
 *
 * Windows の絶対条件: `taskkill /PID <pid> /T /F` は各プロセスの ParentProcessId を辿って
 * プロセスツリーを畳む。先に `child.kill()`（= TerminateProcess(cmd.exe)）を送ると
 * cmd.exe の親リンクが切れ、以後 `taskkill /PID <cmd.exe の pid> /T /F` は
 * 「該当プロセスなし」（exit 128）で孫プロセスに一切届かなくなる。
 * よって **taskkill を先に実行し、`proc.kill()`（fallbackSignal）は
 * taskkill 自体の起動に失敗した場合のみ**に限定する。
 *
 * POSIX は変更しない（今サイクルのスコープ外）: `shell: true` は `/bin/sh -c "..."` になるが
 * dash/bash は単純コマンドを exec で置き換えるため `proc.pid` は実質的に devin 自身の pid になる。
 * `detached: true` + `process.kill(-pid)`（プロセスグループ kill）は devin がプロセスグループの
 * リーダーでない場合に agent 自身を巻き込む事故リスクがあるため、今回は単一 pid への
 * SIGTERM→SIGKILL のまま据え置く（Gradle 等の孫プロセスは残り得るが、ターンの確定＝
 * WebUI の「処理中」解除は 'exit' watchdog 側で担保される）。
 *
 * 外部 import ゼロに保ち、コンパイル済み dist を直接 `node --test` から import して
 * 単体検証できるようにする（running-code-stale.ts / sdk-loop-guard.ts と同じ流儀）。
 *
 * 注意: `agents/macos` はこのファイルの byte-for-byte 複製を持つ（意図的に同一内容を維持する）。
 * `agents/windows`（Electron GUI 版）も同一内容を持つ。
 */

/** `process.env` 相当の最小型（Node 型定義への依存を避けるため独自定義） */
type EnvLike = Record<string, string | undefined>;

/** kill エスカレーションの段階。term→force の順で1段階ずつ進む */
export type KillStage = 'term' | 'force';

/**
 * 1 段階分の停止手順。
 * `command` が非 null の場合はそれを最優先で実行し、**起動に失敗したときだけ**
 * `fallbackSignal` を `proc.kill()` で送る（両方は同時に実行しない）。
 */
export interface KillPlan {
  /** win32 かつ pid が有効な場合のみ非 null（taskkill の呼び出し引数） */
  command: { file: string; args: string[] } | null;
  /** command が無い、または起動に失敗したときに proc.kill() へ渡すシグナル */
  fallbackSignal: 'SIGTERM' | 'SIGKILL';
  /** ログ用の短い説明（チャットには出さない） */
  note: string;
}

/**
 * プラットフォームと停止段階から kill 手順を決定する（副作用なし・例外を投げない）。
 *
 * 判定表:
 * - platform !== 'win32' → 常に command:null（term は SIGTERM、force は SIGKILL）
 * - platform === 'win32' かつ pid が正の整数 → term は `taskkill /PID <pid> /T`、
 *   force は `taskkill /PID <pid> /T /F`
 * - platform === 'win32' だが pid が null/undefined/0以下/非整数/NaN → command:null（fail-open）
 */
export function buildKillPlan(input: {
  platform: string;
  pid: number | null | undefined;
  stage: KillStage;
}): KillPlan {
  const fallbackSignal: 'SIGTERM' | 'SIGKILL' = input.stage === 'term' ? 'SIGTERM' : 'SIGKILL';

  if (input.platform !== 'win32') {
    return {
      command: null,
      fallbackSignal,
      note: `posix ${input.stage}: single-pid signal (${fallbackSignal})`,
    };
  }

  const pid = input.pid;
  const isValidPid = typeof pid === 'number' && Number.isInteger(pid) && pid > 0;
  if (!isValidPid) {
    return {
      command: null,
      fallbackSignal,
      note: `win32 ${input.stage}: invalid pid (${String(pid)}), fail-open to signal`,
    };
  }

  const args = ['/PID', String(pid), '/T'];
  if (input.stage === 'force') {
    args.push('/F');
  }
  return {
    command: { file: 'taskkill', args },
    fallbackSignal,
    note: `win32 ${input.stage}: taskkill ${args.join(' ')}`,
  };
}

/** kill エスカレーションの各段階の待ち時間（ms）。すべて env で上書き可能 */
export const DEFAULT_EXIT_FLUSH_GRACE_MS = 10_000;
export const DEFAULT_SYNTHETIC_CLOSE_GRACE_MS = 5_000;
export const DEFAULT_KILL_FORCE_DELAY_MS = 10_000;
export const DEFAULT_KILL_GIVEUP_DELAY_MS = 20_000;

export interface KillTimings {
  /** 'exit' 受信後、こちら側の stdio を destroy() するまでの猶予 */
  exitFlushGraceMs: number;
  /** stdio destroy() 後、'close' を合成するまでの猶予 */
  syntheticCloseGraceMs: number;
  /** term 送信後、force へエスカレーションするまでの猶予 */
  forceDelayMs: number;
  /** force 送信後、ターンを強制確定するまでの猶予 */
  giveUpDelayMs: number;
}

/**
 * 正の有限数のみ受理し、それ以外（未設定・空文字・非数値・0・負値・Infinity 等）は
 * fallback を返す。例外は投げない。
 */
function parsePositiveMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/** env から KillTimings を解決する。全て未設定なら DEFAULT_* がそのまま使われる */
export function resolveKillTimings(env: EnvLike): KillTimings {
  return {
    exitFlushGraceMs: parsePositiveMs(env.DEVRELAY_EXIT_FLUSH_GRACE_MS, DEFAULT_EXIT_FLUSH_GRACE_MS),
    syntheticCloseGraceMs: parsePositiveMs(
      env.DEVRELAY_SYNTHETIC_CLOSE_GRACE_MS,
      DEFAULT_SYNTHETIC_CLOSE_GRACE_MS
    ),
    forceDelayMs: parsePositiveMs(env.DEVRELAY_KILL_FORCE_DELAY_MS, DEFAULT_KILL_FORCE_DELAY_MS),
    giveUpDelayMs: parsePositiveMs(env.DEVRELAY_KILL_GIVEUP_DELAY_MS, DEFAULT_KILL_GIVEUP_DELAY_MS),
  };
}

/**
 * ハートビート（⏳ Devin 実行中...）を出してよいかどうかを判定する。
 * kill 要求後・プロセス終了後・ターン確定後はいずれも false にする。
 * 矛盾表示（例: kill 済みなのに「(43分経過 / 上限15分)」が出続ける）と、
 * サーバー側 5 分ソフトタイムアウトの無限再武装（appendSessionOutput 経由）を止めるため。
 */
export function shouldEmitHeartbeat(state: {
  killRequested: boolean;
  turnEnded: boolean;
  processExited: boolean;
}): boolean {
  return !state.killRequested && !state.turnEnded && !state.processExited;
}
