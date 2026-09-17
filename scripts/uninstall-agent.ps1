# =============================================================================
# DevRelay Agent 完全アンインストールスクリプト（Windows）
# =============================================================================
#
# 使い方:
#   irm https://raw.githubusercontent.com/murata1215/devrelay/main/scripts/uninstall-agent.ps1 | iex
#
# 既定はドライラン相当です。まず削除対象の一覧だけを表示し、確認プロンプトで y を
# 入力するまで何も削除しません。事前に確認を省略したい場合は
#   $env:DEVRELAY_UNINSTALL_YES="1"
# を設定してから実行してください。
#
# 環境変数:
#   DEVRELAY_UNINSTALL_YES             "1" なら確認プロンプトをスキップして即削除
#   DEVRELAY_UNINSTALL_GUI             "1" なら GUI版（Electron）のアンインストールも無人実行
#   DEVRELAY_UNINSTALL_PROJECT_DATA    "1" なら各プロジェクト内の .devrelay\ も削除（既定は残す）
#
# 削除対象:
#   - devrelay 関連プロセス（node.exe/Electron/wscript.exe 問わず、実行中のものすべて）
#   - 自動起動（Startup フォルダの VBS / タスクスケジューラ / レジストリ Run キー）
#   - %APPDATA%\devrelay\ 一式（設定・ログ・Agent のリポジトリ clone・portable node を含む）
#   - ~\.claude\skills\devrelay-*（Agent 起動時に再生成されるもの）
#   - GUI版（Electron）本体（検出時のみ・確認の上でアンインストール）
#
# 削除しないもの:
#   - ユーザーのソースコード・git リポジトリ
#   - Claude Code / Devin CLI 本体
#   - ~\.claude\ の devrelay-* 以外のファイル
#   - 各プロジェクトの .devrelay\（DEVRELAY_UNINSTALL_PROJECT_DATA=1 のときのみ削除）
#
# このスクリプトはトークンを一切表示しません。
# =============================================================================

$ErrorActionPreference = "Stop"
$PrevEAP = $ErrorActionPreference

$Yes = $env:DEVRELAY_UNINSTALL_YES -eq "1" -or $env:DEVRELAY_UNINSTALL_YES -eq "true"
$UninstallGui = $env:DEVRELAY_UNINSTALL_GUI -eq "1" -or $env:DEVRELAY_UNINSTALL_GUI -eq "true"
$PurgeProjectData = $env:DEVRELAY_UNINSTALL_PROJECT_DATA -eq "1" -or $env:DEVRELAY_UNINSTALL_PROJECT_DATA -eq "true"

$ConfigDir = Join-Path $env:APPDATA "devrelay"
$ConfigFile = Join-Path $ConfigDir "config.yaml"
$LogFile = Join-Path $ConfigDir "logs\agent.log"
$StartupDir = [Environment]::GetFolderPath("Startup")
$StartupVbs = Join-Path $StartupDir "DevRelay Agent.vbs"
$TaskName = "DevRelay Agent"
$SkillsDir = Join-Path $env:USERPROFILE ".claude\skills"
$SkillNames = @(
    "devrelay-docs", "devrelay-ask-member", "devrelay-read-messages",
    "devrelay-list-inventory", "devrelay-create-project", "devrelay-flutter-deploy"
)
# devrelay 系プロセスを止める際、自分自身（このスクリプトを実行している PowerShell ホスト）を
# 誤って殺さないための除外リスト（G1）。irm | iex で起動したプロセスの CommandLine にも
# "devrelay"（スクリプト URL）が含まれるため、ProcessId 自体の除外だけでは不十分。
$SelfExcludeNames = @("powershell.exe", "pwsh.exe", "WindowsTerminal.exe", "conhost.exe")

Write-Host ""
Write-Host "+--------------------------------------------------+" -ForegroundColor Red
Write-Host "|  DevRelay Agent 完全アンインストール                |" -ForegroundColor Red
Write-Host "+--------------------------------------------------+" -ForegroundColor Red
Write-Host ""

# =============================================================================
# [1/6] 削除対象の確認（常に最初に実施。これがドライラン相当）
# =============================================================================
Write-Host "[1/6] 削除対象を確認中..." -ForegroundColor Cyan

$TargetsFound = @()

if (Test-Path $ConfigDir) { $TargetsFound += "設定/ログ/Agent本体: $ConfigDir" }
if (Test-Path $StartupVbs) { $TargetsFound += "自動起動 (Startup): $StartupVbs" }

$TaskExists = $false
try {
    schtasks /Query /TN $TaskName 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
        $TaskExists = $true
        $TargetsFound += "タスクスケジューラ: $TaskName"
    }
} catch {}

$RunKeyPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$RunKeyEntries = @()
try {
    $RunProps = Get-ItemProperty -Path $RunKeyPath -EA SilentlyContinue
    if ($RunProps) {
        foreach ($prop in $RunProps.PSObject.Properties) {
            if ($prop.Name -notlike "PS*" -and "$($prop.Value)" -like "*devrelay*") {
                $RunKeyEntries += $prop.Name
                $TargetsFound += "自動起動 (レジストリ Run): $($prop.Name)"
            }
        }
    }
} catch {}

$SkillsFound = @()
foreach ($name in $SkillNames) {
    $p = Join-Path $SkillsDir $name
    if (Test-Path $p) {
        $SkillsFound += $p
        $TargetsFound += "スキル: $p"
    }
}

$RunningProcs = @()
try {
    $RunningProcs = Get-CimInstance Win32_Process -EA Stop | Where-Object {
        $_.CommandLine -and $_.CommandLine -like "*devrelay*" -and
        $_.ProcessId -ne $PID -and
        $_.Name -notin $SelfExcludeNames
    }
} catch {
    Write-Host "  WARNING: プロセス一覧の取得に失敗しました（続行します）" -ForegroundColor Yellow
}
foreach ($p in $RunningProcs) {
    $cmdShort = if ($p.CommandLine -and $p.CommandLine.Length -gt 100) { $p.CommandLine.Substring(0, 100) + "..." } else { $p.CommandLine }
    $TargetsFound += "プロセス: PID=$($p.ProcessId) $($p.Name) [$cmdShort]"
}

# GUI版（Electron / NSIS、appId=io.devrelay.agent）の検出
$GuiUninstallString = $null
$GuiDisplayName = $null
$UninstallRoots = @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
)
foreach ($root in $UninstallRoots) {
    try {
        $entries = Get-ItemProperty -Path $root -EA SilentlyContinue | Where-Object {
            $_.DisplayName -eq "DevRelay Agent" -or $_.PSChildName -like "*io.devrelay.agent*"
        }
        foreach ($e in $entries) {
            if ($e.UninstallString) {
                $GuiUninstallString = $e.UninstallString
                $GuiDisplayName = $e.DisplayName
                $TargetsFound += "GUI版アンインストーラ: $($e.DisplayName) ($($e.UninstallString))"
            }
        }
    } catch {}
}

if ($TargetsFound.Count -eq 0) {
    Write-Host "  削除対象は見つかりませんでした（すでにクリーンな状態です）" -ForegroundColor Green
    Write-Host ""
    $ErrorActionPreference = $PrevEAP
    return
}

Write-Host ""
Write-Host "以下を削除します:" -ForegroundColor Yellow
foreach ($t in $TargetsFound) { Write-Host "  - $t" -ForegroundColor Gray }
Write-Host ""
Write-Host "削除しないもの: プロジェクトのソースコード / git リポジトリ / Claude Code・Devin CLI 本体" -ForegroundColor DarkGray
if (-not $PurgeProjectData) {
    Write-Host "各プロジェクト内の .devrelay\ フォルダは残します（削除するには DEVRELAY_UNINSTALL_PROJECT_DATA=1）" -ForegroundColor DarkGray
}
Write-Host ""

if (-not $Yes) {
    $Confirm = Read-Host "本当に削除しますか？ (y/N)"
    if ($Confirm -notmatch "^[Yy]") {
        Write-Host ""
        Write-Host "中断しました。何も削除していません。" -ForegroundColor Yellow
        $ErrorActionPreference = $PrevEAP
        return
    }
}

# 削除前に projectsDirs を読み取っておく（config.yaml はこの後削除されるため）
$ProjectsDirs = @()
if ($PurgeProjectData -and (Test-Path $ConfigFile)) {
    try {
        $lines = Get-Content $ConfigFile -Encoding UTF8
        $inList = $false
        foreach ($line in $lines) {
            if ($line -match '^projectsDirs:\s*$') { $inList = $true; continue }
            if ($inList) {
                if ($line -match '^\s+-\s+(.+)$') {
                    $ProjectsDirs += $Matches[1].Trim().Trim('"')
                } else {
                    $inList = $false
                }
            }
        }
    } catch {}
    if ($ProjectsDirs.Count -eq 0) { $ProjectsDirs = @($env:USERPROFILE) }
}

# =============================================================================
# [2/6] プロセス停止
# =============================================================================
Write-Host "[2/6] プロセスを停止中..." -ForegroundColor Cyan

$PidFile = Join-Path $ConfigDir "agent.pid"
if (Test-Path $PidFile) {
    try {
        $OldPid = [int](Get-Content $PidFile -EA Stop)
        if ($OldPid -ne $PID) {
            Stop-Process -Id $OldPid -Force -EA SilentlyContinue
            Write-Host "  停止: PID $OldPid (agent.pid)" -ForegroundColor Gray
        }
    } catch {}
}

try {
    $KillTargets = Get-CimInstance Win32_Process -EA Stop | Where-Object {
        $_.CommandLine -and $_.CommandLine -like "*devrelay*" -and
        $_.ProcessId -ne $PID -and
        $_.Name -notin $SelfExcludeNames
    }
    foreach ($p in $KillTargets) {
        Stop-Process -Id $p.ProcessId -Force -EA SilentlyContinue
        Write-Host "  停止: PID $($p.ProcessId) $($p.Name)" -ForegroundColor Gray
    }
} catch {
    Write-Host "  WARNING: プロセス一覧の取得に失敗しました（続行します）" -ForegroundColor Yellow
}
Start-Sleep -Seconds 2

# =============================================================================
# [3/6] 自動起動の解除
# =============================================================================
Write-Host "[3/6] 自動起動を解除中..." -ForegroundColor Cyan

if (Test-Path $StartupVbs) {
    Remove-Item $StartupVbs -Force -EA SilentlyContinue
    Write-Host "  OK Startup フォルダのエントリを削除" -ForegroundColor Green
}

if ($TaskExists) {
    try {
        schtasks /Delete /TN $TaskName /F 2>$null | Out-Null
        Write-Host "  OK タスクスケジューラのエントリを削除" -ForegroundColor Green
    } catch {
        Write-Host "  WARNING: タスクスケジューラの削除に失敗しました" -ForegroundColor Yellow
    }
}

foreach ($name in $RunKeyEntries) {
    try {
        Remove-ItemProperty -Path $RunKeyPath -Name $name -EA SilentlyContinue
        Write-Host "  OK レジストリ Run キーを削除: $name" -ForegroundColor Green
    } catch {}
}

# =============================================================================
# [4/6] 設定・ログ・Agent本体の削除（ログは削除前に退避）
# =============================================================================
Write-Host "[4/6] 設定・ログ・Agent本体を削除中..." -ForegroundColor Cyan

if (Test-Path $LogFile) {
    try {
        $Stamp = Get-Date -Format "yyyyMMdd_HHmmss"
        $BackupLog = Join-Path $env:TEMP "devrelay-agent-$Stamp.log"
        Copy-Item -Path $LogFile -Destination $BackupLog -Force
        Write-Host "  ログを退避しました: $BackupLog" -ForegroundColor Yellow
    } catch {}
}

# G2: カレントディレクトリが削除対象の配下だと Remove-Item が失敗するため、先に退避する
try { Set-Location $env:USERPROFILE } catch {}

if (Test-Path $ConfigDir) {
    Remove-Item -Path $ConfigDir -Recurse -Force -EA SilentlyContinue
    if (-not (Test-Path $ConfigDir)) {
        Write-Host "  OK $ConfigDir を削除" -ForegroundColor Green
    } else {
        Write-Host "  WARNING: 一部削除できませんでした（プロセスが残っている可能性があります）。手動確認してください: $ConfigDir" -ForegroundColor Yellow
    }
}

foreach ($p in $SkillsFound) {
    Remove-Item -Path $p -Recurse -Force -EA SilentlyContinue
}
if ($SkillsFound.Count -gt 0) { Write-Host "  OK devrelay-* skills を削除" -ForegroundColor Green }

# =============================================================================
# [5/6] GUI版（Electron）のアンインストール
# =============================================================================
Write-Host "[5/6] GUI版（Electron）を確認中..." -ForegroundColor Cyan

if ($GuiUninstallString) {
    $RunGuiUninstall = $UninstallGui
    if (-not $RunGuiUninstall -and -not $Yes) {
        $GuiConfirm = Read-Host "GUI版（$GuiDisplayName）のインストールが見つかりました。アンインストールしますか？ (y/N)"
        $RunGuiUninstall = $GuiConfirm -match "^[Yy]"
    }
    if ($RunGuiUninstall) {
        try {
            if ($GuiUninstallString -match '^"([^"]+)"(.*)$') {
                $ExePath = $Matches[1]
                $RestArgs = $Matches[2].Trim()
            } else {
                $Parts = $GuiUninstallString.Split(" ", 2)
                $ExePath = $Parts[0]
                $RestArgs = if ($Parts.Length -gt 1) { $Parts[1] } else { "" }
            }
            Start-Process -FilePath $ExePath -ArgumentList "$RestArgs /S" -Wait -EA Stop
            Write-Host "  OK GUI版をアンインストールしました" -ForegroundColor Green
        } catch {
            Write-Host "  WARNING: GUI版の自動アンインストールに失敗しました。「アプリと機能」から手動削除してください。" -ForegroundColor Yellow
        }
    } else {
        Write-Host "  スキップしました（「アプリと機能」から手動削除できます）" -ForegroundColor Gray
    }
} else {
    Write-Host "  OK GUI版は見つかりませんでした" -ForegroundColor Green
}

# =============================================================================
# [6/6] プロジェクトデータの削除（任意・既定はスキップ）
# =============================================================================
if ($PurgeProjectData -and $ProjectsDirs.Count -gt 0) {
    Write-Host "[6/6] プロジェクト内の .devrelay\ を削除中..." -ForegroundColor Cyan
    foreach ($baseDir in $ProjectsDirs) {
        if (-not (Test-Path $baseDir)) { continue }
        try {
            $dirs = Get-ChildItem -Path $baseDir -Filter ".devrelay" -Directory -Recurse -Depth 5 -EA SilentlyContinue
            foreach ($d in $dirs) {
                Remove-Item -Path $d.FullName -Recurse -Force -EA SilentlyContinue
                Write-Host "  削除: $($d.FullName)" -ForegroundColor Gray
            }
        } catch {}
    }
} else {
    Write-Host "[6/6] プロジェクトデータはスキップ（既定。削除するには DEVRELAY_UNINSTALL_PROJECT_DATA=1）" -ForegroundColor Gray
}

# =============================================================================
# 残留チェック（報告のみ・削除しない — 別インストールの物証になる）
# =============================================================================
Write-Host ""
Write-Host "残留チェック（このマシン上の別インストールの可能性。削除はしません）:" -ForegroundColor Cyan

$ResidualFound = $false
$ResidualPaths = @(
    (Join-Path $env:LOCALAPPDATA "devrelay"),
    (Join-Path $env:USERPROFILE ".devrelay")
)
foreach ($rp in $ResidualPaths) {
    if (Test-Path $rp) {
        Write-Host "  WARNING: $rp が見つかりました" -ForegroundColor Yellow
        $ResidualFound = $true
    }
}
try {
    $OtherProfiles = Get-ChildItem "C:\Users" -Directory -EA SilentlyContinue | Where-Object { $_.Name -ne $env:USERNAME }
    foreach ($prof in $OtherProfiles) {
        $p = Join-Path $prof.FullName "AppData\Roaming\devrelay"
        if (Test-Path $p) {
            Write-Host "  WARNING: 別ユーザープロファイルに見つかりました: $p" -ForegroundColor Yellow
            $ResidualFound = $true
        }
    }
} catch {}
try {
    if (Get-Command wsl -EA SilentlyContinue) {
        wsl -l -q 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  WSL が検出されました。WSL 内の ~/.devrelay は別途確認してください（このスクリプトの対象外です）。" -ForegroundColor Yellow
        }
    }
} catch {}
if (-not $ResidualFound) {
    Write-Host "  OK 他の場所への残留は見つかりませんでした" -ForegroundColor Green
}

Write-Host ""
Write-Host "+--------------------------------------------------+" -ForegroundColor Green
Write-Host "|  アンインストール完了                              |" -ForegroundColor Green
Write-Host "+--------------------------------------------------+" -ForegroundColor Green
Write-Host ""
Write-Host "再インストールする場合:"
Write-Host "  - 別の PC に同じトークンの Agent が残っていない場合は、WebUI でトークンを再表示し"
Write-Host "    同じトークンで入れ直せば、これまでの履歴・プロジェクトを引き継げます。"
Write-Host "  - 別の PC に同じトークンの Agent が残っている可能性がある場合は、WebUI で該当マシンを"
Write-Host "    削除してトークンを無効化し、新しいトークンを発行してから入れ直してください。"
Write-Host "    （1 台 1 トークンを徹底してください。使い回すと今回と同じ事故が再発します）"
Write-Host ""

$ErrorActionPreference = $PrevEAP
