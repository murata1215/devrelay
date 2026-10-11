/**
 * 高辻ナレッジ サイクル2: 数値権限（0〜10）＋ 案件の壁（compartment）の可視判定・付与判定を行う
 * 純関数モジュール。外部 import ゼロ（`knowledge-rank.ts` / `thread-list-filter.ts` と同じ流儀。
 * `node --test` から `dist/` を直接 import してテストする）。
 *
 * 用語（指示書 §1）:
 * - level: 会話の機密度。0〜10 の整数。0 = 組織内の全員が見てよい、10 = 最高機密
 * - compartment: 案件名の文字列（横の壁）。null = 壁なし
 * - readLevel / writeLevel: その人が読める／付けられる上限
 * - compartments: その人が見てよい案件名のリスト。"*" 1 要素なら全案件
 *
 * 見える条件（指示書 §1）: 自分の会話 または（同じ組織 かつ level ≤ readLevel かつ
 * （compartment が null または自分のリストに含む））
 */

/** level の範囲（指示書 D1: 0〜10 固定）。 */
export const CLASSIFICATION_LEVEL_MIN = 0;
export const CLASSIFICATION_LEVEL_MAX = 10;

/** compartment 文字列の最大長（指示書 D8）。 */
export const COMPARTMENT_MAX_LENGTH = 64;

/** compartments リストにこの値が含まれていれば全案件を許可する（指示書 D7）。 */
export const COMPARTMENT_WILDCARD = '*';

/** UserClearance.compartments の要素数上限（SQL の IN 展開数に上限を設けるため）。 */
export const COMPARTMENT_LIST_MAX = 64;

/**
 * 検索・閲覧を行う人の実効権限（検索 1 回・閲覧 1 回につき 1 回だけ DB から読む）。
 * `OrganizationMember` と `UserClearance` の 2 クエリから組み立てる（指示書 §4.1）。
 */
export interface KnowledgeViewer {
  userId: string;
  /** 組織未所属は null（D6: 組織が無ければ他人の会話は一切見えない） */
  organizationId: string | null;
  readLevel: number;
  writeLevel: number;
  /** "*" を含むなら全案件 */
  compartments: string[];
  /** 組織 admin は D7 の付与制限をバイパスする */
  isOrgAdmin: boolean;
}

/** 可視判定の対象となる 1 ターン（会話）の実効値。 */
export interface TurnClassification {
  ownerUserId: string;
  ownerOrganizationId: string | null;
  effectiveLevel: number;
  effectiveCompartment: string | null;
}

/**
 * Session / Project の null 継承を解決し、実効 level / compartment を求める（指示書 §3.3、D2/D3）。
 * `effectiveLevel = session.level ?? project.defaultLevel ?? 0`
 * `effectiveCompartment = session.compartment ?? project.defaultCompartment ?? null`
 */
export function resolveEffectiveClassification(
  session: { level: number | null | undefined; compartment: string | null | undefined },
  project: { defaultLevel: number | null | undefined; defaultCompartment: string | null | undefined }
): { level: number; compartment: string | null } {
  const level = session.level ?? project.defaultLevel ?? 0;
  const compartment = session.compartment ?? project.defaultCompartment ?? null;
  return { level, compartment };
}

/**
 * 1 ターンが viewer に見えるかを判定する（指示書 §4.2 の 5 段判定）。
 *
 * 1. 自分の会話 → true（D5: オーナー例外。協力会社の人が自分で書いた高機密の会話を
 *    自分で読めなくなる事故を防ぐ。本人には level/compartment の制限が一切かからない）
 * 2. 組織未所属、または対象と組織が違う → false（D6）
 * 3. effectiveLevel が readLevel を超える → false
 * 4. effectiveCompartment が null でなく、"*" も効果 compartment も持っていない → false
 * 5. それ以外 → true
 */
export function isTurnVisible(viewer: KnowledgeViewer, turn: TurnClassification): boolean {
  if (turn.ownerUserId === viewer.userId) {
    return true;
  }
  if (viewer.organizationId === null || turn.ownerOrganizationId !== viewer.organizationId) {
    return false;
  }
  if (turn.effectiveLevel > viewer.readLevel) {
    return false;
  }
  if (turn.effectiveCompartment !== null) {
    const hasWildcard = viewer.compartments.includes(COMPARTMENT_WILDCARD);
    const hasExact = viewer.compartments.includes(turn.effectiveCompartment);
    if (!hasWildcard && !hasExact) {
      return false;
    }
  }
  return true;
}

/** `buildVisibilityPredicate` の戻り値。 */
export interface VisibilityPredicate {
  /** WHERE 句に埋め込む SQL 断片（括弧込み）。 */
  sql: string;
  /** `sql` が消費する bind パラメータ（$startIndex から順に積む）。 */
  params: unknown[];
  /** 続く条件が使ってよい次の `$n` の番号。 */
  nextIndex: number;
}

/**
 * 検索候補クエリの WHERE に差し込む可視判定の SQL 述語を組み立てる（指示書 §4.3）。
 *
 * 呼び出し側は FROM 句に以下の JOIN を追加していることが前提:
 * `JOIN "Session" s ON s.id = kc."sessionId"`
 * `JOIN "Project" p ON p.id = s."projectId"`
 * `LEFT JOIN "OrganizationMember" om ON om."userId" = kc."userId"`
 *
 * - `scope='mine'`: `kc."userId" = $n` の 1 本のみ（他人は一切候補に出さない）
 * - `scope='all'` かつ `viewer.organizationId === null`: 同上 1 本のみ
 *   （「組織なしなら構造的に自分だけ」を機械的に保証する。$orgId IS NULL の分岐を SQL に書かない）
 * - `scope='all'` かつ組織あり: 「自分の会話」OR「同じ組織 かつ level 以下 かつ compartment 条件」
 *   - compartments に `"*"` を含む場合は compartment の括弧ごと省略（全案件許可）
 *   - compartments が空の場合は `IS NULL` 節のみ（壁なしの会話しか見えない）
 *   - それ以外は `IS NULL OR IN ($n, $n+1, …)`（指示書 D8: 完全一致、配列は個別スカラーへ展開）
 *
 * @param startIndex 最初に使う `$n` の番号（呼び出し側が既に使った分の続き）
 */
export function buildVisibilityPredicate(
  viewer: KnowledgeViewer,
  scope: 'all' | 'mine',
  startIndex: number
): VisibilityPredicate {
  if (scope === 'mine' || viewer.organizationId === null) {
    return {
      sql: `kc."userId" = $${startIndex}`,
      params: [viewer.userId],
      nextIndex: startIndex + 1,
    };
  }

  const params: unknown[] = [viewer.userId];
  let idx = startIndex + 1; // $startIndex は kc."userId" = $n （自分の会話）に使う

  const orgIdIndex = idx++;
  params.push(viewer.organizationId);

  const readLevelIndex = idx++;
  params.push(viewer.readLevel);

  const hasWildcard = viewer.compartments.includes(COMPARTMENT_WILDCARD);
  let compartmentClause: string;
  if (hasWildcard) {
    compartmentClause = '';
  } else if (viewer.compartments.length === 0) {
    compartmentClause = ` AND COALESCE(s."compartment", p."defaultCompartment") IS NULL`;
  } else {
    const placeholders = viewer.compartments.map(() => `$${idx++}`);
    params.push(...viewer.compartments);
    compartmentClause =
      ` AND (COALESCE(s."compartment", p."defaultCompartment") IS NULL` +
      ` OR COALESCE(s."compartment", p."defaultCompartment") IN (${placeholders.join(', ')}))`;
  }

  const sql =
    `(kc."userId" = $${startIndex}` +
    ` OR (om."organizationId" = $${orgIdIndex}` +
    ` AND COALESCE(s."level", p."defaultLevel", 0) <= $${readLevelIndex}` +
    compartmentClause +
    `))`;

  return { sql, params, nextIndex: idx };
}

/** `search_knowledge` の追加絞り込み（§5.1 の `compartment` / `maxLevel`）。 */
export interface ClassificationFilter {
  compartment?: string;
  maxLevel?: number;
}

/**
 * `search_knowledge` の追加パラメータ（`compartment` / `maxLevel`）を候補クエリの WHERE に
 * 追加する述語を組み立てる。可視判定（`buildVisibilityPredicate`）とは独立した絞り込みで、
 * 両方を AND で繋ぐ想定。該当パラメータが無ければ `sql: null` を返す。
 */
export function buildClassificationFilterPredicate(
  filter: ClassificationFilter,
  startIndex: number
): { sql: string | null; params: unknown[]; nextIndex: number } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  let idx = startIndex;

  if (filter.compartment !== undefined) {
    clauses.push(`COALESCE(s."compartment", p."defaultCompartment") = $${idx}`);
    params.push(filter.compartment);
    idx++;
  }
  if (filter.maxLevel !== undefined) {
    clauses.push(`COALESCE(s."level", p."defaultLevel", 0) <= $${idx}`);
    params.push(filter.maxLevel);
    idx++;
  }

  if (clauses.length === 0) {
    return { sql: null, params: [], nextIndex: startIndex };
  }
  return { sql: clauses.join(' AND '), params, nextIndex: idx };
}

/** `normalizeCompartment` の戻り値。 */
export type NormalizeCompartmentResult =
  | { ok: true; value: string | null }
  | { ok: false; error: string };

/**
 * compartment 文字列を正規化する（指示書 D8）。
 * trim → NFKC 正規化 → 空文字は null → 64 文字超はエラー。比較は完全一致（大文字小文字は区別する）。
 */
export function normalizeCompartment(raw: string | null | undefined): NormalizeCompartmentResult {
  if (raw === null || raw === undefined) {
    return { ok: true, value: null };
  }
  const normalized = raw.trim().normalize('NFKC');
  if (normalized.length === 0) {
    return { ok: true, value: null };
  }
  if (normalized.length > COMPARTMENT_MAX_LENGTH) {
    return { ok: false, error: `compartment must be ${COMPARTMENT_MAX_LENGTH} characters or fewer` };
  }
  return { ok: true, value: normalized };
}

/** `normalizeLevel` の戻り値。 */
export type NormalizeLevelResult =
  | { ok: true; value: number | null }
  | { ok: false; error: string };

/**
 * level を検証する（指示書 D1）。`null`/`undefined` はそのまま通す（= 継承に戻す）。
 * 0〜10 の整数以外（範囲外・小数・文字列・NaN）は明示エラー。
 */
export function normalizeLevel(raw: unknown): NormalizeLevelResult {
  if (raw === null || raw === undefined) {
    return { ok: true, value: null };
  }
  if (
    typeof raw !== 'number' ||
    !Number.isInteger(raw) ||
    raw < CLASSIFICATION_LEVEL_MIN ||
    raw > CLASSIFICATION_LEVEL_MAX
  ) {
    return {
      ok: false,
      error: `level must be an integer between ${CLASSIFICATION_LEVEL_MIN} and ${CLASSIFICATION_LEVEL_MAX}`,
    };
  }
  return { ok: true, value: raw };
}

/** `canAssignClassification` が受け取る「現在値／新しい値」の形。 */
export interface ClassificationValue {
  level: number | null;
  compartment: string | null;
}

/** `canAssignClassification` の戻り値。 */
export type CanAssignClassificationResult = { ok: true } | { ok: false; error: string };

/**
 * viewer が `next` の分類を付与してよいかを判定する（指示書 §4.4）。
 * `current` / `next` は Session（または Project）に保存されている生の値
 * （`null` = 継承。実効値ではない）。「現在値を下げる／外す場合も同じ判定を現在値に対して
 * 行う」(D7) ため、`current` にも同じチェックを通す（例: 現在 level=7 の会話を level=3 にする
 * には writeLevel ≥ 7 が必要。現在 compartment="LAFIT" を外すには "LAFIT" を保有していることが
 * 必要。`null`（継承に戻す／継承のまま）は制約なしで常に通す）。
 *
 * - `next.level` は 0〜10 の整数または `null` であること。範囲外はエラー
 * - `viewer.isOrgAdmin` はこの関数の制限を全てバイパスする
 * - それ以外は、`current` と `next` の両方について:
 *   - `level !== null && level > viewer.writeLevel` → NG
 *   - `compartment !== null` かつ `"*"` も該当値も持っていない → NG
 */
export function canAssignClassification(
  viewer: KnowledgeViewer,
  current: ClassificationValue,
  next: ClassificationValue
): CanAssignClassificationResult {
  const nextLevelCheck = normalizeLevel(next.level);
  if (!nextLevelCheck.ok) return nextLevelCheck;

  if (viewer.isOrgAdmin) {
    return { ok: true };
  }

  const hasWildcard = viewer.compartments.includes(COMPARTMENT_WILDCARD);

  for (const value of [current, next]) {
    if (value.level !== null && value.level > viewer.writeLevel) {
      return {
        ok: false,
        error: `level ${value.level} exceeds your writeLevel (${viewer.writeLevel})`,
      };
    }
    if (value.compartment !== null && !hasWildcard && !viewer.compartments.includes(value.compartment)) {
      return {
        ok: false,
        error: `compartment "${value.compartment}" is not in your compartments`,
      };
    }
  }

  return { ok: true };
}

/**
 * 検索結果に含まれる他人のターンの所有者 ID から、監査対象（自分を除いた distinct リスト、
 * 初出順）を決める（指示書 D9、§9 `decideAuditTargets`）。
 */
export function decideAuditTargets(viewerUserId: string, ownerUserIds: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const ownerId of ownerUserIds) {
    if (ownerId === viewerUserId) continue;
    if (seen.has(ownerId)) continue;
    seen.add(ownerId);
    result.push(ownerId);
  }
  return result;
}

/** `normalizeClearanceInput` の戻り値。 */
export type NormalizeClearanceInputResult =
  | { ok: true; value: { readLevel: number; writeLevel: number; compartments: string[] } }
  | { ok: false; error: string };

/** `normalizeClearanceInput` の生入力（REST `PUT /api/org/members/:userId/clearance`）。 */
export interface RawClearanceInput {
  readLevel?: unknown;
  writeLevel?: unknown;
  compartments?: unknown;
}

/**
 * `PUT /api/org/members/:userId/clearance` の入力を検証・正規化する。
 * readLevel/writeLevel は 0〜10 の整数必須（null 継承の概念は無い。人の権限は常に具体値）。
 * compartments は配列必須、各要素を `normalizeCompartment` で検証（"*" はワイルドカードとして
 * そのまま許可）、重複除去、`COMPARTMENT_LIST_MAX` 超は拒否。
 */
export function normalizeClearanceInput(raw: RawClearanceInput): NormalizeClearanceInputResult {
  if (
    typeof raw.readLevel !== 'number' ||
    !Number.isInteger(raw.readLevel) ||
    raw.readLevel < CLASSIFICATION_LEVEL_MIN ||
    raw.readLevel > CLASSIFICATION_LEVEL_MAX
  ) {
    return {
      ok: false,
      error: `readLevel must be an integer between ${CLASSIFICATION_LEVEL_MIN} and ${CLASSIFICATION_LEVEL_MAX}`,
    };
  }
  if (
    typeof raw.writeLevel !== 'number' ||
    !Number.isInteger(raw.writeLevel) ||
    raw.writeLevel < CLASSIFICATION_LEVEL_MIN ||
    raw.writeLevel > CLASSIFICATION_LEVEL_MAX
  ) {
    return {
      ok: false,
      error: `writeLevel must be an integer between ${CLASSIFICATION_LEVEL_MIN} and ${CLASSIFICATION_LEVEL_MAX}`,
    };
  }
  if (!Array.isArray(raw.compartments)) {
    return { ok: false, error: 'compartments must be an array of strings' };
  }
  if (raw.compartments.length > COMPARTMENT_LIST_MAX) {
    return { ok: false, error: `compartments must have ${COMPARTMENT_LIST_MAX} items or fewer` };
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const item of raw.compartments) {
    if (typeof item !== 'string') {
      return { ok: false, error: 'compartments must be an array of strings' };
    }
    if (item === COMPARTMENT_WILDCARD) {
      if (!seen.has(COMPARTMENT_WILDCARD)) {
        seen.add(COMPARTMENT_WILDCARD);
        normalized.push(COMPARTMENT_WILDCARD);
      }
      continue;
    }
    const result = normalizeCompartment(item);
    if (!result.ok) return result;
    if (result.value === null) continue; // 空文字は捨てる
    if (!seen.has(result.value)) {
      seen.add(result.value);
      normalized.push(result.value);
    }
  }

  return { ok: true, value: { readLevel: raw.readLevel, writeLevel: raw.writeLevel, compartments: normalized } };
}
