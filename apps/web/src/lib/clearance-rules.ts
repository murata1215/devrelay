/**
 * 高辻ナレッジ サイクル3（WebUI）: 権限設定（設定>組織「ナレッジ権限」節）・案件/スレッドの
 * 機密度エディタが使う純関数群（外部 import ゼロ。knowledge-search-rules.ts と同じ流儀）。
 *
 * `PUT /api/org/members/:userId/clearance` は `readLevel`/`writeLevel`/`compartments` の
 * 3 フィールドを常に必須で受け取る（省略不可）ため、`validateClearanceDraft` は常に 3 つ揃った
 * ボディを返す。`PUT /api/projects/:id/classification` と `PUT /api/threads/:id/classification` は
 * 逆に「省略 = 変更なし、null = 継承へ戻す」なので `buildClassificationPatch` は変更したキーだけを
 * 返す。この非対称性を UI コンポーネント側に持たせず、ここに 1 箇所で固定する。
 *
 * もう一つの罠: どちらの PUT も権限エラーを 403 ではなく 400 で返す（404 は
 * 'Project not found' / 'Session not found' のみ）。さらに `lib/api.ts` の `request()` は
 * ステータスを捨てて `Error(body.error)` だけを投げるため、呼び出し側は**ステータスで分岐できない**。
 * `isClassificationForbiddenError` 等の文言マッチャで判定する。
 */

export const CLEARANCE_LEVEL_MIN = 0;
export const CLEARANCE_LEVEL_MAX = 10;
export const COMPARTMENT_WILDCARD = '*';

export type OrgRoleLike = 'admin' | 'manager' | 'member' | null | undefined;

export interface ClearanceValue {
  readLevel: number;
  writeLevel: number;
  compartments: string[];
}

export interface ClearanceDraft {
  readLevel: string;
  writeLevel: string;
  compartmentsInput: string;
}

// ---- role ゲート（表示の出し分けのみ。最終判定は常にサーバー） ----

/** `GET /api/org/clearance` を見られるか（admin・manager）。 */
export function canViewClearance(role: OrgRoleLike): boolean {
  return role === 'admin' || role === 'manager';
}

/** `PUT /api/org/members/:userId/clearance` を叩けるか（admin のみ）。 */
export function canEditClearance(role: OrgRoleLike): boolean {
  return role === 'admin';
}

/** 自分自身の権限は常に閲覧できる（組織なしでも `GET /api/org/members/:self/clearance` は 200）。 */
export function canEditOwnClearance(role: OrgRoleLike, viewerUserId: string, targetUserId: string): boolean {
  return viewerUserId === targetUserId || canEditClearance(role);
}

/** 案件/スレッドの機密度を編集できるか（所有者本人、または同組織の admin/manager）。 */
export function canEditClassification(role: OrgRoleLike, viewerUserId: string, ownerUserId: string): boolean {
  if (viewerUserId === ownerUserId) return true;
  return role === 'admin' || role === 'manager';
}

/** スレッドビューア内の機密度エディタを表示するか（`isOwn` または admin/manager）。 */
export function canShowThreadEditor(input: { isOwn: boolean; role: OrgRoleLike }): boolean {
  return input.isOwn || input.role === 'admin' || input.role === 'manager';
}

// ---- 案件名（compartment）チップ ----

const COMPARTMENT_SPLIT_PATTERN = /[,\n、，]+/;

/** カンマ（半角/全角）・改行で分割し、trim・空除去・重複除去する。NFKC 等の正規化はサーバーに任せる。 */
export function parseCompartmentInput(raw: string): string[] {
  const parts = raw
    .split(COMPARTMENT_SPLIT_PATTERN)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return Array.from(new Set(parts));
}

/** `'*'` を先頭に、残りを昇順ソート。重複除去。 */
export function normalizeCompartmentList(values: readonly string[]): string[] {
  const unique = Array.from(new Set(values.map((v) => v.trim()).filter((v) => v.length > 0)));
  const hasWildcard = unique.includes(COMPARTMENT_WILDCARD);
  const rest = unique.filter((v) => v !== COMPARTMENT_WILDCARD).sort();
  return hasWildcard ? [COMPARTMENT_WILDCARD, ...rest] : rest;
}

export function serializeCompartmentList(values: readonly string[]): string {
  return normalizeCompartmentList(values).join(', ');
}

/** `'*'` と他の案件名が同時に存在する状態を検出する（排他ルール違反）。 */
export function compartmentConflict(values: readonly string[]): { conflict: boolean; kind: 'wildcard-exclusive' | null } {
  const hasWildcard = values.includes(COMPARTMENT_WILDCARD);
  const hasOthers = values.some((v) => v !== COMPARTMENT_WILDCARD);
  if (hasWildcard && hasOthers) return { conflict: true, kind: 'wildcard-exclusive' };
  return { conflict: false, kind: null };
}

/** `'*'` を ON にしたら他のチップを全て落とす。OFF にしたら `'*'` だけ除く。 */
export function applyWildcardExclusivity(values: readonly string[], on?: boolean): string[] {
  if (on === true) return [COMPARTMENT_WILDCARD];
  if (on === false) return values.filter((v) => v !== COMPARTMENT_WILDCARD);
  // on 省略時は「現在 '*' を含むなら '*' だけにする」（追加操作の後始末として使う）
  return values.includes(COMPARTMENT_WILDCARD) ? [COMPARTMENT_WILDCARD] : [...values];
}

/** 閲覧者の案件名リストが `required` にアクセス可能かを判定する（`'*'` は全案件、`[]` は壁なし案件のみ）。 */
export function hasCompartmentAccess(viewerCompartments: readonly string[], required: string | null): boolean {
  if (required === null) return true;
  if (viewerCompartments.includes(COMPARTMENT_WILDCARD)) return true;
  return viewerCompartments.includes(required);
}

// ---- level 検証 ----

export type LevelParseReason = 'empty' | 'not-integer' | 'out-of-range';
export type LevelParse = { ok: true; value: number } | { ok: false; reason: LevelParseReason };

/** `''` は `0` ではなく `empty` エラー（`parseMaxLevel` と同じ罠の封じ込め）。 */
export function parseLevelInput(raw: string): LevelParse {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, reason: 'empty' };
  if (!/^-?\d+$/.test(trimmed)) return { ok: false, reason: 'not-integer' };
  const n = Number(trimmed);
  if (n < CLEARANCE_LEVEL_MIN || n > CLEARANCE_LEVEL_MAX) return { ok: false, reason: 'out-of-range' };
  return { ok: true, value: n };
}

// ---- クリアランス（人の権限）フォーム ----

export interface ClearanceFieldError {
  field: 'readLevel' | 'writeLevel' | 'compartments';
  reason: LevelParseReason | 'wildcard-exclusive';
}

export type ClearanceValidation =
  | { ok: true; value: ClearanceValue }
  | { ok: false; errors: ClearanceFieldError[] };

/**
 * ドラフト（入力欄の生テキスト）を検証する。API が 3 フィールドとも必須なので、
 * 成功時は常に 3 フィールド揃ったボディを返す。read/write 両方のエラーは両方報告する
 * （先に見つかったほうだけ返して短絡させない）。
 */
export function validateClearanceDraft(draft: ClearanceDraft): ClearanceValidation {
  const errors: ClearanceFieldError[] = [];

  const read = parseLevelInput(draft.readLevel);
  if (!read.ok) errors.push({ field: 'readLevel', reason: read.reason });

  const write = parseLevelInput(draft.writeLevel);
  if (!write.ok) errors.push({ field: 'writeLevel', reason: write.reason });

  const compartments = parseCompartmentInput(draft.compartmentsInput);
  const conflict = compartmentConflict(compartments);
  if (conflict.conflict) errors.push({ field: 'compartments', reason: 'wildcard-exclusive' });

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      readLevel: (read as { ok: true; value: number }).value,
      writeLevel: (write as { ok: true; value: number }).value,
      compartments: normalizeCompartmentList(compartments),
    },
  };
}

export function toClearanceDraft(value: ClearanceValue): ClearanceDraft {
  return {
    readLevel: String(value.readLevel),
    writeLevel: String(value.writeLevel),
    compartmentsInput: serializeCompartmentList(value.compartments),
  };
}

/** 空白差・チップの並び順差は dirty とみなさない（保存ボタンの誤爆防止）。 */
export function isClearanceDirty(original: ClearanceValue, draft: ClearanceDraft): boolean {
  const validated = validateClearanceDraft(draft);
  if (!validated.ok) return true; // 入力エラー自体が「未保存の変更」とみなす
  const v = validated.value;
  if (v.readLevel !== original.readLevel) return true;
  if (v.writeLevel !== original.writeLevel) return true;
  const a = normalizeCompartmentList(original.compartments);
  const b = normalizeCompartmentList(v.compartments);
  if (a.length !== b.length) return true;
  return a.some((c, i) => c !== b[i]);
}

// ---- 案件・スレッドの機密度（classification）編集 ----

export interface ClassificationValue {
  level: number | null;
  compartment: string | null;
}

/** フォーム入力の生テキスト。`''` は「継承（null）」を意味する。 */
export interface ClassificationDraft {
  level: string;
  compartment: string;
}

export type ClassificationPatch = { level?: number | null; compartment?: string | null };

export function toClassificationDraft(v: ClassificationValue): ClassificationDraft {
  return {
    level: v.level === null ? '' : String(v.level),
    compartment: v.compartment ?? '',
  };
}

/**
 * `original` と `draft` を比較し、変更があったキーだけを含む PUT ボディを作る
 * （省略 = 変更なし、`null` = 継承へ戻す、という API の非対称仕様をここに閉じ込める）。
 * 変更が無ければ `{ ok: true, patch: {} }`。`level` が不正なら `{ ok: false, key: 'level' }`。
 */
export function buildClassificationPatch(
  original: ClassificationValue,
  draft: ClassificationDraft
): { ok: true; patch: ClassificationPatch } | { ok: false; key: 'level' } {
  const patch: ClassificationPatch = {};

  const trimmedLevel = draft.level.trim();
  let nextLevel: number | null;
  if (trimmedLevel === '') {
    nextLevel = null;
  } else {
    const parsed = parseLevelInput(trimmedLevel);
    if (!parsed.ok) return { ok: false, key: 'level' };
    nextLevel = parsed.value;
  }
  if (nextLevel !== original.level) patch.level = nextLevel;

  const trimmedCompartment = draft.compartment.trim();
  const nextCompartment = trimmedCompartment === '' ? null : trimmedCompartment;
  if (nextCompartment !== original.compartment) patch.compartment = nextCompartment;

  return { ok: true, patch };
}

export function isClassificationDirty(original: ClassificationValue, draft: ClassificationDraft): boolean {
  const result = buildClassificationPatch(original, draft);
  if (!result.ok) return true;
  return Object.keys(result.patch).length > 0;
}

export interface EffectiveClassificationSnapshot {
  level: number | null;
  compartment: string | null;
  effectiveLevel: number;
  effectiveCompartment: string | null;
}

export function describeEffectiveClassification(snapshot: EffectiveClassificationSnapshot): {
  levelInherited: boolean;
  compartmentInherited: boolean;
  effectiveLevel: number;
  effectiveCompartment: string | null;
} {
  return {
    levelInherited: snapshot.level === null,
    compartmentInherited: snapshot.compartment === null,
    effectiveLevel: snapshot.effectiveLevel,
    effectiveCompartment: snapshot.effectiveCompartment,
  };
}

// ---- エラー文言判定 ----

export const ORG_LESS_MESSAGE = '組織に所属していません';
export const ADMIN_REQUIRED_MESSAGE = '管理者権限が必要です';
export const MANAGER_OR_ADMIN_REQUIRED_MESSAGE = '管理者またはマネージャー権限が必要です';

export function isOrgLessError(message: string | null | undefined): boolean {
  return message === ORG_LESS_MESSAGE;
}

export function isAdminRequiredError(message: string | null | undefined): boolean {
  return message === ADMIN_REQUIRED_MESSAGE;
}

/** 機密度 PUT の権限エラーは 400 で返り、文言は常に `'Forbidden: ...'` で始まる。 */
export function isClassificationForbiddenError(message: string | null | undefined): boolean {
  return typeof message === 'string' && message.startsWith('Forbidden:');
}
