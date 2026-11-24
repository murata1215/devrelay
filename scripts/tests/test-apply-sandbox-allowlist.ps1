# =============================================================================
# DevRelay Sandbox allowlist reconciler -- Windows PowerShell 5.1 harness test
# (cycle SB-2.1.4)
# =============================================================================
#
# WHY THIS FILE EXISTS: scripts/apply-sandbox-allowlist.ps1 is written on Linux
# and had never once been run under Windows PowerShell 5.1 before being pushed
# to a real machine (hp630g9). Three real-machine bugs (SB-2.1.1, SB-2.1.2,
# SB-2.1.3) were each found and fixed one at a time this way. This file lets a
# developer run the full reconciler, every validation/error path, and the
# generation-switch logic, on 5.1, as a NON-ADMINISTRATOR, before the next
# real-machine check -- without ever touching a real firewall rule.
#
# HOW IT WORKS (no changes to the production script's interface):
#   - For each test case, this harness makes a byte-for-byte copy of the real
#     scripts/apply-sandbox-allowlist.ps1 into a fresh temp directory, with
#     exactly two literal text substitutions (the ProgramData path, and the
#     "NT SERVICE\..." account lookup) and one inserted line (a dot-source of
#     a generated stub file). These five anchor strings are verified present
#     in the real script before any copy is made; if a future edit to
#     apply-sandbox-allowlist.ps1 removes one, this harness fails loudly
#     instead of silently testing a no-op copy.
#   - The stub file replaces New-NetFirewallRule / Get-NetFirewallRule /
#     Remove-NetFirewallRule with functions that record every call and persist
#     a small JSON "virtual firewall" under the case's temp directory --
#     nothing under this file's control ever calls the real NetSecurity
#     module. PowerShell resolves a same-named function before a cmdlet, so
#     these stubs take effect without the real cmdlets even needing to exist
#     (this is also why this works when run from a plain Linux dev box: there
#     is no NetSecurity module here at all).
#   - The copy is then run as a brand-new child process (never dot-sourced or
#     "&"-invoked in this process), because the real script calls "exit" on
#     every path, which would kill this harness too if run in-process.
#   - The production script itself is NEVER given a new argument, environment
#     variable, or config switch for testing. It is a zero-argument, SYSTEM-run
#     scheduled task in production; this harness works entirely from the
#     outside, on a disposable copy.
#
# PLATFORM NOTE: this file is verified to run under both Windows PowerShell
# 5.1 (the real target) and pwsh 7 on Linux (used during development to catch
# syntax errors and logic bugs in THIS harness before ever touching hp630g9).
# The specific 5.1 bug this cycle fixes -- Group-Object -Property / Select-
# Object -ExpandProperty not resolving a Hashtable's keys as properties -- does
# NOT reproduce under pwsh 7 (its Hashtable adapter behaves differently), so a
# green run under pwsh 7 does NOT by itself prove the 5.1 bug is fixed; it
# proves this harness and the rest of the reconciler's logic (validation,
# rule math, rollback, generation switching) are correct on both. The 5.1 fix
# itself must still be confirmed by running this file on a real 5.1 host.
#
# ASCII ONLY (same reason as the three scripts this harness exercises).
# =============================================================================

$ErrorActionPreference = "Stop"

# --- locate the real script under test (this file lives in scripts/tests/) ---
$__TestScriptDir = $PSScriptRoot
if (-not $__TestScriptDir) {
    $__TestScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
$RepoScriptsDir = Split-Path -Parent $__TestScriptDir
$RealApplyScriptPath = Join-Path $RepoScriptsDir "apply-sandbox-allowlist.ps1"

if (-not (Test-Path $RealApplyScriptPath)) {
    Write-Host "[ERROR] Could not find apply-sandbox-allowlist.ps1 next to this test's parent folder: $RealApplyScriptPath" -ForegroundColor Red
    exit 1
}

$RealApplySource = Get-Content -Path $RealApplyScriptPath -Raw

# --- anchors this harness depends on to build a safe, isolated copy. If any
#     of these ever stop matching (because apply-sandbox-allowlist.ps1 was
#     refactored), fail loudly here rather than silently testing a copy that
#     still points at C:\ProgramData or tries to resolve a real service SID. ---
$AnchorProgramDataDir = '$ProgramDataDir = "C:\ProgramData\devrelay\sandbox"'
$AnchorSidResolve = '$sidObj = (New-Object System.Security.Principal.NTAccount($ServiceAccountName)).Translate([System.Security.Principal.SecurityIdentifier])'
$AnchorErrorActionPreference = '$ErrorActionPreference = "Stop"'

foreach ($anchor in @($AnchorProgramDataDir, $AnchorSidResolve, $AnchorErrorActionPreference)) {
    if (-not $RealApplySource.Contains($anchor)) {
        Write-Host "[ERROR] apply-sandbox-allowlist.ps1 no longer contains an anchor this test harness depends on. Update scripts/tests/test-apply-sandbox-allowlist.ps1. Missing anchor:" -ForegroundColor Red
        Write-Host $anchor -ForegroundColor Red
        exit 1
    }
}

# -----------------------------------------------------------------------------
# counters and tiny assertion helpers
# -----------------------------------------------------------------------------

$script:PassCount = 0
$script:FailCount = 0
$script:SkipCount = 0

function Assert-That {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Write-CaseResult {
    param([string]$Status, [string]$Name, [string]$Detail = "")
    switch ($Status) {
        "PASS" {
            $script:PassCount++
            Write-Host "[PASS] $Name"
        }
        "FAIL" {
            $script:FailCount++
            Write-Host "[FAIL] $Name :: $Detail" -ForegroundColor Red
        }
        "SKIP" {
            $script:SkipCount++
            Write-Host "[SKIP] $Name :: $Detail" -ForegroundColor Yellow
        }
    }
}

# Runs one test case body; PASS on normal return, SKIP on a thrown message
# starting with "SKIP:", FAIL on any other thrown message.
function Invoke-TestCase {
    param([string]$Name, [scriptblock]$Body)
    try {
        & $Body
        Write-CaseResult -Status "PASS" -Name $Name
    } catch {
        $msg = "$($_.Exception.Message)"
        if ($msg.StartsWith("SKIP:")) {
            Write-CaseResult -Status "SKIP" -Name $Name -Detail $msg.Substring(5).Trim()
        } else {
            Write-CaseResult -Status "FAIL" -Name $Name -Detail $msg
        }
    }
}

function Write-AsciiFile {
    param([string]$Path, [string]$Content)
    [System.IO.File]::WriteAllText($Path, $Content, [System.Text.Encoding]::ASCII)
}

# -----------------------------------------------------------------------------
# per-case fixture directory layout (mirrors what install-sandbox-host.ps1
# creates under C:\ProgramData\devrelay\sandbox in production)
# -----------------------------------------------------------------------------

$script:RootTestDir = Join-Path ([System.IO.Path]::GetTempPath()) ("devrelay-sbtest-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $script:RootTestDir -Force | Out-Null

function New-CaseDir {
    param([string]$Suffix)
    $dir = Join-Path $script:RootTestDir $Suffix
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $dir "allowlist-request") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $dir "allowlist-result") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $dir "allowlist-deny") -Force | Out-Null
    return $dir
}

function Get-CaseRequestPath { param([string]$CaseDir) Join-Path (Join-Path $CaseDir "allowlist-request") "request.json" }
function Get-CaseStatePath   { param([string]$CaseDir) Join-Path (Join-Path $CaseDir "allowlist-result") "state.json" }
function Get-CaseDenyPath    { param([string]$CaseDir) Join-Path (Join-Path $CaseDir "allowlist-deny") "deny.json" }
function Get-CaseRulesPath   { param([string]$CaseDir) Join-Path $CaseDir "rules.json" }
function Get-CaseCallsPath   { param([string]$CaseDir) Join-Path $CaseDir "calls.jsonl" }

# -----------------------------------------------------------------------------
# the virtual firewall: functions dot-sourced into each disposable copy of
# apply-sandbox-allowlist.ps1, replacing New-/Get-/Remove-NetFirewallRule.
# Written as a single-quoted here-string (no interpolation) with two tokens
# replaced per case, so none of this text's own "$" characters need escaping.
# -----------------------------------------------------------------------------

$StubTemplate = @'
# --- DevRelay sandbox test stub: virtual firewall (cycle SB-2.1.4) ---
# This file is generated per test case by test-apply-sandbox-allowlist.ps1.
# It never touches a real firewall rule.
$script:SbRulesJsonPath = "__RULES_JSON_PATH__"
$script:SbCallsJsonlPath = "__CALLS_JSONL_PATH__"

function Get-SbStubRules {
    if (-not (Test-Path $script:SbRulesJsonPath)) { return @() }
    $raw = Get-Content -Path $script:SbRulesJsonPath -Raw -ErrorAction SilentlyContinue
    if (-not $raw) { return @() }
    $parsed = $raw | ConvertFrom-Json
    if ($null -eq $parsed) { return @() }
    return @($parsed)
}

function Set-SbStubRules {
    param($Rules)
    $json = @($Rules) | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($script:SbRulesJsonPath, $json, [System.Text.Encoding]::ASCII)
}

function Add-SbStubCallLog {
    param([string]$Kind, [string]$RuleName)
    $entry = @{ kind = $Kind; name = $RuleName; at = [DateTimeOffset]::UtcNow.ToString("o") }
    $line = $entry | ConvertTo-Json -Compress -Depth 4
    Add-Content -Path $script:SbCallsJsonlPath -Value $line -Encoding Ascii
}

function New-NetFirewallRule {
    [CmdletBinding()]
    param(
        [string]$Name,
        [string]$DisplayName,
        [string]$Group,
        [string]$Direction,
        [string]$LocalUser,
        [string]$Action,
        [string]$Protocol,
        [string[]]$RemoteAddress,
        [string[]]$RemotePort
    )
    $existing = @(Get-SbStubRules)
    $callIndex = $existing.Count + 1

    $failMode = $env:DEVRELAY_SBTEST_FAIL_MODE
    $failAt = $env:DEVRELAY_SBTEST_FAIL_AT
    if ($failMode -and $failAt -and ([int]$failAt -eq $callIndex)) {
        if ($failMode -eq "throw") {
            Add-SbStubCallLog -Kind "create-throw" -RuleName $Name
            throw [System.InvalidOperationException]::new("DevRelaySbStub: simulated rule-creation failure at call $callIndex")
        } elseif ($failMode -eq "error") {
            Add-SbStubCallLog -Kind "create-error" -RuleName $Name
            Write-Error "DevRelaySbStub: simulated non-terminating rule-creation error at call $callIndex"
            return
        } elseif ($failMode -eq "silent") {
            Add-SbStubCallLog -Kind "create-silent-fail" -RuleName $Name
            return
        }
    }

    if (@($existing | Where-Object { $_.Name -eq $Name }).Count -gt 0) {
        throw [System.InvalidOperationException]::new("DevRelaySbStub: a rule named $Name already exists")
    }

    $rule = [pscustomobject]@{
        Name          = $Name
        DisplayName   = $DisplayName
        Group         = $Group
        Direction     = $Direction
        LocalUser     = $LocalUser
        Action        = $Action
        Protocol      = $Protocol
        RemoteAddress = @($RemoteAddress)
        RemotePort    = if ($PSBoundParameters.ContainsKey("RemotePort")) { @($RemotePort) } else { @() }
    }
    $newRules = @($existing) + $rule
    Set-SbStubRules -Rules $newRules
    Add-SbStubCallLog -Kind "create" -RuleName $Name
    return $rule
}

function Get-NetFirewallRule {
    [CmdletBinding()]
    param(
        [string]$Name,
        [string]$Group
    )
    $rules = @(Get-SbStubRules)
    if ($Name) {
        $match = @($rules | Where-Object { $_.Name -eq $Name })
        if ($match.Count -eq 0) {
            throw [System.Management.Automation.ItemNotFoundException]::new("DevRelaySbStub: no rule named $Name")
        }
        return $match[0]
    }
    if ($Group) {
        $matched = @($rules | Where-Object { $_.Group -eq $Group })
        if ($matched.Count -eq 0) {
            throw [System.Management.Automation.ItemNotFoundException]::new("DevRelaySbStub: no rule in group $Group")
        }
        return $matched
    }
    return @($rules)
}

function Remove-NetFirewallRule {
    [CmdletBinding()]
    param(
        [Parameter(ValueFromPipelineByPropertyName=$true)]
        [string]$Name
    )
    process {
        $rules = @(Get-SbStubRules)
        $match = @($rules | Where-Object { $_.Name -eq $Name })
        if ($match.Count -eq 0) {
            throw [System.Management.Automation.ItemNotFoundException]::new("DevRelaySbStub: no rule named $Name to remove")
        }
        $remaining = @($rules | Where-Object { $_.Name -ne $Name })
        Set-SbStubRules -Rules $remaining
        Add-SbStubCallLog -Kind "remove" -RuleName $Name
    }
}
'@

function Get-StubsScriptText {
    param([string]$CaseDir)
    $rulesPath = Get-CaseRulesPath $CaseDir
    $callsPath = Get-CaseCallsPath $CaseDir
    return $StubTemplate.Replace("__RULES_JSON_PATH__", $rulesPath).Replace("__CALLS_JSONL_PATH__", $callsPath)
}

# -----------------------------------------------------------------------------
# build a disposable, isolated copy of the real script for one case
# -----------------------------------------------------------------------------

function New-ApplyScriptCopy {
    param([string]$CaseDir)

    $text = $RealApplySource
    $text = $text.Replace($AnchorProgramDataDir, ('$ProgramDataDir = "' + $CaseDir + '"'))
    $text = $text.Replace($AnchorSidResolve, '$sidObj = [pscustomobject]@{ Value = "S-1-5-80-0" }')

    $stubsPath = Join-Path $CaseDir "stubs.ps1"
    Write-AsciiFile -Path $stubsPath -Content (Get-StubsScriptText -CaseDir $CaseDir)

    $anchorIdx = $text.IndexOf($AnchorErrorActionPreference)
    $insertAt = $anchorIdx + $AnchorErrorActionPreference.Length
    $dotSourceLine = [System.Environment]::NewLine + '. "' + $stubsPath + '"'
    $text = $text.Substring(0, $insertAt) + $dotSourceLine + $text.Substring($insertAt)

    $copyPath = Join-Path $CaseDir "apply-sandbox-allowlist.copy.ps1"
    Write-AsciiFile -Path $copyPath -Content $text
    return $copyPath
}

# -----------------------------------------------------------------------------
# run the copy as a brand-new child process (never dot-sourced in this
# process -- the real script calls exit on every path)
# -----------------------------------------------------------------------------

function Invoke-ApplyScript {
    param([string]$CopyPath, [string]$CaseDir)
    $stdoutPath = Join-Path $CaseDir "stdout.txt"
    $stderrPath = Join-Path $CaseDir "stderr.txt"
    Remove-Item -Path $stdoutPath, $stderrPath -ErrorAction SilentlyContinue

    $hostExe = (Get-Process -Id $PID).Path
    $argList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ('"' + $CopyPath + '"'))
    $proc = Start-Process -FilePath $hostExe -ArgumentList $argList -Wait -PassThru -NoNewWindow `
        -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath

    $stdout = if (Test-Path $stdoutPath) { Get-Content -Path $stdoutPath -Raw } else { "" }
    $stderr = if (Test-Path $stderrPath) { Get-Content -Path $stderrPath -Raw } else { "" }
    return [pscustomobject]@{
        ExitCode = $proc.ExitCode
        Stdout   = $stdout
        Stderr   = $stderr
    }
}

function Read-CaseState {
    param([string]$CaseDir)
    $path = Get-CaseStatePath $CaseDir
    if (-not (Test-Path $path)) { return $null }
    $raw = Get-Content -Path $path -Raw
    if (-not $raw) { return $null }
    return $raw | ConvertFrom-Json
}

function Read-CaseRules {
    param([string]$CaseDir)
    $path = Get-CaseRulesPath $CaseDir
    if (-not (Test-Path $path)) { return @() }
    $raw = Get-Content -Path $path -Raw
    if (-not $raw) { return @() }
    $parsed = $raw | ConvertFrom-Json
    if ($null -eq $parsed) { return @() }
    return @($parsed)
}

function Read-CaseCalls {
    param([string]$CaseDir)
    $path = Get-CaseCallsPath $CaseDir
    if (-not (Test-Path $path)) { return @() }
    $lines = @(Get-Content -Path $path)
    return @($lines | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
}

# Pre-seeds the case's virtual firewall with the fail-closed rule that
# install-sandbox-host.ps1 creates before ever invoking the reconciler, so
# this harness can verify it survives a failed run and is removed only after
# a fully-verified successful one.
function Add-FailClosedSeedRule {
    param([string]$CaseDir)
    Write-AsciiFile -Path (Join-Path $CaseDir "stubs.ps1") -Content (Get-StubsScriptText -CaseDir $CaseDir)
    $seedScript = @'
. "__STUBS_PATH__"
$rule = [pscustomobject]@{
    Name = "DevRelay-SandboxFailClosed-ipv4"
    DisplayName = "DevRelay Sandbox - Block IPv4 except loopback (fail-closed)"
    Group = "DevRelay Sandbox"
    Direction = "Outbound"
    LocalUser = $null
    Action = "Block"
    Protocol = "Any"
    RemoteAddress = @("0.0.0.0-126.255.255.255","128.0.0.0-255.255.255.255")
    RemotePort = @()
}
Set-SbStubRules -Rules @($rule)
'@
    $stubsPath = Join-Path $CaseDir "stubs.ps1"
    $seedScript = $seedScript.Replace("__STUBS_PATH__", $stubsPath)
    $seedPath = Join-Path $CaseDir "seed.ps1"
    Write-AsciiFile -Path $seedPath -Content $seedScript
    $hostExe = (Get-Process -Id $PID).Path
    & $hostExe -NoProfile -ExecutionPolicy Bypass -File $seedPath | Out-Null
}

Write-Host "DevRelay sandbox allowlist reconciler test harness (cycle SB-2.1.4)"
Write-Host "Real script under test: $RealApplyScriptPath"
Write-Host "Temp root: $script:RootTestDir"
Write-Host ""

# =============================================================================
# case a: empty destination set
# =============================================================================
Invoke-TestCase -Name "a: empty destination set produces the IPv4 bootstrap rule" -Body {
    $caseDir = New-CaseDir "case-a"
    Write-AsciiFile -Path (Get-CaseRequestPath $caseDir) -Content '{"version":1,"destinations":[]}'
    Write-AsciiFile -Path (Join-Path $caseDir "stubs.ps1") -Content (Get-StubsScriptText -CaseDir $caseDir)
    $copy = New-ApplyScriptCopy -CaseDir $caseDir
    $result = Invoke-ApplyScript -CopyPath $copy -CaseDir $caseDir
    Assert-That ($result.ExitCode -eq 0) "exit code should be 0, got $($result.ExitCode); stderr=$($result.Stderr); stdout=$($result.Stdout)"

    $state = Read-CaseState $caseDir
    Assert-That ($null -ne $state) "state.json should exist"
    Assert-That ($state.result -eq "ok") "state.result should be ok, got $($state.result); error=$($state.error)"
    Assert-That ($state.reconcilerVersion -eq 1) "reconcilerVersion should be 1, got $($state.reconcilerVersion)"

    $rules = @(Read-CaseRules $caseDir)
    Assert-That ($rules.Count -eq 1) "expected exactly 1 rule, got $($rules.Count)"
    $ipv4Rule = $rules[0]
    Assert-That ($ipv4Rule.Name -like "DevRelay-SandboxGen-*-ipv4") "rule name should match the ipv4 pattern, got $($ipv4Rule.Name)"
    $addrs = @($ipv4Rule.RemoteAddress)
    Assert-That ($addrs.Count -eq 2) "expected 2 remote address ranges, got $($addrs.Count): $($addrs -join ',')"
    Assert-That ($addrs[0] -eq "0.0.0.0-126.255.255.255") "first range mismatch: $($addrs[0])"
    Assert-That ($addrs[1] -eq "128.0.0.0-255.255.255.255") "second range mismatch: $($addrs[1])"
}

# =============================================================================
# case b: one destination
# =============================================================================
Invoke-TestCase -Name "b: one destination produces 3 correctly-shaped rules" -Body {
    $caseDir = New-CaseDir "case-b"
    Write-AsciiFile -Path (Get-CaseRequestPath $caseDir) -Content '{"version":1,"destinations":[{"ip":"192.168.32.196","port":2222}]}'
    Write-AsciiFile -Path (Join-Path $caseDir "stubs.ps1") -Content (Get-StubsScriptText -CaseDir $caseDir)
    $copy = New-ApplyScriptCopy -CaseDir $caseDir
    $result = Invoke-ApplyScript -CopyPath $copy -CaseDir $caseDir
    Assert-That ($result.ExitCode -eq 0) "exit code should be 0, got $($result.ExitCode); stderr=$($result.Stderr); stdout=$($result.Stdout)"

    $state = Read-CaseState $caseDir
    Assert-That ($state.result -eq "ok") "state.result should be ok, got $($state.result); error=$($state.error)"

    $rules = @(Read-CaseRules $caseDir)
    Assert-That ($rules.Count -eq 3) "expected exactly 3 rules, got $($rules.Count): $(($rules | ForEach-Object { $_.Name }) -join ',')"

    $ipv4Rule = $rules | Where-Object { $_.Name -like "*-ipv4" }
    $tcpRule  = $rules | Where-Object { $_.Name -like "*-tcp-0" }
    $udpRule  = $rules | Where-Object { $_.Name -like "*-udp" }
    Assert-That ($null -ne $ipv4Rule) "an ipv4 rule should exist"
    Assert-That ($null -ne $tcpRule) "a tcp-0 rule should exist"
    Assert-That ($null -ne $udpRule) "a udp rule should exist"

    $ipv4Addrs = @($ipv4Rule.RemoteAddress)
    Assert-That ($ipv4Addrs.Count -eq 3) "ipv4 rule should have 3 ranges, got $($ipv4Addrs.Count): $($ipv4Addrs -join ',')"
    Assert-That ($ipv4Addrs[0] -eq "0.0.0.0-126.255.255.255") "ipv4 range 1 mismatch: $($ipv4Addrs[0])"
    Assert-That ($ipv4Addrs[1] -eq "128.0.0.0-192.168.32.195") "ipv4 range 2 mismatch: $($ipv4Addrs[1])"
    Assert-That ($ipv4Addrs[2] -eq "192.168.32.197-255.255.255.255") "ipv4 range 3 mismatch: $($ipv4Addrs[2])"

    $tcpPorts = @($tcpRule.RemotePort) -join ","
    Assert-That ($tcpPorts -eq "1-2221,2223-65535") "tcp remote port mismatch: $tcpPorts"
    Assert-That ((@($tcpRule.RemoteAddress) -join ",") -eq "192.168.32.196") "tcp remote address mismatch: $(@($tcpRule.RemoteAddress) -join ',')"
    Assert-That ((@($udpRule.RemoteAddress) -join ",") -eq "192.168.32.196") "udp remote address mismatch: $(@($udpRule.RemoteAddress) -join ',')"
}

# =============================================================================
# case c1: same IP, two ports -- the port complement must merge them
# =============================================================================
Invoke-TestCase -Name "c1: same IP with two adjacent ports merges into one TCP rule" -Body {
    $caseDir = New-CaseDir "case-c1"
    Write-AsciiFile -Path (Get-CaseRequestPath $caseDir) -Content '{"version":1,"destinations":[{"ip":"10.0.0.5","port":2222},{"ip":"10.0.0.5","port":2223}]}'
    Write-AsciiFile -Path (Join-Path $caseDir "stubs.ps1") -Content (Get-StubsScriptText -CaseDir $caseDir)
    $copy = New-ApplyScriptCopy -CaseDir $caseDir
    $result = Invoke-ApplyScript -CopyPath $copy -CaseDir $caseDir
    Assert-That ($result.ExitCode -eq 0) "exit code should be 0, got $($result.ExitCode); stderr=$($result.Stderr); stdout=$($result.Stdout)"

    $state = Read-CaseState $caseDir
    Assert-That ($state.result -eq "ok") "state.result should be ok, got $($state.result); error=$($state.error)"

    $rules = @(Read-CaseRules $caseDir)
    $tcpRules = @($rules | Where-Object { $_.Name -like "*-tcp-*" })
    Assert-That ($tcpRules.Count -eq 1) "expected exactly 1 TCP rule (ports merged), got $($tcpRules.Count)"
    $tcpPorts = @($tcpRules[0].RemotePort) -join ","
    Assert-That ($tcpPorts -eq "1-2221,2224-65535") "merged tcp remote port mismatch: $tcpPorts"
}

# =============================================================================
# case c2: two IPs -- tcp-<N> assignment must be deterministic (numeric IP
# order), independent of the order the destinations appeared in request.json
# =============================================================================
Invoke-TestCase -Name "c2: two IPs get deterministic tcp-0/tcp-1 rules in numeric IP order" -Body {
    $caseDir = New-CaseDir "case-c2"
    # Deliberately listed with the numerically LARGER ip first, to prove
    # tcp-<N> assignment is not just insertion order.
    Write-AsciiFile -Path (Get-CaseRequestPath $caseDir) -Content '{"version":1,"destinations":[{"ip":"10.0.0.9","port":9},{"ip":"10.0.0.2","port":2}]}'
    Write-AsciiFile -Path (Join-Path $caseDir "stubs.ps1") -Content (Get-StubsScriptText -CaseDir $caseDir)
    $copy = New-ApplyScriptCopy -CaseDir $caseDir
    $result = Invoke-ApplyScript -CopyPath $copy -CaseDir $caseDir
    Assert-That ($result.ExitCode -eq 0) "exit code should be 0, got $($result.ExitCode); stderr=$($result.Stderr); stdout=$($result.Stdout)"

    $rules = @(Read-CaseRules $caseDir)
    Assert-That ($rules.Count -eq 4) "expected 4 rules (ipv4 + tcp-0 + tcp-1 + udp), got $($rules.Count): $(($rules | ForEach-Object { $_.Name }) -join ',')"

    $tcp0 = $rules | Where-Object { $_.Name -like "*-tcp-0" }
    $tcp1 = $rules | Where-Object { $_.Name -like "*-tcp-1" }
    Assert-That ($null -ne $tcp0 -and $null -ne $tcp1) "both tcp-0 and tcp-1 should exist"
    Assert-That ((@($tcp0.RemoteAddress) -join ",") -eq "10.0.0.2") "tcp-0 should be bound to the numerically smaller IP (10.0.0.2), got $(@($tcp0.RemoteAddress) -join ',')"
    Assert-That ((@($tcp1.RemoteAddress) -join ",") -eq "10.0.0.9") "tcp-1 should be bound to the numerically larger IP (10.0.0.9), got $(@($tcp1.RemoteAddress) -join ',')"

    $udpRule = $rules | Where-Object { $_.Name -like "*-udp" }
    $udpAddrs = @($udpRule.RemoteAddress | Sort-Object)
    Assert-That ((($udpAddrs -join ",")) -eq "10.0.0.2,10.0.0.9") "udp rule should cover both IPs, got $($udpAddrs -join ',')"
}

# =============================================================================
# case d: generation switch -- the new generation must be fully created and
# verified BEFORE the old generation (and the fail-closed rule) is removed
# =============================================================================
Invoke-TestCase -Name "d: generation switch creates the new generation before removing the old one" -Body {
    $caseDir = New-CaseDir "case-d"
    Add-FailClosedSeedRule -CaseDir $caseDir

    # --- first run: empty destination set (generation A) ---
    Write-AsciiFile -Path (Get-CaseRequestPath $caseDir) -Content '{"version":1,"destinations":[]}'
    $copy = New-ApplyScriptCopy -CaseDir $caseDir
    $result1 = Invoke-ApplyScript -CopyPath $copy -CaseDir $caseDir
    Assert-That ($result1.ExitCode -eq 0) "first run: exit code should be 0, got $($result1.ExitCode); stderr=$($result1.Stderr)"
    $state1 = Read-CaseState $caseDir
    Assert-That ($state1.result -eq "ok") "first run: state.result should be ok, got $($state1.result); error=$($state1.error)"

    $rulesAfterFirst = @(Read-CaseRules $caseDir)
    Assert-That ($rulesAfterFirst.Count -eq 1) "after first run: expected exactly 1 rule (generation A's ipv4 rule), got $($rulesAfterFirst.Count): $(($rulesAfterFirst | ForEach-Object { $_.Name }) -join ',')"
    $genARuleName = $rulesAfterFirst[0].Name
    Assert-That (-not ($rulesAfterFirst | Where-Object { $_.Name -eq "DevRelay-SandboxFailClosed-ipv4" })) "after first run: the fail-closed rule should have been removed"

    # --- second run: one destination (generation B) ---
    Write-AsciiFile -Path (Get-CaseRequestPath $caseDir) -Content '{"version":1,"destinations":[{"ip":"192.168.32.196","port":2222}]}'
    $result2 = Invoke-ApplyScript -CopyPath $copy -CaseDir $caseDir
    Assert-That ($result2.ExitCode -eq 0) "second run: exit code should be 0, got $($result2.ExitCode); stderr=$($result2.Stderr)"
    $state2 = Read-CaseState $caseDir
    Assert-That ($state2.result -eq "ok") "second run: state.result should be ok, got $($state2.result); error=$($state2.error)"

    $rulesAfterSecond = @(Read-CaseRules $caseDir)
    Assert-That ($rulesAfterSecond.Count -eq 3) "after second run: expected exactly 3 rules (generation B only), got $($rulesAfterSecond.Count): $(($rulesAfterSecond | ForEach-Object { $_.Name }) -join ',')"
    Assert-That (-not ($rulesAfterSecond | Where-Object { $_.Name -eq $genARuleName })) "after second run: generation A's rule should be gone"

    # --- ordering: every "create" for generation B must appear in the call
    #     log before the "remove" of generation A's rule ---
    $calls = @(Read-CaseCalls $caseDir)
    $genBCreateCalls = @($calls | Where-Object { $_.kind -eq "create" -and $_.name -ne $genARuleName -and $_.name -ne "DevRelay-SandboxFailClosed-ipv4" })
    $genARemoveCalls = @($calls | Where-Object { $_.kind -eq "remove" -and $_.name -eq $genARuleName })
    Assert-That ($genBCreateCalls.Count -eq 3) "expected 3 generation-B create calls across both runs, got $($genBCreateCalls.Count)"
    Assert-That ($genARemoveCalls.Count -eq 1) "expected exactly 1 remove call for generation A's rule, got $($genARemoveCalls.Count)"
    $lastGenBCreateIndex = [array]::LastIndexOf($calls, ($calls | Where-Object { $_ -in $genBCreateCalls })[-1])
    $genARemoveIndex = [array]::IndexOf($calls, $genARemoveCalls[0])
    Assert-That ($genARemoveIndex -gt $lastGenBCreateIndex) "generation A's rule must be removed AFTER all of generation B's rules were created (remove index $genARemoveIndex, last create index $lastGenBCreateIndex)"
}

# =============================================================================
# cases e1/e2/e3: rule-creation failure must never widen access
# =============================================================================
function Invoke-FailureInjectionCase {
    param([string]$Name, [string]$FailMode, [string]$ExpectedErrorSubstring)
    Invoke-TestCase -Name $Name -Body {
        $caseDir = New-CaseDir ($Name -replace '[^a-zA-Z0-9]', '_')
        Add-FailClosedSeedRule -CaseDir $caseDir
        # Two distinct IPs so there are 4 New-NetFirewallRule calls
        # (ipv4, tcp-0, tcp-1, udp); failing call #2 (tcp-0) leaves call #1
        # (ipv4) as something that genuinely succeeded this run.
        Write-AsciiFile -Path (Get-CaseRequestPath $caseDir) -Content '{"version":1,"destinations":[{"ip":"10.0.0.2","port":2},{"ip":"10.0.0.9","port":9}]}'
        $copy = New-ApplyScriptCopy -CaseDir $caseDir

        $env:DEVRELAY_SBTEST_FAIL_MODE = $FailMode
        $env:DEVRELAY_SBTEST_FAIL_AT = "2"
        try {
            $result = Invoke-ApplyScript -CopyPath $copy -CaseDir $caseDir
        } finally {
            Remove-Item Env:\DEVRELAY_SBTEST_FAIL_MODE -ErrorAction SilentlyContinue
            Remove-Item Env:\DEVRELAY_SBTEST_FAIL_AT -ErrorAction SilentlyContinue
        }

        Assert-That ($result.ExitCode -ne 0) "expected a non-zero exit code, got $($result.ExitCode); stdout=$($result.Stdout)"

        $state = Read-CaseState $caseDir
        Assert-That ($null -ne $state) "state.json should exist"
        Assert-That ($state.result -eq "error") "state.result should be error, got $($state.result)"
        Assert-That ("$($state.error)".Contains($ExpectedErrorSubstring)) "state.error should contain '$ExpectedErrorSubstring', got: $($state.error)"
        Assert-That (-not "$($state.error)".Contains("Exception.Message")) "state.error must never contain the literal text Exception.Message"

        $rules = @(Read-CaseRules $caseDir)
        Assert-That ($rules.Count -eq 1) "expected only the pre-seeded fail-closed rule to remain, got $($rules.Count): $(($rules | ForEach-Object { $_.Name }) -join ',')"
        Assert-That ($rules[0].Name -eq "DevRelay-SandboxFailClosed-ipv4") "the fail-closed rule must survive a failed run, found instead: $($rules[0].Name)"
    }
}

Invoke-FailureInjectionCase -Name "e1: a throwing rule creation rolls back this run and keeps the fail-closed rule" -FailMode "throw" -ExpectedErrorSubstring "rule_creation_failed:"
Invoke-FailureInjectionCase -Name "e2: a silently-failing rule creation is caught by post-creation verification" -FailMode "silent" -ExpectedErrorSubstring "rule_verification_failed:"
Invoke-FailureInjectionCase -Name "e3: a non-terminating rule-creation error is escalated by -ErrorAction Stop" -FailMode "error" -ExpectedErrorSubstring "rule_creation_failed:"

# =============================================================================
# cases f1-f9: every rejection reason code, and that rejection changes no
# firewall rule and never echoes the raw rejected value back in state.json
# =============================================================================
function Invoke-RejectedCase {
    param([string]$Name, [string]$RequestContent, [string]$ExpectedReason, [string]$ForbiddenRawSnippet = $null, [string]$DenyContent = $null)
    Invoke-TestCase -Name $Name -Body {
        $caseDir = New-CaseDir ($Name -replace '[^a-zA-Z0-9]', '_')
        Write-AsciiFile -Path (Get-CaseRequestPath $caseDir) -Content $RequestContent
        if ($DenyContent) {
            Write-AsciiFile -Path (Get-CaseDenyPath $caseDir) -Content $DenyContent
        }
        Write-AsciiFile -Path (Join-Path $caseDir "stubs.ps1") -Content (Get-StubsScriptText -CaseDir $caseDir)
        $copy = New-ApplyScriptCopy -CaseDir $caseDir
        $result = Invoke-ApplyScript -CopyPath $copy -CaseDir $caseDir
        Assert-That ($result.ExitCode -eq 0) "expected exit code 0 for a rejected request, got $($result.ExitCode); stderr=$($result.Stderr); stdout=$($result.Stdout)"

        $state = Read-CaseState $caseDir
        Assert-That ($null -ne $state) "state.json should exist"
        Assert-That ($state.result -eq "rejected") "expected result=rejected, got $($state.result)"

        $rejected = @($state.rejected)
        Assert-That ($rejected.Count -ge 1) "expected at least one rejected entry"
        $matching = @($rejected | Where-Object { $_.reason -eq $ExpectedReason })
        Assert-That ($matching.Count -gt 0) "expected a rejected entry with reason=$ExpectedReason, got reasons: $(($rejected | ForEach-Object { $_.reason }) -join ',')"

        foreach ($r in $rejected) {
            $propNames = @($r | Get-Member -MemberType NoteProperty | Select-Object -ExpandProperty Name | Sort-Object)
            Assert-That ((($propNames -join ",")) -eq "index,reason") "a rejected entry should only have index/reason, got: $($propNames -join ',')"
        }

        $rules = @(Read-CaseRules $caseDir)
        Assert-That ($rules.Count -eq 0) "no firewall rule should be created for a rejected request, got $($rules.Count)"

        if ($ForbiddenRawSnippet) {
            $rawStateText = Get-Content -Path (Get-CaseStatePath $caseDir) -Raw
            Assert-That (-not $rawStateText.Contains($ForbiddenRawSnippet)) "state.json must not contain the raw rejected value '$ForbiddenRawSnippet'"
        }
    }
}

Invoke-RejectedCase -Name "f1: invalid_ip is rejected and the raw value never echoed" `
    -RequestContent '{"version":1,"destinations":[{"ip":"999.1.1.1","port":80}]}' `
    -ExpectedReason "invalid_ip" -ForbiddenRawSnippet "999.1.1.1"

Invoke-RejectedCase -Name "f2: invalid_port is rejected and the raw value never echoed" `
    -RequestContent '{"version":1,"destinations":[{"ip":"1.2.3.4","port":70000}]}' `
    -ExpectedReason "invalid_port" -ForbiddenRawSnippet "70000"

Invoke-RejectedCase -Name "f3: forbidden_range is rejected and the raw value never echoed" `
    -RequestContent '{"version":1,"destinations":[{"ip":"127.0.0.5","port":80}]}' `
    -ExpectedReason "forbidden_range" -ForbiddenRawSnippet "127.0.0.5"

Invoke-TestCase -Name "f4: too_many_destinations is rejected when over the limit" -Body {
    $entries = 1..21 | ForEach-Object { '{"ip":"10.0.1.' + $_ + '","port":80}' }
    $requestContent = '{"version":1,"destinations":[' + ($entries -join ',') + ']}'
    $caseDir = New-CaseDir "case_f4"
    Write-AsciiFile -Path (Get-CaseRequestPath $caseDir) -Content $requestContent
    Write-AsciiFile -Path (Join-Path $caseDir "stubs.ps1") -Content (Get-StubsScriptText -CaseDir $caseDir)
    $copy = New-ApplyScriptCopy -CaseDir $caseDir
    $result = Invoke-ApplyScript -CopyPath $copy -CaseDir $caseDir
    Assert-That ($result.ExitCode -eq 0) "expected exit code 0, got $($result.ExitCode); stderr=$($result.Stderr)"
    $state = Read-CaseState $caseDir
    Assert-That ($state.result -eq "rejected") "expected result=rejected, got $($state.result)"
    $matching = @($state.rejected | Where-Object { $_.reason -eq "too_many_destinations" })
    Assert-That ($matching.Count -gt 0) "expected a rejected entry with reason=too_many_destinations, got: $(($state.rejected | ForEach-Object { $_.reason }) -join ',')"
    $rules = @(Read-CaseRules $caseDir)
    Assert-That ($rules.Count -eq 0) "no firewall rule should be created, got $($rules.Count)"
}

Invoke-RejectedCase -Name "f5: unsupported_request_version is rejected" `
    -RequestContent '{"version":2,"destinations":[]}' `
    -ExpectedReason "unsupported_request_version"

Invoke-RejectedCase -Name "f6: invalid_json is rejected" `
    -RequestContent '{this is not valid json' `
    -ExpectedReason "invalid_json"

Invoke-TestCase -Name "f7: request_file_too_large is rejected" -Body {
    $padding = "A" * 70000
    $requestContent = '{"version":1,"destinations":[],"pad":"' + $padding + '"}'
    $caseDir = New-CaseDir "case_f7"
    Write-AsciiFile -Path (Get-CaseRequestPath $caseDir) -Content $requestContent
    Write-AsciiFile -Path (Join-Path $caseDir "stubs.ps1") -Content (Get-StubsScriptText -CaseDir $caseDir)
    $copy = New-ApplyScriptCopy -CaseDir $caseDir
    $result = Invoke-ApplyScript -CopyPath $copy -CaseDir $caseDir
    Assert-That ($result.ExitCode -eq 0) "expected exit code 0, got $($result.ExitCode); stderr=$($result.Stderr)"
    $state = Read-CaseState $caseDir
    Assert-That ($state.result -eq "rejected") "expected result=rejected, got $($state.result)"
    $matching = @($state.rejected | Where-Object { $_.reason -eq "request_file_too_large" })
    Assert-That ($matching.Count -gt 0) "expected a rejected entry with reason=request_file_too_large, got: $(($state.rejected | ForEach-Object { $_.reason }) -join ',')"
    $rawStateText = Get-Content -Path (Get-CaseStatePath $caseDir) -Raw
    Assert-That (-not $rawStateText.Contains("AAAA")) "state.json must not contain the oversized raw request content"
}

Invoke-RejectedCase -Name "f8: denied_destination is rejected and the raw value never echoed" `
    -RequestContent '{"version":1,"destinations":[{"ip":"1.2.3.4","port":5678}]}' `
    -ExpectedReason "denied_destination" -ForbiddenRawSnippet "1.2.3.4" `
    -DenyContent '{"destinations":["1.2.3.4:5678"]}'

Invoke-RejectedCase -Name "f9: invalid_entry_shape is rejected" `
    -RequestContent '{"version":1,"destinations":[{"port":80}]}' `
    -ExpectedReason "invalid_entry_shape"

# =============================================================================
# case g: request.json as a reparse point (symlink) must be rejected
# =============================================================================
Invoke-TestCase -Name "g: request.json as a symlink is rejected" -Body {
    $caseDir = New-CaseDir "case-g"
    $targetPath = Join-Path $caseDir "real-request.json"
    Write-AsciiFile -Path $targetPath -Content '{"version":1,"destinations":[]}'
    $linkPath = Get-CaseRequestPath $caseDir
    try {
        New-Item -ItemType SymbolicLink -Path $linkPath -Target $targetPath -ErrorAction Stop | Out-Null
    } catch {
        throw "SKIP: cannot create a symlink in this environment (non-administrator without Developer Mode?): $($_.Exception.Message)"
    }
    Write-AsciiFile -Path (Join-Path $caseDir "stubs.ps1") -Content (Get-StubsScriptText -CaseDir $caseDir)
    $copy = New-ApplyScriptCopy -CaseDir $caseDir
    $result = Invoke-ApplyScript -CopyPath $copy -CaseDir $caseDir
    Assert-That ($result.ExitCode -eq 0) "expected exit code 0, got $($result.ExitCode); stderr=$($result.Stderr); stdout=$($result.Stdout)"
    $state = Read-CaseState $caseDir
    Assert-That ($null -ne $state) "state.json should exist"
    Assert-That ($state.result -eq "rejected") "expected result=rejected, got $($state.result)"
    $matching = @($state.rejected | Where-Object { $_.reason -eq "request_file_is_reparse_point" })
    Assert-That ($matching.Count -gt 0) "expected a rejected entry with reason=request_file_is_reparse_point, got: $(($state.rejected | ForEach-Object { $_.reason }) -join ',')"
}

# =============================================================================
# summary
# =============================================================================
Write-Host ""
Write-Host "Results: $script:PassCount passed, $script:FailCount failed, $script:SkipCount skipped"
Write-Host "Temp root: $script:RootTestDir"

if ($script:FailCount -eq 0) {
    Remove-Item -Path $script:RootTestDir -Recurse -Force -ErrorAction SilentlyContinue
    exit 0
} else {
    Write-Host "(left in place for inspection because of the failure(s) above)"
    exit 1
}
