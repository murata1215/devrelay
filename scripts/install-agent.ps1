# =============================================================================
# DevRelay Agent Windows ワンライナーインストーラー
# =============================================================================
#
# 使い方:
#   $env:DEVRELAY_TOKEN="YOUR_TOKEN"; irm https://raw.githubusercontent.com/murata1215/devrelay/main/scripts/install-agent.ps1 | iex
#
# プロキシ環境:
#   $env:DEVRELAY_TOKEN="YOUR_TOKEN"; $env:DEVRELAY_PROXY="http://proxy:8080"; irm ... | iex
#
# 前提条件:
#   - Node.js 20+
#   - git
#   - Claude Code（claude コマンド）
#   - pnpm（未インストールなら自動インストール）
#
# 処理内容:
#   1. 依存ツールの確認（Node.js 20+, git, pnpm）
#   2. リポジトリを %APPDATA%\devrelay\agent\ に clone（既存なら git pull）
#   3. shared + agent をビルド
#   4. config.yaml を自動生成（machineName = COMPUTERNAME/USERNAME）
#   5. devrelay-claude.cmd ラッパー作成（claude があれば）
#   6. タスクスケジューラでログオン時自動起動を登録・即時起動
# =============================================================================

$ErrorActionPreference = "Stop"
# `irm | iex` 実行時、この値の変更は呼び出し元の対話セッションにも残留してしまうため、
# 元の値を退避しておき、スクリプト終了時（正常/異常問わず）に復元する。
$PrevEAP = $ErrorActionPreference

# --- ExecutionPolicy 自動設定 ---
# Windows デフォルトの Restricted ポリシーでは npm.ps1/pnpm.ps1 等の
# PowerShell ラッパースクリプトがブロックされるため、RemoteSigned に変更
# -Scope CurrentUser: 管理者権限不要、現在のユーザーにのみ適用
try {
    $currentPolicy = Get-ExecutionPolicy -Scope CurrentUser
    if ($currentPolicy -eq "Restricted" -or $currentPolicy -eq "Undefined") {
        Set-ExecutionPolicy RemoteSigned -Scope CurrentUser -Force
        Write-Host "ExecutionPolicy を RemoteSigned に設定しました" -ForegroundColor Green
    }
} catch {
    # 失敗しても続行（既に適切なポリシーが設定されている場合など）
}

# --- 定数 ---
$RepoUrl = "https://github.com/murata1215/devrelay.git"
$ConfigDir = Join-Path $env:APPDATA "devrelay"
$AgentDir = Join-Path $ConfigDir "agent"
$ConfigFile = Join-Path $ConfigDir "config.yaml"
$LogDir = Join-Path $ConfigDir "logs"
$BinDir = Join-Path $ConfigDir "bin"
$TaskName = "DevRelay Agent"
# ビルド成果物のパス。Step 3 の成果物検証（#328）と Step 6 のランチャー生成の両方で使うため
# 先頭で定義する（従来は Step 6 で初めて定義していた）。
$AgentEntry = Join-Path $AgentDir "agents\linux\dist\index.js"
$SharedEntry = Join-Path $AgentDir "packages\shared\dist\index.js"
# インストール時のビルドログ（#328: install/build が失敗しても握りつぶさず、後から原因を追えるようにする）
$BuildLog = Join-Path $LogDir "install-build.log"

# --- トークン・プロキシ取得 ---
$Token = $env:DEVRELAY_TOKEN
$ProxyUrl = $env:DEVRELAY_PROXY
$Force = $env:DEVRELAY_FORCE -eq "true" -or $env:DEVRELAY_FORCE -eq "1"
$ServerUrl = "wss://devrelay.io/ws/agent"

if (-not $Token) {
    Write-Host ""
    Write-Host "ERROR: DEVRELAY_TOKEN が設定されていません" -ForegroundColor Red
    Write-Host ""
    Write-Host "使い方:" -ForegroundColor Yellow
    Write-Host '  $env:DEVRELAY_TOKEN="YOUR_TOKEN"; irm https://raw.githubusercontent.com/murata1215/devrelay/main/scripts/install-agent.ps1 | iex'
    Write-Host ""
    Write-Host "トークンは WebUI のエージェント作成画面で取得できます。"
    Write-Host ""
    Write-Host "インストールを中断しました。" -ForegroundColor Red
    # `irm | iex` 実行時、`exit` は呼び出し元の PowerShell ホストごと終了させてしまうため
    # `return` を使う（このスクリプトブロックだけを抜ける）。$ErrorActionPreference も復元。
    $ErrorActionPreference = $PrevEAP
    return
}

# --- 新形式トークン（drl_）からサーバーURL自動抽出 ---
# トークン形式: drl_<base64url エンコードされたサーバーURL>_<ランダム hex>
if ($Token -match "^drl_(.+)_[0-9a-f]+$") {
    $B64Part = $Matches[1]
    try {
        # Base64URL -> 標準 Base64 に変換（- → +, _ → /）
        $StdBase64 = $B64Part -replace '-', '+' -replace '_', '/'
        # パディング追加
        switch ($StdBase64.Length % 4) {
            2 { $StdBase64 += "==" }
            3 { $StdBase64 += "=" }
        }
        $DecodedUrl = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($StdBase64))
        if ($DecodedUrl -match "^wss?://") {
            $ServerUrl = $DecodedUrl
        }
    } catch {
        # デコード失敗時はデフォルトURL使用
    }
}

# --- ヘッダー表示 ---
Write-Host ""
Write-Host "+--------------------------------------------------+" -ForegroundColor Blue
Write-Host "|  DevRelay Agent Installer (Windows)               |" -ForegroundColor Blue
Write-Host "+--------------------------------------------------+" -ForegroundColor Blue
Write-Host ""

# --- プロキシ設定プロンプト ---
# $env:DEVRELAY_PROXY が未設定の場合、対話的にプロキシ使用の有無を確認する
# Read-Host はパイプライン（irm | iex）中でもコンソールから読み取れる
# ※ 依存ツールチェック（pnpm 自動インストール）より前に実行する必要がある
if (-not $ProxyUrl) {
    $UseProxy = Read-Host "プロキシを使用しますか？ (y/N)"
    if ($UseProxy -match "^[Yy]") {
        $ProxyUrl = Read-Host "プロキシURL (例: http://proxy:8080)"
        if ($ProxyUrl) {
            Write-Host "  OK プロキシ: $ProxyUrl" -ForegroundColor Green
        }
    }
    Write-Host ""
}

# プロキシが設定されている場合、git/pnpm/npm でもプロキシを使うよう環境変数をセット
if ($ProxyUrl) {
    $env:HTTP_PROXY = $ProxyUrl
    $env:HTTPS_PROXY = $ProxyUrl
}

# =============================================================================
# Step 1: 依存ツール確認
# =============================================================================
Write-Host "[1/6] 依存ツールを確認中..."

$Missing = 0

# Node.js チェック（未検出/バージョン不足なら公式バイナリを自動インストールする。
# Linux/macOS の install-agent.sh と同じ設計。node 無し端末で「案内文を読む前に
# ウィンドウが閉じる」問題への対処として、なるべく自動で解決を試みる）
function Install-PortableNode {
    $NodeDlVersion = "v20.20.0"
    $NodeArch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
    $NodeDir = Join-Path $ConfigDir "node"
    $NodeZipUrl = "https://nodejs.org/dist/$NodeDlVersion/node-$NodeDlVersion-win-$NodeArch.zip"

    if (-not (Test-Path (Join-Path $NodeDir "node.exe"))) {
        try {
            New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
            $tmpZip = Join-Path $env:TEMP "devrelay-node-$NodeDlVersion-$NodeArch.zip"
            $tmpExtract = Join-Path $env:TEMP "devrelay-node-extract-$NodeDlVersion-$NodeArch"
            Write-Host "     ダウンロード: $NodeZipUrl"
            Invoke-WebRequest -Uri $NodeZipUrl -OutFile $tmpZip -UseBasicParsing -ErrorAction Stop
            if (Test-Path $tmpExtract) { Remove-Item $tmpExtract -Recurse -Force }
            Expand-Archive -Path $tmpZip -DestinationPath $tmpExtract -Force
            # Windows 版 zip は node-v20.20.0-win-x64\ という単一フォルダ直下に node.exe があり、
            # tar --strip-components=1 相当の処理が必要（bin/ は存在しない）
            $extractedRoot = Get-ChildItem -Path $tmpExtract -Directory | Select-Object -First 1
            if ($extractedRoot) {
                if (Test-Path $NodeDir) { Remove-Item $NodeDir -Recurse -Force }
                Move-Item -Path $extractedRoot.FullName -Destination $NodeDir -Force
            }
            Remove-Item $tmpZip -Force -ErrorAction SilentlyContinue
            Remove-Item $tmpExtract -Recurse -Force -ErrorAction SilentlyContinue
        } catch {
            Write-Host "  X Node.js の自動インストールに失敗しました: $($_.Exception.Message)" -ForegroundColor Red
            return $null
        }
    }

    if (Test-Path (Join-Path $NodeDir "node.exe")) {
        return $NodeDir
    }
    return $null
}

$PortableNodeDir = $null
$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
$NodeMajor = 0
if ($NodeCmd) {
    $NodeVersion = (node -v) -replace '^v', ''
    $NodeMajor = [int]($NodeVersion.Split('.')[0])
}

if (-not $NodeCmd -or $NodeMajor -lt 20) {
    if ($NodeCmd) {
        Write-Host "  ! Node.js v$NodeVersion は古いバージョンです（20+ が必要）。自動インストールを試みます..." -ForegroundColor Yellow
    } else {
        Write-Host "  ! Node.js が見つかりません。自動インストールを試みます..." -ForegroundColor Yellow
    }
    $PortableNodeDir = Install-PortableNode
    if ($PortableNodeDir) {
        # PATH 先頭に追加（この後の pnpm 自動インストール・ビルドでも使われる）
        $env:Path = "$PortableNodeDir;$env:Path"
        $NodeCmd = Get-Command node -ErrorAction SilentlyContinue
        if ($NodeCmd) {
            $NodeVersion = (node -v) -replace '^v', ''
            Write-Host "  OK Node.js v$NodeVersion をインストールしました ($PortableNodeDir)" -ForegroundColor Green
        }
    }
    if (-not $NodeCmd) {
        Write-Host "  X Node.js 20 以上が必要です" -ForegroundColor Red
        Write-Host "    インストール: winget install OpenJS.NodeJS.LTS" -ForegroundColor Yellow
        Write-Host "    または: https://nodejs.org" -ForegroundColor Yellow
        $Missing++
    }
} else {
    Write-Host "  OK Node.js v$NodeVersion" -ForegroundColor Green
}

# git チェック
$GitCmd = Get-Command git -ErrorAction SilentlyContinue
if (-not $GitCmd) {
    Write-Host "  X git が必要です" -ForegroundColor Red
    Write-Host "    インストール: winget install Git.Git" -ForegroundColor Yellow
    $Missing++
} else {
    $GitVersion = (git --version) -replace 'git version ', ''
    Write-Host "  OK git $GitVersion" -ForegroundColor Green
}

# プロキシ指定時、npm にも proxy 設定を投入（HTTP_PROXY/HTTPS_PROXY 環境変数だけでは
# `npm install -g pnpm` が通らない環境向け）。npm が無いタイミングでは skip。
if ($ProxyUrl -and (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "  npm に proxy 設定を投入..." -ForegroundColor Yellow
    try {
        cmd /c "npm config set proxy `"$ProxyUrl`"" 2>$null
        cmd /c "npm config set https-proxy `"$ProxyUrl`"" 2>$null
    } catch {
        Write-Host "  WARNING: npm proxy 設定に失敗（続行）" -ForegroundColor Yellow
    }
}

# =============================================================================
# pnpm 解決ヘルパー群
# =============================================================================
# 背景（実測: 既存 Node v24.18.0 端末で `npm install -g pnpm` 成功直後に
# 「X pnpm が必要です」で中断）:
#   真因A: 従来は PATH を
#            $env:Path = (Machine PATH) + ";" + (User PATH)
#          とレジストリ値で丸ごと置き換えていた。プロセス PATH にしか無い
#          エントリ（fnm/nvm-windows/volta の shim、ポータブル Node、親シェルが
#          注入した npm prefix）が消える。補償の `%APPDATA%\npm` 追加は
#          `if ($PortableNodeDir)` の中にあり、Node が既にインストール済みの
#          端末では実行されない。npm のグローバル bin は `npm prefix -g` で
#          決まり、社内 .npmrc / NPM_CONFIG_PREFIX で既定以外に変更されている
#          場合があるのに、その場所を一度も問い合わせていなかった。
#   真因B: `cmd /c "npm install -g pnpm" 2>$null` の `2>$null` は PowerShell 側の
#          リダイレクトであり、$ErrorActionPreference="Stop" 下では stderr 1 行
#          ごとに NativeCommandError（終了エラー）が送出される（本ファイル
#          Invoke-LoggedCommand の注記と同じ落とし穴）。npm は成功時でも notice
#          を stderr に出すため、PATH 再解決と Get-Command を丸ごと飛ばして
#          空の catch {} に落ち、同じ症状になる。

<#
.SYNOPSIS
  プロセス PATH を「マージ」で更新する（従来のように置き換えない）。
.DESCRIPTION
  優先順は $Prepend > 既存のプロセス PATH > Machine PATH > User PATH。
  大文字小文字を無視して重複排除するが、比較キーだけ末尾の \ を落とし、
  PATH に格納する値は元のまま使う（"C:\" を "C:" に壊さないため）。
#>
function Update-ProcessPathMerged {
    param([string[]]$Prepend = @())

    $ordered = @()
    $ordered += $Prepend
    $ordered += ($env:Path -split ';')
    $ordered += ([Environment]::GetEnvironmentVariable('Path', 'Machine') -split ';')
    $ordered += ([Environment]::GetEnvironmentVariable('Path', 'User') -split ';')

    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $result = New-Object System.Collections.Generic.List[string]
    foreach ($entry in $ordered) {
        if ([string]::IsNullOrWhiteSpace($entry)) { continue }
        $value = $entry.Trim().Trim('"')
        if ([string]::IsNullOrWhiteSpace($value)) { continue }
        $key = $value.TrimEnd('\')
        if ([string]::IsNullOrWhiteSpace($key)) { $key = $value }
        if ($seen.Add($key)) { [void]$result.Add($value) }
    }
    $env:Path = ($result -join ';')
}

<#
.SYNOPSIS
  npm のグローバル bin ディレクトリ候補を、権威的な順に列挙する。
.DESCRIPTION
  stderr のリダイレクトは cmd.exe 内部（2>NUL）で完結させる。PowerShell 側の
  `2>$null` は EAP=Stop 下で NativeCommandError を誘発するため使わない（真因B）。
#>
function Get-NpmGlobalBinCandidates {
    param([string]$PortableNodeDir)

    $dirs = @()

    # (1) npm 自身が持つ prefix。社内 .npmrc / NPM_CONFIG_PREFIX で変更されている
    #     場合はここだけが真の値になる。2 系統とも試す（片方が失敗しても続行）。
    foreach ($probe in @('npm prefix -g', 'npm config get prefix')) {
        try {
            $out = cmd /c "$probe 2>NUL"
            $prefix = (@($out) | Where-Object { $_ -and $_.Trim() } | Select-Object -Last 1)
            if ($prefix) {
                $prefix = $prefix.Trim()
                $dirs += $prefix
                $dirs += (Join-Path $prefix 'bin')
            }
        } catch { }
    }

    # (2) 既定・準既定の置き場
    if ($env:APPDATA)      { $dirs += (Join-Path $env:APPDATA 'npm') }
    if ($env:LOCALAPPDATA) { $dirs += (Join-Path $env:LOCALAPPDATA 'npm') }
    if ($env:LOCALAPPDATA) { $dirs += (Join-Path $env:LOCALAPPDATA 'pnpm') }  # corepack / pnpm standalone

    # (3) ポータブル Node と、現在解決されている node の隣（corepack shim はここに出る）
    if ($PortableNodeDir) { $dirs += $PortableNodeDir }
    $nodeSrc = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeSrc -and $nodeSrc.Source) { $dirs += (Split-Path -Parent $nodeSrc.Source) }

    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $result = @()
    foreach ($d in $dirs) {
        if ([string]::IsNullOrWhiteSpace($d)) { continue }
        $t = $d.Trim().TrimEnd('\')
        if ($seen.Add($t)) { $result += $t }
    }
    return $result
}

<#
.SYNOPSIS
  候補ディレクトリから pnpm の実行ファイル（.cmd / .exe / .bat）を実ファイルで探す。
.DESCRIPTION
  `.ps1` は決して選ばない。ExecutionPolicy の影響を受ける上、#352 の
  「起動するが無音・$LASTEXITCODE も更新しない」事故の直接原因だったため。
  探索方針は agents/linux/src/services/update-script.ts の
  buildExecutableResolver()（明示パス優先 → .cmd → .exe）と揃えてある。
#>
function Resolve-PnpmExecutable {
    param([string[]]$Dirs)

    foreach ($dir in $Dirs) {
        if ([string]::IsNullOrWhiteSpace($dir)) { continue }
        foreach ($leaf in @('pnpm.cmd', 'pnpm.exe', 'pnpm.bat')) {
            try {
                $p = Join-Path $dir $leaf
                if (Test-Path -LiteralPath $p -PathType Leaf) { return $p }
            } catch {
                # 不正な文字を含むパス等。EAP=Stop でも次の候補へ進む
            }
        }
    }
    return $null
}

<#
.SYNOPSIS
  pnpm のバージョン文字列を取得する（.ps1 経路を通さない）。
.DESCRIPTION
  cmd.exe は .ps1 を実行対象にしないため、`cmd /c` 経由の呼び出しは
  ExecutionPolicy と pnpm.ps1 の無音問題（#352）を構造的に回避できる。
  取得できない場合も中断せず '(unknown)' を返す（ビルドログのヘッダ用途）。
#>
function Get-PnpmVersionString {
    param([string]$PnpmExe)

    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if ($PnpmExe) { $out = cmd /c "`"$PnpmExe`" -v 2>NUL" }
        else          { $out = cmd /c "pnpm -v 2>NUL" }
        $line = (@($out) | Where-Object { $_ -and $_.Trim() } | Select-Object -Last 1)
        if ($line) { return $line.Trim() }
        return '(unknown)'
    } catch {
        return '(unknown)'
    } finally {
        $ErrorActionPreference = $prevEap
    }
}

# =============================================================================
# pnpm チェック（未インストールなら自動インストール）
# =============================================================================
$PnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
$PnpmExe = $null          # 解決できた実体パス（診断・バージョン取得用）
$PnpmSearchDirs = @()

if (-not $PnpmCmd) {
    # Node.js がある場合のみ自動インストールを試みる
    if ($NodeCmd) {
        Write-Host "  pnpm をインストール中..." -ForegroundColor Yellow
        # 真因B 対策:
        #   (a) リダイレクトを cmd.exe 内部（2>&1）で完結させ、PowerShell に
        #       ErrorRecord を一切渡さない
        #   (b) 念のため EAP も一時的に Continue に落とし、finally で必ず戻す
        #   (c) 出力を捨てず変数に取り、末尾数行を表示（従来は 2>$null で全部捨てていた）
        $PrevEapLocal = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $NpmInstallOut = ''
        try {
            $NpmInstallOut = (cmd /c "npm install -g pnpm 2>&1" | Out-String)
        } catch {
            $NpmInstallOut = "EXCEPTION: $($_.Exception.Message)"
        } finally {
            $ErrorActionPreference = $PrevEapLocal
        }
        if ($NpmInstallOut) {
            ($NpmInstallOut.TrimEnd() -split '\r?\n') | Select-Object -Last 5 | ForEach-Object {
                if ($_.Trim()) { Write-Host "    $_" -ForegroundColor DarkGray }
            }
        }

        # --- PATH 再解決（置き換えではなくマージ）---
        # 1) npm のグローバル bin を権威的に特定し、pnpm.cmd/.exe を実ファイルで探す
        # 2) 見つかったディレクトリを PATH 先頭に足す（既存のプロセス PATH は保持）
        # 以降のステップ（Step 3 の `pnpm install` 等）は裸の `pnpm` を呼ぶため、
        # ここで必ず「裸の pnpm が解決できる」状態にしておく必要がある。
        $PnpmSearchDirs = Get-NpmGlobalBinCandidates -PortableNodeDir $PortableNodeDir
        $PnpmExe = Resolve-PnpmExecutable -Dirs $PnpmSearchDirs

        $Prepend = @()
        if ($PortableNodeDir) { $Prepend += $PortableNodeDir }
        if ($PnpmExe)         { $Prepend += (Split-Path -Parent $PnpmExe) }
        Update-ProcessPathMerged -Prepend $Prepend

        # PATHEXT に .CMD が無い端末では、ディレクトリを PATH に足しても裸の `pnpm` は
        # 解決されない（pnpm の実体は pnpm.cmd）。欠けていれば補う。
        if ($env:PATHEXT -and ($env:PATHEXT -notmatch '(^|;)\.CMD(;|$)')) {
            $env:PATHEXT = "$env:PATHEXT;.CMD"
        }

        $PnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
        if (-not $PnpmCmd -and $PnpmExe) {
            # 実ファイルはあるのに裸で解決できない病的な端末向けの最後の一手
            $PnpmCmd = Get-Command $PnpmExe -ErrorAction SilentlyContinue
        }
    }
    if (-not $PnpmCmd) {
        # --- 実行可能な診断（従来は「npm install -g pnpm」としか出さず、
        #     すでにインストールに成功しているユーザーを誤誘導していた）---
        $NpmPrefixShown = '(取得できませんでした)'
        try {
            $p = (cmd /c "npm prefix -g 2>NUL" | Where-Object { $_ -and $_.Trim() } | Select-Object -Last 1)
            if ($p) { $NpmPrefixShown = $p.Trim() }
        } catch { }

        Write-Host "  X pnpm を PATH 上で解決できませんでした" -ForegroundColor Red
        Write-Host "    npm グローバル prefix: $NpmPrefixShown" -ForegroundColor Yellow
        Write-Host "    探索したディレクトリ:" -ForegroundColor Yellow
        foreach ($d in $PnpmSearchDirs) {
            $mark = '(ディレクトリが存在しません)'
            try {
                if (Test-Path -LiteralPath $d) {
                    $mark = 'pnpm 無し'
                    foreach ($leaf in @('pnpm.cmd', 'pnpm.exe', 'pnpm.bat')) {
                        if (Test-Path -LiteralPath (Join-Path $d $leaf) -PathType Leaf) { $mark = "$leaf あり"; break }
                    }
                }
            } catch { $mark = '(確認失敗)' }
            Write-Host "      $d  [$mark]" -ForegroundColor DarkGray
        }
        Write-Host "    対処:" -ForegroundColor Yellow
        Write-Host "      1) 新しい PowerShell ウィンドウを開いて pnpm -v を確認し、通るならそのウィンドウで再実行" -ForegroundColor Green
        Write-Host "      2) 上の一覧に『pnpm.cmd あり』の行があれば、同じウィンドウで PATH に足して再実行:" -ForegroundColor Green
        Write-Host "         `$env:Path = `"<そのディレクトリ>;`$env:Path`"" -ForegroundColor Green
        Write-Host "      3) どこにも無い場合は npm install -g pnpm を手動実行し、出力に出た場所を確認してください" -ForegroundColor Green
        Write-Host "      ※ setx PATH `"%PATH%;...`" は 1024 文字で切り詰められ PATH を破壊するため使わないでください" -ForegroundColor Yellow
        $Missing++
    } else {
        if (-not $PnpmExe) { $PnpmExe = $PnpmCmd.Source }
        $PnpmVersion = Get-PnpmVersionString -PnpmExe $PnpmExe
        Write-Host "  OK pnpm $PnpmVersion (自動インストール: $PnpmExe)" -ForegroundColor Green
    }
} else {
    # 既に PATH 上で解決できている場合は PATH を一切触らない（最小変更・最小リスク）。
    # バージョン取得だけ .ps1 経路を避ける（#352）。
    $PnpmProbe = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
    if (-not $PnpmProbe) { $PnpmProbe = Get-Command pnpm.exe -ErrorAction SilentlyContinue }
    if ($PnpmProbe) { $PnpmExe = $PnpmProbe.Source }
    $PnpmVersion = Get-PnpmVersionString -PnpmExe $PnpmExe
    Write-Host "  OK pnpm $PnpmVersion" -ForegroundColor Green
}

# プロキシ指定時、pnpm にも proxy 設定を投入（環境変数だけでは `pnpm install` が拾わない
# 環境への対策。pnpm 検出/インストール完了直後に実行する）。
if ($ProxyUrl -and $PnpmCmd) {
    Write-Host "  pnpm に proxy 設定を投入..." -ForegroundColor Yellow
    try {
        cmd /c "pnpm config set proxy `"$ProxyUrl`"" 2>$null
        cmd /c "pnpm config set https-proxy `"$ProxyUrl`"" 2>$null
    } catch {
        Write-Host "  WARNING: pnpm proxy 設定に失敗（続行）" -ForegroundColor Yellow
    }
}

# AI CLI チェック（任意）
# Claude Code は必須ではなく、claude / gemini / codex / aider / devin のいずれか
# 1 つあれば動作する（どれも無くても Agent 自体は起動でき、後からインストールすれば
# 起動時の自動検出が config に追加する）。
$ClaudeCmd = Get-Command claude -ErrorAction SilentlyContinue
if (-not $ClaudeCmd) {
    # Claude Code が無くても他の AI CLI があれば続行する
    $OtherAiTools = @()
    foreach ($tool in @('gemini', 'codex', 'aider', 'devin')) {
        if (Get-Command $tool -ErrorAction SilentlyContinue) {
            $OtherAiTools += $tool
        }
    }
    if ($OtherAiTools.Count -gt 0) {
        Write-Host "  ! Claude Code 未検出（検出された AI ツール: $($OtherAiTools -join ', ')）" -ForegroundColor Yellow
        Write-Host "    Claude Code が必要な場合は後から: irm https://claude.ai/install.ps1 | iex" -ForegroundColor Yellow
    } else {
        Write-Host "  ! AI CLI が見つかりません（claude / gemini / codex / aider / devin）" -ForegroundColor Yellow
        Write-Host "    Agent はインストールしますが、AI ツールを後からインストールしてください。" -ForegroundColor Yellow
        Write-Host "    例: irm https://claude.ai/install.ps1 | iex" -ForegroundColor Yellow
        Write-Host "    ※ Agent 起動時の自動検出が、後からインストールした AI CLI を config に追加します。" -ForegroundColor Yellow
    }
} else {
    Write-Host "  OK Claude Code" -ForegroundColor Green
}

# 不足ツールがあれば終了
if ($Missing -gt 0) {
    Write-Host ""
    Write-Host "上記 $Missing 件のツールをインストールしてから再実行してください。" -ForegroundColor Red
    Write-Host "インストールを中断しました。" -ForegroundColor Red
    $ErrorActionPreference = $PrevEAP
    return
}

Write-Host "OK 依存ツール OK" -ForegroundColor Green
Write-Host ""

# =============================================================================
# トークン事前検証
# =============================================================================
# サーバーに問い合わせて、トークンが別のマシンに割り当て済みでないか確認する
# 仮名（agent-*）でないマシン名が登録されていて、現在のマシンと異なる場合は中断
if (-not $Force) {
    # WebSocket URL → HTTP URL に変換して API ベース URL を構築
    $ApiBaseUrl = $ServerUrl -replace '^wss://', 'https://' -replace '^ws://', 'http://' -replace '/ws/agent$', ''

    Write-Host "トークンを検証中..."

    try {
        $ValidateBody = @{ token = $Token } | ConvertTo-Json
        $ValidateResponse = Invoke-RestMethod -Uri "$ApiBaseUrl/api/public/validate-token" `
            -Method Post `
            -ContentType "application/json" `
            -Body $ValidateBody `
            -ErrorAction Stop

        if (-not $ValidateResponse.valid) {
            Write-Host ""
            Write-Host "X エラー: 無効なトークンです" -ForegroundColor Red
            Write-Host "  WebUI で正しいトークンを確認してください。"
            Write-Host "インストールを中断しました。" -ForegroundColor Red
            $ErrorActionPreference = $PrevEAP
            return
        }

        if ($ValidateResponse.valid -and -not $ValidateResponse.provisional) {
            # 仮名でないマシン名が登録されている場合、現在のマシンと比較
            $CurrentMachineName = "$env:COMPUTERNAME/$env:USERNAME"
            if ($ValidateResponse.machineName -ne $CurrentMachineName) {
                Write-Host ""
                Write-Host "X エラー: このトークンは別のエージェントに割り当て済みです" -ForegroundColor Red
                Write-Host ""
                Write-Host "  トークンのエージェント名:  $($ValidateResponse.machineName)" -ForegroundColor Yellow
                Write-Host "  このマシンの名前:          $CurrentMachineName" -ForegroundColor Yellow
                Write-Host ""
                Write-Host "  WebUI で新しいエージェントを作成するか、"
                Write-Host '  強制インストールする場合は $env:DEVRELAY_FORCE="true" を設定してください。'
                Write-Host ""
                Write-Host '  例: $env:DEVRELAY_TOKEN="..."; $env:DEVRELAY_FORCE="true"; irm ... | iex' -ForegroundColor Green
                Write-Host ""
                Write-Host "インストールを中断しました。" -ForegroundColor Red
                $ErrorActionPreference = $PrevEAP
                return
            }
        }

        Write-Host "  OK トークン検証OK" -ForegroundColor Green
    } catch {
        # サーバーに接続できない場合はインストールを中断
        Write-Host ""
        Write-Host "X エラー: サーバーに接続できません" -ForegroundColor Red
        Write-Host ""
        Write-Host "  サーバー: $ApiBaseUrl" -ForegroundColor Yellow
        if ($ProxyUrl) {
            Write-Host "  プロキシ: $ProxyUrl" -ForegroundColor Yellow
            Write-Host ""
            Write-Host "  プロキシURLが正しいか確認してください。"
        }
        Write-Host ""
        Write-Host '  強制インストールする場合は $env:DEVRELAY_FORCE="true" を設定してください。'
        Write-Host ""
        Write-Host "インストールを中断しました。" -ForegroundColor Red
        $ErrorActionPreference = $PrevEAP
        return
    }
}
Write-Host ""

# =============================================================================
# ネイティブコマンド実行ヘルパー（#328）
# =============================================================================
# PowerShell 固有の落とし穴 2 つに同時に対処する:
#  (1) ネイティブコマンド（pnpm/git/npm）は非ゼロ終了しても例外を投げない。
#      $ErrorActionPreference="Stop" でも try/catch では絶対に捕まらないため、
#      $LASTEXITCODE を戻り値として返し、呼び出し側で必ず判定する。
#  (2) $ErrorActionPreference="Stop" のままネイティブコマンドの stderr を
#      リダイレクト（2>&1 / 2>$null）すると、stderr 1 行ごとに NativeCommandError が
#      「終了エラー」として送出される（Windows PowerShell 5.1 / PowerShell 7.0-7.1）。
#      pnpm は進捗を stderr に出すため、成功していても catch に飛んでしまう。
#      実行中だけ Continue に落とし、finally で必ず元に戻す。
function Invoke-LoggedCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][scriptblock]$Command,
        [Parameter(Mandatory = $true)][string]$LogFile
    )

    # `e は PowerShell 7 専用のエスケープなので 5.1 互換のため [char]27 を使う
    $esc = [char]27
    $prevEap = $ErrorActionPreference
    $writer = $null
    $code = 0

    try {
        # 1 コマンドにつきハンドル 1 本。AutoFlush でハング時も途中まで残る
        $writer = New-Object System.IO.StreamWriter($LogFile, $true)
        $writer.AutoFlush = $true
        $writer.WriteLine("")
        $writer.WriteLine("===== [$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))] $Label =====")
    } catch {
        # ログが開けなくてもインストール自体は続行する
        $writer = $null
    }

    $ErrorActionPreference = "Continue"
    # コマンドが見つからない場合 $LASTEXITCODE は更新されず前回値が残るためリセット
    $global:LASTEXITCODE = 0
    try {
        & $Command 2>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) {
                $line = $_.ToString()
            } else {
                $line = [string]$_
            }
            $line = $line -replace "$esc\[[0-9;?]*[A-Za-z]", ""
            Write-Host "    $line"
            if ($writer) { $writer.WriteLine($line) }
        }
        # $LASTEXITCODE はパイプラインを通しても cmdlet に上書きされない
        $code = $LASTEXITCODE
    } catch {
        $line = "EXCEPTION: $($_.Exception.Message)"
        Write-Host "    $line" -ForegroundColor Yellow
        if ($writer) { $writer.WriteLine($line) }
        $code = 1
    } finally {
        $ErrorActionPreference = $prevEap
    }

    if ($null -eq $code) { $code = 0 }
    if ($writer) {
        $writer.WriteLine("----- exit code: $code -----")
        $writer.Close()
    }
    return $code
}

# =============================================================================
# Step 2: リポジトリ取得
# =============================================================================
Write-Host "[2/6] リポジトリを取得中..."

# ディレクトリ作成
New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
New-Item -ItemType Directory -Path $BinDir -Force | Out-Null

# ビルドログを毎回作り直す（前回実行のログと混ざらないように、#328）
$BuildLogHeader = @(
    "DevRelay Agent install build log",
    "date      : $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))",
    "machine   : $env:COMPUTERNAME/$env:USERNAME",
    "agentDir  : $AgentDir",
    "node      : $(if ($NodeCmd) { (node -v) } else { 'n/a' })",
    "pnpm      : $PnpmVersion",
    "proxy     : $(if ($ProxyUrl) { $ProxyUrl } else { '(none)' })",
    "psVersion : $($PSVersionTable.PSVersion)"
)
Set-Content -LiteralPath $BuildLog -Value $BuildLogHeader -Encoding UTF8

if (Test-Path (Join-Path $AgentDir ".git")) {
    # 既存なら最新に更新（失敗しても致命的ではないので警告のみ）
    Write-Host "  既存のリポジトリを更新中..."
    Push-Location $AgentDir
    $PullCode = Invoke-LoggedCommand -Label "git pull" -Command { git pull --quiet } -LogFile $BuildLog
    Pop-Location
    if ($PullCode -ne 0) {
        Write-Host "  WARNING: git pull に失敗しました (exit $PullCode)。既存のコードで続行します" -ForegroundColor Yellow
    }
} else {
    # 新規 clone
    Write-Host "  クローン中... (初回は時間がかかります)"
    $CloneCode = Invoke-LoggedCommand -Label "git clone" -Command { git clone --quiet --depth 1 $RepoUrl $AgentDir } -LogFile $BuildLog
    if (($CloneCode -ne 0) -or (-not (Test-Path (Join-Path $AgentDir "package.json")))) {
        Write-Host ""
        Write-Host "X エラー: リポジトリの取得に失敗しました (git clone exit $CloneCode)" -ForegroundColor Red
        Write-Host "  URL:      $RepoUrl" -ForegroundColor Yellow
        Write-Host "  ログ:     $BuildLog" -ForegroundColor Yellow
        if ($ProxyUrl) {
            Write-Host "  プロキシ: $ProxyUrl （URL が正しいか確認してください）" -ForegroundColor Yellow
        } else {
            Write-Host '  プロキシ環境の場合は $env:DEVRELAY_PROXY="http://proxy:8080" を指定して再実行してください。' -ForegroundColor Yellow
        }
        Write-Host "インストールを中断しました。" -ForegroundColor Red
        $ErrorActionPreference = $PrevEAP
        return
    }
}

Write-Host "OK リポジトリ取得完了" -ForegroundColor Green
Write-Host ""

# =============================================================================
# Step 3: ビルド
# =============================================================================
Write-Host "[3/6] ビルド中..."

Write-Host "  ビルドログ: $BuildLog" -ForegroundColor DarkGray
Push-Location $AgentDir

Write-Host "  依存関係をインストール中..."
# --ignore-scripts: Electron 等の postinstall をスキップ（CLI Agent には不要）
# 企業ネットワークで Electron バイナリ取得が ECONNRESET で失敗する問題を回避
# 3 段階フォールバック（#328、前段が非ゼロ終了したときだけ次に進む）:
#   1. lockfile 固定 + モノレポ全体（従来の第一候補・成功すればここで終わる）
#   2. lockfile 固定なし + モノレポ全体（lockfile ズレ対策。従来 catch で走っていた方）
#   3. Agent に必要なワークスペースだけに絞る（Electron/Prisma/Vite を丸ごと外し、
#      企業ネットワークでのパッケージ取得失敗の母数を減らす最後の砦）
$InstallOk = $false
$InstallTiers = @(
    @{ Label = "pnpm install --frozen-lockfile --ignore-scripts";
       Command = { pnpm install --frozen-lockfile --ignore-scripts } },
    @{ Label = "pnpm install --ignore-scripts";
       Command = { pnpm install --ignore-scripts } },
    @{ Label = "pnpm install --ignore-scripts --filter @devrelay/agent...";
       Command = { pnpm install --ignore-scripts --filter "@devrelay/agent..." } }
)
foreach ($tier in $InstallTiers) {
    Write-Host "  > $($tier.Label)" -ForegroundColor DarkGray
    $InstallCode = Invoke-LoggedCommand -Label $tier.Label -Command $tier.Command -LogFile $BuildLog
    if ($InstallCode -eq 0) { $InstallOk = $true; break }
    Write-Host "  ! 失敗 (exit $InstallCode) — 次の方法を試します" -ForegroundColor Yellow
}

if (-not $InstallOk) {
    Pop-Location
    Write-Host ""
    Write-Host "X エラー: 依存関係のインストールに失敗しました" -ForegroundColor Red
    Write-Host ""
    Write-Host "  ログ末尾 (最新 30 行):" -ForegroundColor Yellow
    Get-Content -LiteralPath $BuildLog -Tail 30 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    Write-Host ""
    Write-Host "  全文ログ: $BuildLog" -ForegroundColor Yellow
    if ($ProxyUrl) {
        Write-Host "  プロキシ: $ProxyUrl （URL が正しいか確認してください）" -ForegroundColor Yellow
    } else {
        Write-Host '  プロキシ環境の場合は $env:DEVRELAY_PROXY="http://proxy:8080" を指定して再実行してください。' -ForegroundColor Yellow
    }
    Write-Host ""
    Write-Host "  手動で切り分ける場合:" -ForegroundColor Yellow
    Write-Host "    cd `"$AgentDir`"" -ForegroundColor Green
    Write-Host "    pnpm install --ignore-scripts" -ForegroundColor Green
    Write-Host ""
    Write-Host "  ※ 自動起動の登録と Agent の起動は行っていません。" -ForegroundColor Yellow
    Write-Host "     解消後にワンライナーをもう一度実行してください。" -ForegroundColor Yellow
    Write-Host "インストールを中断しました。" -ForegroundColor Red
    $ErrorActionPreference = $PrevEAP
    return
}

# 端末インタフェースモード用に PTY プリビルドを取得
# @homebridge/node-pty-prebuilt-multiarch は Windows/macOS/Linux のプリビルドを同梱
# 失敗しても fatal にしない（端末モードのみ無効化、他機能は動作継続）
Write-Host "  PTY prebuilt binary を取得中..."
# 引数は引用符で囲む: PowerShell の `@homebridge` を splat operator として誤解釈されないように
$RebuildCode = Invoke-LoggedCommand -Label "pnpm rebuild @homebridge/node-pty-prebuilt-multiarch" `
    -Command { pnpm rebuild "@homebridge/node-pty-prebuilt-multiarch" } -LogFile $BuildLog
if ($RebuildCode -ne 0) {
    Write-Host "  WARNING: pnpm rebuild に失敗しました (exit $RebuildCode) — 端末モードのみ無効、続行します" -ForegroundColor Yellow
}

# pnpm rebuild が Windows で conpty.node を配置しない既知問題のフォールバック
# build/Release/conpty.node が無ければ GitHub Releases から ABI 別 tarball を手動展開
$ptyDirs = Get-ChildItem -Path "$AgentDir\node_modules\.pnpm" -Filter "@homebridge+node-pty-prebuilt-multiarch@*" -Directory -ErrorAction SilentlyContinue
foreach ($d in $ptyDirs) {
    $verMatch = [regex]::Match($d.Name, '@([0-9.]+)$')
    if (-not $verMatch.Success) { continue }
    $version = $verMatch.Groups[1].Value
    $ptyPkg = Join-Path $d.FullName "node_modules\@homebridge\node-pty-prebuilt-multiarch"
    if (-not (Test-Path "$ptyPkg\build\Release\conpty.node")) {
        $abi = & node -e "process.stdout.write(process.versions.modules)"
        $url = "https://github.com/homebridge/node-pty-prebuilt-multiarch/releases/download/v$version/node-pty-prebuilt-multiarch-v$version-node-v$abi-win32-x64.tar.gz"
        $tmp = "$env:TEMP\node-pty-prebuild-$abi.tar.gz"
        Write-Host "  conpty.node が見つかりません。手動 download: $url"
        try {
            Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing -ErrorAction Stop
            # Windows 10+ 内蔵の tar コマンドで展開
            & tar -xzf $tmp -C $ptyPkg
            Remove-Item $tmp -Force
            if (Test-Path "$ptyPkg\build\Release\conpty.node") {
                Write-Host "  ✅ conpty.node 取得成功" -ForegroundColor Green
            } else {
                Write-Host "  ⚠️ conpty.node が展開後も見つかりません（端末モードは動作しません）" -ForegroundColor Yellow
            }
        } catch {
            Write-Host "  ⚠️ 手動 download 失敗: $($_.Exception.Message)（端末モードは動作しません）" -ForegroundColor Yellow
        }
    }
}

Write-Host "  shared パッケージをビルド中..."
$SharedBuildCode = Invoke-LoggedCommand -Label "pnpm --filter @devrelay/shared build" `
    -Command { pnpm --filter "@devrelay/shared" build } -LogFile $BuildLog

Write-Host "  Agent をビルド中..."
$AgentBuildCode = Invoke-LoggedCommand -Label "pnpm --filter @devrelay/agent build" `
    -Command { pnpm --filter "@devrelay/agent" build } -LogFile $BuildLog

Pop-Location

# --- ビルド成果物の検証（#328）---
# 終了コードだけでは拾えないケース（tsc が 0 を返したのに出力が無い、途中で
# プロセスが強制終了された等）に備えて実ファイルの存在を必ず確認する。
# ここを通過して初めて config.yaml 生成・自動起動登録・Agent 起動へ進む。
$SharedExists = Test-Path $SharedEntry
$AgentExists = Test-Path $AgentEntry
if (($SharedBuildCode -ne 0) -or ($AgentBuildCode -ne 0) -or (-not $SharedExists) -or (-not $AgentExists)) {
    Write-Host ""
    Write-Host "X エラー: ビルドに失敗しました（Agent の実行ファイルが生成されていません）" -ForegroundColor Red
    Write-Host ""
    Write-Host "  shared build 終了コード: $SharedBuildCode  (dist 存在: $SharedExists)" -ForegroundColor Yellow
    Write-Host "  agent  build 終了コード: $AgentBuildCode  (dist 存在: $AgentExists)" -ForegroundColor Yellow
    Write-Host "  期待するファイル: $AgentEntry" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  ログ末尾 (最新 30 行):" -ForegroundColor Yellow
    Get-Content -LiteralPath $BuildLog -Tail 30 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    Write-Host ""
    Write-Host "  全文ログ: $BuildLog" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  手動で切り分ける場合:" -ForegroundColor Yellow
    Write-Host "    cd `"$AgentDir`"" -ForegroundColor Green
    Write-Host "    pnpm install --ignore-scripts" -ForegroundColor Green
    Write-Host "    pnpm --filter @devrelay/shared build" -ForegroundColor Green
    Write-Host "    pnpm --filter @devrelay/agent build" -ForegroundColor Green
    Write-Host ""
    Write-Host "  ※ 自動起動の登録と Agent の起動は行っていません（起動しても即座に" -ForegroundColor Yellow
    Write-Host "     MODULE_NOT_FOUND で落ちるだけのため）。" -ForegroundColor Yellow
    Write-Host "     解消後にワンライナーをもう一度実行してください。" -ForegroundColor Yellow
    Write-Host "インストールを中断しました。" -ForegroundColor Red
    $ErrorActionPreference = $PrevEAP
    return
}

Write-Host "OK ビルド完了" -ForegroundColor Green
Write-Host ""

# =============================================================================
# Step 4: config.yaml 生成
# =============================================================================
Write-Host "[4/6] 設定ファイルを生成中..."

$MachineName = "$env:COMPUTERNAME/$env:USERNAME"

if (Test-Path $ConfigFile) {
    Write-Host "  WARNING: config.yaml が既に存在します。トークン・サーバーURL・マシン名を更新します" -ForegroundColor Yellow
    # 既存ファイルのトークンを更新
    $Content = Get-Content $ConfigFile -Raw
    if ($Content -match "(?m)^token:") {
        $Content = $Content -replace '(?m)^token:.*', "token: `"$Token`""
    } else {
        $Content += "`ntoken: `"$Token`""
    }
    # serverUrl も更新（トークンから抽出した URL、またはデフォルト wss://devrelay.io/ws/agent）
    if ($Content -match "(?m)^serverUrl:") {
        $Content = $Content -replace '(?m)^serverUrl:.*', "serverUrl: `"$ServerUrl`""
    } else {
        $Content += "`nserverUrl: `"$ServerUrl`""
    }
    # machineName も更新（旧形式 hostname のみ → 新形式 hostname/username への移行対応）
    if ($Content -match "(?m)^machineName:") {
        $Content = $Content -replace '(?m)^machineName:.*', "machineName: `"$MachineName`""
    } else {
        $Content += "`nmachineName: `"$MachineName`""
    }
    Set-Content -Path $ConfigFile -Value $Content -Encoding UTF8

    # プロキシが指定されている場合、既存設定に追加/更新
    if ($ProxyUrl) {
        $Content = Get-Content $ConfigFile -Raw
        if ($Content -match "(?m)^proxy:") {
            # 既存の proxy.url を更新
            $Content = $Content -replace '(?m)^(  url:).*', "`$1 `"$ProxyUrl`""
        } else {
            # proxy セクションを末尾に追加
            $Content += "`nproxy:`n  url: `"$ProxyUrl`""
        }
        Set-Content -Path $ConfigFile -Value $Content -Encoding UTF8
        Write-Host "  プロキシ設定を更新しました"
    }
} else {
    # 新規作成: 基本設定
    # --- 検出された AI CLI から aiTools セクションを動的生成 ---
    # 優先順（claude > devin > gemini > codex > aider）で最初に検出されたものを default にする。
    # 1 つも無ければ従来どおり claude を default（後からインストールされたら起動時自動検出が拾う）。
    $AiDefault = ""
    $AiToolLines = @()
    foreach ($tool in @('claude', 'devin', 'gemini', 'codex', 'aider')) {
        if (Get-Command $tool -ErrorAction SilentlyContinue) {
            if (-not $AiDefault) { $AiDefault = $tool }
            $AiToolLines += "  ${tool}:"
            $AiToolLines += "    command: ${tool}"
        }
    }
    if (-not $AiDefault) {
        $AiDefault = "claude"
        $AiToolLines = @("  claude:", "    command: claude")
    }
    $AiToolsYaml = $AiToolLines -join "`n"

    $ConfigContent = @"
# DevRelay Agent 設定ファイル
# 詳細: https://github.com/murata1215/devrelay

machineName: "$MachineName"
machineId: ""
serverUrl: "$ServerUrl"
token: "$Token"
projectsDirs:
  - $($env:USERPROFILE)
aiTools:
  default: $AiDefault
$AiToolsYaml
logLevel: info
"@

    # プロキシ設定がある場合は追記
    if ($ProxyUrl) {
        $ConfigContent += "`nproxy:`n  url: `"$ProxyUrl`""
    }

    Set-Content -Path $ConfigFile -Value $ConfigContent -Encoding UTF8
    Write-Host "  作成: $ConfigFile"
}

Write-Host "  エージェント名: $MachineName" -ForegroundColor Green
Write-Host "OK 設定完了" -ForegroundColor Green
Write-Host ""

# =============================================================================
# Step 5: devrelay-claude.cmd ラッパー作成
# =============================================================================
Write-Host "[5/6] Claude Code ラッパーを作成中..."

$ClaudeCmd = Get-Command claude -ErrorAction SilentlyContinue
if ($ClaudeCmd) {
    $ClaudePath = $ClaudeCmd.Source
    $WrapperPath = Join-Path $BinDir "devrelay-claude.cmd"
    Set-Content -Path $WrapperPath -Value "@echo off`r`n`"$ClaudePath`" %*`r`n" -Encoding ASCII
    Write-Host "  OK devrelay-claude.cmd -> $ClaudePath" -ForegroundColor Green
} else {
    Write-Host "  -- Claude Code 未インストール（後からインストール可能）" -ForegroundColor Gray
}

Write-Host ""

# =============================================================================
# Step 6: VBS ランチャー作成 + 自動起動登録 + 即時起動
# =============================================================================
Write-Host "[6/6] Agent を起動中..."

# $AgentEntry はファイル先頭の定数ブロックで定義済み（Step 3 の成果物検証と共用、#328）
$NodePath = (Get-Command node).Source
$LogFile = Join-Path $LogDir "agent.log"

# --- CMD バッチファイルを作成（node 実行 + ログリダイレクト担当）---
$CmdPath = Join-Path $BinDir "start-agent.cmd"
$CmdContent = @"
@echo off
"$NodePath" "$AgentEntry" >> "$LogFile" 2>&1
"@
Set-Content -Path $CmdPath -Value $CmdContent -Encoding ASCII
Write-Host "  OK バッチファイル作成: $CmdPath" -ForegroundColor Green

# --- VBS ランチャースクリプトを作成（CMD を非表示で起動するだけ）---
# VBS の """path""" は VBS側で "path" に展開される（VBSの文字列エスケープ）
$VbsPath = Join-Path $BinDir "start-agent.vbs"
$VbsContent = @"
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """$CmdPath""", 0, False
"@
Set-Content -Path $VbsPath -Value $VbsContent -Encoding ASCII
Write-Host "  OK ランチャー作成: $VbsPath" -ForegroundColor Green

# --- 自動起動登録（Startup フォルダにコピー）---
$AutoStartRegistered = $false
try {
    $StartupDir = [Environment]::GetFolderPath("Startup")
    $StartupVbs = Join-Path $StartupDir "DevRelay Agent.vbs"
    Copy-Item -Path $VbsPath -Destination $StartupVbs -Force
    $AutoStartRegistered = $true
    Write-Host "  OK 自動起動登録完了（Startup フォルダ）" -ForegroundColor Green
} catch {
    # Startup フォルダ失敗時はタスクスケジューラをフォールバック
    try {
        $TaskAction = "`"wscript.exe`" `"$VbsPath`""
        schtasks /Delete /TN $TaskName /F 2>$null | Out-Null
        schtasks /Create /TN $TaskName /TR $TaskAction /SC ONLOGON /F /RL LIMITED | Out-Null
        $AutoStartRegistered = $true
        Write-Host "  OK 自動起動登録完了（タスクスケジューラ）" -ForegroundColor Green
    } catch {
        Write-Host "  WARNING: 自動起動の登録に失敗しました（手動起動は可能）" -ForegroundColor Yellow
    }
}

# --- 既存の Agent プロセスを停止（再インストール対応）---
# 方式1: PID ファイルから停止（Agent が起動時に書き込む agent.pid を参照）
# 方式2: フォールバック — Get-CimInstance をバックグラウンドジョブ + 5秒タイムアウトで実行
$PidFile = Join-Path $ConfigDir "agent.pid"
$KilledByPid = $false
if (Test-Path $PidFile) {
    try {
        $OldPid = [int](Get-Content $PidFile -ErrorAction Stop)
        $OldProc = Get-Process -Id $OldPid -ErrorAction SilentlyContinue
        if ($OldProc -and $OldProc.Name -eq "node") {
            Stop-Process -Id $OldPid -Force -ErrorAction SilentlyContinue
            $KilledByPid = $true
            Write-Host "  既存の Agent を停止しました (PID: $OldPid, PID ファイル)" -ForegroundColor Yellow
        }
    } catch {}
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

# PID ファイルで停止できなかった場合、WMI で検索（5秒タイムアウト付き）
if (-not $KilledByPid) {
    try {
        $AgentScript = $AgentEntry
        $job = Start-Job -ScriptBlock {
            param($scriptPath)
            Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
                Where-Object { $_.CommandLine -like "*$scriptPath*" -or $_.CommandLine -like "*devrelay*" } |
                ForEach-Object {
                    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
                    $_.ProcessId
                }
        } -ArgumentList $AgentScript
        $completed = Wait-Job $job -Timeout 5
        if ($completed) {
            $killedPids = Receive-Job $job
            if ($killedPids) {
                $killedPids | ForEach-Object { Write-Host "  既存の Agent を停止しました (PID: $_, WMI)" -ForegroundColor Yellow }
            }
        } else {
            Write-Host "  既存プロセス検索がタイムアウトしました（5秒）— スキップ" -ForegroundColor DarkGray
        }
        Remove-Job $job -Force -ErrorAction SilentlyContinue
    } catch {
        # 初回インストール時は既存プロセスなし — 無視
    }
}

# --- Agent をバックグラウンドで即時起動 ---
$AgentStarted = $false
try {
    # wscript.exe で VBS を実行（ウィンドウなしで node が起動する）
    Start-Process -FilePath "wscript.exe" -ArgumentList "`"$VbsPath`""
    Start-Sleep -Seconds 3

    # プロセス確認
    $NodeProcesses = Get-Process -Name "node" -ErrorAction SilentlyContinue
    if ($NodeProcesses) {
        $AgentStarted = $true
        Write-Host "  OK Agent をバックグラウンドで起動しました" -ForegroundColor Green
    } else {
        Write-Host "  WARNING: Agent プロセスの確認に失敗（起動中の可能性あり）" -ForegroundColor Yellow
    }
    Write-Host "  ログ: $LogFile" -ForegroundColor Yellow
} catch {
    Write-Host "  X Agent の起動に失敗しました" -ForegroundColor Red
    Write-Host "  手動起動: wscript.exe `"$VbsPath`"" -ForegroundColor Yellow
}

Write-Host ""

# =============================================================================
# 完了
# =============================================================================
Write-Host "+--------------------------------------------------+" -ForegroundColor Green
Write-Host "|  インストール完了！                                  |" -ForegroundColor Green
Write-Host "+--------------------------------------------------+" -ForegroundColor Green
Write-Host ""
Write-Host "  エージェント名:  $MachineName" -ForegroundColor Green
Write-Host "  設定ファイル:    $ConfigFile" -ForegroundColor Green
Write-Host "  サーバーURL:     $ServerUrl" -ForegroundColor Green
if ($ProxyUrl) {
    Write-Host "  プロキシ:        $ProxyUrl" -ForegroundColor Green
    Write-Host "  プロキシ削除:    pnpm config delete proxy && pnpm config delete https-proxy" -ForegroundColor Green
}
Write-Host ""

Write-Host "管理コマンド:" -ForegroundColor Cyan
Write-Host "  ログ確認:        Get-Content `"$LogFile`" -Tail 50 -Encoding UTF8" -ForegroundColor Green
Write-Host "  停止:            tasklist /FI `"IMAGENAME eq node.exe`" /FO CSV 2>`$null | Select-String 'devrelay' | ForEach-Object { if (`$_ -match '`"node\.exe`",`"(\d+)`"') { Stop-Process -Id `$Matches[1] -Force } }" -ForegroundColor Green
Write-Host "  手動起動:        wscript.exe `"$VbsPath`"" -ForegroundColor Green
if ($AutoStartRegistered) {
    $StartupVbsPath = Join-Path ([Environment]::GetFolderPath("Startup")) "DevRelay Agent.vbs"
    Write-Host "  自動起動解除:    Remove-Item `"$StartupVbsPath`"" -ForegroundColor Green
}
Write-Host ""

# 環境変数をクリア（セキュリティ）
$env:DEVRELAY_TOKEN = $null
$env:DEVRELAY_PROXY = $null
$env:DEVRELAY_FORCE = $null
$env:HTTP_PROXY = $null
$env:HTTPS_PROXY = $null

# `irm | iex` 実行時、$ErrorActionPreference の変更が対話セッションに残留しないよう復元
$ErrorActionPreference = $PrevEAP
