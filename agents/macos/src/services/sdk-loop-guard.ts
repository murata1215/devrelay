/**
 * #355: Claude Agent SDK の auto-compact 無限ループ検知（外部 import ゼロの純関数モジュール）。
 *
 * 2026-09-02、cwd=/opt/devrelay の Claude SDK セッションが 138.3 分・79 回連続で
 * 「compact_boundary(auto) → ToolSearch(同一入力) のみ → 出力ゼロ → compact_boundary(auto) → ...」
 * という自己再帰ループに陥った（`.devrelay-files/20260902_225955_pasted-text.txt` の実測検証で確定）。
 * 既に閾値ギリギリのコンテキストで deferred tool（ToolSearch 経由の Bash 等）を再ロードすると
 * その場で compact が再発火し、compact で deferred tool 一覧がリセットされるため再び同じツールを
 * 呼び直す、という構造。`for await` ループ自体は生きてメッセージを受け続けているため、
 * ループ内でこのモジュールを呼び出して検知し、呼び出し側（ai-runner.ts）で
 * `abortController.abort()` により実際に停止させる。
 *
 * 過剰検知を避けるための唯一確実なシグナルは「compact したのに何も進んでいない」こと
 * （13:53 以降の正常区間では compact が 2〜3 分おきに出るが、その間に assistant テキストや
 * 複数種類のツール呼び出しが発生している＝実測で確認済み）。したがって「compact 回数」単体では
 * 判定しない。
 *
 * 重要な設計上の罠（回帰テストで固定する）:
 * - 同一ツール連打カウンタ（layer 2）は compact_boundary が来ても**リセットしない**。
 *   事故の実パターンは `COMPACT → tool → COMPACT → tool → ...` であり、compact でリセットすると
 *   layer 2 が一生発火しなくなる。
 * - このモジュールは状態を持つ引数（state）を破壊的に更新するが、config / event 引数は変更しない。
 * - 例外を一切投げない（不正な env 値・想定外の入力は既定値へフォールバックする）。
 */

/** `process.env` 相当の最小型（Node 型定義への依存を避けるため独自定義） */
type EnvLike = Record<string, string | undefined>;

/** compact ループ検知の閾値（既定値。全て env で上書き可能） */
export const DEFAULT_MAX_NO_PROGRESS_COMPACTS = 3;
export const DEFAULT_MAX_IDENTICAL_TOOL_REPEATS = 5;
/** 45分。サーバー側 PROGRESS_HARD_TIMEOUT（60分）より先に Agent 側が主導権を持って止めるための値 */
export const DEFAULT_WALL_CLOCK_MS = 2_700_000;
export const DEFAULT_MIN_PROGRESS_TEXT_CHARS = 1;

export interface LoopGuardConfig {
  /** 何回連続で「進捗なし compact」が起きたら停止するか */
  maxNoProgressCompacts: number;
  /** 何回連続で同一シグネチャのツール呼び出しが起きたら停止するか */
  maxIdenticalToolRepeats: number;
  /** この実行の開始から何 ms 経過したら強制停止するか */
  wallClockMs: number;
  /** 「進捗あり」とみなす trim 後テキスト文字数の下限（compact 間の累積） */
  minProgressTextChars: number;
  /** true の場合、全ての検知を無効化する（キルスイッチ） */
  disabled: boolean;
}

export interface LoopGuardState {
  /** この実行（1回の query() ループ）が開始した時刻（ms epoch） */
  startedAtMs: number;
  /** 直近で進捗が無いまま連続した compact の回数（進捗があれば 0 にリセット） */
  noProgressCompactCount: number;
  /** この実行での compact 総数（リセットされない、参考値・ログ用） */
  totalCompacts: number;
  /** 直近の compact 以降に観測した trim 後 assistant テキストの累積文字数 */
  textCharsSinceCompact: number;
  /** 直近の compact 以降に観測した異なるツール名の集合（P2 判定用） */
  distinctToolNamesSinceCompact: Set<string>;
  /** 直前のツール呼び出しのシグネチャ（同一シグネチャ連打の検知用） */
  lastToolSignature: string | null;
  /** 直前のツール呼び出しから連続する同一シグネチャの回数 */
  identicalToolRepeatCount: number;
  /** 直近の compact_boundary の pre_tokens（通知メッセージ用、無ければ undefined） */
  lastCompactPreTokens: number | undefined;
}

export type LoopGuardEvent =
  | { kind: 'text'; text: string; nowMs: number }
  | { kind: 'tool'; name: string; input: unknown; nowMs: number }
  | { kind: 'compact'; preTokens?: number; nowMs: number };

export interface LoopGuardDetail {
  compacts?: number;
  preTokens?: number;
  minutes?: number;
  repeats?: number;
  tool?: string;
}

export interface LoopGuardDecision {
  abort: boolean;
  reason?: 'compactLoop' | 'toolRepeat';
  detail?: LoopGuardDetail;
}

export interface WallClockDecision {
  abort: boolean;
  reason?: 'wallClock';
  detail?: LoopGuardDetail;
}

/**
 * env 文字列を正の整数として解釈する。未設定・空文字・非数値・許容範囲外は fallback を返す
 * （例外は投げない）。
 */
function parseEnvInt(raw: string | undefined, fallback: number, allowZero: boolean): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (allowZero ? n < 0 : n <= 0) return fallback;
  return Math.floor(n);
}

/**
 * env から LoopGuardConfig を解決する。全て未設定なら DEFAULT_* がそのまま使われる。
 */
export function resolveLoopGuardConfig(env: EnvLike): LoopGuardConfig {
  return {
    maxNoProgressCompacts: parseEnvInt(
      env.DEVRELAY_SDK_MAX_NOPROGRESS_COMPACTS,
      DEFAULT_MAX_NO_PROGRESS_COMPACTS,
      false
    ),
    maxIdenticalToolRepeats: parseEnvInt(
      env.DEVRELAY_SDK_MAX_IDENTICAL_TOOL_REPEATS,
      DEFAULT_MAX_IDENTICAL_TOOL_REPEATS,
      false
    ),
    wallClockMs: parseEnvInt(env.DEVRELAY_SDK_WALL_CLOCK_MS, DEFAULT_WALL_CLOCK_MS, false),
    minProgressTextChars: parseEnvInt(
      env.DEVRELAY_SDK_MIN_PROGRESS_TEXT_CHARS,
      DEFAULT_MIN_PROGRESS_TEXT_CHARS,
      true
    ),
    disabled: env.DEVRELAY_SDK_LOOP_GUARD_DISABLED === '1',
  };
}

/**
 * 1回の実行（1回の query() ループ）用の初期状態を作る。
 * 呼び出すたびに独立した新しいオブジェクトを返す（前回呼び出しの状態を共有しない）。
 */
export function createLoopGuardState(nowMs: number): LoopGuardState {
  return {
    startedAtMs: nowMs,
    noProgressCompactCount: 0,
    totalCompacts: 0,
    textCharsSinceCompact: 0,
    distinctToolNamesSinceCompact: new Set<string>(),
    lastToolSignature: null,
    identicalToolRepeatCount: 0,
    lastCompactPreTokens: undefined,
  };
}

/** 経過分数（小数第1位まで、負値は0に丸める） */
function elapsedMinutes(startedAtMs: number, nowMs: number): number {
  const elapsedMs = Math.max(0, nowMs - startedAtMs);
  return Math.round((elapsedMs / 60000) * 10) / 10;
}

const STABLE_STRINGIFY_MAX_DEPTH = 10;

/** JSON.stringify をキー順ソート・深さ制限付きで行う（循環参照や巨大構造でも例外を投げない） */
function stableStringify(value: unknown, depth: number): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (depth > STABLE_STRINGIFY_MAX_DEPTH) return '"[MaxDepth]"';

  const t = typeof value;
  if (t !== 'object') {
    if (t === 'function' || t === 'symbol') return `"[${t}]"`;
    try {
      const s = JSON.stringify(value);
      return s === undefined ? String(value) : s;
    } catch {
      return String(value);
    }
  }

  if (Array.isArray(value)) {
    return '[' + value.map((v) => stableStringify(v, depth + 1)).join(',') + ']';
  }

  try {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return '{' + keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k], depth + 1)}`).join(',') + '}';
  } catch {
    return '"[Unstringifiable]"';
  }
}

const TOOL_SIGNATURE_MAX_LEN = 2000;

/**
 * ツール名＋入力から安定したシグネチャ文字列を作る（キー順に依存しない、深さ・長さに上限あり）。
 * 同一のツール呼び出し（名前・入力とも同じ）かどうかの比較にのみ使う。
 */
export function stableToolSignature(name: string, input: unknown): string {
  const safeName = typeof name === 'string' ? name : String(name ?? '');
  const raw = `${safeName}:${stableStringify(input, 0)}`;
  if (raw.length > TOOL_SIGNATURE_MAX_LEN) {
    return `${raw.slice(0, TOOL_SIGNATURE_MAX_LEN)}...[truncated len=${raw.length}]`;
  }
  return raw;
}

/**
 * ループガードにイベントを1件流し込む。state を破壊的に更新し、停止すべきかどうかを返す。
 * config.disabled=true の場合は常に abort:false（何もしない）。
 *
 * 注意: compact イベント処理で per-cycle のトラッカー（textCharsSinceCompact /
 * distinctToolNamesSinceCompact）はリセットするが、identicalToolRepeatCount /
 * lastToolSignature は**リセットしない**（layer 2 の独立性を保つ、回帰テストで固定）。
 */
export function observeLoopGuardEvent(
  state: LoopGuardState,
  event: LoopGuardEvent,
  config: LoopGuardConfig
): LoopGuardDecision {
  if (config.disabled) {
    return { abort: false };
  }

  if (event.kind === 'text') {
    const text = typeof event.text === 'string' ? event.text : String(event.text ?? '');
    const trimmedLen = text.trim().length;
    if (trimmedLen > 0) {
      state.textCharsSinceCompact += trimmedLen;
    }
    return { abort: false };
  }

  if (event.kind === 'tool') {
    const name = typeof event.name === 'string' ? event.name : String(event.name ?? '');
    state.distinctToolNamesSinceCompact.add(name);

    const signature = stableToolSignature(name, event.input);
    if (signature === state.lastToolSignature) {
      state.identicalToolRepeatCount += 1;
    } else {
      state.lastToolSignature = signature;
      state.identicalToolRepeatCount = 1;
    }

    if (state.identicalToolRepeatCount >= config.maxIdenticalToolRepeats) {
      return {
        abort: true,
        reason: 'toolRepeat',
        detail: {
          repeats: state.identicalToolRepeatCount,
          tool: name,
          minutes: elapsedMinutes(state.startedAtMs, event.nowMs),
        },
      };
    }
    return { abort: false };
  }

  // event.kind === 'compact'
  const hadProgress =
    state.textCharsSinceCompact >= config.minProgressTextChars ||
    state.distinctToolNamesSinceCompact.size >= 2;

  state.totalCompacts += 1;
  state.lastCompactPreTokens = event.preTokens;
  state.noProgressCompactCount = hadProgress ? 0 : state.noProgressCompactCount + 1;

  // 次サイクル用にリセット（identicalToolRepeatCount / lastToolSignature は意図的にリセットしない）
  state.textCharsSinceCompact = 0;
  state.distinctToolNamesSinceCompact = new Set<string>();

  if (state.noProgressCompactCount >= config.maxNoProgressCompacts) {
    return {
      abort: true,
      reason: 'compactLoop',
      detail: {
        compacts: state.noProgressCompactCount,
        preTokens: state.lastCompactPreTokens,
        minutes: elapsedMinutes(state.startedAtMs, event.nowMs),
      },
    };
  }

  return { abort: false };
}

/**
 * 実行時間の上限チェック（暴走安全網）。observeLoopGuardEvent とは独立に、メッセージ受信のたびに
 * 呼び出す想定。config.disabled=true の場合は常に abort:false。
 */
export function checkWallClock(state: LoopGuardState, nowMs: number, config: LoopGuardConfig): WallClockDecision {
  if (config.disabled) {
    return { abort: false };
  }

  const elapsedMs = nowMs - state.startedAtMs;
  if (elapsedMs >= config.wallClockMs) {
    return {
      abort: true,
      reason: 'wallClock',
      detail: {
        minutes: elapsedMinutes(state.startedAtMs, nowMs),
        compacts: state.totalCompacts,
      },
    };
  }
  return { abort: false };
}
