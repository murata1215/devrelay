/**
 * Agents ページ（MachinesPage.tsx）のインストール一行コマンドを生成する純関数群
 * （外部 import ゼロ。`uninstall-command-rules.ts` と同じ流儀）。
 *
 * 会社 private リポジトリ clone 対応サイクル: `repoUrl` を指定したときだけ `--repo`
 * （Linux/macOS）/ `$env:DEVRELAY_REPO_URL`（Windows）を追加する。**未指定時は従来のコマンド文字列と
 * 1 バイト同一**（後方互換の確認は `install-command-rules.test.mjs` の非退行アサーションで固定する）。
 *
 * PAT（`DEVRELAY_REPO_TOKEN`）はこの関数には一切渡さない・含めない（サーバーに保存しない方針を
 * 型レベルで保証するため、引数そのものに token/PAT を受け取らない）。
 */

export type InstallOs = 'linux' | 'macos' | 'windows';

export interface BuildInstallCommandOptions {
  os: InstallOs;
  /** WebUI で生成したエージェントトークン（DevRelay 自身のトークン。PAT ではない） */
  token: string;
  /** 会社 private リポジトリ等の clone 先。未指定/空文字/空白のみなら従来どおり付与しない */
  repoUrl?: string | null;
}

/**
 * 一行インストールコマンドを生成する（OS 別）。
 * `repoUrl` が空のときは `MachinesPage.tsx` の既存 `getInstallCommand` と完全に同じ文字列を返す。
 */
export function buildInstallCommand(opts: BuildInstallCommandOptions): string {
  const { os, token } = opts;
  if (!token) return '';
  const repoUrl = opts.repoUrl?.trim() || '';

  if (os === 'windows') {
    const repoEnv = repoUrl ? `$env:DEVRELAY_REPO_URL="${repoUrl}"; ` : '';
    return `$env:DEVRELAY_TOKEN="${token}"; ${repoEnv}irm https://raw.githubusercontent.com/murata1215/devrelay/main/scripts/install-agent.ps1 | iex`;
  }
  // macOS と Linux は同じインストーラー（install-agent.sh が uname -s で自動判定）
  const repoArg = repoUrl ? ` --repo ${repoUrl}` : '';
  return `curl -fsSL https://raw.githubusercontent.com/murata1215/devrelay/main/scripts/install-agent.sh | bash -s -- --token ${token}${repoArg}`;
}
