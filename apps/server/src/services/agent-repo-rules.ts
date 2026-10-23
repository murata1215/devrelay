/**
 * 会社 private リポジトリ clone 対応サイクル: `DEVRELAY_AGENT_REPO_URL` の値を検証・正規化する
 * 純粋関数（外部 import ゼロ。`update-busy-rules.ts` 等と同じ流儀）。
 *
 * `GET /api/machines/:id/token` が WebUI に返す値を作る際に使う。WebUI のインストール一行コマンドに
 * そのまま載る値なので、万一 `https://user:PAT@host/...` のような PAT 埋め込み URL が env に
 * 設定されてしまっても、それをブラウザ・DB に一切出さないよう型と関数でここで止める
 * （PAT は env 側では `DEVRELAY_REPO_TOKEN`/`DEVRELAY_REPO_PAT` のようなローカル専用の別変数を使う想定で、
 * サーバー側はそもそも PAT を読まない設計にしているが、運用ミスへの保険として本関数で弾く）。
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
