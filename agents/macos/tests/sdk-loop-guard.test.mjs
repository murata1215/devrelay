// #355: SDK auto-compact 無限ループ検知（sdk-loop-guard.ts）の単体テスト。
// 外部 import ゼロの純粋関数（agents/linux/src/services/sdk-loop-guard.ts）を
// コンパイル済み dist から直接 import する（running-code-stale.test.mjs と同じ流儀）。
// agents/macos/tests/sdk-loop-guard.test.mjs と byte-for-byte 同一。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MAX_NO_PROGRESS_COMPACTS,
  DEFAULT_MAX_IDENTICAL_TOOL_REPEATS,
  DEFAULT_WALL_CLOCK_MS,
  DEFAULT_MIN_PROGRESS_TEXT_CHARS,
  resolveLoopGuardConfig,
  createLoopGuardState,
  stableToolSignature,
  observeLoopGuardEvent,
  checkWallClock,
} from '../dist/services/sdk-loop-guard.js';

const T0 = Date.parse('2026-09-02T11:18:11.000Z');
const DEFAULT_CONFIG = resolveLoopGuardConfig({});

// ============================================================
// A. stableToolSignature
// ============================================================

test('A1: stableToolSignature はキー順に依存しない', () => {
  const a = stableToolSignature('Bash', { command: 'ls', cwd: '/tmp' });
  const b = stableToolSignature('Bash', { cwd: '/tmp', command: 'ls' });
  assert.equal(a, b);
});

test('A2: stableToolSignature は深いネストを例外なく処理する', () => {
  let nested = { leaf: 1 };
  for (let i = 0; i < 50; i++) {
    nested = { child: nested };
  }
  assert.doesNotThrow(() => stableToolSignature('Tool', nested));
});

test('A3: stableToolSignature は長大な入力を切り詰める', () => {
  const bigString = 'x'.repeat(10000);
  const sig = stableToolSignature('Write', { content: bigString });
  assert.ok(sig.length < bigString.length);
  assert.ok(sig.includes('[truncated'));
});

test('A4: stableToolSignature は null/undefined を含む入力でも例外を投げない', () => {
  assert.doesNotThrow(() => stableToolSignature('Tool', null));
  assert.doesNotThrow(() => stableToolSignature('Tool', undefined));
  assert.doesNotThrow(() => stableToolSignature('Tool', { a: null, b: undefined }));
});

test('A5: stableToolSignature は非オブジェクト入力（文字列・数値・配列）を処理する', () => {
  assert.doesNotThrow(() => stableToolSignature('Tool', 'plain string'));
  assert.doesNotThrow(() => stableToolSignature('Tool', 42));
  assert.doesNotThrow(() => stableToolSignature('Tool', [1, 2, { a: 1 }]));
  const arrA = stableToolSignature('Tool', [1, 2, 3]);
  const arrB = stableToolSignature('Tool', [1, 2, 3]);
  assert.equal(arrA, arrB);
});

// ============================================================
// B. resolveLoopGuardConfig
// ============================================================

test('B1: resolveLoopGuardConfig は env 未指定時に既定値を返す', () => {
  const cfg = resolveLoopGuardConfig({});
  assert.equal(cfg.maxNoProgressCompacts, DEFAULT_MAX_NO_PROGRESS_COMPACTS);
  assert.equal(cfg.maxIdenticalToolRepeats, DEFAULT_MAX_IDENTICAL_TOOL_REPEATS);
  assert.equal(cfg.wallClockMs, DEFAULT_WALL_CLOCK_MS);
  assert.equal(cfg.minProgressTextChars, DEFAULT_MIN_PROGRESS_TEXT_CHARS);
  assert.equal(cfg.disabled, false);
});

test('B2: resolveLoopGuardConfig は各 env 変数で上書きできる', () => {
  const cfg = resolveLoopGuardConfig({
    DEVRELAY_SDK_MAX_NOPROGRESS_COMPACTS: '5',
    DEVRELAY_SDK_MAX_IDENTICAL_TOOL_REPEATS: '10',
    DEVRELAY_SDK_WALL_CLOCK_MS: '60000',
    DEVRELAY_SDK_MIN_PROGRESS_TEXT_CHARS: '0',
  });
  assert.equal(cfg.maxNoProgressCompacts, 5);
  assert.equal(cfg.maxIdenticalToolRepeats, 10);
  assert.equal(cfg.wallClockMs, 60000);
  assert.equal(cfg.minProgressTextChars, 0);
});

test('B3: resolveLoopGuardConfig は不正値（NaN・負数）を既定値にフォールバックする', () => {
  const cfg = resolveLoopGuardConfig({
    DEVRELAY_SDK_MAX_NOPROGRESS_COMPACTS: 'not-a-number',
    DEVRELAY_SDK_MAX_IDENTICAL_TOOL_REPEATS: '-3',
    DEVRELAY_SDK_WALL_CLOCK_MS: '',
  });
  assert.equal(cfg.maxNoProgressCompacts, DEFAULT_MAX_NO_PROGRESS_COMPACTS);
  assert.equal(cfg.maxIdenticalToolRepeats, DEFAULT_MAX_IDENTICAL_TOOL_REPEATS);
  assert.equal(cfg.wallClockMs, DEFAULT_WALL_CLOCK_MS);
});

test('B4: resolveLoopGuardConfig の minProgressTextChars は 0 を許容する（allowZero）', () => {
  const cfg = resolveLoopGuardConfig({ DEVRELAY_SDK_MIN_PROGRESS_TEXT_CHARS: '0' });
  assert.equal(cfg.minProgressTextChars, 0);
});

test('B5: resolveLoopGuardConfig はキルスイッチ DEVRELAY_SDK_LOOP_GUARD_DISABLED=1 を解決する', () => {
  assert.equal(resolveLoopGuardConfig({ DEVRELAY_SDK_LOOP_GUARD_DISABLED: '1' }).disabled, true);
  assert.equal(resolveLoopGuardConfig({ DEVRELAY_SDK_LOOP_GUARD_DISABLED: '0' }).disabled, false);
  assert.equal(resolveLoopGuardConfig({}).disabled, false);
});

// ============================================================
// C. 層1 真陽性（本事故の再現）
// ============================================================

test('C1: 本事故の再現 — compact×3連続・テキスト0・ツール1種類のみで abort する', () => {
  const state = createLoopGuardState(T0);
  let decision;
  for (let i = 0; i < 3; i++) {
    const nowMs = T0 + (i + 1) * 100_000;
    // ToolSearch(select:Bash) のみ、テキスト0文字
    observeLoopGuardEvent(state, { kind: 'tool', name: 'ToolSearch', input: { query: 'select:Bash' }, nowMs }, DEFAULT_CONFIG);
    decision = observeLoopGuardEvent(state, { kind: 'compact', preTokens: 169800, nowMs }, DEFAULT_CONFIG);
  }
  assert.equal(decision.abort, true);
  assert.equal(decision.reason, 'compactLoop');
  assert.equal(decision.detail.compacts, 3);
  assert.equal(decision.detail.preTokens, 169800);
});

test('C2: maxNoProgressCompacts 到達ちょうどで abort（境界値）', () => {
  const cfg = { ...DEFAULT_CONFIG, maxNoProgressCompacts: 2 };
  const state = createLoopGuardState(T0);
  observeLoopGuardEvent(state, { kind: 'compact', nowMs: T0 + 1000 }, cfg);
  const decision = observeLoopGuardEvent(state, { kind: 'compact', nowMs: T0 + 2000 }, cfg);
  assert.equal(decision.abort, true);
});

test('C3: テキストが空白のみ（trim後0文字）の場合は進捗なしと判定される', () => {
  const state = createLoopGuardState(T0);
  let decision;
  for (let i = 0; i < 3; i++) {
    const nowMs = T0 + (i + 1) * 100_000;
    observeLoopGuardEvent(state, { kind: 'text', text: '   \n\t  ', nowMs }, DEFAULT_CONFIG);
    observeLoopGuardEvent(state, { kind: 'tool', name: 'ToolSearch', input: { query: 'select:Bash' }, nowMs }, DEFAULT_CONFIG);
    decision = observeLoopGuardEvent(state, { kind: 'compact', nowMs }, DEFAULT_CONFIG);
  }
  assert.equal(decision.abort, true);
  assert.equal(decision.reason, 'compactLoop');
});

test('C4: 同一ツールを異なる入力で連打しても進捗にはならない（ツール名が1種類のまま）', () => {
  const state = createLoopGuardState(T0);
  let decision;
  for (let i = 0; i < 3; i++) {
    const nowMs = T0 + (i + 1) * 100_000;
    observeLoopGuardEvent(state, { kind: 'tool', name: 'Bash', input: { command: `ls ${i}` }, nowMs }, DEFAULT_CONFIG);
    decision = observeLoopGuardEvent(state, { kind: 'compact', nowMs }, DEFAULT_CONFIG);
  }
  assert.equal(decision.abort, true);
  assert.equal(decision.reason, 'compactLoop');
});

// ============================================================
// D. 層1 偽陰性防止（正常区間の再現）
// ============================================================

test('D1: 13:53以降の正常区間の再現 — compact多数＋テキスト＋複数ツールで発火しない', () => {
  const state = createLoopGuardState(T0);
  let decision = { abort: false };
  const texts = ['a'.repeat(2767), 'b'.repeat(1004), 'c'.repeat(983), 'd'.repeat(500), 'e'.repeat(700)];
  for (let i = 0; i < 5; i++) {
    const nowMs = T0 + (i + 1) * 150_000;
    observeLoopGuardEvent(state, { kind: 'text', text: texts[i], nowMs }, DEFAULT_CONFIG);
    observeLoopGuardEvent(state, { kind: 'tool', name: 'Edit', input: { file: `f${i}.ts` }, nowMs }, DEFAULT_CONFIG);
    observeLoopGuardEvent(state, { kind: 'tool', name: 'Read', input: { file: `g${i}.ts` }, nowMs }, DEFAULT_CONFIG);
    decision = observeLoopGuardEvent(state, { kind: 'compact', nowMs }, DEFAULT_CONFIG);
    assert.equal(decision.abort, false, `iteration ${i} unexpectedly aborted`);
  }
});

test('D2: テキストのみ（P1）で進捗ありと判定され連続 compact でも発火しない', () => {
  const state = createLoopGuardState(T0);
  let decision = { abort: false };
  for (let i = 0; i < 6; i++) {
    const nowMs = T0 + (i + 1) * 100_000;
    observeLoopGuardEvent(state, { kind: 'text', text: 'progress update text', nowMs }, DEFAULT_CONFIG);
    decision = observeLoopGuardEvent(state, { kind: 'compact', nowMs }, DEFAULT_CONFIG);
  }
  assert.equal(decision.abort, false);
});

test('D3: 異なるツール2種類のみ（P2、テキスト0）で進捗ありと判定される', () => {
  const state = createLoopGuardState(T0);
  let decision = { abort: false };
  for (let i = 0; i < 6; i++) {
    const nowMs = T0 + (i + 1) * 100_000;
    observeLoopGuardEvent(state, { kind: 'tool', name: 'Read', input: { file: 'a.ts' }, nowMs }, DEFAULT_CONFIG);
    observeLoopGuardEvent(state, { kind: 'tool', name: 'Grep', input: { pattern: 'x' }, nowMs }, DEFAULT_CONFIG);
    decision = observeLoopGuardEvent(state, { kind: 'compact', nowMs }, DEFAULT_CONFIG);
  }
  assert.equal(decision.abort, false);
});

test('D4: 進捗あり compact と進捗なし compact が交互に来る場合はカウンタが都度リセットされ発火しない', () => {
  const state = createLoopGuardState(T0);
  let decision = { abort: false };
  for (let i = 0; i < 8; i++) {
    const nowMs = T0 + (i + 1) * 100_000;
    if (i % 2 === 0) {
      observeLoopGuardEvent(state, { kind: 'text', text: 'ok', nowMs }, DEFAULT_CONFIG);
    } else {
      observeLoopGuardEvent(state, { kind: 'tool', name: 'ToolSearch', input: { query: 'select:Bash' }, nowMs }, DEFAULT_CONFIG);
    }
    decision = observeLoopGuardEvent(state, { kind: 'compact', nowMs }, DEFAULT_CONFIG);
    assert.equal(decision.abort, false);
  }
});

test('D5: disabled=true のときは事故パターンでも一切発火しない（キルスイッチ）', () => {
  const cfg = { ...DEFAULT_CONFIG, disabled: true };
  const state = createLoopGuardState(T0);
  let decision;
  for (let i = 0; i < 10; i++) {
    const nowMs = T0 + (i + 1) * 100_000;
    observeLoopGuardEvent(state, { kind: 'tool', name: 'ToolSearch', input: { query: 'select:Bash' }, nowMs }, cfg);
    decision = observeLoopGuardEvent(state, { kind: 'compact', nowMs }, cfg);
  }
  assert.equal(decision.abort, false);
});

// ============================================================
// E. 層2 同一ツール連打
// ============================================================

test('E1: 同一ツール（同一シグネチャ）5連続で発火する', () => {
  const state = createLoopGuardState(T0);
  let decision;
  for (let i = 0; i < 5; i++) {
    const nowMs = T0 + (i + 1) * 10_000;
    decision = observeLoopGuardEvent(state, { kind: 'tool', name: 'Bash', input: { command: 'ls' }, nowMs }, DEFAULT_CONFIG);
  }
  assert.equal(decision.abort, true);
  assert.equal(decision.reason, 'toolRepeat');
  assert.equal(decision.detail.repeats, 5);
  assert.equal(decision.detail.tool, 'Bash');
});

test('E2: 入力が毎回異なれば同一シグネチャにならず発火しない', () => {
  const state = createLoopGuardState(T0);
  let decision;
  for (let i = 0; i < 10; i++) {
    const nowMs = T0 + (i + 1) * 10_000;
    decision = observeLoopGuardEvent(state, { kind: 'tool', name: 'Bash', input: { command: `ls ${i}` }, nowMs }, DEFAULT_CONFIG);
  }
  assert.equal(decision.abort, false);
});

test('E3: 【回帰テスト】compact でカウンタがリセットされない — COMPACT→tool→COMPACT→tool パターンで層2が発火する', () => {
  const state = createLoopGuardState(T0);
  let decision;
  for (let i = 0; i < 5; i++) {
    const nowMs = T0 + (i + 1) * 100_000;
    observeLoopGuardEvent(state, { kind: 'compact', nowMs }, DEFAULT_CONFIG);
    decision = observeLoopGuardEvent(state, { kind: 'tool', name: 'ToolSearch', input: { query: 'select:Bash' }, nowMs: nowMs + 1 }, DEFAULT_CONFIG);
  }
  assert.equal(decision.abort, true);
  assert.equal(decision.reason, 'toolRepeat');
});

test('E4: maxIdenticalToolRepeats ちょうどで発火（境界値）、1回未満は発火しない', () => {
  const cfg = { ...DEFAULT_CONFIG, maxIdenticalToolRepeats: 3 };
  const state = createLoopGuardState(T0);
  let decision;
  decision = observeLoopGuardEvent(state, { kind: 'tool', name: 'Bash', input: { command: 'ls' }, nowMs: T0 + 1000 }, cfg);
  assert.equal(decision.abort, false);
  decision = observeLoopGuardEvent(state, { kind: 'tool', name: 'Bash', input: { command: 'ls' }, nowMs: T0 + 2000 }, cfg);
  assert.equal(decision.abort, false);
  decision = observeLoopGuardEvent(state, { kind: 'tool', name: 'Bash', input: { command: 'ls' }, nowMs: T0 + 3000 }, cfg);
  assert.equal(decision.abort, true);
});

test('E5: 途中でシグネチャが変わるとカウンタが1にリセットされる', () => {
  const state = createLoopGuardState(T0);
  observeLoopGuardEvent(state, { kind: 'tool', name: 'Bash', input: { command: 'ls' }, nowMs: T0 + 1000 }, DEFAULT_CONFIG);
  observeLoopGuardEvent(state, { kind: 'tool', name: 'Bash', input: { command: 'ls' }, nowMs: T0 + 2000 }, DEFAULT_CONFIG);
  observeLoopGuardEvent(state, { kind: 'tool', name: 'Bash', input: { command: 'pwd' }, nowMs: T0 + 3000 }, DEFAULT_CONFIG);
  assert.equal(state.identicalToolRepeatCount, 1);
  let decision;
  for (let i = 0; i < 4; i++) {
    decision = observeLoopGuardEvent(state, { kind: 'tool', name: 'Bash', input: { command: 'pwd' }, nowMs: T0 + 4000 + i * 1000 }, DEFAULT_CONFIG);
  }
  assert.equal(decision.abort, true);
});

test('E6: disabled=true のときは同一ツール連打でも発火しない', () => {
  const cfg = { ...DEFAULT_CONFIG, disabled: true };
  const state = createLoopGuardState(T0);
  let decision;
  for (let i = 0; i < 20; i++) {
    decision = observeLoopGuardEvent(state, { kind: 'tool', name: 'Bash', input: { command: 'ls' }, nowMs: T0 + i * 1000 }, cfg);
  }
  assert.equal(decision.abort, false);
});

// ============================================================
// F. 実行時間上限（checkWallClock）
// ============================================================

test('F1: 経過時間が上限ちょうどで abort（境界値）', () => {
  const state = createLoopGuardState(T0);
  const decision = checkWallClock(state, T0 + DEFAULT_WALL_CLOCK_MS, DEFAULT_CONFIG);
  assert.equal(decision.abort, true);
  assert.equal(decision.reason, 'wallClock');
});

test('F2: 経過時間が上限未満では abort しない', () => {
  const state = createLoopGuardState(T0);
  const decision = checkWallClock(state, T0 + DEFAULT_WALL_CLOCK_MS - 1, DEFAULT_CONFIG);
  assert.equal(decision.abort, false);
});

test('F3: 経過時間が上限を大きく超過した場合も abort し、経過分数・compact回数を detail に含む', () => {
  const state = createLoopGuardState(T0);
  state.totalCompacts = 79;
  const nowMs = T0 + 138.3 * 60_000;
  const decision = checkWallClock(state, nowMs, DEFAULT_CONFIG);
  assert.equal(decision.abort, true);
  assert.equal(decision.detail.compacts, 79);
  assert.ok(decision.detail.minutes >= 138);
});

test('F4: キルスイッチ有効時は経過時間が上限を超過しても abort しない', () => {
  const cfg = { ...DEFAULT_CONFIG, disabled: true };
  const state = createLoopGuardState(T0);
  const decision = checkWallClock(state, T0 + DEFAULT_WALL_CLOCK_MS * 10, cfg);
  assert.equal(decision.abort, false);
});

// ============================================================
// G. 不変条件
// ============================================================

test('G1: observeLoopGuardEvent は config オブジェクトを破壊しない（純関数性）', () => {
  const cfg = resolveLoopGuardConfig({});
  const cfgCopy = { ...cfg };
  const state = createLoopGuardState(T0);
  observeLoopGuardEvent(state, { kind: 'tool', name: 'Bash', input: { command: 'ls' }, nowMs: T0 + 1000 }, cfg);
  observeLoopGuardEvent(state, { kind: 'compact', nowMs: T0 + 2000 }, cfg);
  assert.deepEqual(cfg, cfgCopy);
});

test('G2: resolveLoopGuardConfig は渡された env オブジェクトを破壊しない', () => {
  const env = { DEVRELAY_SDK_MAX_NOPROGRESS_COMPACTS: '5' };
  const envCopy = { ...env };
  resolveLoopGuardConfig(env);
  assert.deepEqual(env, envCopy);
});

test('G3: observeLoopGuardEvent / checkWallClock はいかなる入力でも例外を投げない', () => {
  const state = createLoopGuardState(T0);
  assert.doesNotThrow(() => observeLoopGuardEvent(state, { kind: 'text', text: undefined, nowMs: T0 }, DEFAULT_CONFIG));
  assert.doesNotThrow(() => observeLoopGuardEvent(state, { kind: 'tool', name: undefined, input: undefined, nowMs: T0 }, DEFAULT_CONFIG));
  assert.doesNotThrow(() => observeLoopGuardEvent(state, { kind: 'compact', preTokens: undefined, nowMs: T0 }, DEFAULT_CONFIG));
  assert.doesNotThrow(() => checkWallClock(state, T0 - 100000, DEFAULT_CONFIG));
});

test('G4: 同一入力に対して observeLoopGuardEvent は決定的（同じ結果を返す）', () => {
  const stateA = createLoopGuardState(T0);
  const stateB = createLoopGuardState(T0);
  const events = [
    { kind: 'tool', name: 'ToolSearch', input: { query: 'select:Bash' }, nowMs: T0 + 100000 },
    { kind: 'compact', preTokens: 169800, nowMs: T0 + 100000 },
  ];
  let lastA, lastB;
  for (const e of events) {
    lastA = observeLoopGuardEvent(stateA, e, DEFAULT_CONFIG);
    lastB = observeLoopGuardEvent(stateB, e, DEFAULT_CONFIG);
  }
  assert.deepEqual(lastA, lastB);
});
