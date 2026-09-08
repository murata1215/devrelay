/**
 * 組織 AI デフォルト設定サービス（#372）
 *
 * 組織ごとに AI モデル（4ツール × plan/exec = 8キー）の既定値を持たせ、
 * 一般メンバーは既定でその組織既定に従う（ロック）。管理者が
 * `OrganizationMember.canOverrideAiSettings` を true にしたメンバーだけが
 * 自分の個人設定（`UserSettings`）で上書きできる。admin 自身は常に自分の設定を使える
 * （組織既定を管理する側が自分自身を締め出さないようにするため）。
 *
 * 既存の `Organization.allowedIpRanges`（#285）と同じ「専用テーブルを作らず
 * JSON 文字列カラムに保存」方式を踏襲する。
 *
 * parseOrgAiDefaults / serializeOrgAiDefaults / decideEffectiveModel /
 * isOrgAiDefaultKey は外部 import ゼロの純粋関数（#308/#331〜#334 と同じ流儀）。
 * resolveOrgAiContext / isModelSettingLocked のみ DB（prisma）に依存する。
 */

import { prisma } from '../db/client.js';

/** 組織AIデフォルトが対象とする8キーのパターン（<tool>_model_<plan|exec>）。
 * user-settings.ts の MODEL_SETTING_KEY_MAP と循環 import になるのを避けるため、
 * ここでは正規表現でキー形式のみを判定する（値のズレは org-ai-defaults.test.mjs で検知）。*/
const MODEL_KEY_PATTERN = /^(claude|codex|gemini|devin)_model_(plan|exec)$/;

/** 指定キーが組織AIデフォルトの対象（モデル設定キー）かどうか判定する */
export function isOrgAiDefaultKey(key: string): boolean {
  return MODEL_KEY_PATTERN.test(key);
}

/**
 * `Organization.aiModelDefaults` の JSON 文字列を `Record<string, string>` にパースする。
 * fail-open: 不正な JSON・非オブジェクト・null は空オブジェクトにフォールバックする
 * （既存の `parseIpRanges` と同じ方針）。モデル設定キー以外のキーや、危険文字を含む値は無視する。
 */
export function parseOrgAiDefaults(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (!isOrgAiDefaultKey(key)) continue;
      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (trimmed.length === 0) continue;
      // CLI 引数・TOML インジェクション防止（危険文字を含む値は無視）
      if (/["'`;$\n\r]/.test(trimmed) || /\s/.test(trimmed)) continue;
      result[key] = trimmed;
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * `Record<string, string>` を `Organization.aiModelDefaults` に保存する JSON 文字列へ変換する。
 * 空オブジェクトの場合は null を返す（allowedIpRanges と同じ「未設定は null」方針）。
 */
export function serializeOrgAiDefaults(map: Record<string, string>): string | null {
  const entries = Object.entries(map).filter(
    ([key, value]) => isOrgAiDefaultKey(key) && typeof value === 'string' && value.trim().length > 0,
  );
  if (entries.length === 0) return null;
  return JSON.stringify(Object.fromEntries(entries));
}

/** 実効値の出所 */
export type EffectiveModelSource = 'user' | 'org' | 'default';

/**
 * ユーザーの個人設定値・組織既定値・上書き許可フラグから、実際に使用するモデル値と
 * その出所を決定する（単一情報源）。
 *
 * 判定表:
 * | canOverride | userValue | orgDefault | 結果                     |
 * |-------------|-----------|------------|--------------------------|
 * | true        | あり      | 問わず     | user                     |
 * | true        | なし      | あり       | org                      |
 * | true        | なし      | なし       | default (undefined)      |
 * | false       | 問わず    | あり       | org（個人設定は無視）     |
 * | false       | あり      | なし       | user（後方互換フォールバック）|
 * | false       | なし      | なし       | default (undefined)      |
 */
export function decideEffectiveModel(input: {
  userValue: string | undefined;
  orgDefault: string | undefined;
  canOverride: boolean;
}): { value: string | undefined; source: EffectiveModelSource } {
  const { userValue, orgDefault, canOverride } = input;

  if (canOverride) {
    if (userValue) return { value: userValue, source: 'user' };
    if (orgDefault) return { value: orgDefault, source: 'org' };
    return { value: undefined, source: 'default' };
  }

  // ロック中: 組織既定が最優先。組織既定が未設定の場合のみ個人設定にフォールバックする
  // （組織がまだ既定を設定していないキーで、既存ユーザーの過去設定を消さないため）。
  if (orgDefault) return { value: orgDefault, source: 'org' };
  if (userValue) return { value: userValue, source: 'user' };
  return { value: undefined, source: 'default' };
}

/**
 * ユーザーの組織AIコンテキスト（組織既定値マップ + 上書き許可）を解決する。
 * 組織未所属の場合は制約なし（`canOverride: true`, `orgDefaults: {}`）を返す。
 * admin は常に `canOverride: true`（組織既定を管理する側が自分自身を締め出さないため）。
 */
export async function resolveOrgAiContext(
  userId: string,
): Promise<{ orgDefaults: Record<string, string>; canOverride: boolean }> {
  const membership = await prisma.organizationMember.findUnique({
    where: { userId },
    select: {
      role: true,
      canOverrideAiSettings: true,
      organization: { select: { aiModelDefaults: true } },
    },
  });
  if (!membership) {
    return { orgDefaults: {}, canOverride: true };
  }
  const canOverride = membership.role === 'admin' || membership.canOverrideAiSettings;
  return { orgDefaults: parseOrgAiDefaults(membership.organization.aiModelDefaults), canOverride };
}

/**
 * 指定ユーザーが指定のモデル設定キーを自分で変更できない（ロックされている）かどうかを判定する。
 * モデル設定キー以外（key が `isOrgAiDefaultKey` に該当しない）は常に false（対象外）。
 */
export async function isModelSettingLocked(userId: string, key: string): Promise<boolean> {
  if (!isOrgAiDefaultKey(key)) return false;
  const { orgDefaults, canOverride } = await resolveOrgAiContext(userId);
  if (canOverride) return false;
  const orgValue = orgDefaults[key];
  return typeof orgValue === 'string' && orgValue.trim().length > 0;
}
