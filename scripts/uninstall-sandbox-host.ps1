# =============================================================================
# DevRelay Sandbox Host アンインストーラー（サイクル SB-1a-1、管理者権限必須）
# =============================================================================
# install-sandbox-host.ps1 が作成したサービス・ファイアウォールのルール・
# C:\ProgramData\devrelay\sandbox を削除する。
# =============================================================================

#Requires -RunAsAdministrator

$ServiceName = "devrelay-sandbox"
$ProgramDataDir = "C:\ProgramData\devrelay\sandbox"

Write-Host "=== DevRelay Sandbox Host アンインストール ===" -ForegroundColor Cyan

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    if ($existing.Status -eq "Running") {
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    }
    & sc.exe delete $ServiceName | Out-Null
    Write-Host "✓ サービスを削除しました" -ForegroundColor Green
} else {
    Write-Host "✓ サービスは存在しません" -ForegroundColor Gray
}

$rules = Get-NetFirewallRule -DisplayName "DevRelay Sandbox*" -ErrorAction SilentlyContinue
if ($rules) {
    $rules | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    Write-Host "✓ ファイアウォールのルールを削除しました" -ForegroundColor Green
} else {
    Write-Host "✓ ファイアウォールのルールは存在しません" -ForegroundColor Gray
}

if (Test-Path $ProgramDataDir) {
    Remove-Item -Path $ProgramDataDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "✓ $ProgramDataDir を削除しました" -ForegroundColor Green
} else {
    Write-Host "✓ $ProgramDataDir は存在しません" -ForegroundColor Gray
}

Write-Host ""
Write-Host "=== アンインストール完了 ===" -ForegroundColor Cyan
Write-Host "Agent 側の設定（config.yaml の sandbox セクション・sandbox-token）は削除されません。"
Write-Host "必要であれば devrelay sandbox set-token で再登録、config.yaml を手動編集してください。"
