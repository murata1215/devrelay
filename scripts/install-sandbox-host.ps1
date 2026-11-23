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

# Cycle SB-2.1: -DeveloperAccount names the single non-administrator account that
# may trigger the allow-destinations reconciler task (schtasks /Run, from the
# Agent). Defaults to whoever is running this install script (common case: a
# single-developer machine where the developer is also the local administrator).
# -DenyDestination is an administrator-set denylist (upstream proxy etc.); it is
# recorded into allowlist-deny\deny.json and is never readable by the developer
# account, let alone the Sandbox identity. Both are optional; omitting them keeps
# this script's behavior unchanged from before cycle SB-2.1 except for the
# allow-destinations plumbing itself (which defaults to "nothing allowed").
param(
    [string]$DeveloperAccount = "",
    [string[]]$DenyDestination = @()
)

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

# Cycle SB-2.1: allow-destinations (IP and port) plumbing.
$AllowlistRequestDir = Join-Path $ProgramDataDir "allowlist-request"
$AllowlistResultDir = Join-Path $ProgramDataDir "allowlist-result"
$AllowlistDenyDir = Join-Path $ProgramDataDir "allowlist-deny"
$AllowlistBinDir = Join-Path $ProgramDataDir "allowlist-bin"
$RequestJsonPath = Join-Path $AllowlistRequestDir "request.json"
$StateJsonPath = Join-Path $AllowlistResultDir "state.json"
$DenyJsonPath = Join-Path $AllowlistDenyDir "deny.json"
$ApplyScriptDestPath = Join-Path $AllowlistBinDir "apply-allowlist.ps1"
$FirewallGroup = "DevRelay Sandbox"
# Cycle SB-2.1.2: fixed name for the fail-closed IPv4 rule this script
# creates before ever invoking apply-sandbox-allowlist.ps1, and that script
# removes once (and only once) its own new generation is fully created.
# Must stay byte-identical to the same literal in apply-sandbox-allowlist.ps1
# (guarded by sandbox-scripts-guard.test.mjs E2/E3).
$FailClosedRuleName = "DevRelay-SandboxFailClosed-ipv4"
$TaskFolder = "\DevRelay"
$TaskName = "apply-sandbox-allowlist"
$TaskPath = "$TaskFolder\$TaskName"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$SourcePath = Join-Path $RepoRoot "agents\sandbox-host\SandboxHost.cs"
$CliEntry = Join-Path $RepoRoot "agents\linux\dist\cli\index.js"
$ApplyScriptSourcePath = Join-Path $RepoRoot "scripts\apply-sandbox-allowlist.ps1"

if (-not (Test-Path $SourcePath)) {
    Write-Error "SandboxHost.cs not found: $SourcePath (run this script from the repo's scripts\ directory)"
    exit 1
}
if (-not (Test-Path $ApplyScriptSourcePath)) {
    Write-Error "apply-sandbox-allowlist.ps1 not found: $ApplyScriptSourcePath (run this script from the repo's scripts\ directory)"
    exit 1
}

Write-Host "=== DevRelay Sandbox Host install ===" -ForegroundColor Cyan

# --- resolve the developer account that may trigger the allow-destinations task ---
if ($DeveloperAccount) {
    try {
        $DeveloperSid = (New-Object System.Security.Principal.NTAccount($DeveloperAccount)).Translate([System.Security.Principal.SecurityIdentifier]).Value
    } catch {
        Write-Error "Could not resolve -DeveloperAccount '$DeveloperAccount': $_"
        exit 1
    }
} else {
    try {
        $currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        $DeveloperAccount = $currentIdentity.Name
        $DeveloperSid = $currentIdentity.User.Value
    } catch {
        Write-Error "Could not resolve the current user as the default developer account: $_"
        exit 1
    }
}
Write-Host "[OK] Developer account for the allow-destinations task: $DeveloperAccount ($DeveloperSid)" -ForegroundColor Green

# =============================================================================
# Cycle SB-2.1.1: shared native-command helper.
#
# Windows PowerShell 5.1 turns an external command's stderr output into a
# terminating NativeCommandError whenever $ErrorActionPreference = "Stop" is
# in effect (set above). Redirecting with "2>$null" does NOT prevent this --
# the ErrorRecord is produced before the redirect discards it. This exact bug
# was hit on hp630g9: "schtasks /Delete" on a non-existent task (the normal
# case on first install) terminated the whole script right after the
# "[OK] Saved deny.json" message, before the task was ever registered.
#
# Fix: every external command in this file is invoked through this helper,
# which temporarily sets $ErrorActionPreference = "Continue" around the call,
# resets $LASTEXITCODE first (a stale value survives if the command is not
# found), and collects both streams via "2>&1" manually instead of relying on
# ErrorActionPreference to decide what counts as fatal. -AllowFailure marks
# calls where a non-zero exit is an expected, non-fatal outcome (for example:
# deleting a service or task that may not exist yet). Calls made without
# -AllowFailure stop the script on failure (matching the original intent of
# $ErrorActionPreference = "Stop", but now only for conditions that actually
# warrant stopping).
#
# Must stay byte-identical between install-sandbox-host.ps1 and
# uninstall-sandbox-host.ps1 (see sandbox-scripts-guard.test.mjs D4). Not
# dot-sourced from a shared file because apply-sandbox-allowlist.ps1 is copied
# standalone into allowlist-bin\ and cannot depend on a sibling file.
# =============================================================================
# >>> SB-2.1.1 shared helper (keep byte-identical in install/uninstall-sandbox-host.ps1) >>>
function Invoke-NativeCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][scriptblock]$Command,
        [switch]$AllowFailure
    )
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $global:LASTEXITCODE = 0
    $lines = New-Object System.Collections.Generic.List[string]
    $code = 0
    try {
        & $Command 2>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) { $lines.Add($_.ToString()) }
            else { $lines.Add([string]$_) }
        }
        $code = $LASTEXITCODE
    } catch {
        $lines.Add("EXCEPTION: $($_.Exception.Message)")
        $code = 1
    } finally {
        $ErrorActionPreference = $prevEap
    }
    if ($null -eq $code) { $code = 0 }
    if ($code -ne 0 -and -not $AllowFailure) {
        Write-Host "ERROR: $Label failed (exit=$code)" -ForegroundColor Red
        foreach ($line in $lines) { Write-Host "  $line" }
        exit 1
    }
    return [pscustomobject]@{ ExitCode = $code; Output = @($lines) }
}
# <<< SB-2.1.1 shared helper <<<

# --- Step 1: stop and remove any existing service BEFORE building ---
# Must happen before the build step: if the service is running, SandboxHost.exe is
# locked and csc.exe fails with CS0016 (observed on hp630g9 during re-install).
$existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existingService) {
    Write-Host "Existing service found. Stopping and removing it..." -ForegroundColor Yellow
    if ($existingService.Status -eq "Running") {
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    }
    $null = Invoke-NativeCommand -Label "sc.exe delete (pre-build)" -AllowFailure -Command { & sc.exe delete $ServiceName }
}

# Wait for the service itself to be fully removed (not just stopped). A
# service left in "pending deletion" state makes the later "sc create" call
# fail with exit code 1073. Best-effort: warn and continue if it never clears,
# since "sc create" below will fail loudly on its own if this was the cause.
$serviceWaited = 0
while ($serviceWaited -lt 15) {
    if (-not (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Seconds 1
    $serviceWaited++
}
if ($serviceWaited -ge 15 -and (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) {
    Write-Host "WARNING: service $ServiceName still present after deletion wait. The create step may fail." -ForegroundColor Yellow
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
$null = Invoke-NativeCommand -Label "csc.exe build" -Command { & $CscPath $buildArgs }
Write-Host "[OK] Build complete: $ExePath" -ForegroundColor Green

# --- Step 5: create the service (virtual account) ---
# sc.exe syntax is `key= value` (a space is required right after `=`). The `password=`
# argument is intentionally omitted: on Windows PowerShell 5.1, `password= ""` (an
# empty-string argument) is dropped from the argument list entirely, which shifts
# every argument after it and makes sc.exe fail with exit code 1639 (invalid command
# line argument). Virtual accounts do not need a password (LSA manages them), so the
# fix is simply not to pass the argument at all (verified working on hp630g9).
$scCreateResult = Invoke-NativeCommand -Label "sc.exe create" -AllowFailure -Command { & sc.exe create $ServiceName binPath= "`"$ExePath`"" obj= "$ServiceAccountName" start= auto DisplayName= "DevRelay Sandbox Host" }
if ($scCreateResult.ExitCode -ne 0) {
    Write-Host "ERROR: sc create failed (exit=$($scCreateResult.ExitCode))" -ForegroundColor Red
    $scCreateResult.Output | ForEach-Object { Write-Host $_ }
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
    $null = Invoke-NativeCommand -Label "icacls /grant (reset old private key ACL)" -AllowFailure -Command { & icacls $PrivKeyPath /grant "*S-1-5-32-544:(F)" }
    Remove-Item -Path $PrivKeyPath -Force
}

[System.IO.File]::WriteAllBytes($PrivKeyPath, $privBlob)
[System.IO.File]::WriteAllText($PubKeyPath, $pubPem)

# Private key: strip inheritance and restrict to the service SID only (not even the
# developer or Administrators can read it after this point).
$null = Invoke-NativeCommand -Label "icacls /inheritance:r (private key)" -Command { & icacls $PrivKeyPath /inheritance:r }
$null = Invoke-NativeCommand -Label "icacls /grant service SID (private key)" -Command { & icacls $PrivKeyPath /grant "*$($ServiceSid):(R)" }
$null = Invoke-NativeCommand -Label "icacls /remove:g Users (private key)" -AllowFailure -Command { & icacls $PrivKeyPath /remove:g "*S-1-5-32-545" }   # BUILTIN\Users
$null = Invoke-NativeCommand -Label "icacls /remove:g Administrators (private key)" -AllowFailure -Command { & icacls $PrivKeyPath /remove:g "*S-1-5-32-544" }   # BUILTIN\Administrators (explicit removal after breaking inheritance)
Write-Host "[OK] Saved private key, restricted to the service identity: $PrivKeyPath" -ForegroundColor Green
Write-Host "[OK] Saved public key: $PubKeyPath" -ForegroundColor Green

# --- Step 9: host.json (read by the Agent's `sandbox prep` command for the SID) ---
# reconcilerVersion (cycle SB-2.1) lets the Agent detect a stale apply-allowlist.ps1
# copy under allowlist-bin\ (see sandbox-protocol.ts) independently of this
# protocolVersion, which covers the Sandbox Host handshake only.
$hostJson = @{
    serviceName       = $ServiceAccountName
    sid               = $ServiceSid
    protocolVersion   = 1
    reconcilerVersion = 1
} | ConvertTo-Json
[System.IO.File]::WriteAllText($HostJsonPath, $hostJson)
Write-Host "[OK] Saved host.json: $HostJsonPath" -ForegroundColor Green

# --- Step 10: home directory ACL (Modify for the service identity) ---
$null = Invoke-NativeCommand -Label "icacls /grant (home dir)" -Command { & icacls $HomeDir /grant "*$($ServiceSid):(OI)(CI)(M)" }

# --- Step 11: firewall rules ---
# Windows Firewall applies Block rules before Allow rules regardless of rule order,
# so a naive "Allow loopback + Block everything" pair risks blocking loopback too.
#
# Rule ownership (cycle SB-2.1): the IPv4 "block everything except loopback and the
# currently allowed destinations" rule is owned by apply-sandbox-allowlist.ps1 (see
# that script's header comment for why: it must be able to carve out allowed
# destinations, and Windows Firewall ORs all matching Block rules, so a second,
# independent "block all IPv4" rule here would silently defeat anything the allow
# list permits).
#
# Cycle SB-2.1.2 (fail-closed): apply-sandbox-allowlist.ps1 can itself fail (it was
# found doing so on every run on hp630g9 -- see that script's SB-2.1.2 header note
# for the PowerShell 5.1 bug that caused it), and when it fails it leaves the
# PREVIOUS IPv4 rule in place rather than widening it -- except the very first time
# it ever runs, when there IS no previous IPv4 rule yet. Without a rule of its own,
# THIS script's install window would leave IPv4 completely open until that first
# run of apply-sandbox-allowlist.ps1 succeeds. So this script creates one more
# static rule below, $FailClosedRuleName, that blocks all non-loopback IPv4 --
# BEFORE invoking apply-sandbox-allowlist.ps1 (below). apply-sandbox-allowlist.ps1
# removes this rule itself, but only once its own new generation's rules have all
# been created successfully (see that script's "new generation fully created"
# comment) -- so if it fails at any point, this fail-closed rule (and whatever
# generation already existed) is left standing instead of nothing being blocked.
# This script therefore creates three STATIC-or-fail-closed rules whose content
# never depends on the allow list, then invokes apply-sandbox-allowlist.ps1 once
# (as a child process, below) to materialize the IPv4 allow-list rule for whatever
# is configured right now (nothing, the first time) and remove the fail-closed rule.
#
# All rules target the service identity via -LocalUser with an explicit SDDL
# string (not -Service). -LocalUser "D:(A;;CC;;;<service SID>)" was verified on
# hp630g9 to actually block outbound traffic from the service's child AND
# grandchild processes (status showed the positive control probe blocked). The
# -Service form was never verified and is not used here.
#
# Full reset on every (re)install: remove rules matched by the old DisplayName-only
# scheme (pre-SB-2.1 installs had no -Name/-Group) AND by the current Group, so a
# re-install always starts from a clean slate before anything below re-creates them.
$existingRules = @(Get-NetFirewallRule -DisplayName "DevRelay Sandbox*" -ErrorAction SilentlyContinue) +
                 @(Get-NetFirewallRule -Group $FirewallGroup -ErrorAction SilentlyContinue)
if ($existingRules) {
    $existingRules | Sort-Object -Property Name -Unique | Remove-NetFirewallRule -ErrorAction SilentlyContinue
}

$LocalUserSddl = "D:(A;;CC;;;$ServiceSid)"

# Fail-closed (cycle SB-2.1.2): created FIRST, immediately after the reset above,
# so the window with no IPv4 rule at all (between the reset and this line) is as
# short as possible. Same two half-open ranges the pre-SB-2.1 static IPv4 rule
# used (verified on hp630g9 in cycle SB-1) -- removed by
# apply-sandbox-allowlist.ps1 once its own generation is up, never by this script.
New-NetFirewallRule -Name $FailClosedRuleName -DisplayName "DevRelay Sandbox - Block IPv4 (fail-closed, except loopback)" `
    -Group $FirewallGroup -Direction Outbound -LocalUser $LocalUserSddl -Action Block -Protocol Any `
    -RemoteAddress "0.0.0.0-126.255.255.255","128.0.0.0-255.255.255.255" | Out-Null

# IPv6: "::/0" is rejected by New-NetFirewallRule ("one or more address prefixes are
# invalid", HRESULT 0x80070057 on hp630g9). Two half-ranges work instead. This rule's
# content never depends on the allow list (cycle SB-2.1 only adds IPv4 destinations).
New-NetFirewallRule -Name "DevRelay-SandboxStatic-ipv6-block" -DisplayName "DevRelay Sandbox - Block IPv6 (all)" `
    -Group $FirewallGroup -Direction Outbound -LocalUser $LocalUserSddl -Action Block -Protocol Any `
    -RemoteAddress "::/1","8000::/1" | Out-Null

# Explicit Allow rule (technically redundant since the dynamic IPv4 Block rule never
# covers loopback either, but documents intent and is a safety net).
New-NetFirewallRule -Name "DevRelay-SandboxStatic-loopback-allow" -DisplayName "DevRelay Sandbox - Allow loopback" `
    -Group $FirewallGroup -Direction Outbound -LocalUser $LocalUserSddl -Action Allow -Protocol Any `
    -RemoteAddress "127.0.0.0/8" | Out-Null

Write-Host "[OK] Created static firewall rules (fail-closed IPv4, IPv6 block, loopback allow)" -ForegroundColor Green

# --- Step 11b (cycle SB-2.1): allow-destinations directories, ACLs, deny list ---
New-Item -ItemType Directory -Path $AllowlistRequestDir -Force | Out-Null
New-Item -ItemType Directory -Path $AllowlistResultDir -Force | Out-Null
New-Item -ItemType Directory -Path $AllowlistDenyDir -Force | Out-Null
New-Item -ItemType Directory -Path $AllowlistBinDir -Force | Out-Null

# request.json: the developer may create/replace it (Modify); nobody else may,
# and the Sandbox identity gets no ACE at all.
$null = Invoke-NativeCommand -Label "icacls /inheritance:r (allowlist-request)" -Command { & icacls $AllowlistRequestDir /inheritance:r }
$null = Invoke-NativeCommand -Label "icacls /grant SYSTEM (allowlist-request)" -Command { & icacls $AllowlistRequestDir /grant "*S-1-5-18:(OI)(CI)(F)" }       # SYSTEM
$null = Invoke-NativeCommand -Label "icacls /grant Administrators (allowlist-request)" -Command { & icacls $AllowlistRequestDir /grant "*S-1-5-32-544:(OI)(CI)(F)" }  # Administrators
$null = Invoke-NativeCommand -Label "icacls /grant developer (allowlist-request)" -Command { & icacls $AllowlistRequestDir /grant "*$($DeveloperSid):(OI)(CI)(M)" }

# state.json: only SYSTEM/Administrators may write; the developer may only read.
$null = Invoke-NativeCommand -Label "icacls /inheritance:r (allowlist-result)" -Command { & icacls $AllowlistResultDir /inheritance:r }
$null = Invoke-NativeCommand -Label "icacls /grant SYSTEM (allowlist-result)" -Command { & icacls $AllowlistResultDir /grant "*S-1-5-18:(OI)(CI)(F)" }
$null = Invoke-NativeCommand -Label "icacls /grant Administrators (allowlist-result)" -Command { & icacls $AllowlistResultDir /grant "*S-1-5-32-544:(OI)(CI)(F)" }
$null = Invoke-NativeCommand -Label "icacls /grant developer (allowlist-result)" -Command { & icacls $AllowlistResultDir /grant "*$($DeveloperSid):(OI)(CI)(R)" }

# deny.json: administrator-set; the developer gets no access at all (not even read).
$null = Invoke-NativeCommand -Label "icacls /inheritance:r (allowlist-deny)" -Command { & icacls $AllowlistDenyDir /inheritance:r }
$null = Invoke-NativeCommand -Label "icacls /grant SYSTEM (allowlist-deny)" -Command { & icacls $AllowlistDenyDir /grant "*S-1-5-18:(OI)(CI)(F)" }
$null = Invoke-NativeCommand -Label "icacls /grant Administrators (allowlist-deny)" -Command { & icacls $AllowlistDenyDir /grant "*S-1-5-32-544:(OI)(CI)(F)" }

# allowlist-bin\: holds the privileged script itself. The developer may read and
# execute it (so `schtasks /Run` can launch it) but never modify it -- the task
# must never run a file the developer (and so, transitively, a prompt-injected AI
# running under the developer's own shell) can edit.
$null = Invoke-NativeCommand -Label "icacls /inheritance:r (allowlist-bin)" -Command { & icacls $AllowlistBinDir /inheritance:r }
$null = Invoke-NativeCommand -Label "icacls /grant SYSTEM (allowlist-bin)" -Command { & icacls $AllowlistBinDir /grant "*S-1-5-18:(OI)(CI)(F)" }
$null = Invoke-NativeCommand -Label "icacls /grant Administrators (allowlist-bin)" -Command { & icacls $AllowlistBinDir /grant "*S-1-5-32-544:(OI)(CI)(F)" }
$null = Invoke-NativeCommand -Label "icacls /grant developer RX (allowlist-bin)" -Command { & icacls $AllowlistBinDir /grant "*$($DeveloperSid):(OI)(CI)(RX)" }

Write-Host "[OK] Created allow-destinations directories and ACLs" -ForegroundColor Green

Copy-Item -Path $ApplyScriptSourcePath -Destination $ApplyScriptDestPath -Force
Write-Host "[OK] Copied apply-sandbox-allowlist.ps1 to $ApplyScriptDestPath" -ForegroundColor Green

# Administrator-set upstream-proxy denylist (decision 4; default empty).
$denyJson = @{ version = 1; destinations = @($DenyDestination) } | ConvertTo-Json
[System.IO.File]::WriteAllText($DenyJsonPath, $denyJson)
Write-Host "[OK] Saved deny.json ($($DenyDestination.Count) entr(y/ies))" -ForegroundColor Green

# --- Step 11c (cycle SB-2.1): register the allow-destinations reconciler task ---
# No arguments: schtasks /Run has no mechanism to pass arguments, so the action
# below must never reference "$(ArgN)" (see apply-sandbox-allowlist.ps1 header).
$null = Invoke-NativeCommand -Label "schtasks /Delete (pre-register)" -AllowFailure -Command { & schtasks /Delete /TN $TaskPath /F }
$taskAction = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$ApplyScriptDestPath`""
$null = Invoke-NativeCommand -Label "schtasks /Create" -Command { & schtasks /Create /TN $TaskPath /TR $taskAction /SC ONSTART /RU "SYSTEM" /RL HIGHEST /F }
Write-Host "[OK] Registered scheduled task: $TaskPath (ONSTART, runs as SYSTEM)" -ForegroundColor Green

# Grant the developer account permission to trigger the task on demand
# (`schtasks /Run /TN "$TaskPath"`) without needing to be an administrator.
# This uses the Schedule.Service COM object's SetSecurityDescriptor, which has
# no prior use in this repository and could not be verified without real
# Windows hardware; see doc/sandbox/SB-2.0_investigation.md C-1 for the
# documented fallbacks (manual ACE append, numeric access mask, or an
# ONEVENT-trigger-based alternative) if this does not work as expected. Until
# confirmed, the ONSTART trigger above is the guaranteed fallback: the rule
# still reconciles every boot even if the developer can never trigger it early.
try {
    $scheduleService = New-Object -ComObject "Schedule.Service"
    $scheduleService.Connect()
    $taskFolderObj = $scheduleService.GetFolder($TaskFolder)
    $taskObj = $taskFolderObj.GetTask($TaskName)
    # D:P = protected DACL (do not merge with inherited ACEs). SY = SYSTEM (Full),
    # BA = Administrators (Full), the developer SID gets Read + Generic Execute.
    $taskSddl = "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FRFX;;;$DeveloperSid)"
    $taskObj.SetSecurityDescriptor($taskSddl, 0)
    Write-Host "[OK] Granted $DeveloperAccount permission to run the task on demand" -ForegroundColor Green
} catch {
    Write-Host "[WARN] Could not grant $DeveloperAccount permission to run the task on demand: $_" -ForegroundColor Yellow
    Write-Host "[WARN] The task will still run at every boot (ONSTART). Until this is fixed, an" -ForegroundColor Yellow
    Write-Host "[WARN] administrator can reconcile on demand with: schtasks /Run /TN `"$TaskPath`"" -ForegroundColor Yellow
}

# Materialize the current generation right now (as a separate process, exactly
# like the scheduled task itself will run it, so `exit` inside the child script
# never terminates this installer). The first time this runs, request.json
# usually does not exist yet, so on success this reproduces the pre-SB-2.1
# behavior exactly (block everything except loopback). If this fails, the
# fail-closed rule created above is left standing (see Step 11), so IPv4 is
# never left unmanaged -- but it then stays at "block everything" rather than
# picking up any allowDestinations until the failure is fixed and the task
# (or this installer) is run again.
$applyProcess = Start-Process -FilePath "powershell.exe" `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$ApplyScriptDestPath`"") `
    -Wait -PassThru -WindowStyle Hidden
if ($applyProcess.ExitCode -ne 0) {
    Write-Host "[WARN] apply-sandbox-allowlist.ps1 reported exit code $($applyProcess.ExitCode). Check $StateJsonPath." -ForegroundColor Yellow
    Write-Host "[WARN] IPv4 remains fully blocked (except loopback) via the fail-closed rule until this is fixed." -ForegroundColor Yellow
    # Best-effort: surface state.json's ASCII-only error code so the WARN above is
    # actionable without opening the file by hand. Never let a read/parse failure
    # here affect the installer's own exit code.
    try {
        if (Test-Path $StateJsonPath) {
            $stateForWarn = Get-Content -Path $StateJsonPath -Raw | ConvertFrom-Json
            if ($stateForWarn.error) {
                Write-Host "[WARN] state.json error: $($stateForWarn.error)" -ForegroundColor Yellow
            }
        }
    } catch {
        # state.json could not be read/parsed; the WARN lines above already told
        # the administrator where to look by hand.
    }
} else {
    Write-Host "[OK] Applied the current allow-destinations generation (see $StateJsonPath)" -ForegroundColor Green
}

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
    $nodeCheckResult = Invoke-NativeCommand -Label "node public key check" -AllowFailure -Command { & $NodeExe -e $nodeCheckScript $PubKeyPath }
    if ($nodeCheckResult.ExitCode -eq 0) {
        Write-Host "[OK] Verified the public key is readable by Node.js crypto.createPublicKey()" -ForegroundColor Green
    } else {
        Write-Host "[WARN] Node.js could not read the generated public key: $($nodeCheckResult.Output -join ' ')" -ForegroundColor Yellow
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
