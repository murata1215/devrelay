# =============================================================================
# DevRelay Sandbox Host uninstaller (cycle SB-1a-1 / SB-1a-1.1, administrator required)
# =============================================================================
# Removes the service, firewall rules, and C:\ProgramData\devrelay\sandbox created by
# install-sandbox-host.ps1.
#
# ASCII ONLY (see install-sandbox-host.ps1 for why: this script runs as a file, and
# Windows PowerShell 5.1 misreads a BOM-less UTF-8 file containing non-ASCII text as
# the active ANSI code page, which breaks string/quote parsing).
# =============================================================================

#Requires -RunAsAdministrator

$ServiceName = "devrelay-sandbox"
$ProgramDataDir = "C:\ProgramData\devrelay\sandbox"
$PrivKeyPath = Join-Path $ProgramDataDir "host-key.priv.blob"
$FirewallGroup = "DevRelay Sandbox"
$TaskFolder = "\DevRelay"
$TaskName = "apply-sandbox-allowlist"
$TaskPath = "$TaskFolder\$TaskName"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$CliEntry = Join-Path $RepoRoot "agents\linux\dist\cli\index.js"

Write-Host "=== DevRelay Sandbox Host uninstall ===" -ForegroundColor Cyan

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    if ($existing.Status -eq "Running") {
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    }
    & sc.exe delete $ServiceName | Out-Null
    Write-Host "[OK] Removed service" -ForegroundColor Green
} else {
    Write-Host "[OK] Service does not exist" -ForegroundColor Gray
}

# Cycle SB-2.1: remove the allow-destinations reconciler task before removing the
# firewall rules it manages, so nothing can re-trigger it mid-uninstall.
& schtasks /Delete /TN $TaskPath /F 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
    Write-Host "[OK] Removed scheduled task: $TaskPath" -ForegroundColor Green
} else {
    Write-Host "[OK] Scheduled task does not exist: $TaskPath" -ForegroundColor Gray
}
try {
    $scheduleService = New-Object -ComObject "Schedule.Service"
    $scheduleService.Connect()
    $rootFolder = $scheduleService.GetFolder("\")
    $rootFolder.DeleteFolder($TaskFolder.TrimStart('\'), 0)
    Write-Host "[OK] Removed task folder: $TaskFolder" -ForegroundColor Green
} catch {
    # Best-effort only: the folder may not exist, may still contain other tasks,
    # or COM may be unavailable. None of these are failures worth stopping for.
}

# Full removal: DisplayName wildcard catches pre-SB-2.1 installs (no -Name/-Group
# was ever set on their rules); -Group catches every rule from cycle SB-2.1 onward
# (the two static rules AND any apply-sandbox-allowlist.ps1 generation still live).
$rules = @(Get-NetFirewallRule -DisplayName "DevRelay Sandbox*" -ErrorAction SilentlyContinue) +
         @(Get-NetFirewallRule -Group $FirewallGroup -ErrorAction SilentlyContinue)
if ($rules) {
    $rules | Sort-Object -Property Name -Unique | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    Write-Host "[OK] Removed firewall rules" -ForegroundColor Green
} else {
    Write-Host "[OK] No firewall rules to remove" -ForegroundColor Gray
}

# The private key file's ACL only grants read access to the service SID, so even an
# administrator cannot delete C:\ProgramData\devrelay\sandbox recursively without
# first resetting that ACL (same issue the installer hits on re-install).
if (Test-Path $PrivKeyPath) {
    try {
        & icacls $PrivKeyPath /grant "*S-1-5-32-544:(F)" | Out-Null
    } catch {
        # best-effort; the Remove-Item below will report the real failure if this did not help
    }
}

if (Test-Path $ProgramDataDir) {
    Remove-Item -Path $ProgramDataDir -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path $ProgramDataDir) {
        Write-Host "[WARN] Could not fully remove $ProgramDataDir (check for locked files)" -ForegroundColor Yellow
    } else {
        Write-Host "[OK] Removed $ProgramDataDir" -ForegroundColor Green
    }
} else {
    Write-Host "[OK] $ProgramDataDir does not exist" -ForegroundColor Gray
}

$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($NodeCmd) {
    $NodeExe = $NodeCmd.Source
} else {
    $portableNodeExe = Join-Path $env:APPDATA "devrelay\node\node.exe"
    if (Test-Path $portableNodeExe) { $NodeExe = $portableNodeExe } else { $NodeExe = "node.exe" }
}

Write-Host ""
Write-Host "=== Uninstall complete ===" -ForegroundColor Cyan
Write-Host "Agent-side settings (config.yaml's sandbox section, sandbox-token) are not removed."
Write-Host "If needed, re-register the token (run in a NORMAL, non-administrator PowerShell):"
Write-Host "  & `"$NodeExe`" `"$CliEntry`" sandbox set-token" -ForegroundColor Green
Write-Host "or edit config.yaml by hand."
