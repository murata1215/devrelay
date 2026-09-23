/**
 * DevRelay Sites Phase 1-B — Caddy JSON access log の読み取り層。
 *
 * 方式：cold scan（起動時 1 回）+ fd 保持 tail（常時）+ 異常時 cold rebuild。
 * inode/offset だけでは「current で既読 → rotate → gz 化で別 inode」の再読を防げないため、
 * current のファイルディスクリプタを開いたまま保持し、rotation は
 * 「stat(currentPath) の inode が保持中 fd の inode と異なる」ことで検出する
 * （fd 自体は rename 後も同じ inode を指し続けるので、rotate 直前の未読末尾を
 * 失わずに EOF まで読み切ってから切り替えられる）。
 *
 * runtime（tail）では rotated / gz を一切読まない。読むのは cold scan / rebuild 時のみ。
 * よって「既読内容が gz として再加算される」経路が原理的に存在しない。
 */

import { open, readdir, stat } from 'fs/promises';
import type { FileHandle } from 'fs/promises';
import { gunzip as gunzipCb } from 'zlib';
import { promisify } from 'util';
import { join } from 'path';
import { parseAccessLogLine, type ParsedAccessLine } from './access-log-parser.js';
import { toDateKey, daysSince } from './sites-rules.js';
import type { StatsCoverage } from './types.js';

const gunzip = promisify(gunzipCb);

/** rotated ファイル名に埋め込まれたタイムスタンプ（実例 `xxx-2026-09-10T03-37-01.822-size.log.gz`）。 */
const ROTATED_TS_PATTERN = /-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d+)-size\.log(?:\.gz)?$/;

/** rotated ファイル名から埋め込みタイムスタンプ文字列を取り出す（無ければ null）。 */
export function extractRotationTimestamp(filename: string): string | null {
  const m = filename.match(ROTATED_TS_PATTERN);
  return m ? m[1] : null;
}

/** `.gz` で終わるファイルかどうか。 */
export function isGzFile(filename: string): boolean {
  return filename.toLowerCase().endsWith('.gz');
}

export interface ClassifiedFiles {
  current: string | null;
  /** rotated ファイル名（plain / gz 混在）。新しい順にソート済み。 */
  rotated: string[];
}

/**
 * ディレクトリ内のファイル名一覧を current / rotated に分類する（純粋関数）。
 * rotated はファイル名の埋め込みタイムスタンプ降順、パース不能なものは末尾（mtimes 指定があれば mtime 降順）。
 */
export function classifyLogFiles(files: string[], currentFileName: string, mtimes: Map<string, number> = new Map()): ClassifiedFiles {
  const current = files.includes(currentFileName) ? currentFileName : null;
  const baseName = currentFileName.replace(/\.log$/, '');
  const rotated = files.filter((f) => f !== currentFileName && f.startsWith(`${baseName}-`));
  rotated.sort((a, b) => {
    const ta = extractRotationTimestamp(a);
    const tb = extractRotationTimestamp(b);
    if (ta && tb) return tb.localeCompare(ta);
    if (ta) return -1;
    if (tb) return 1;
    return (mtimes.get(b) ?? 0) - (mtimes.get(a) ?? 0);
  });
  return { current, rotated };
}

/** 生テキストを行分割し、末尾の未完行（改行なしで終わる断片）を partial として切り出す。 */
export function splitLines(text: string, existingPartial: string): { lines: string[]; partial: string } {
  const combined = existingPartial + text;
  if (combined.length === 0) return { lines: [], partial: '' };
  const parts = combined.split('\n');
  // 末尾が '\n' で終わっていれば parts の最後は空文字列（= 完全な行の直後）。
  // そうでなければ最後の要素が未完行 = 次回まで持ち越す partial。
  const partial = parts[parts.length - 1];
  const lines = parts.slice(0, -1).filter((l) => l.length > 0);
  return { lines, partial };
}

// ---------------------------------------------------------------------------
// reader state
// ---------------------------------------------------------------------------

export interface ReaderState {
  handle: FileHandle | null;
  currentInode: number | null;
  offset: number;
  partial: string;
  /** cold scan で読んだ rotated ファイル名（同一 rebuild 内での重複読みガードにのみ使う）。 */
  scannedRotated: Set<string>;
  bytesReadTotal: number;
  droppedPartialAtRotation: number;
  /** 直近 tick 時点で確認した rotated ファイル数（gap 検出用）。 */
  lastKnownRotatedCount: number;
  gapDetected: boolean;
  /** B2-0 修正1（self-heal）: `tailTick()` が `handle === null` から再 open に成功した回数（可視化・テスト用）。 */
  reopenCount: number;
}

/** 初期状態（cold scan 前）を作る。 */
export function createInitialState(): ReaderState {
  return {
    handle: null,
    currentInode: null,
    offset: 0,
    partial: '',
    scannedRotated: new Set(),
    bytesReadTotal: 0,
    droppedPartialAtRotation: 0,
    lastKnownRotatedCount: 0,
    gapDetected: false,
    reopenCount: 0,
  };
}

/** 保持中の fd を close する（プロセス終了・rebuild 前に呼ぶ）。 */
export async function closeState(state: ReaderState): Promise<void> {
  if (state.handle) {
    await state.handle.close().catch(() => undefined);
    state.handle = null;
  }
}

export interface ScanLimits {
  /** window 日数（既定 30）。 */
  windowDays: number;
  /** 全体の読み取り上限バイト数（展開後）。current は必ず全読みし、この上限は主に rotated 側に適用する。 */
  byteBudget: number;
  /** 基準日（'YYYY-MM-DD'）。coverage 計算に使う。 */
  today: string;
}

export interface ScanOutcome {
  truncated: boolean;
  truncatedReason: StatsCoverage['truncatedReason'];
  oldestDateSeen: string | null;
}

type LineHandler = (parsed: ParsedAccessLine, raw: string) => void;

/** current ファイル 1 個を先頭から全読みし、fd を保持したまま state を初期化する。 */
async function readCurrentFully(dir: string, currentFileName: string, state: ReaderState, onLine: LineHandler): Promise<number> {
  const path = join(dir, currentFileName);
  const handle = await open(path, 'r');
  const st = await handle.stat();
  const buf = Buffer.alloc(st.size);
  if (st.size > 0) {
    await handle.read(buf, 0, st.size, 0);
  }
  const text = buf.toString('utf8');
  const { lines, partial } = splitLines(text, '');
  for (const line of lines) {
    const parsed = parseAccessLogLine(line);
    if (parsed) onLine(parsed, line);
  }
  state.handle = handle;
  state.currentInode = st.ino;
  state.offset = st.size;
  state.partial = partial;
  return st.size;
}

/** 1 個の rotated ファイル（plain or gz）を全読みしてテキストを返す。 */
async function readRotatedFile(dir: string, filename: string): Promise<string> {
  const path = join(dir, filename);
  const raw = await open(path, 'r').then(async (h) => {
    const st = await h.stat();
    const buf = Buffer.alloc(st.size);
    if (st.size > 0) await h.read(buf, 0, st.size, 0);
    await h.close();
    return buf;
  });
  if (isGzFile(filename)) {
    const decompressed = await gunzip(raw);
    return decompressed.toString('utf8');
  }
  return raw.toString('utf8');
}

/**
 * cold scan：起動時／rebuild 時のみ実行する。
 * current を先頭から全読みして fd を保持し、rotated を新しい順に window 到達 or 読み取り上限まで読む。
 */
export async function coldScan(dir: string, currentFileName: string, onLine: LineHandler, limits: ScanLimits): Promise<{ state: ReaderState; outcome: ScanOutcome }> {
  const state = createInitialState();
  let truncated = false;
  let truncatedReason: StatsCoverage['truncatedReason'] = null;
  let oldestDateSeen: string | null = null;

  const updateOldest = (parsed: ParsedAccessLine) => {
    const d = toDateKey(parsed.ts);
    if (oldestDateSeen === null || d < oldestDateSeen) oldestDateSeen = d;
  };

  const files = await readdir(dir).catch(() => [] as string[]);
  const { current, rotated } = classifyLogFiles(files, currentFileName);

  let budgetRemaining = limits.byteBudget;

  if (current) {
    const consumed = await readCurrentFully(dir, current, state, (parsed, raw) => {
      updateOldest(parsed);
      onLine(parsed, raw);
    });
    state.bytesReadTotal += consumed;
    // current は tail 継続性のため必ず全読みする（budget は主に rotated 側の制御に使う）。
    budgetRemaining -= consumed;
  }

  for (const filename of rotated) {
    if (oldestDateSeen !== null && daysSince(oldestDateSeen, limits.today) >= limits.windowDays - 1) {
      // 既に window 先頭日まで覆っている → これ以上古い rotated は読む必要がない
      break;
    }
    if (budgetRemaining <= 0) {
      truncated = true;
      truncatedReason = 'byte_budget';
      break;
    }
    const text = await readRotatedFile(dir, filename);
    const consumed = Buffer.byteLength(text, 'utf8');
    if (consumed > budgetRemaining) {
      truncated = true;
      truncatedReason = 'byte_budget';
      break;
    }
    budgetRemaining -= consumed;
    state.bytesReadTotal += consumed;
    const { lines } = splitLines(text, '');
    for (const line of lines) {
      const parsed = parseAccessLogLine(line);
      if (parsed) {
        updateOldest(parsed);
        onLine(parsed, line);
      }
    }
    state.scannedRotated.add(filename);
  }

  state.lastKnownRotatedCount = rotated.length;
  state.gapDetected = false;

  return { state, outcome: { truncated, truncatedReason, oldestDateSeen } };
}

export interface TickOutcome {
  /** rotation を検出し fd を切り替えたか。 */
  rotated: boolean;
  /** truncate（size < offset）を検出し offset をリセットしたか。 */
  truncatedInPlace: boolean;
  /** tick 間に rotated ファイルが 2 個以上増えた（取りこぼしの疑い）。呼び出し側は cold rebuild すべき。 */
  gapDetected: boolean;
  /**
   * B2-0 修正1（self-heal）: cold scan 時点で存在しなかった current ファイルを、
   * このtick で新規に open して先頭から全読みしたか。
   */
  reopened: boolean;
}

/**
 * 起動後 tail の 1 tick（既定 30 秒周期で呼ぶ想定）。current の追記だけを読む。
 * runtime では rotated / gz を一切読まない（`dir` の readdir は gap 検出のためだけに使う）。
 */
export async function tailTick(dir: string, currentFileName: string, state: ReaderState, onLine: LineHandler): Promise<TickOutcome> {
  const outcome: TickOutcome = { rotated: false, truncatedInPlace: false, gapDetected: false, reopened: false };
  const currentPath = join(dir, currentFileName);

  // gap 検出: rotated ファイル数の増分をチェック（実ファイル読み込みはしない）
  const files = await readdir(dir).catch(() => [] as string[]);
  const { rotated } = classifyLogFiles(files, currentFileName);
  if (rotated.length - state.lastKnownRotatedCount >= 2) {
    state.gapDetected = true;
    outcome.gapDetected = true;
  }
  state.lastKnownRotatedCount = rotated.length;

  if (!state.handle) {
    // B2-0 修正1（self-heal）: fd を保持していない（初回 tick 前に cold scan が current 無しで
    // 終わった、または前回 rotation で新 current の open に失敗した）。
    // 「その時点の current の内容は 1 行も集計していない」ことが保証されている 2 経路のみで
    // handle === null になるため、open 成功時は offset 0 からの全読みが安全（二重計上しない）。
    // rebuild は呼ばない（rotated/gz の再読による無駄と二重計上を避けるため、current 1 本だけを開き直す）。
    try {
      const handle = await open(currentPath, 'r');
      const st = await handle.stat();
      const buf = Buffer.alloc(st.size);
      if (st.size > 0) {
        await handle.read(buf, 0, st.size, 0);
      }
      const { lines, partial } = splitLines(buf.toString('utf8'), '');
      for (const line of lines) {
        const parsed = parseAccessLogLine(line);
        if (parsed) onLine(parsed, line);
      }
      state.handle = handle;
      state.currentInode = st.ino;
      state.offset = st.size;
      state.partial = partial;
      state.bytesReadTotal += st.size;
      state.reopenCount += 1;
      outcome.reopened = true;
    } catch {
      // open 失敗（ENOENT 等）→ state は一切変更せず、次 tick で再試行可能にする。
    }
    return outcome;
  }

  let pathStat;
  try {
    pathStat = await stat(currentPath);
  } catch {
    // current が一時的に見えない（rotate の瞬間等）。次 tick まで待つ。
    return outcome;
  }

  if (pathStat.ino !== state.currentInode) {
    // rotation 検出: まず旧 fd から EOF まで読み切る（rename 後も fd は同じ inode を指し続ける）
    outcome.rotated = true;
    const oldStat = await state.handle.stat();
    if (oldStat.size > state.offset) {
      const remaining = oldStat.size - state.offset;
      const buf = Buffer.alloc(remaining);
      await state.handle.read(buf, 0, remaining, state.offset);
      state.bytesReadTotal += remaining;
      const text = buf.toString('utf8');
      const { lines, partial } = splitLines(text, state.partial);
      for (const line of lines) {
        const parsed = parseAccessLogLine(line);
        if (parsed) onLine(parsed, line);
      }
      if (partial.length > 0) {
        // rotate 直前に割れた行は Caddy が 1 行 1 Write のため通常発生しないが、防御的に破棄してカウントする
        state.droppedPartialAtRotation += 1;
      }
      state.offset = oldStat.size;
      state.partial = '';
    }
    await state.handle.close().catch(() => undefined);
    state.handle = null;

    // 新しい current を開く
    try {
      const newHandle = await open(currentPath, 'r');
      const newStat = await newHandle.stat();
      state.handle = newHandle;
      state.currentInode = newStat.ino;
      state.offset = 0;
      state.partial = '';
      // 新 current にも既に追記されている分があれば読む
      if (newStat.size > 0) {
        const buf = Buffer.alloc(newStat.size);
        await newHandle.read(buf, 0, newStat.size, 0);
        state.bytesReadTotal += newStat.size;
        const { lines, partial } = splitLines(buf.toString('utf8'), '');
        for (const line of lines) {
          const parsed = parseAccessLogLine(line);
          if (parsed) onLine(parsed, line);
        }
        state.offset = newStat.size;
        state.partial = partial;
      }
    } catch {
      state.handle = null;
      state.currentInode = null;
    }
    return outcome;
  }

  // 同一 inode: 通常の差分読み
  const st = await state.handle.stat();
  if (st.size < state.offset) {
    // truncate（防御的）: offset をリセットして全読み
    outcome.truncatedInPlace = true;
    state.offset = 0;
    state.partial = '';
  }
  if (st.size > state.offset) {
    const diff = st.size - state.offset;
    const buf = Buffer.alloc(diff);
    await state.handle.read(buf, 0, diff, state.offset);
    state.bytesReadTotal += diff;
    const { lines, partial } = splitLines(buf.toString('utf8'), state.partial);
    for (const line of lines) {
      const parsed = parseAccessLogLine(line);
      if (parsed) onLine(parsed, line);
    }
    state.offset = st.size;
    state.partial = partial;
  }

  return outcome;
}
