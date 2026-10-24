/**
 * 会社 private リポジトリ clone 対応サイクル: `DEVRELAY_AGENT_REPO_URL` の値を検証・正規化する
 * 純粋関数（外部 import ゼロ。`update-busy-rules.ts` 等と同じ流儀）。
 *
 * `GET /api/machines/:id/token` が WebUI に返す値を作る際に使う。WebUI のインストール一行コマンドに
 * そのまま載る値なので、万一 `https://user:PAT@host/...` のような PAT 埋め込み URL が env に
 * 設定されてしまっても、それをブラウザ・DB に一切出さないよう型と関数でここで止める。
 *
 * 読取PATのサーバー配布サイクル: 前サイクルは「サーバーは PAT を一切読まない設計」だったが、
 * 本サイクルで **サーバー env（`DEVRELAY_AGENT_REPO_TOKEN`）に限って** PAT を保持し、`POST
 * /api/agent/repo-auth`（HTTP、インストール時）・`server:repo:auth`（WS、`u` 時のローテーション）
 * で認証済み Agent にのみ配布する方式に変更した（DB には一切保存しない。env のみ）。
 * 「URL に PAT を埋め込んで配る」経路は本関数が引き続き拒否する（別フィールドで配る設計に統一）。
 */

/**
 * `process.env.DEVRELAY_AGENT_REPO_URL` を解決する。
 * 未設定・空文字・空白のみ → `null`（WebUI のインストールコマンドは現行どおり repo 指定なし）。
 * `https://` で始まらない、または userinfo（`user:pass@`/PAT 埋め込み）を含む場合 → `null` ＋ warn
 * （PAT がブラウザ・DB に露出する経路を構造的に塞ぐ）。
 */
export function resolveAgentRepoUrl(raw: string | undefined): string | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith('https://')) {
    console.warn('[agent-repo-rules] DEVRELAY_AGENT_REPO_URL は https:// で始まる URL のみ許可します。無視します。');
    return null;
  }
  // https:// の後に userinfo（@ より前に : または @ 自体が現れる）があれば PAT 埋め込みの疑いがあるため拒否する
  const afterScheme = trimmed.slice('https://'.length);
  const atIndex = afterScheme.indexOf('@');
  if (atIndex !== -1) {
    console.warn('[agent-repo-rules] DEVRELAY_AGENT_REPO_URL に認証情報(userinfo)が含まれています。PAT 漏えい防止のため無視します。');
    return null;
  }
  return trimmed;
}

/**
 * `process.env.DEVRELAY_AGENT_REPO_TOKEN` を解決する（読取PATのサーバー配布サイクル）。
 *
 * **重要**: この関数は値そのものを `console.warn` 等に一切出さない（PAT をログに漏らさないため）。
 * 検証に失敗した理由だけを warn し、値は出さない。
 *
 * - 未設定・空文字・空白のみ → `null`（配布しない。既定の「未設定時は現行同一」の実体）
 * - trim 後に改行・タブ・制御文字を含む → `null` ＋ warn（`.git/config` や HTTP ヘッダへの
 *   インジェクション経路を構造的に遮断する。env の設定ミス・コピペ事故への保険）
 * - 印字可能 ASCII（0x20-0x7E）以外の文字を含む → `null` ＋ warn（GitHub PAT は ASCII のみ）
 * - 長さが 20 未満または 255 を超える → `null` ＋ warn（典型的な GitHub PAT は 40〜255 文字程度。
 *   極端に短い値は設定ミスの可能性が高いため安全側に弾く）
 */
export function resolveAgentRepoToken(raw: string | undefined): string | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    console.warn('[agent-repo-rules] DEVRELAY_AGENT_REPO_TOKEN に制御文字（改行等）が含まれています。無視します。');
    return null;
  }
  // eslint-disable-next-line no-control-regex
  if (!/^[\x20-\x7e]+$/.test(trimmed)) {
    console.warn('[agent-repo-rules] DEVRELAY_AGENT_REPO_TOKEN に印字可能 ASCII 以外の文字が含まれています。無視します。');
    return null;
  }
  if (trimmed.length < 20 || trimmed.length > 255) {
    console.warn('[agent-repo-rules] DEVRELAY_AGENT_REPO_TOKEN の長さが想定範囲外です（20〜255文字）。無視します。');
    return null;
  }
  return trimmed;
}

/**
 * GitHub の Basic 認証ヘッダ値を組み立てる（`x-access-token:<PAT>` を base64 したもの）。
 * Agent 側 `repo-auth-rules.ts` の `buildBasicAuthHeaderValue()` と同一規約
 * （クライアント側はこの文字列をそのまま `.git/config` の `extraHeader` に書くだけでよく、
 * base64 実装や `x-access-token:` 規約をクライアント側で再現する必要がない）。
 *
 * @param base64Encode `Buffer` に依存しない呼び出し側の base64 実装を注入可能にしてある
 *   （テスト容易性のため。サーバー側の呼び出し元は `Buffer.from(s).toString('base64')` を渡す）
 */
export function buildRepoAuthHeader(pat: string, base64Encode: (s: string) => string): string {
  return `Authorization: Basic ${base64Encode(`x-access-token:${pat}`)}`;
}

/** `resolveAgentRepoAuth()` の戻り値。`authHeader` は秘密情報（呼び出し元はログに出さないこと）。 */
export interface ResolvedRepoAuth {
  repoUrl: string | null;
  authHeader: string | null;
}

/**
 * env から「配布可能な repo URL と認証ヘッダ」を解決する。
 *
 * 要件: `DEVRELAY_AGENT_REPO_TOKEN` は `DEVRELAY_AGENT_REPO_URL` とセットのときのみ有効
 * （URL が無効・未設定なら、PAT が設定されていても `authHeader` は返さない。配布先の URL が
 * 定まらない PAT を配っても Agent 側で使い道がなく、設定ミスの早期発見にもなる）。
 */
export function resolveAgentRepoAuth(input: {
  rawUrl: string | undefined;
  rawToken: string | undefined;
  base64Encode: (s: string) => string;
}): ResolvedRepoAuth {
  const repoUrl = resolveAgentRepoUrl(input.rawUrl);
  if (!repoUrl) {
    return { repoUrl: null, authHeader: null };
  }
  const token = resolveAgentRepoToken(input.rawToken);
  if (!token) {
    // URL だけ有効（PAT 未設定）: public 相当の URL 切り替えのみ配布し、認証ヘッダは返さない
    return { repoUrl, authHeader: null };
  }
  return { repoUrl, authHeader: buildRepoAuthHeader(token, input.base64Encode) };
}

/**
 * `resolveAgentRepoAuth()` を `process.env` から直接読んで呼ぶラッパー。
 *
 * `DEVRELAY_AGENT_REPO_TOKEN`/`DEVRELAY_AGENT_REPO_URL` を直接 `process.env` から読む箇所を
 * 本ファイルだけに閉じ込めるための入口（`agent-repo-auth-wiring.test.mjs` の静的ガードが
 * 「この2つの env を読むのは本ファイルだけ」を固定する）。呼び出し元（HTTP ルート・WS ハンドラ）は
 * 本関数を呼ぶだけで、`process.env` を直接触らない。
 */
export function resolveAgentRepoAuthFromEnv(base64Encode: (s: string) => string): ResolvedRepoAuth {
  return resolveAgentRepoAuth({
    rawUrl: process.env.DEVRELAY_AGENT_REPO_URL,
    rawToken: process.env.DEVRELAY_AGENT_REPO_TOKEN,
    base64Encode,
  });
}

/**
 * サーバー側で読取PATが配布可能な状態か（URL・PAT ともに有効）を真偽値だけで返す。
 * `GET /api/machines/:id/token` が WebUI の案内文言出し分けに使う（PAT の値は一切含まない）。
 */
export function isAgentRepoTokenConfigured(): boolean {
  return resolveAgentRepoUrl(process.env.DEVRELAY_AGENT_REPO_URL) !== null
    && resolveAgentRepoToken(process.env.DEVRELAY_AGENT_REPO_TOKEN) !== null;
}

/**
 * `POST /api/agent/repo-auth` / WS `agent:repo:auth:request` 向けの簡易レート制限判定
 * （`raw-completion-guard.ts` の純関数 + 呼び出し側 Map の流儀）。
 *
 * @param timestamps 直近のリクエスト時刻（ms epoch）の配列。呼び出し側が machineId/IP 単位で保持する
 * @returns true なら許可（呼び出し側は許可時に `timestamps` へ `now` を追加する責務を持つ）
 */
export function decideRepoAuthRateLimit(input: {
  timestamps: number[];
  now: number;
  windowMs: number;
  max: number;
}): boolean {
  const cutoff = input.now - input.windowMs;
  const recent = input.timestamps.filter((t) => t > cutoff);
  return recent.length < input.max;
}
