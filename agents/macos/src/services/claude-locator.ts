/**
 * `resolveSystemClaude()` が使う OS 別のコマンド文字列・フォールバック候補パスを純関数として切り出す（#350）。
 *
 * 背景: 従来の `resolveSystemClaude()` は `execSync('command -v claude')` を無条件に実行していた。
 * `command` は POSIX シェルのビルトインで cmd.exe には存在しないため、`agents/linux`（Windows CLI Agent の
 * 実体でもある）を Windows で動かすと常に失敗し、stderr が親に継承されて agent.log に生の cmd エラーが
 * 出続けていた（`checkClaudeAuth()` 経由で15分ごと）。フォールバック候補も POSIX パスのみで Windows では
 * 常に空振りしていた。
 *
 * 外部 import ゼロに保ち、コンパイル済み dist を直接 `node --test` から import して
 * 単体検証できるようにする（progress-timeout.ts / cross-query-guard.ts と同じ流儀）。
 *
 * サイクル SDK-1 コミット①: `agents/macos` へ byte-identical で移植した（従来は macOS 専用のインライン実装が
 * `ai-runner.ts` に残っていた）。`darwin` 用に Homebrew 標準パス（`/opt/homebrew/bin/claude`）の候補を追加し、
 * 移植前の macOS 実装（`/usr/local/bin` の手前に homebrew パスを挟む順序）を厳密に保存している。
 * `linux` / `win32` の分岐は今回追加していないため無変更。
 */

/**
 * claude の所在を PATH から引くコマンド文字列を返す。
 * @param platform `process.platform` の値（'win32' | 'darwin' | 'linux' 等）
 * @returns Windows は `where claude`、それ以外は `command -v claude`
 */
export function buildClaudeLookupCommand(platform: string): string {
  return platform === 'win32' ? 'where claude' : 'command -v claude';
}

/**
 * PATH で見つからなかったときに順に試す絶対パス候補（OS 別）。
 * 存在しない端末では従来どおり全て空振りし `resolveSystemClaude()` は null を返す（誤検知を増やさない）。
 * @param platform `process.platform` の値
 * @param home ホームディレクトリ（`os.homedir()` の値）
 * @returns 候補パスの配列（存在確認は呼び出し側が行う）
 */
export function claudeFallbackCandidates(platform: string, home: string): string[] {
  if (platform === 'win32') {
    return [
      `${home}\\AppData\\Roaming\\npm\\claude.cmd`,
      `${home}\\AppData\\Local\\Programs\\claude\\claude.exe`,
      `${home}\\.local\\bin\\claude.cmd`,
    ];
  }
  if (platform === 'darwin') {
    return [
      `${home}/.local/bin/claude`,
      `${home}/.claude/local/claude`,
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
      '/usr/bin/claude',
    ];
  }
  return [
    `${home}/.local/bin/claude`,
    `${home}/.claude/local/claude`,
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ];
}
