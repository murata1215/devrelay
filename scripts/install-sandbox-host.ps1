# =============================================================================
# DevRelay Sandbox Host installer (cycle SB-1a-1 / SB-1a-1.1, administrator required)
# =============================================================================
#
# This script is limited to operations that require administrator rights (service
# creation, firewall rule creation). The Agent itself (agents/linux) and its normal
# installer (install-agent.ps1) stay non-admin and are completely separate from this
# script (requirement 4 of the original design).
#
# ASCII ONLY. Windows PowerShell 5.1 reads a file without a BOM using the active
# ANSI code page (CP932 on Japanese Windows), not UTF-8. A BOM-less UTF-8 file that
# contains Japanese text is silently misread and produces ParserError (this exact
# bug was hit on hp630g9 during real-machine verification). Keep every message in
# this file plain ASCII so it can never happen again, regardless of how the file is
# saved. (install-agent.ps1 / uninstall-agent.ps1 are NOT changed by this cycle:
# they are distributed via "irm | iex", which decodes the script as a UTF-8 string
# before execution and therefore does not hit this bug today. Changing them is out
# of scope for this cycle; see the devlog for the investigation note.)
#
# Usage (in an administrator PowerShell):
#   cd <path to this repo clone>
#   .\scripts\install-sandbox-host.ps1
#
# What this script does:
#   1. Stop and remove any existing devrelay-sandbox service BEFORE building, and wait
#      for the SandboxHost.exe process to actually exit (a locked exe makes csc.exe
#      fail with CS0016).
#   2. Build agents/sandbox-host/SandboxHost.cs with the in-box csc.exe (.NET
#      Framework, no NuGet required).
#   3. Create the devrelay-sandbox service running as the virtual account
#      NT SERVICE\devrelay-sandbox.
#   4. Generate a signing key pair (ECDSA P-256). The private key is saved with an
#      ACL that only the service SID can read; the public key is saved as PEM,
#      world-readable.
#   5. Create firewall rules: block all outbound traffic from the service identity
#      except loopback (IPv4 and IPv6 handled separately; see notes below).
#   6. Create C:\ProgramData\devrelay\sandbox\home (the virtual account's fixed home
#      directory).
#
# Verified on real hardware (hp630g9, Windows 11 / Windows PowerShell 5.1 / Node
# 24.12.0, 2026-11-23):
#   - csc.exe build succeeds with the referenced assemblies.
#   - sc.exe create with obj="NT SERVICE\devrelay-sandbox" (no password= argument)
#     resolves and creates the service. Example resolved SID observed:
#     S-1-5-80-155625040-3701452770-3529234849-117044284-2303438102
#   - New-NetFirewallRule -LocalUser "D:(A;;CC;;;<service SID>)" creates the rule and
#     actually blocks outbound traffic from the service identity (status showed the
#     positive control probe blocked).
#   - New-Object System.Security.Cryptography.ECDsaCng(256) produces a public key
#     blob that round-trips through Node's crypto.createPublicKey() once wrapped in
#     the SubjectPublicKeyInfo PEM prefix below (signature verification reported OK).
#   - IPv6 outbound block requires "::/1","8000::/1" (two half-ranges); "::/0" is
#     rejected by New-NetFirewallRule with "one or more prefixes are invalid".
# =============================================================================

#Requires -RunAsAdministrator

$ErrorActionPreference = "Stop"

# --- constants ---
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
$CliEntry = Join-Path $RepoRoot "agents\linux\dist\cli\index.js"

if (-not (Test-Path $SourcePath)) {
    Write-Error "SandboxHost.cs not found: $SourcePath (run this script from the repo's scripts\ directory)"
    exit 1
}

Write-Host "=== DevRelay Sandbox Host install ===" -ForegroundColor Cyan

# --- Step 1: stop and remove any existing service BEFORE building ---
# Must happen before the build step: if the service is running, SandboxHost.exe is
# locked and csc.exe fails with CS0016 (observed on hp630g9 during re-install).
$existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existingService) {
    Write-Host "Existing service found. Stopping and removing it..." -ForegroundColor Yellow
    if ($existingService.Status -eq "Running") {
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    }
    & sc.exe delete $ServiceName | Out-Null
}

# Wait for the SandboxHost.exe process to actually exit. Service stop does not
# guarantee the process handle is released immediately.
$waited = 0
while ($waited -lt 30) {
    $lockingProcess = Get-Process -Name "SandboxHost" -ErrorAction SilentlyContinue
    if (-not $lockingProcess) { break }
    Start-Sleep -Seconds 1
    $waited++
}
if ($waited -ge 30) {
    Write-Host "WARNING: SandboxHost.exe process did not exit within 30 seconds. The build may fail." -ForegroundColor Yellow
}

# Extra safety net: confirm the exe file itself is not locked (a locked file still
# fails the build with CS0016 even if the process already looks gone).
if (Test-Path $ExePath) {
    try {
        $lockCheckStream = [System.IO.File]::Open($ExePath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        $lockCheckStream.Close()
    } catch {
        Write-Error "SandboxHost.exe at $ExePath is still locked by another process. Stop it and re-run this script."
        exit 1
    }
}

# --- Step 2: create ProgramData directories ---
New-Item -ItemType Directory -Path $ProgramDataDir -Force | Out-Null
New-Item -ItemType Directory -Path $HomeDir -Force | Out-Null
Write-Host "[OK] Created $ProgramDataDir" -ForegroundColor Green

# --- Step 3: locate in-box csc.exe ---
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
    Write-Error "in-box csc.exe not found (.NET Framework 4.x is required)"
    exit 1
}
Write-Host "[OK] csc.exe: $CscPath" -ForegroundColor Green

# --- Step 4: build ---
Write-Host "Building..." -ForegroundColor Blue
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
    Write-Error "Build failed (exit=$LASTEXITCODE)"
    exit 1
}
Write-Host "[OK] Build complete: $ExePath" -ForegroundColor Green

# --- Step 5: create the service (virtual account) ---
# sc.exe syntax is `key= value` (a space is required right after `=`). The `password=`
# argument is intentionally omitted: on Windows PowerShell 5.1, `password= ""` (an
# empty-string argument) is dropped from the argument list entirely, which shifts
# every argument after it and makes sc.exe fail with exit code 1639 (invalid command
# line argument). Virtual accounts do not need a password (LSA manages them), so the
# fix is simply not to pass the argument at all (verified working on hp630g9).
$scCreateOutput = & sc.exe create $ServiceName binPath= "`"$ExePath`"" obj= "$ServiceAccountName" start= auto DisplayName= "DevRelay Sandbox Host" 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: sc create failed (exit=$LASTEXITCODE)" -ForegroundColor Red
    $scCreateOutput | ForEach-Object { Write-Host $_ }
    exit 1
}
Write-Host "[OK] Created service $ServiceName (identity: $ServiceAccountName)" -ForegroundColor Green

# --- Step 6: resolve the virtual account's SID ---
try {
    $sidObj = (New-Object System.Security.Principal.NTAccount($ServiceAccountName)).Translate([System.Security.Principal.SecurityIdentifier])
    $ServiceSid = $sidObj.Value
} catch {
    Write-Error "Could not resolve SID for virtual account $ServiceAccountName : $_"
    exit 1
}
Write-Host "[OK] Service SID: $ServiceSid" -ForegroundColor Green

# --- Step 7: generate the signing key pair (ECDSA P-256) ---
# .NET Framework (csc.exe / Windows PowerShell 5.1) has no Ed25519, so ECDSA P-256 is
# used instead (see agents/linux/src/services/sandbox-attest.ts for details; this is a
# documented deviation from the originally approved Plan).
#
# IMPORTANT: `New-Object ECDsaCng([ECCurve]::NamedCurves.nistP256)` does NOT resolve to
# the constructor overload that takes an ECCurve on Windows PowerShell 5.1 -- it
# silently resolves to a different overload and produces a key that is NOT P-256. The
# resulting public key blob then fails to parse as valid P-256 (Node's
# crypto.createPublicKey() reports ERR_OSSL_EVP_DECODE_ERROR). The fix is to use the
# explicit key-size constructor `ECDsaCng(256)` instead (verified working on hp630g9).
Add-Type -AssemblyName System.Core
$ecdsa = New-Object System.Security.Cryptography.ECDsaCng(256)
$cngKey = $ecdsa.Key
$privBlob = $cngKey.Export([System.Security.Cryptography.CngKeyBlobFormat]::EccPrivateBlob)
$pubBlob = $cngKey.Export([System.Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)
$ecdsa.Dispose()
$cngKey.Dispose()

# Validate the generated public key blob immediately: BCRYPT_ECCKEY_BLOB is an 8-byte
# header (4-byte magic + 4-byte key length, little-endian) followed by X(32) and
# Y(32). Fail loudly here instead of producing a broken key file silently.
if ($pubBlob.Length -ne 72) {
    Write-Error "Generated public key blob has unexpected length: $($pubBlob.Length) bytes (expected 72). Aborting."
    exit 1
}
$expectedMagic = [byte[]](0x45, 0x43, 0x53, 0x31)  # "ECS1" = BCRYPT_ECDSA_PUBLIC_P256_MAGIC
for ($i = 0; $i -lt 4; $i++) {
    if ($pubBlob[$i] -ne $expectedMagic[$i]) {
        Write-Error "Generated public key blob has unexpected magic bytes (not a P-256 key). Aborting."
        exit 1
    }
}
$keyLenField = [BitConverter]::ToUInt32($pubBlob, 4)
if ($keyLenField -ne 32) {
    Write-Error "Generated public key blob has unexpected key length field: $keyLenField (expected 32). Aborting."
    exit 1
}
Write-Host "[OK] Generated ECDSA P-256 key pair (validated blob length and magic)" -ForegroundColor Green

$pointX = $pubBlob[8..39]
$pointY = $pubBlob[40..71]

# Fixed X.509 SubjectPublicKeyInfo prefix (EC P-256, id-ecPublicKey, prime256v1).
$spkiPrefix = [byte[]](0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00)
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

# --- Step 8: save and lock down the keys ---
# If a previous private key file exists, its ACL only grants read access to the
# OLD service SID (from a prior install), so even an administrator cannot overwrite
# or delete it directly. Reset the ACL first, then delete (verified working on
# hp630g9: this unblocks re-install on a machine with a running service and a
# locked key file).
if (Test-Path $PrivKeyPath) {
    & icacls $PrivKeyPath /grant "*S-1-5-32-544:(F)" | Out-Null
    Remove-Item -Path $PrivKeyPath -Force
}

[System.IO.File]::WriteAllBytes($PrivKeyPath, $privBlob)
[System.IO.File]::WriteAllText($PubKeyPath, $pubPem)

# Private key: strip inheritance and restrict to the service SID only (not even the
# developer or Administrators can read it after this point).
& icacls $PrivKeyPath /inheritance:r | Out-Null
& icacls $PrivKeyPath /grant "*$($ServiceSid):(R)" | Out-Null
& icacls $PrivKeyPath /remove:g "*S-1-5-32-545" | Out-Null   # BUILTIN\Users
& icacls $PrivKeyPath /remove:g "*S-1-5-32-544" | Out-Null   # BUILTIN\Administrators (explicit removal after breaking inheritance)
Write-Host "[OK] Saved private key, restricted to the service identity: $PrivKeyPath" -ForegroundColor Green
Write-Host "[OK] Saved public key: $PubKeyPath" -ForegroundColor Green

# --- Step 9: host.json (read by the Agent's `sandbox prep` command for the SID) ---
$hostJson = @{
    serviceName     = $ServiceAccountName
    sid             = $ServiceSid
    protocolVersion = 1
} | ConvertTo-Json
[System.IO.File]::WriteAllText($HostJsonPath, $hostJson)
Write-Host "[OK] Saved host.json: $HostJsonPath" -ForegroundColor Green

# --- Step 10: home directory ACL (Modify for the service identity) ---
& icacls $HomeDir /grant "*$($ServiceSid):(OI)(CI)(M)" | Out-Null

# --- Step 11: firewall rules ---
# Windows Firewall applies Block rules before Allow rules regardless of rule order,
# so a naive "Allow loopback + Block everything" pair risks blocking loopback too.
# This script instead excludes loopback (127.0.0.0/8) from the Block rule's own
# address range (split into two IPv4 ranges).
#
# All three rules target the service identity via -LocalUser with an explicit SDDL
# string (not -Service). -LocalUser "D:(A;;CC;;;<service SID>)" was verified on
# hp630g9 to actually block outbound traffic from the service's child AND
# grandchild processes (status showed the positive control probe blocked). The
# -Service form was never verified and is not used here.
$existingRules = Get-NetFirewallRule -DisplayName "DevRelay Sandbox*" -ErrorAction SilentlyContinue
if ($existingRules) {
    $existingRules | Remove-NetFirewallRule -ErrorAction SilentlyContinue
}

$LocalUserSddl = "D:(A;;CC;;;$ServiceSid)"

New-NetFirewallRule -DisplayName "DevRelay Sandbox - Block IPv4 (except loopback)" `
    -Direction Outbound -LocalUser $LocalUserSddl -Action Block -Protocol Any `
    -RemoteAddress "0.0.0.0-126.255.255.255","128.0.0.0-255.255.255.255" | Out-Null

# IPv6: "::/0" is rejected by New-NetFirewallRule ("one or more address prefixes are
# invalid", HRESULT 0x80070057 on hp630g9). Two half-ranges work instead.
New-NetFirewallRule -DisplayName "DevRelay Sandbox - Block IPv6 (all)" `
    -Direction Outbound -LocalUser $LocalUserSddl -Action Block -Protocol Any `
    -RemoteAddress "::/1","8000::/1" | Out-Null

# Explicit Allow rule (technically redundant since the Block rule above never covers
# loopback, but documents intent and is a safety net if someone widens the Block
# rule's range in the future).
New-NetFirewallRule -DisplayName "DevRelay Sandbox - Allow loopback" `
    -Direction Outbound -LocalUser $LocalUserSddl -Action Allow -Protocol Any `
    -RemoteAddress "127.0.0.0/8" | Out-Null

Write-Host "[OK] Created firewall rules" -ForegroundColor Green

# --- Step 12: start the service ---
Start-Service -Name $ServiceName
Start-Sleep -Seconds 1
$status = (Get-Service -Name $ServiceName).Status
Write-Host "[OK] Service status: $status" -ForegroundColor Green

# --- Step 13: best-effort verification that Node.js can read the public key ---
# This catches a recurrence of the ECDsaCng curve bug (wrong overload -> wrong key)
# right at install time instead of only showing up later as "signature always
# invalid" in `sandbox status`. Failure here is a warning, not a hard stop.
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
    $NodeExe = $nodeCmd.Source
} else {
    $portableNodeExe = Join-Path $env:APPDATA "devrelay\node\node.exe"
    if (Test-Path $portableNodeExe) { $NodeExe = $portableNodeExe } else { $NodeExe = $null }
}
if ($NodeExe) {
    $nodeCheckScript = 'require(''crypto'').createPublicKey(require(''fs'').readFileSync(process.argv[1],''utf8'')); console.log(''OK'')'
    $nodeCheckOutput = & $NodeExe -e $nodeCheckScript $PubKeyPath 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "[OK] Verified the public key is readable by Node.js crypto.createPublicKey()" -ForegroundColor Green
    } else {
        Write-Host "[WARN] Node.js could not read the generated public key: $nodeCheckOutput" -ForegroundColor Yellow
    }
} else {
    Write-Host "[--] Skipped Node.js public-key verification (node.exe not found)" -ForegroundColor Gray
}

# --- Step 14: print next steps as commands that actually run ---
# There is no `devrelay` command on Windows (the Agent's install does not add any
# PATH entry or shim for the CLI; see doc/sandbox for the investigation). Print the
# real node.exe + cli/index.js invocation instead of a bare `devrelay ...` line.
if (-not $NodeExe) { $NodeExe = "node.exe" }

function Format-SandboxCliCommand {
    param([string]$Subcommand, [string]$ProjectPath)
    $cmd = "& `"$NodeExe`" `"$CliEntry`" $Subcommand"
    if ($ProjectPath) {
        $cmd = "$cmd --project `"$ProjectPath`""
    }
    return $cmd
}

Write-Host ""
Write-Host "=== Install complete ===" -ForegroundColor Cyan
Write-Host "Next steps (run in a NORMAL, non-administrator PowerShell, as the developer user):"
Write-Host "  1. Register the Claude token (the one from 'claude setup-token'):"
Write-Host "     $(Format-SandboxCliCommand -Subcommand 'sandbox set-token')" -ForegroundColor Green
Write-Host "  2. Set ACLs on the target project (replace <project-path>):"
Write-Host "     $(Format-SandboxCliCommand -Subcommand 'sandbox prep' -ProjectPath '<project-path>')" -ForegroundColor Green
Write-Host "  3. Run the pre-flight check:"
Write-Host "     $(Format-SandboxCliCommand -Subcommand 'sandbox status' -ProjectPath '<project-path>')" -ForegroundColor Green
