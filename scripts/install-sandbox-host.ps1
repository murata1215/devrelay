# =============================================================================
# DevRelay Sandbox Host インストーラー（サイクル SB-1a-1、管理者権限必須）
# =============================================================================
#
# このスクリプトは管理者権限が必要な操作（サービス作成・ファイアウォールのルール作成）に
# 限定する。Agent 本体（agents/linux）とその通常のインストーラー（install-agent.ps1）は
# 非管理者のままで、本スクリプトとは完全に分離している（要件4）。
#
# 使い方（管理者 PowerShell で）:
#   cd <このリポジトリのクローン先>
#   .\scripts\install-sandbox-host.ps1
#
# 処理内容:
#   1. in-box csc.exe（.NET Framework、NuGet 不要）で agents/sandbox-host/SandboxHost.cs をビルド
#   2. サービス devrelay-sandbox を仮想アカウント NT SERVICE\devrelay-sandbox として作成
#   3. 署名鍵（ECDSA P-256）を生成し、秘密鍵はサービスの SID のみが読める ACL で保存、
#      公開鍵は PEM 形式で誰でも読める場所に保存
#   4. ファイアウォールのルールを作成（当該サービスの Outbound: loopback 以外の IPv4・
#      IPv6 を全て Block。IPv6 を全ブロックする理由は agents/linux 側が中継プロキシへ
#      127.0.0.1 のリテラルで接続させるため、::1 解決による無言ハングを避ける）
#   5. C:\ProgramData\devrelay\sandbox\home（仮想アカウント専用の固定ホームディレクトリ）を作成
#
# 要実機確認（本スクリプトは Windows 上でのみ動作確認できる。推測の部分は devlog に明記する）:
#   - csc.exe の実際のパス・参照アセンブリでのビルド成功
#   - NT SERVICE\devrelay-sandbox の SID 解決・サービス作成の成否
#   - New-NetFirewallRule -Service <name> が実際にサービスの通信を対象にするか
#   - Windows Firewall の「block が allow に優先する」という公表されている挙動
#     （そのため本スクリプトは「loopback を除外した範囲だけを Block する」設計にしており、
#      「loopback を Allow + 全体を Block」という素朴な2ルール構成は採用していない）
# =============================================================================

#Requires -RunAsAdministrator

$ErrorActionPreference = "Stop"

# --- 定数 ---
$ServiceName = "devrelay-sandbox"
$ServiceAccountName = "NT SERVICE\$ServiceName"
$ProgramDataDir = "C:\ProgramData\devrelay\sandbox"
$HomeDir = Join-Path $ProgramDataDir "home"
$ExePath = Join-Path $ProgramDataDir "SandboxHost.exe"
$PrivKeyPath = Join-Path $ProgramDataDir "host-key.priv.blob"
$PubKeyPath = Join-Path $ProgramDataDir "host-key.pub"
$HostJsonPath = Join-Path $ProgramDataDir "host.json"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$SourcePath = Join-Path $RepoRoot "agents\sandbox-host\SandboxHost.cs"

if (-not (Test-Path $SourcePath)) {
    Write-Error "SandboxHost.cs が見つかりません: $SourcePath（このスクリプトはリポジトリの scripts\ から実行してください）"
    exit 1
}

Write-Host "=== DevRelay Sandbox Host インストール ===" -ForegroundColor Cyan

# --- Step 1: ProgramData ディレクトリ作成 ---
New-Item -ItemType Directory -Path $ProgramDataDir -Force | Out-Null
New-Item -ItemType Directory -Path $HomeDir -Force | Out-Null
Write-Host "✓ $ProgramDataDir を作成しました" -ForegroundColor Green

# --- Step 2: in-box csc.exe の検出 ---
function Find-CscPath {
    $candidates = @(
        (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
        (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) { return $c }
    }
    return $null
}
$CscPath = Find-CscPath
if (-not $CscPath) {
    Write-Error "in-box csc.exe が見つかりません（.NET Framework 4.x が必要です）"
    exit 1
}
Write-Host "✓ csc.exe: $CscPath" -ForegroundColor Green

# --- Step 3: ビルド ---
Write-Host "ビルド中..." -ForegroundColor Blue
$buildArgs = @(
    "/nologo",
    "/target:winexe",
    "/out:$ExePath",
    "/r:System.ServiceProcess.dll",
    "/r:System.Web.Extensions.dll",
    "/r:System.Core.dll",
    $SourcePath
)
& $CscPath $buildArgs
if ($LASTEXITCODE -ne 0) {
    Write-Error "ビルドに失敗しました（exit=$LASTEXITCODE）"
    exit 1
}
Write-Host "✓ ビルド完了: $ExePath" -ForegroundColor Green

# --- Step 4: 既存サービスの停止・削除（再インストール対応） ---
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "既存サービスを検出。停止・削除します..." -ForegroundColor Yellow
    if ($existing.Status -eq "Running") {
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    }
    & sc.exe delete $ServiceName | Out-Null
    Start-Sleep -Seconds 1
}

# --- Step 5: サービス作成（仮想アカウント） ---
# sc.exe の構文は `キー= 値`（= の直後にスペース必須）。password= "" は仮想アカウント用
# （パスワード不要。仮想アカウントは LSA が管理する）。
& sc.exe create $ServiceName binPath= "`"$ExePath`"" obj= "$ServiceAccountName" password= "" start= auto DisplayName= "DevRelay Sandbox Host" | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Error "sc create に失敗しました（exit=$LASTEXITCODE）"
    exit 1
}
Write-Host "✓ サービス $ServiceName を作成しました（身元: $ServiceAccountName）" -ForegroundColor Green

# --- Step 6: 仮想アカウントの SID を解決 ---
try {
    $sidObj = (New-Object System.Security.Principal.NTAccount($ServiceAccountName)).Translate([System.Security.Principal.SecurityIdentifier])
    $ServiceSid = $sidObj.Value
} catch {
    Write-Error "仮想アカウント $ServiceAccountName の SID を解決できませんでした: $_"
    exit 1
}
Write-Host "✓ サービス SID: $ServiceSid" -ForegroundColor Green

# --- Step 7: 署名鍵（ECDSA P-256）の生成 ---
# .NET Framework（csc.exe / Windows PowerShell 5.1）には Ed25519 が無いため ECDSA P-256 を使う
# （詳細は agents/linux/src/services/sandbox-attest.ts のコメント参照。Plan からの変更点）。
Add-Type -AssemblyName System.Core
$ecdsa = New-Object System.Security.Cryptography.ECDsaCng([System.Security.Cryptography.ECCurve]::NamedCurves.nistP256)
$cngKey = $ecdsa.Key
$privBlob = $cngKey.Export([System.Security.Cryptography.CngKeyBlobFormat]::EccPrivateBlob)
$pubBlob = $cngKey.Export([System.Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)
$ecdsa.Dispose()
$cngKey.Dispose()

# BCRYPT_ECCKEY_BLOB: 8 バイトヘッダ（magic + keylen）+ X(32) + Y(32) [+ D(32) 秘密鍵のみ]
$pointX = $pubBlob[8..39]
$pointY = $pubBlob[40..71]

# X.509 SubjectPublicKeyInfo の固定プレフィックス（EC P-256, id-ecPublicKey, prime256v1）。
# 要実機確認: Node.js の crypto.createPublicKey() がこの PEM を正しく読めること
# （devrelay sandbox status 実行時、signatureValid の判定を通じて間接的に確認できる。
#  読めない場合は常に signatureValid=false になり fail-closed のまま壊れる＝安全側だが
#  機能しない。実機でこの手順の直後に Node で検証することを推奨）。
$spkiPrefix = [byte[]](0x30,0x59,0x30,0x13,0x06,0x07,0x2a,0x86,0x48,0xce,0x3d,0x02,0x01,0x06,0x08,0x2a,0x86,0x48,0xce,0x3d,0x03,0x01,0x07,0x03,0x42,0x00)
$uncompressedPoint = [byte[]](0x04) + $pointX + $pointY
$derBytes = $spkiPrefix + $uncompressedPoint

function ConvertTo-Pem {
    param([byte[]]$Der, [string]$Label)
    $base64 = [Convert]::ToBase64String($Der)
    $lines = New-Object System.Collections.Generic.List[string]
    for ($i = 0; $i -lt $base64.Length; $i += 64) {
        $len = [Math]::Min(64, $base64.Length - $i)
        $lines.Add($base64.Substring($i, $len))
    }
    return "-----BEGIN $Label-----`n" + ($lines -join "`n") + "`n-----END $Label-----`n"
}

$pubPem = ConvertTo-Pem -Der $derBytes -Label "PUBLIC KEY"

# --- Step 8: 鍵の保存とロックダウン ---
[System.IO.File]::WriteAllBytes($PrivKeyPath, $privBlob)
[System.IO.File]::WriteAllText($PubKeyPath, $pubPem)

# 秘密鍵: 継承を切り、サービス SID のみ読める ACL にする（開発者含め他は読めない）
& icacls $PrivKeyPath /inheritance:r | Out-Null
& icacls $PrivKeyPath /grant "*$($ServiceSid):(R)" | Out-Null
& icacls $PrivKeyPath /remove:g "*S-1-5-32-545" | Out-Null   # BUILTIN\Users
& icacls $PrivKeyPath /remove:g "*S-1-5-32-544" | Out-Null   # BUILTIN\Administrators（継承除去後の明示削除）
Write-Host "✓ 秘密鍵を保存し、サービス身元のみに制限しました: $PrivKeyPath" -ForegroundColor Green
Write-Host "✓ 公開鍵を保存しました: $PubKeyPath" -ForegroundColor Green

# --- Step 9: host.json（Agent 側の devrelay sandbox prep が参照する SID 情報） ---
$hostJson = @{
    serviceName     = $ServiceAccountName
    sid             = $ServiceSid
    protocolVersion = 1
} | ConvertTo-Json
[System.IO.File]::WriteAllText($HostJsonPath, $hostJson)
Write-Host "✓ host.json を保存しました: $HostJsonPath" -ForegroundColor Green

# --- Step 10: home ディレクトリの ACL（サービス身元に Modify） ---
& icacls $HomeDir /grant "*$($ServiceSid):(OI)(CI)(M)" | Out-Null

# --- Step 11: ファイアウォールのルール作成 ---
# Windows Firewall は「block が allow より優先される」ため、素朴な「loopback を Allow +
# 全体を Block」の2ルール構成では loopback も block されてしまう恐れがある。
# そのため Block ルールの対象範囲そのものから loopback（127.0.0.0/8）を除外する
# （0.0.0.0-126.255.255.255 と 128.0.0.0-255.255.255.255 の2レンジに分割）。
$existingRules = Get-NetFirewallRule -DisplayName "DevRelay Sandbox*" -ErrorAction SilentlyContinue
if ($existingRules) {
    $existingRules | Remove-NetFirewallRule -ErrorAction SilentlyContinue
}

New-NetFirewallRule -DisplayName "DevRelay Sandbox - Block IPv4 (except loopback)" `
    -Direction Outbound -Service $ServiceName -Action Block -Protocol Any `
    -RemoteAddress "0.0.0.0-126.255.255.255","128.0.0.0-255.255.255.255" | Out-Null

New-NetFirewallRule -DisplayName "DevRelay Sandbox - Block IPv6 (all)" `
    -Direction Outbound -Service $ServiceName -Action Block -Protocol Any `
    -RemoteAddress "::/0" | Out-Null

# 明示的な Allow ルール（技術的には Step 上の Block ルールが loopback を含まないため冗長だが、
# 意図を明文化し、将来誰かが Block ルールの範囲を誤って広げた際の保険にする）。
New-NetFirewallRule -DisplayName "DevRelay Sandbox - Allow loopback" `
    -Direction Outbound -Service $ServiceName -Action Allow -Protocol Any `
    -RemoteAddress "127.0.0.0/8" | Out-Null

Write-Host "✓ ファイアウォールのルールを作成しました" -ForegroundColor Green

# --- Step 12: サービス起動 ---
Start-Service -Name $ServiceName
Start-Sleep -Seconds 1
$status = (Get-Service -Name $ServiceName).Status
Write-Host "✓ サービス状態: $status" -ForegroundColor Green

Write-Host ""
Write-Host "=== インストール完了 ===" -ForegroundColor Cyan
Write-Host "次の手順:"
Write-Host "  1. devrelay sandbox set-token  （claude setup-token のトークンを登録）"
Write-Host "  2. devrelay sandbox prep --project <path>  （対象プロジェクトの ACL を設定）"
Write-Host "  3. devrelay sandbox status --project <path>  （実行前確認）"
