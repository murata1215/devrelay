/**
 * Sandbox 実行の子プロセスへ渡す環境変数を組み立てる（外部 import ゼロ、純関数）。
 *
 * 設計原則（改訂版 Plan のレビュー指摘9の修正）: ベース env は Sandbox Host（サービス自身）の
 * 環境を使い、Agent 側の `process.env` を丸ごと継承しない。Agent が渡すのは閉じた明示キーの
 * 追加分のみで、Sandbox Host 側がこれを自分の env の上に merge する。
 *
 * サイクル SB-1a-1。
 */

/**
 * Sandbox 時に明示的に除去するキー（閉じた許可リスト方式なので通常は素通りしないはずだが、
 * 将来の呼び出し側の誤り（例: `...process.env` を `extra` に渡してしまう）に対する
 * 防御的二重チェック）。`NO_PROXY`/`ANTHROPIC_BASE_URL` 等は許可リスト外への脱出経路になるため、
 * 常に最後に明示削除する。
 */
export const SANDBOX_FORBIDDEN_ENV_KEYS: readonly string[] = [
  'NO_PROXY',
  'no_proxy',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
];

export interface BuildSandboxChildEnvInput {
  /** `claude setup-token` で発行した専用トークン */
  oauthToken: string;
  /** Agent プロセス内の中継プロキシ URL（127.0.0.1 のリテラル必須。IPv6 `::1` 解決を避ける） */
  proxyUrl: string;
  /** 仮想アカウント専用の固定ホームディレクトリ（例 `C:\ProgramData\devrelay\sandbox\home`） */
  homeDir: string;
  sessionId: string;
  projectPath: string;
  /** 呼び出し側が追加したい値（`SANDBOX_FORBIDDEN_ENV_KEYS` は常に除去される） */
  extra?: Record<string, string>;
}

/**
 * Sandbox Host へ送る「上書き env」を組み立てる。ホストは自分自身の env の上にこれを merge する
 * （`process.env` の丸ごと継承はしない）。
 * @returns 送信する env の key-value。**値にはトークンが含まれるため、呼び出し側はこれをそのまま
 *   ログに出さず、キー一覧には `describeSandboxEnvKeys()` を使うこと**
 */
export function buildSandboxChildEnv(input: BuildSandboxChildEnvInput): Record<string, string> {
  const env: Record<string, string> = {
    CLAUDE_CODE_OAUTH_TOKEN: input.oauthToken,
    HTTPS_PROXY: input.proxyUrl,
    HTTP_PROXY: input.proxyUrl,
    https_proxy: input.proxyUrl,
    http_proxy: input.proxyUrl,
    HOME: input.homeDir,
    USERPROFILE: input.homeDir,
    APPDATA: `${input.homeDir}\\AppData\\Roaming`,
    LOCALAPPDATA: `${input.homeDir}\\AppData\\Local`,
    TEMP: `${input.homeDir}\\Temp`,
    TMP: `${input.homeDir}\\Temp`,
    CLAUDE_CONFIG_DIR: `${input.homeDir}\\.claude`,
    DEVRELAY: '1',
    DEVRELAY_SESSION_ID: input.sessionId,
    DEVRELAY_PROJECT: input.projectPath,
    DEVRELAY_SANDBOX: '1',
  };
  if (input.extra) {
    for (const [key, value] of Object.entries(input.extra)) {
      if (SANDBOX_FORBIDDEN_ENV_KEYS.includes(key)) continue;
      env[key] = value;
    }
  }
  for (const forbidden of SANDBOX_FORBIDDEN_ENV_KEYS) {
    delete env[forbidden];
  }
  return env;
}

/** トークン等の秘密情報をテキストから隠す（ログ・エラー文・進捗表示に出す前に必ず通す） */
export function redactSandboxSecrets(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (!secret) continue;
    result = result.split(secret).join('***REDACTED***');
  }
  return result;
}

/** ログ用にキー名だけを返す（値は絶対に含めない） */
export function describeSandboxEnvKeys(env: Record<string, string>): string[] {
  return Object.keys(env).sort();
}
