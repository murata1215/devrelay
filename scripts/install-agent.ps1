# =============================================================================
# DevRelay Agent Windows ワンライナーインストーラー
# =============================================================================
#
# 使い方:
#   $env:DEVRELAY_TOKEN="YOUR_TOKEN"; irm https://raw.githubusercontent.com/murata1215/devrelay/main/scripts/install-agent.ps1 | iex
#
# 前提条件:
#   - Node.js 20+
#   - git
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

# --- トークン取得 ---
$Token = $env:DEVRELAY_TOKEN
$ServerUrl = "wss://devrelay.io/ws/agent"

if (-not $Token) {
    Write-Host ""
    Write-Host "ERROR: DEVRELAY_TOKEN が設定されていません" -ForegroundColor Red
    Write-Host ""
    Write-Host "使い方:" -ForegroundColor Yellow
    Write-Host '  $env:DEVRELAY_TOKEN="YOUR_TOKEN"; irm https://raw.githubusercontent.com/murata1215/devrelay/main/scripts/install-agent.ps1 | iex'
    Write-Host ""
    Write-Host "トークンは WebUI のエージェント作成画面で取得できます。"
    exit 1
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

# =============================================================================
# Step 1: 依存ツール確認
# =============================================================================
Write-Host "[1/6] 依存ツールを確認中..."

$Missing = 0

# Node.js チェック
$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCmd) {
    Write-Host "  X Node.js 20 以上が必要です" -ForegroundColor Red
    Write-Host "    インストール: winget install OpenJS.NodeJS.LTS" -ForegroundColor Yellow
    Write-Host "    または: https://nodejs.org" -ForegroundColor Yellow
    $Missing++
} else {
    $NodeVersion = (node -v) -replace '^v', ''
    $NodeMajor = [int]($NodeVersion.Split('.')[0])
    if ($NodeMajor -lt 20) {
        Write-Host "  X Node.js 20 以上が必要です（現在: v$NodeVersion）" -ForegroundColor Red
        Write-Host "    アップグレード: winget install OpenJS.NodeJS.LTS" -ForegroundColor Yellow
        $Missing++
    } else {
        Write-Host "  OK Node.js v$NodeVersion" -ForegroundColor Green
    }
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

# pnpm チェック（未インストールなら自動インストール）
$PnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $PnpmCmd) {
    # Node.js がある場合のみ自動インストールを試みる
    if ($NodeCmd) {
        Write-Host "  pnpm をインストール中..." -ForegroundColor Yellow
        try {
            # cmd /c 経由で npm.cmd を直接呼び出し（npm.ps1 の ExecutionPolicy 問題を回避）
            cmd /c "npm install -g pnpm" 2>$null
            $PnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
        } catch {}
    }
    if (-not $PnpmCmd) {
        Write-Host "  X pnpm が必要です" -ForegroundColor Red
        Write-Host "    インストール: npm install -g pnpm" -ForegroundColor Yellow
        $Missing++
    } else {
        $PnpmVersion = pnpm -v
        Write-Host "  OK pnpm $PnpmVersion (自動インストール)" -ForegroundColor Green
    }
} else {
    $PnpmVersion = pnpm -v
    Write-Host "  OK pnpm $PnpmVersion" -ForegroundColor Green
}

# 不足ツールがあれば終了
if ($Missing -gt 0) {
    Write-Host ""
    Write-Host "上記 $Missing 件のツールをインストールしてから再実行してください。" -ForegroundColor Red
    exit 1
}

Write-Host "OK 依存ツール OK" -ForegroundColor Green
Write-Host ""

# =============================================================================
# Step 2: リポジトリ取得
# =============================================================================
Write-Host "[2/6] リポジトリを取得中..."

# ディレクトリ作成
New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
New-Item -ItemType Directory -Path $BinDir -Force | Out-Null

if (Test-Path (Join-Path $AgentDir ".git")) {
    # 既存なら最新に更新
    Write-Host "  既存のリポジトリを更新中..."
    Push-Location $AgentDir
    try {
        git pull --quiet 2>$null
    } catch {
        Write-Host "  WARNING: git pull に失敗。既存のコードで続行します" -ForegroundColor Yellow
    }
    Pop-Location
} else {
    # 新規 clone
    Write-Host "  クローン中... (初回は時間がかかります)"
    git clone --quiet --depth 1 $RepoUrl $AgentDir
}

Write-Host "OK リポジトリ取得完了" -ForegroundColor Green
Write-Host ""

# =============================================================================
# Step 3: ビルド
# =============================================================================
Write-Host "[3/6] ビルド中..."

Push-Location $AgentDir

Write-Host "  依存関係をインストール中..."
try {
    pnpm install --frozen-lockfile 2>$null
} catch {
    pnpm install
}

Write-Host "  shared パッケージをビルド中..."
pnpm --filter @devrelay/shared build

Write-Host "  Agent をビルド中..."
pnpm --filter @devrelay/agent build

Pop-Location

Write-Host "OK ビルド完了" -ForegroundColor Green
Write-Host ""

# =============================================================================
# Step 4: config.yaml 生成
# =============================================================================
Write-Host "[4/6] 設定ファイルを生成中..."

$MachineName = "$env:COMPUTERNAME/$env:USERNAME"

if (Test-Path $ConfigFile) {
    Write-Host "  WARNING: config.yaml が既に存在します。トークンのみ更新します" -ForegroundColor Yellow
    # 既存ファイルのトークンを更新
    $Content = Get-Content $ConfigFile -Raw
    if ($Content -match "(?m)^token:") {
        $Content = $Content -replace '(?m)^token:.*', "token: `"$Token`""
    } else {
        $Content += "`ntoken: `"$Token`""
    }
    Set-Content -Path $ConfigFile -Value $Content -Encoding UTF8
} else {
    # 新規作成
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
  default: claude
  claude:
    command: claude
  gemini:
    command: gemini
logLevel: info
"@
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

$AgentEntry = Join-Path $AgentDir "agents\linux\dist\index.js"
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
Write-Host ""

Write-Host "管理コマンド:" -ForegroundColor Cyan
Write-Host "  ログ確認:        Get-Content `"$LogFile`" -Tail 50" -ForegroundColor Green
Write-Host "  停止:            Get-Process node | Where-Object { `$_.Path -like '*devrelay*' } | Stop-Process" -ForegroundColor Green
Write-Host "  手動起動:        wscript.exe `"$VbsPath`"" -ForegroundColor Green
if ($AutoStartRegistered) {
    $StartupVbsPath = Join-Path ([Environment]::GetFolderPath("Startup")) "DevRelay Agent.vbs"
    Write-Host "  自動起動解除:    Remove-Item `"$StartupVbsPath`"" -ForegroundColor Green
}
Write-Host ""

# トークン環境変数をクリア（セキュリティ）
$env:DEVRELAY_TOKEN = $null
