/**
 * Agents ページ（MachinesPage.tsx）の Uninstall セクションで使う純関数群（外部 import ゼロ。
 * node:test から dist-test/ を直接 import する、machine-display-rules.ts / panel-resize-rules.ts と
 * 同じ流儀）。
 *
 * 背景（2026-09-17 サイクル）: Windows 機で `a`（AI ツール一覧）から devin が消える障害を調査した結果、
 * 真因は「同一トークンで Agent が 2 本接続し、後発が先発の WebSocket を奪い合う」ことだった。
 * `agents/windows`（Electron GUI 版）と `agents/linux`（Windows で動く CLI 版）は同じ
 * `%APPDATA%\devrelay\config.yaml` を読むため、1 台に両方入っていると同じトークンで 2 本接続しうる。
 *
 * 既存の Windows 用アンインストール一行は `Name='node.exe'` のプロセスしか止めないため、
 * Electron GUI 版（`DevRelay Agent.exe`）が生き残ってしまう。本モジュールはその一行を直し、
 * さらに GUI 版本体・自動起動の全経路まで掃除する「完全アンインストール」の 2 本目コマンドも提供する。
 */

/** アンインストール対象の OS（インストーラーの OS タブと同じ 3 択） */
export type UninstallOs = 'linux' | 'macos' | 'windows';

/**
 * `Machine.managementInfo`（`normalizeManagementInfo()` 済みの `os` フィールド、
 * `'win32' | 'darwin' | linux 系文字列 | ''`）から、設定モーダルの OS タブ既定値を決める。
 *
 * fail-open ではなく **fail to 'linux'**（現状の既定値と同じ）にする。理由: 判定できない値を
 * Windows 用アンインストールコマンド（プロセス kill を含む）に倒すと誤操作リスクが上がるため、
 * 情報が無い/壊れているときは従来どおり最も無害な Linux 表示に倒す。
 */
export function resolveSettingsOs(managementInfoOs: string | null | undefined): UninstallOs {
  if (managementInfoOs === 'win32') return 'windows';
  if (managementInfoOs === 'darwin') return 'macos';
  return 'linux';
}

/**
 * 一行アンインストールコマンドを生成する（OS 別）。
 *
 * Linux / macOS は既存挙動を**完全に維持**（この機体の Agent が crontab `@reboot` 起動である等、
 * 環境依存の前提を壊すリスクの方が大きいため、本サイクルではスコープ外とした）。
 *
 * Windows のみ修正:
 * - プロセス抽出を `Name='node.exe'` 限定 → 全プロセスの `CommandLine -like '*devrelay*'` に拡張
 *   （Electron GUI 版 `DevRelay Agent.exe` も対象に含める）。
 * - **自己 kill 防止（G1）**: `irm ... | iex` で実行した PowerShell 自身の CommandLine にも
 *   `devrelay`（インストーラー/アンインストーラーの URL）が含まれるため、除外しないと
 *   コマンドが自分自身を殺して途中で止まる。`$PID` と `powershell.exe`/`pwsh.exe` を除外する。
 * - タスクスケジューラ `DevRelay Agent`（Startup フォルダ登録失敗時のフォールバック、
 *   `install-agent.ps1:806-807`）の削除を追加。
 */
export function buildUninstallCommand(os: UninstallOs): string {
  if (os === 'windows') {
    return (
      `Get-CimInstance Win32_Process -EA 0 | Where-Object { $_.CommandLine -like '*devrelay*' -and $_.ProcessId -ne $PID -and $_.Name -notin @('powershell.exe','pwsh.exe') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA 0 }; ` +
      `Start-Sleep -Seconds 2; ` +
      `schtasks /Delete /TN "DevRelay Agent" /F 2>$null | Out-Null; ` +
      `Remove-Item "$([Environment]::GetFolderPath('Startup'))\\DevRelay Agent.vbs" -EA 0; ` +
      `Remove-Item "$env:APPDATA\\devrelay" -Recurse -Force -EA 0`
    );
  }
  if (os === 'macos') {
    return `launchctl unload ~/Library/LaunchAgents/io.devrelay.agent.plist 2>/dev/null; rm -f ~/Library/LaunchAgents/io.devrelay.agent.plist; pkill -f "devrelay.*index.js"; rm -rf ~/.devrelay`;
  }
  return `sudo systemctl stop devrelay-agent 2>/dev/null; sudo systemctl disable devrelay-agent 2>/dev/null; crontab -l 2>/dev/null | grep -v devrelay | crontab -; pkill -f "devrelay.*index.js"; rm -rf ~/.devrelay`;
}

/**
 * 「完全アンインストール」コマンド（`scripts/uninstall-agent.ps1` を `irm | iex` で呼ぶ 1 行）を返す。
 * 現状 Windows のみ提供（GUI 版との共存問題が Windows 固有のため）。
 * Windows 以外では空文字を返し、呼び出し側（UI）はこれを「2 本目を表示しない」判定に使う。
 */
export function buildFullUninstallCommand(os: UninstallOs): string {
  if (os !== 'windows') return '';
  return 'irm https://raw.githubusercontent.com/murata1215/devrelay/main/scripts/uninstall-agent.ps1 | iex';
}
