/**
 * Usage（コスト集計）サイクル: 人別・グループ別・プロジェクト別・案件別のコスト集計の純関数群。
 *
 * - サーバー（`GET /api/usage` / サイネージ用 `GET /api/public/usage-signage`）と WebUI（`/usage` の
 *   小計・CSV）の両方から使うため shared に置く（同じ集計式を二重実装しない）。
 * - 金額そのものはここでは計算しない。1 ターンの金額は会話履歴のコスト列と同じ
 *   `resolveMessageCost()`（model-pricing.ts）でサーバーが出し、スレッド単位に合計した
 *   `UsageThreadRow` をここに渡す。
 * - 金額が不明（`resolveMessageCost` が null）のターンは 0 として足し、`unknownTurns` に件数だけ数える
 *   （「-」を $0.00 と誤解させないため、画面には「不明 n 件」を併記する）。
 * - 月の区切りは日本時間（Asia/Tokyo、UTC+9 固定・夏時間なし）の暦月。
 *
 * 外部 import なし（dist を node:test から直接 import してテストする）。
 */

/** 集計に使うタイムゾーン（画面のラベル表示用）。 */
export const USAGE_TIME_ZONE = 'Asia/Tokyo';

/** JST の UTC オフセット（ミリ秒）。日本は夏時間がないので固定値でよい。 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** グループ名・案件名の最大長（UI での表示崩れと DB 肥大の防止）。 */
export const USAGE_LABEL_MAX_LENGTH = 40;

/** スレッド 1 本分の集計行（= 明細表の 1 行）。 */
export interface UsageThreadRow {
  sessionId: string;
  userId: string;
  userName: string;
  /** 人に付けたグループ（null = タグなし）。 */
  group: string | null;
  /** プロジェクト表示名（別マシンの同名プロジェクトは同じキーになる）。 */
  projectName: string;
  /** スレッドに付けた案件（null = 案件なし）。 */
  caseName: string | null;
  threadTitle: string;
  /** 金額不明のターンを 0 として足した合計（USD）。 */
  costUsd: number;
  /** AI 応答（ターン）数。 */
  turns: number;
  /** うち金額不明のターン数。 */
  unknownTurns: number;
  /** 期間内の最後の AI 応答時刻（ISO 文字列）。 */
  lastAt: string;
}

/** 集計の切り口。 */
export type UsageAxis = 'group' | 'user' | 'project' | 'case';

export const USAGE_AXES: readonly UsageAxis[] = ['group', 'user', 'project', 'case'];

export function isUsageAxis(value: unknown): value is UsageAxis {
  return typeof value === 'string' && (USAGE_AXES as readonly string[]).includes(value);
}

/** 1 つの切り口での小計。`key` が null のものは「タグなし」「案件なし」。 */
export interface UsageBucket {
  key: string | null;
  label: string | null;
  costUsd: number;
  turns: number;
  unknownTurns: number;
  threads: number;
}

export interface UsageTotals {
  costUsd: number;
  turns: number;
  unknownTurns: number;
  threads: number;
}

/** 行から切り口のキーと表示名を取り出す（利用者は同名の別人を分けるため userId をキーにする）。 */
export function usageAxisKey(row: UsageThreadRow, axis: UsageAxis): { key: string | null; label: string | null } {
  switch (axis) {
    case 'group':
      return { key: row.group, label: row.group };
    case 'user':
      return { key: row.userId, label: row.userName };
    case 'project':
      return { key: row.projectName, label: row.projectName };
    case 'case':
      return { key: row.caseName, label: row.caseName };
  }
}

/** 全行の合計。 */
export function totalUsage(rows: readonly UsageThreadRow[]): UsageTotals {
  const t: UsageTotals = { costUsd: 0, turns: 0, unknownTurns: 0, threads: 0 };
  for (const r of rows) {
    t.costUsd += r.costUsd;
    t.turns += r.turns;
    t.unknownTurns += r.unknownTurns;
    t.threads += 1;
  }
  return t;
}

/**
 * 切り口ごとの小計。金額の多い順（同額なら表示名順）に並べ、キーなし（タグなし・案件なし）は最後に置く。
 */
export function summarizeUsage(rows: readonly UsageThreadRow[], axis: UsageAxis): UsageBucket[] {
  const map = new Map<string, UsageBucket>();
  for (const r of rows) {
    const { key, label } = usageAxisKey(r, axis);
    const mapKey = key === null ? '\u0000none' : `k:${key}`;
    let b = map.get(mapKey);
    if (!b) {
      b = { key, label, costUsd: 0, turns: 0, unknownTurns: 0, threads: 0 };
      map.set(mapKey, b);
    }
    b.costUsd += r.costUsd;
    b.turns += r.turns;
    b.unknownTurns += r.unknownTurns;
    b.threads += 1;
  }
  return [...map.values()].sort(compareBuckets);
}

function compareBuckets(a: UsageBucket, b: UsageBucket): number {
  if ((a.key === null) !== (b.key === null)) return a.key === null ? 1 : -1;
  if (b.costUsd !== a.costUsd) return b.costUsd - a.costUsd;
  return (a.label ?? '').localeCompare(b.label ?? '');
}

/** 外側の切り口ごとに、内側の切り口の小計を持つ入れ子集計（サイネージのカード用）。 */
export interface UsageNestedBucket extends UsageBucket {
  items: UsageBucket[];
}

export function summarizeUsageNested(
  rows: readonly UsageThreadRow[],
  outer: UsageAxis,
  inner: UsageAxis,
): UsageNestedBucket[] {
  const groups = new Map<string, UsageThreadRow[]>();
  for (const r of rows) {
    const { key } = usageAxisKey(r, outer);
    const mapKey = key === null ? '\u0000none' : `k:${key}`;
    const arr = groups.get(mapKey);
    if (arr) arr.push(r);
    else groups.set(mapKey, [r]);
  }
  return summarizeUsage(rows, outer).map((b) => {
    const mapKey = b.key === null ? '\u0000none' : `k:${b.key}`;
    return { ...b, items: summarizeUsage(groups.get(mapKey) ?? [], inner) };
  });
}

// ---------------------------------------------------------------------------
// 月（JST 暦月）
// ---------------------------------------------------------------------------

const MONTH_KEY_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** `YYYY-MM` 形式か。 */
export function isValidMonthKey(value: unknown): value is string {
  return typeof value === 'string' && MONTH_KEY_RE.test(value);
}

/** 指定時刻が属する JST の月キー（`YYYY-MM`）。 */
export function jstMonthKey(date: Date): string {
  const d = new Date(date.getTime() + JST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** 月キーを delta か月ずらす（-1 で前月）。 */
export function shiftMonthKey(key: string, delta: number): string {
  const m = MONTH_KEY_RE.exec(key);
  if (!m) throw new Error(`invalid month key: ${key}`);
  const idx = Number(m[1]) * 12 + (Number(m[2]) - 1) + delta;
  const y = Math.floor(idx / 12);
  const mo = idx - y * 12 + 1;
  return `${y}-${String(mo).padStart(2, '0')}`;
}

/** JST 暦月の [start, end) を UTC の Date で返す。 */
export function jstMonthRange(key: string): { start: Date; end: Date } {
  const m = MONTH_KEY_RE.exec(key);
  if (!m) throw new Error(`invalid month key: ${key}`);
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  return {
    start: new Date(Date.UTC(y, mo, 1) - JST_OFFSET_MS),
    end: new Date(Date.UTC(y, mo + 1, 1) - JST_OFFSET_MS),
  };
}

// ---------------------------------------------------------------------------
// ラベル（グループ名・案件名）
// ---------------------------------------------------------------------------

/**
 * グループ名・案件名の入力を正規化する。
 * - 前後空白を除去し、連続する空白を 1 つに詰める
 * - 空文字・null は「未設定」（null）
 * - 文字列以外・長すぎるものは不正（`ok: false`）
 */
export function normalizeUsageLabel(raw: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: 'ラベルは文字列で指定してください' };
  const v = raw.replace(/[\s　]+/g, ' ').trim();
  if (!v) return { ok: true, value: null };
  if (v.length > USAGE_LABEL_MAX_LENGTH) {
    return { ok: false, error: `ラベルは ${USAGE_LABEL_MAX_LENGTH} 文字以内にしてください` };
  }
  return { ok: true, value: v };
}

// ---------------------------------------------------------------------------
// 表示・出力
// ---------------------------------------------------------------------------

/** `$1,234.56` 形式。 */
export function formatUsageUsd(n: number): string {
  const v = Math.round(n * 100) / 100;
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** 前月比（%）。前月が 0 なら null（比較不能）。 */
export function usageChangeRatio(current: number, previous: number): number | null {
  if (!(previous > 0)) return null;
  return ((current - previous) / previous) * 100;
}

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 明細の CSV（Excel で開いて文字化けしないよう先頭に BOM を付ける）。
 * `noneGroup` / `noneCase` は未設定時に出す文字列。
 */
export function usageRowsToCsv(
  rows: readonly UsageThreadRow[],
  opts: { noneGroup: string; noneCase: string } = { noneGroup: '', noneCase: '' },
): string {
  const header = ['グループ', '利用者', 'プロジェクト', '案件', 'スレッド', '金額(USD)', 'ターン数', '金額不明ターン数', '最終応答'];
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.group ?? opts.noneGroup,
        r.userName,
        r.projectName,
        r.caseName ?? opts.noneCase,
        r.threadTitle,
        (Math.round(r.costUsd * 10000) / 10000).toFixed(4),
        r.turns,
        r.unknownTurns,
        r.lastAt,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}
