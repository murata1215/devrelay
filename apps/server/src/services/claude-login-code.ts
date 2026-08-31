// =============================================================================
// `login <code#state>` の認可コード検証（#326 Phase2）
// =============================================================================
//
// Claude CLI の OAuth コールバック（claude_oauth_callback）は一発勝負で、
// 失敗するとフロー自体が壊れて `login` からやり直しになる（cli.js 側の singleton 制約）。
// そのため Agent に送る前にサーバー側で形式検証し、明らかに壊れている入力は
// フローに一切触れずに拒否する。外部 import ゼロの純関数（#335/#337 と同じ流儀）。

export type ValidateOAuthCodeResult =
  | { ok: true; authorizationCode: string; state: string }
  | { ok: false; reason: string };

/** 許可する文字種: OAuth の code/state は URL セーフな base64url + 記号程度が実態のため安全側に絞る */
const SAFE_CODE_PATTERN = /^[A-Za-z0-9._~-]+$/;
const MAX_TOTAL_LENGTH = 512;
const MIN_PART_LENGTH = 4;

/**
 * `login` コマンドに渡された生の引数を検証し、`code#state` に分解する。
 *
 * @param raw ユーザーがチャットに貼り付けた生の文字列（`login ` の後の部分）
 */
export function validateOAuthCode(raw: string): ValidateOAuthCodeResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  if (trimmed.length > MAX_TOTAL_LENGTH) {
    return { ok: false, reason: 'tooLong' };
  }

  const parts = trimmed.split('#');
  if (parts.length !== 2) {
    return { ok: false, reason: 'missingSeparator' };
  }

  const [authorizationCode, state] = parts;
  if (authorizationCode.length < MIN_PART_LENGTH || state.length < MIN_PART_LENGTH) {
    return { ok: false, reason: 'partTooShort' };
  }
  if (!SAFE_CODE_PATTERN.test(authorizationCode) || !SAFE_CODE_PATTERN.test(state)) {
    return { ok: false, reason: 'unsafeCharacters' };
  }

  return { ok: true, authorizationCode, state };
}
