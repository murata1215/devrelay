/**
 * `u`（Agent 自己更新）の `pnpm install` が使うワークスペースセレクタ組み立て（#cmurfdjgu0b2rjhjhjqdo4zux 案2）。
 *
 * `<pkg>...` は「pkg 自身 + pkg が依存するパッケージ」のみを選択する（pkg に依存する側は含まない）。
 * モノレポ全体を対象にした素の `pnpm install` は Electron/Prisma/Vite/React まで取得してしまい
 * （実測: agents/linux 基準で全体 1073MiB に対し agent+shared 相当は 304MiB・258/1153 パッケージ）、
 * 企業ネットワークでの取得失敗の母数を不要に増やしていた。新規インストール（install-agent.sh）側の
 * filter と同じセレクタで `u` にも揃える。
 *
 * `pnpm rebuild <pkg>`（`-r` 無し）はカレント importer の依存グラフしか歩かないため、ワークスペース
 * ルートで実行する既存の PTY rebuild 行はこの変更の前後で挙動が変わらない（元から対象外。macOS Agent
 * は node-pty 自体を依存に持たないため、この行は実質的に常に no-op）。
 *
 * agents/linux/src/services/update-script.ts と同じ純関数を macOS Agent 側にも複製する
 * （linux/macos の connection.ts 自体が既に全面二重化されている既存方針に合わせる。外部 import
 * ゼロに保ち、コンパイル済み dist を直接 `node --test` から import して単体検証できるようにする）。
 */

/** macOS Agent（`@devrelay/agent-macos`）向けの install filter セレクタ */
export const AGENT_INSTALL_FILTER = '@devrelay/agent-macos...';

/**
 * macOS Agent 内の win32 分岐（実際には到達しない、`process.platform === 'win32'` 配下のコード）が
 * 使うセレクタ。同分岐の build 行が `pnpm --filter @devrelay/agent build`（Linux パッケージ名）に
 * なっているため、install 側もそれに揃える。
 */
export const WIN32_AGENT_INSTALL_FILTER = '@devrelay/agent...';

export interface PnpmInstallCommandOptions {
  /** pnpm の起動形。bash 側は 'pnpm'、Windows 側は '& $pnpmResolved'（#352 で解決済みの実行ファイルを明示実行） */
  pnpmCommand: string;
  /** --frozen-lockfile を付けるか（1 段目 true・リトライ段 false）。--filter はどちらでも必ず付く */
  frozen: boolean;
  /** --filter に渡すセレクタ（例: '@devrelay/agent-macos...'） */
  filter: string;
}

/**
 * filter 付き `pnpm install` コマンド文字列を組み立てる。
 *
 * - `--filter` は frozen の値に関係なく常に含める（リトライ段で外すと、素の `pnpm install` と
 *   同じ全パッケージ取得に戻ってしまい filter 化の効果が失敗時にだけ消える）。
 * - `--ignore-scripts` は常に含める（Electron 等の postinstall スキップ、既存方針を維持）。
 * - セレクタは必ず `"` で囲む。PowerShell は先頭 `@` を splat operator として誤解釈し得るため。
 */
export function buildPnpmInstallCommand(opts: PnpmInstallCommandOptions): string {
  if (!opts.pnpmCommand.trim()) {
    throw new Error('update-script: pnpmCommand must not be empty');
  }
  if (!opts.filter.trim() || opts.filter.includes('"')) {
    throw new Error(`update-script: unsafe filter: ${opts.filter}`);
  }
  const parts = [opts.pnpmCommand, 'install', '--filter', `"${opts.filter}"`];
  if (opts.frozen) {
    parts.push('--frozen-lockfile');
  }
  parts.push('--ignore-scripts');
  return parts.join(' ');
}
