# =============================================================================
# DevRelay Sandbox allow-destinations reconciler (cycle SB-2.1)
# =============================================================================
#
# Runs as SYSTEM via the scheduled task "\DevRelay\apply-sandbox-allowlist"
# (registered by install-sandbox-host.ps1, ONSTART trigger) or on demand via
# "schtasks /Run /TN ...". It can also be invoked directly, once, by
# install-sandbox-host.ps1 itself (synchronously, as the installing
# administrator) right after being copied into place, so the dynamic firewall
# rule below is never left unmanaged between install and the first time the
# task actually fires.
#
# ASCII ONLY (same reason as install-sandbox-host.ps1 / uninstall-sandbox-host.ps1:
# Windows PowerShell 5.1 misreads a BOM-less UTF-8 file containing non-ASCII text
# as the active ANSI code page and fails with ParserError). This script is run
# from a local file path, exactly like those two, so it is exposed to the same
# bug class.
#
# ZERO ARGUMENTS. "schtasks /Run" has no mechanism to pass arguments, and
# "IRegisteredTask::Run" only substitutes "$(ArgN)" tokens when the task's own
# action literally contains them. This script therefore reads everything it
# needs from fixed files under C:\ProgramData\devrelay\sandbox\:
#   allowlist-deny\deny.json       (administrator-only; optional)
#   allowlist-request\request.json (developer-writable; strictly re-validated here)
# and writes:
#   allowlist-result\state.json    (SYSTEM/Administrators only; developer read-only)
#
# Firewall rule ownership is split with install-sandbox-host.ps1:
#   - install-sandbox-host.ps1 creates two STATIC rules whose content never
#     depends on the allow list: "Block IPv6 (all)" and "Allow loopback".
#   - THIS script owns the IPv4 "block everything except loopback and the
#     currently allowed destinations" rule, plus a per-destination TCP
#     port-complement rule and a single UDP block rule. These three kinds are
#     the only ones that depend on the allow list, so only they are tagged
#     with a generation digest in their rule Name. Switching generations
#     always creates the new (looser) generation BEFORE deleting the old
#     (stricter) one, so there is never a moment where less is blocked than
#     intended.
#   - Rule ownership matters because Windows Firewall ORs all matching Block
#     rules: if install-sandbox-host.ps1 kept its own separate, unconditional
#     "block all non-loopback IPv4" rule, nothing this script allows would
#     ever actually get through. That rule therefore no longer exists as a
#     static rule; it is only ever created here (digest-tagged), including
#     for the "nothing configured yet" bootstrap state (an empty allow set).
#
# Ping (ICMPv4) is intentionally NOT managed here, even for allowed
# destinations. Real-machine verification in cycle SB-1
# (doc/sandbox/SB-1_verification.md) found that ICMP echo is handled by the
# OS network stack in a way that is not reliably attributable to the virtual
# service account identity, so a per-identity firewall rule does not actually
# stop it. Only TCP (outside the allowed ports) and UDP to allowed
# destinations are blocked; ping to an allowed destination is not blocked by
# this mechanism (see doc/sandbox/SB-2.0_investigation.md decision 1 note).
#
# All-or-nothing validation: if any entry in request.json is rejected, NO
# firewall rule is changed at all (the previous generation stays exactly as
# it was) and state.json records only the index and a fixed reason code per
# rejected entry -- never the raw rejected value.
#
# Cycle SB-2.1.1 note: this script calls zero external commands (every
# firewall and ACL operation below uses a cmdlet, not an .exe), so it was
# never exposed to the NativeCommandError bug fixed in install/uninstall
# -sandbox-host.ps1 (see those files' headers). If a future change needs to
# invoke an external .exe-style command from this script, copy the
# Invoke-NativeCommand helper from install-sandbox-host.ps1 rather than
# calling the command bare with "2>$null" under $ErrorActionPreference =
# "Stop" -- that redirect does not prevent PowerShell 5.1 from turning
# stderr output into a terminating error.
#
# Cycle SB-2.1.2 note (hp630g9 real-machine bug): on Windows PowerShell 5.1,
# applying the array-subexpression operator "@( )" directly to a variable
# holding a System.Collections.Generic.List[object] throws
# "System.ArgumentException: Argument types do not match" (the binder's
# List<object>-only fast path builds an expression typed for the struct
# enumerator, which a downstream IEnumerator-typed helper then rejects).
# This is specific to List[object] held in a variable -- List[string]
# variables and @() applied to a pipeline/function-return value are both
# unaffected. Rule followed everywhere below: a List[object] never leaves
# the scope it was created in via "@($list)" or "$list | ..."; convert with
# ".ToArray()" (or keep it inside the same function) instead. Do not
# reintroduce "@($someListObjectVariable)" for a List[object] variable.
#
# Cycle SB-2.1.2 note (fail-closed): install-sandbox-host.ps1 creates a
# fixed-name rule, "DevRelay-SandboxFailClosed-ipv4", that blocks all IPv4
# except loopback, BEFORE it ever invokes this script. This script's job is
# to remove that rule -- but only once the new generation's rules (below)
# have been fully created. If anything in this script fails partway
# through, the fail-closed rule (and the previous generation) are left in
# place, so a broken reconciliation can never result in IPv4 being wide
# open. This script never creates DevRelay-SandboxFailClosed-ipv4 itself.
#
# Cycle SB-2.1.4 note (hp630g9 real-machine bug): on Windows PowerShell 5.1,
# "Group-Object -Property ip" and "Select-Object -ExpandProperty port" (or
# "-ExpandProperty ip") against an array of PLAIN HASHTABLES (the shape
# $destinations always is -- see "@{ ip = $ip; port = $port }" below) do NOT
# resolve the hashtable's keys as properties. Group-Object silently produces
# one group with an empty Name (no exception); Select-Object -ExpandProperty
# throws "PSArgumentException: Property ... port ... cannot be found" (this
# was the exact error reported from hp630g9 -- it happens to be the second of
# the two calls, so the first one's silent wrong answer was never seen). This
# is specific to Hashtable; it does not affect [pscustomobject] or real CIM
# objects (see the safe "-ExpandProperty Name" call against a real rule
# object returned by Get-NetFirewallRule -Group, elsewhere in this script).
# The per-destination TCP/UDP rule-building loop below therefore never uses Group-Object or
# -ExpandProperty on $destinations; it aggregates ports per IP with a plain
# foreach and direct ".ip" / ".port" member access instead (that member
# access DOES work on a hashtable in both PowerShell 5.1 and 7 -- only the
# cmdlet-level property *resolution* used by Group-Object/-ExpandProperty is
# the part that fails). Do not reintroduce Group-Object or -ExpandProperty
# against $destinations or anything derived from it.
#
# Cycle SB-2.1.3 note (hp630g9 real-machine bug, two independent failures):
# (1) ConvertFrom-Ipv4Value had a rounding bug (see that function's header)
# that made every IPv4 range string this script ever produced wrong; for the
# empty-allow-list case it produced an end-before-start range that
# New-NetFirewallRule rejected with CimException 0x80070057. (2) When that
# CimException was hit via a direct "&" invocation (as opposed to the
# "-File" invocation this script's own catch block was tested against), it
# did NOT terminate the script -- so the rest of the script treated the
# failed call as if it had succeeded and went on to delete the previous
# generation and the fail-closed rule, leaving IPv4 fully open. Fixed by (1)
# computing each octet independently instead of chaining divisions, (2) a
# round-trip self-check of every range string before use (Test-Ipv4RangeStringsSelfCheck),
# (3) pinning -ErrorAction Stop on every firewall-rule create/remove/query
# call so the outcome no longer depends on how this script was invoked, and
# (4) verifying every rule this generation needs is actually present (a
# fresh query, not trust in a cmdlet's own success) before deleting the
# previous generation or the
# fail-closed rule. Write-Error is no longer used anywhere in this script
# (see Format-ErrorCode's comment) because under $ErrorActionPreference =
# "Stop" it is itself a terminating error, which on hp630g9 masked the
# original CimException behind a WriteErrorException referencing the
# Write-Error call's own line number.
# =============================================================================

$ErrorActionPreference = "Stop"

# --- constants (must stay in sync with agents/linux/src/services/config.ts and
#     agents/linux/src/services/sandbox-allow-state.ts) ---
$ServiceName = "devrelay-sandbox"
$ServiceAccountName = "NT SERVICE\$ServiceName"
$ProgramDataDir = "C:\ProgramData\devrelay\sandbox"
$RequestJsonPath = Join-Path $ProgramDataDir "allowlist-request\request.json"
$StateJsonPath = Join-Path $ProgramDataDir "allowlist-result\state.json"
$DenyJsonPath = Join-Path $ProgramDataDir "allowlist-deny\deny.json"
$FirewallGroup = "DevRelay Sandbox"
# Must stay byte-identical to the same literal in install-sandbox-host.ps1
# (guarded by sandbox-scripts-guard.test.mjs E2/E3).
$FailClosedRuleName = "DevRelay-SandboxFailClosed-ipv4"
$SupportedRequestVersion = 1
$ReconcilerVersion = 1
$MaxDestinations = 20
$MaxRequestFileBytes = 65536

# Required directories must already exist with the correct ACLs (created by
# install-sandbox-host.ps1). This script never creates or widens them.
if (-not (Test-Path (Split-Path $StateJsonPath))) {
    # Cycle SB-2.1.3: Write-Error is never used in this script (see the F5 guard
    # and the "main" catch blocks below) -- under $ErrorActionPreference = "Stop"
    # it becomes a terminating WriteErrorException itself, which then masks
    # whatever the real problem was in any surrounding catch block. Write-Host
    # + an explicit exit code reports the same information without that risk.
    # (No exception was thrown here, so there is no InvocationInfo to report a
    # line number from; the message text itself identifies the exact check.)
    Write-Host "[ERROR] allowlist-result directory is missing: $(Split-Path $StateJsonPath). Re-run install-sandbox-host.ps1." -ForegroundColor Red
    exit 1
}

# -----------------------------------------------------------------------------
# IPv4 / port arithmetic helpers (uint64 throughout to avoid Int32 overflow;
# 255.255.255.255 = 4294967295 does not fit in a signed 32-bit integer).
# -----------------------------------------------------------------------------

function Test-StrictIpv4String {
    param([string]$Ip)
    if ($Ip -notmatch '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$') { return $false }
    foreach ($part in $Ip.Split('.')) {
        if ($part.Length -gt 1 -and $part.StartsWith('0')) { return $false }
        $n = [int]$part
        if ($n -lt 0 -or $n -gt 255) { return $false }
    }
    return $true
}

function ConvertTo-Ipv4Value {
    param([string]$Ip)
    [uint64]$value = 0
    foreach ($part in $Ip.Split('.')) {
        $value = ($value * 256) + [uint64]$part
    }
    return $value
}

function ConvertFrom-Ipv4Value {
    param([uint64]$Value)
    # Cycle SB-2.1.3 (hp630g9 real-machine bug): the previous implementation chained
    # three "$v = [uint64]($v / 256)" steps. PowerShell's "/" returns a Double when
    # the division is not exact, and Double -> [uint64] rounds to the nearest integer
    # (banker's rounding), not truncate -- so a remainder above 128 in one octet
    # carries a +1 into the next one. Example: 4294967295 (255.255.255.255) produced
    # "0.0.0.255" instead, which combined with the complement computation to emit a
    # "128.0.0.0-0.0.0.255" range string (end < start), rejected by New-NetFirewallRule
    # with CimException 0x80070057 on hp630g9. Each octet below is computed
    # independently via integer division ([math]::Floor on a Double that is always
    # exactly representable for inputs <= 4294967295, i.e. 2^32-1), so no octet's
    # rounding can ever affect another.
    $o1 = [uint64]([math]::Floor($Value / 16777216)) % 256
    $o2 = [uint64]([math]::Floor($Value / 65536)) % 256
    $o3 = [uint64]([math]::Floor($Value / 256)) % 256
    $o4 = $Value % 256
    return "$o1.$o2.$o3.$o4"
}

# Safety floor (D-3): destinations that make the allow-list feature itself
# meaningless or break the range math, independent of decision 0 (the company
# does not set an upper bound on what a developer may allow).
function Test-ForbiddenIpv4 {
    param([uint64]$Value)
    if ($Value -le [uint64]16777215) { return $true }                              # 0.0.0.0/8
    if ($Value -ge [uint64]2130706432 -and $Value -le [uint64]2147483647) { return $true }   # 127.0.0.0/8
    if ($Value -ge [uint64]2851995648 -and $Value -le [uint64]2852061183) { return $true }   # 169.254.0.0/16
    if ($Value -ge [uint64]3758096384 -and $Value -le [uint64]4026531839) { return $true }   # 224.0.0.0/4
    if ($Value -ge [uint64]4026531840 -and $Value -le [uint64]4294967295) { return $true }   # 240.0.0.0/4 (includes 255.255.255.255)
    return $false
}

function Test-DeniedDestination {
    param([string]$Ip, [int]$Port, $DenyEntries)
    foreach ($d in $DenyEntries) {
        if ($d -eq $Ip) { return $true }
        if ($d -eq "$Ip`:$Port") { return $true }
    }
    return $false
}

# Merge the loopback range and every allowed IP (as a /32) into sorted,
# merged "hole" ranges, then compute the IPv4-space complement of those
# holes (= the addresses this script's IPv4 rule must block).
function Get-Ipv4Complement {
    param([uint64[]]$AllowedValues)

    $holeList = New-Object System.Collections.Generic.List[object]
    $holeList.Add(@{ Start = [uint64]2130706432; End = [uint64]2147483647 }) # 127.0.0.0/8
    foreach ($v in $AllowedValues) {
        $holeList.Add(@{ Start = $v; End = $v })
    }
    # .ToArray() before the pipe: piping a List[object] variable directly is not
    # known to trigger the @() bug described above, but this script keeps a
    # single, simple rule (never hand a List[object] variable to anything outside
    # the function that created it except via .ToArray()) rather than relying on
    # a second, unverified claim about what PowerShell 5.1's pipeline does with it.
    $sorted = $holeList.ToArray() | Sort-Object { $_['Start'] }
    $merged = New-Object System.Collections.Generic.List[object]
    foreach ($r in $sorted) {
        $last = $null
        if ($merged.Count -gt 0) { $last = $merged[$merged.Count - 1] }
        if ($null -ne $last -and $r['Start'] -le ($last['End'] + 1)) {
            if ($r['End'] -gt $last['End']) { $last['End'] = $r['End'] }
        } else {
            $merged.Add(@{ Start = $r['Start']; End = $r['End'] })
        }
    }

    $complement = New-Object System.Collections.Generic.List[object]
    [uint64]$cursor = 0
    foreach ($h in $merged) {
        if ($h['Start'] -gt $cursor) {
            $complement.Add(@{ Start = $cursor; End = $h['Start'] - 1 })
        }
        if (($h['End'] + 1) -gt $cursor) { $cursor = $h['End'] + 1 }
    }
    if ($cursor -le [uint64]4294967295) {
        $complement.Add(@{ Start = $cursor; End = [uint64]4294967295 })
    }

    # SB-2.1.2: never hand a List[object] variable to the caller via "@()"
    # (see header note) -- .ToArray() instead. Merged/Complement are plain
    # object[] from here on; callers only ever foreach over them or read
    # .Count, so no caller change is needed.
    return @{ Merged = $merged.ToArray(); Complement = $complement.ToArray() }
}

# Self-check (B-4 safety net, mirrors the public-key blob validation in
# install-sandbox-host.ps1): verify the computed complement, together with
# the holes it was computed from, reconstructs the full IPv4 address space
# exactly, and that no complement range overlaps a hole. Abort (no firewall
# change) if this ever fails.
function Test-Ipv4ComplementSelfCheck {
    param($Merged, $Complement)
    [uint64]$totalComplement = 0
    foreach ($c in $Complement) { $totalComplement += ($c['End'] - $c['Start'] + 1) }
    [uint64]$totalMerged = 0
    foreach ($h in $Merged) { $totalMerged += ($h['End'] - $h['Start'] + 1) }
    if (($totalComplement + $totalMerged) -ne [uint64]4294967296) { return $false }

    foreach ($c in $Complement) {
        foreach ($h in $Merged) {
            if (-not ($c['End'] -lt $h['Start'] -or $c['Start'] -gt $h['End'])) { return $false }
        }
    }
    return $true
}

function Format-Ipv4RangeStrings {
    param($Ranges)
    $result = @()
    foreach ($r in $Ranges) {
        if ($r['Start'] -eq $r['End']) {
            $result += (ConvertFrom-Ipv4Value $r['Start'])
        } else {
            $result += "$(ConvertFrom-Ipv4Value $r['Start'])-$(ConvertFrom-Ipv4Value $r['End'])"
        }
    }
    return $result
}

# Cycle SB-2.1.3 (hp630g9 real-machine bug): round-trip every range string this
# script is about to hand to New-NetFirewallRule back through
# Test-StrictIpv4String + ConvertTo-Ipv4Value and verify it reconstructs the exact
# same Start/End the range math produced, with Start <= End. This is the only
# gate standing between a future formatting bug (of any kind, not just the
# specific rounding bug fixed above) and a malformed -RemoteAddress string, so it
# must run before the first New-NetFirewallRule call. On any mismatch, no
# firewall rule is touched.
function Test-Ipv4RangeStringsSelfCheck {
    param([string[]]$RangeStrings, $Ranges)
    if ($RangeStrings.Count -ne $Ranges.Count) { return $false }
    for ($i = 0; $i -lt $RangeStrings.Count; $i++) {
        $s = $RangeStrings[$i]
        $r = $Ranges[$i]
        if ($s -match '^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})-(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$') {
            $startStr = $Matches[1]; $endStr = $Matches[2]
        } elseif ($s -match '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$') {
            $startStr = $s; $endStr = $s
        } else {
            return $false
        }
        if (-not (Test-StrictIpv4String $startStr) -or -not (Test-StrictIpv4String $endStr)) { return $false }
        $startVal = ConvertTo-Ipv4Value $startStr
        $endVal = ConvertTo-Ipv4Value $endStr
        if ($startVal -gt $endVal) { return $false }
        if ($startVal -ne $r['Start'] -or $endVal -ne $r['End']) { return $false }
    }
    return $true
}

# Port complement over [1, 65535] for a single IP's allowed TCP ports.
function Get-PortComplementRanges {
    param([int[]]$AllowedPorts)
    $sorted = @($AllowedPorts | Sort-Object -Unique)
    $merged = New-Object System.Collections.Generic.List[object]
    foreach ($p in $sorted) {
        $last = $null
        if ($merged.Count -gt 0) { $last = $merged[$merged.Count - 1] }
        if ($null -ne $last -and $p -le ($last['End'] + 1)) {
            if ($p -gt $last['End']) { $last['End'] = $p }
        } else {
            $merged.Add(@{ Start = $p; End = $p })
        }
    }
    $complement = New-Object System.Collections.Generic.List[object]
    $cursor = 1
    foreach ($h in $merged) {
        if ($h['Start'] -gt $cursor) { $complement.Add(@{ Start = $cursor; End = $h['Start'] - 1 }) }
        if (($h['End'] + 1) -gt $cursor) { $cursor = $h['End'] + 1 }
    }
    if ($cursor -le 65535) { $complement.Add(@{ Start = $cursor; End = 65535 }) }
    $result = @()
    foreach ($c in $complement) {
        if ($c['Start'] -eq $c['End']) { $result += "$($c['Start'])" } else { $result += "$($c['Start'])-$($c['End'])" }
    }
    return $result
}

function Build-CanonicalString {
    param($Destinations)
    $sorted = $Destinations | Sort-Object @{Expression = { ConvertTo-Ipv4Value $_.ip } }, @{Expression = { $_.port } }
    $lines = @()
    foreach ($d in $sorted) { $lines += "$($d.ip):$($d.port)" }
    return ($lines -join "`n")
}

function Get-Sha256HexLower {
    param([string]$Text)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
        $hash = $sha256.ComputeHash($bytes)
        return -join ($hash | ForEach-Object { $_.ToString('x2') })
    } finally {
        $sha256.Dispose()
    }
}

# Cycle SB-2.1.3 (hp630g9 real-machine bug): a bare "Get-NetFirewallRule -Name
# $x -ErrorAction SilentlyContinue" was found, on at least one real-world call
# path, to not reliably stop script execution on a genuine query failure (the
# NetSecurity module's cmdlets resolve $ErrorActionPreference against their own
# module scope, not this script's scope, so the script-level "Stop" setting is
# not guaranteed to apply). Every firewall query in this script now goes
# through one of these two helpers, which both pin -ErrorAction Stop on the
# call itself (not relying on any ambient preference) and treat "the query
# itself failed" the same as "not found" -- i.e. fail closed: callers of
# Test-FirewallRuleExists must not delete anything a failed query could not
# positively rule out.
function Test-FirewallRuleExists {
    param([string]$Name)
    try {
        $rule = Get-NetFirewallRule -Name $Name -ErrorAction Stop
        return ($null -ne $rule)
    } catch {
        return $false
    }
}

function Get-FirewallRulesInGroup {
    try {
        return @(Get-NetFirewallRule -Group $FirewallGroup -ErrorAction Stop)
    } catch {
        return @()
    }
}

function Get-ManagedRuleNames {
    $rules = Get-FirewallRulesInGroup
    if (-not $rules -or $rules.Count -eq 0) { return @() }
    # SB-2.1.2: also report the fail-closed rule's survival (diagnostic only;
    # the Agent never validates or displays ruleNames shapes).
    return @($rules | Where-Object { $_.Name -like 'DevRelay-SandboxGen-*' -or $_.Name -eq $FailClosedRuleName } | Select-Object -ExpandProperty Name)
}

# state.json is written to a temp file in the same directory, then moved into
# place (Move-Item -Force is an atomic rename on the same volume). The Agent
# polls this file; it must never observe a half-written file.
function Write-SandboxAllowState {
    param([hashtable]$State)
    $json = $State | ConvertTo-Json -Depth 6
    $tmpPath = "$StateJsonPath.tmp-$PID-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
    [System.IO.File]::WriteAllText($tmpPath, $json)
    Move-Item -Path $tmpPath -Destination $StateJsonPath -Force
}

# SB-2.1.2: state.json's "error" field must be ASCII-only and must never
# contain the localized exception message or any input value -- only the
# exception's .NET type name (never localized) and the script line number
# it was thrown from, e.g. "System.ArgumentException at line 426". The
# on-screen Write-Host calls (SB-2.1.3: never Write-Error, see that cycle's
# header note) separately still show the full (possibly localized) message
# for human diagnosis; only state.json is restricted.
function Format-ErrorCode {
    param($ErrorRecord)
    $typeName = "UnknownException"
    $line = 0
    try {
        if ($ErrorRecord -and $ErrorRecord.Exception) { $typeName = $ErrorRecord.Exception.GetType().FullName }
        if ($ErrorRecord -and $ErrorRecord.InvocationInfo) { $line = [int]$ErrorRecord.InvocationInfo.ScriptLineNumber }
    } catch {
        # Even inspecting the error record failed; fall back to the defaults above.
    }
    $ascii = ($typeName -replace '[^A-Za-z0-9_.+]', '')
    if ($ascii.Length -gt 120) { $ascii = $ascii.Substring(0, 120) }
    if (-not $ascii) { $ascii = "UnknownException" }
    return "$ascii at line $line"
}

# -----------------------------------------------------------------------------
# main
# -----------------------------------------------------------------------------

try {
    # --- resolve the service SID ourselves; do not trust host.json ---
    try {
        $sidObj = (New-Object System.Security.Principal.NTAccount($ServiceAccountName)).Translate([System.Security.Principal.SecurityIdentifier])
        $ServiceSid = $sidObj.Value
    } catch {
        Write-SandboxAllowState @{
            reconcilerVersion = $ReconcilerVersion
            result            = "error"
            appliedAt         = [DateTimeOffset]::UtcNow.ToString("o")
            digest            = $null
            applied           = @()
            rejectedCount     = 0
            rejected          = @()
            ruleNames         = @(Get-ManagedRuleNames)
            error             = "could_not_resolve_service_sid"
        }
        exit 1
    }
    $LocalUserSddl = "D:(A;;CC;;;$ServiceSid)"

    # --- load the administrator-only deny list (optional, best-effort) ---
    $denyEntries = @()
    if (Test-Path $DenyJsonPath) {
        try {
            $denyRaw = Get-Content -Path $DenyJsonPath -Raw
            $denyParsed = $denyRaw | ConvertFrom-Json
            if ($denyParsed.destinations) {
                $denyEntries = @($denyParsed.destinations | ForEach-Object { [string]$_ })
            }
        } catch {
            Write-Host "[WARN] Could not parse deny.json, treating the deny list as empty." -ForegroundColor Yellow
            $denyEntries = @()
        }
    }

    # --- load and strictly re-validate the developer-writable request file ---
    $violations = New-Object System.Collections.Generic.List[object]
    $rawDestinations = @()
    $requestRejected = $false

    if (Test-Path $RequestJsonPath) {
        $item = Get-Item -Path $RequestJsonPath -Force -ErrorAction SilentlyContinue
        if ($item -and ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            $violations.Add(@{ index = -1; reason = "request_file_is_reparse_point" })
            $requestRejected = $true
        } elseif ($item -and $item.Length -gt $MaxRequestFileBytes) {
            $violations.Add(@{ index = -1; reason = "request_file_too_large" })
            $requestRejected = $true
        } else {
            $requestParsed = $null
            try {
                $requestRaw = Get-Content -Path $RequestJsonPath -Raw
                $requestParsed = $requestRaw | ConvertFrom-Json
            } catch {
                $violations.Add(@{ index = -1; reason = "invalid_json" })
                $requestRejected = $true
            }
            if (-not $requestRejected) {
                if ($requestParsed.version -ne $SupportedRequestVersion) {
                    $violations.Add(@{ index = -1; reason = "unsupported_request_version" })
                    $requestRejected = $true
                } elseif ($null -eq $requestParsed.destinations) {
                    $rawDestinations = @()
                } else {
                    $rawDestinations = @($requestParsed.destinations)
                }
            }
        }
    }

    # --- validate each entry (collect every violation; all-or-nothing) ---
    $validDestinations = New-Object System.Collections.Generic.List[object]
    if (-not $requestRejected) {
        $seenKeys = New-Object System.Collections.Generic.HashSet[string]
        for ($i = 0; $i -lt $rawDestinations.Count; $i++) {
            $entry = $rawDestinations[$i]
            if (-not $entry -or -not $entry.ip -or $null -eq $entry.port) {
                $violations.Add(@{ index = $i; reason = "invalid_entry_shape" })
                continue
            }
            $ip = [string]$entry.ip
            if (-not (Test-StrictIpv4String $ip)) {
                $violations.Add(@{ index = $i; reason = "invalid_ip" })
                continue
            }
            $portStr = "$($entry.port)"
            if ($portStr -notmatch '^\d+$') {
                $violations.Add(@{ index = $i; reason = "invalid_port" })
                continue
            }
            $port = [int]$portStr
            if ($port -lt 1 -or $port -gt 65535) {
                $violations.Add(@{ index = $i; reason = "invalid_port" })
                continue
            }
            $ipVal = ConvertTo-Ipv4Value $ip
            if (Test-ForbiddenIpv4 $ipVal) {
                $violations.Add(@{ index = $i; reason = "forbidden_range" })
                continue
            }
            if (Test-DeniedDestination -Ip $ip -Port $port -DenyEntries $denyEntries) {
                $violations.Add(@{ index = $i; reason = "denied_destination" })
                continue
            }
            $key = "$ip`:$port"
            if ($seenKeys.Contains($key)) { continue } # silent de-dup, not a violation
            [void]$seenKeys.Add($key)
            $validDestinations.Add(@{ ip = $ip; port = $port })
        }
        if ($validDestinations.Count -gt $MaxDestinations) {
            $violations.Add(@{ index = -1; reason = "too_many_destinations" })
        }
    }

    if ($violations.Count -gt 0) {
        # All-or-nothing: no firewall rule is touched. Report index + reason
        # code only -- never the rejected raw value.
        Write-SandboxAllowState @{
            reconcilerVersion = $ReconcilerVersion
            result            = "rejected"
            appliedAt         = [DateTimeOffset]::UtcNow.ToString("o")
            digest            = $null
            applied           = @()
            rejectedCount     = $violations.Count
            rejected          = $violations.ToArray()
            ruleNames         = @(Get-ManagedRuleNames)
            error             = $null
        }
        Write-Host "[REJECTED] $($violations.Count) entr(y/ies) rejected; firewall rules unchanged." -ForegroundColor Yellow
        exit 0
    }

    # --- compute the desired generation from the validated set (source of
    #     truth; the canonical/digest fields the Agent sent are informational
    #     only and are not trusted here) ---
    # SB-2.1.2: $validDestinations is a List[object]; "@($validDestinations)"
    # is exactly the pattern that threw "Argument types do not match" on
    # hp630g9 (see header note). .ToArray() instead.
    $destinations = $validDestinations.ToArray()
    $canonical = Build-CanonicalString -Destinations $destinations
    $digest = Get-Sha256HexLower -Text $canonical
    $gen = $digest.Substring(0, 12)

    # --- compute the IPv4 block complement and self-check it before touching
    #     any firewall rule ---
    $allowedValues = @($destinations | ForEach-Object { ConvertTo-Ipv4Value $_.ip })
    $ipv4 = Get-Ipv4Complement -AllowedValues $allowedValues
    if (-not (Test-Ipv4ComplementSelfCheck -Merged $ipv4['Merged'] -Complement $ipv4['Complement'])) {
        Write-SandboxAllowState @{
            reconcilerVersion = $ReconcilerVersion
            result            = "error"
            appliedAt         = [DateTimeOffset]::UtcNow.ToString("o")
            digest            = $null
            applied           = @()
            rejectedCount     = 0
            rejected          = @()
            ruleNames         = @(Get-ManagedRuleNames)
            error             = "self_check_failed"
        }
        Write-Host "[ERROR] IPv4 complement self-check failed. Aborting without changing any firewall rule." -ForegroundColor Red
        exit 1
    }
    # Wrap the function result with @() at the call site: PowerShell's
    # "return $array" unrolls a single-element array onto the output stream,
    # so a 1-range complement would otherwise arrive here as a bare scalar
    # string instead of a 1-element array (0 and 2+ elements are unaffected).
    $ipv4RangeStrings = @(Format-Ipv4RangeStrings -Ranges $ipv4['Complement'])

    # Cycle SB-2.1.3 (hp630g9 real-machine bug): round-trip every range string
    # before it is ever handed to New-NetFirewallRule (see the function's header
    # comment). This must run before the FIRST New-NetFirewallRule call below.
    if (-not (Test-Ipv4RangeStringsSelfCheck -RangeStrings $ipv4RangeStrings -Ranges $ipv4['Complement'])) {
        Write-SandboxAllowState @{
            reconcilerVersion = $ReconcilerVersion
            result            = "error"
            appliedAt         = [DateTimeOffset]::UtcNow.ToString("o")
            digest            = $null
            applied           = @()
            rejectedCount     = 0
            rejected          = @()
            ruleNames         = @(Get-ManagedRuleNames)
            error             = "range_format_self_check_failed"
        }
        Write-Host "[ERROR] IPv4 range string self-check failed. Aborting without changing any firewall rule." -ForegroundColor Red
        exit 1
    }

    # --- create the new generation's rules (idempotent: skip any rule whose
    #     exact Name already exists). Track what THIS run actually created so
    #     a failure partway through can be rolled back without touching the
    #     previous generation. $expectedRuleNames collects every rule name this
    #     generation needs regardless of whether it was created just now or
    #     already existed -- verified to actually exist (via a fresh firewall
    #     query, not by trusting the New-NetFirewallRule call's own return)
    #     before anything is deleted below. ---
    $createdThisRun = New-Object System.Collections.Generic.List[string]
    $expectedRuleNames = New-Object System.Collections.Generic.List[string]
    try {
        $ipv4RuleName = "DevRelay-SandboxGen-$gen-ipv4"
        $expectedRuleNames.Add($ipv4RuleName)
        if (-not (Test-FirewallRuleExists -Name $ipv4RuleName)) {
            New-NetFirewallRule -Name $ipv4RuleName -DisplayName "DevRelay Sandbox - Block IPv4 except allowed (gen $gen)" `
                -Group $FirewallGroup -Direction Outbound -LocalUser $LocalUserSddl -Action Block -Protocol Any `
                -RemoteAddress $ipv4RangeStrings -ErrorAction Stop | Out-Null
            $createdThisRun.Add($ipv4RuleName)
        }

        # SB-2.1.4: aggregate ports per IP with a plain foreach and direct
        # ".ip" / ".port" member access instead of Group-Object -Property /
        # Select-Object -ExpandProperty (see the cycle note at the top of
        # this file for why those two do not work against $destinations'
        # hashtable elements on Windows PowerShell 5.1). IPs are then
        # processed in ascending numeric order so that "tcp-<N>" is
        # deterministic for a given destination set, regardless of the order
        # entries appeared in request.json.
        $ipOrder = New-Object System.Collections.Generic.List[string]
        $portsByIp = @{}
        foreach ($d in $destinations) {
            if (-not $portsByIp.ContainsKey($d.ip)) {
                $portsByIp[$d.ip] = New-Object System.Collections.Generic.List[int]
                $ipOrder.Add($d.ip)
            }
            $portsByIp[$d.ip].Add($d.port)
        }
        # .ToArray() before Sort-Object: same "never hand a List[...] variable
        # to a pipeline via @() or |" rule as the SB-2.1.2 note above (applied
        # consistently even though List[string] itself is not known to be
        # affected by the underlying @() bug).
        $sortedIps = @($ipOrder.ToArray() | Sort-Object { ConvertTo-Ipv4Value $_ })

        $tcpIndex = 0
        foreach ($ipKey in $sortedIps) {
            $ports = $portsByIp[$ipKey].ToArray()
            # See the @() note above Format-Ipv4RangeStrings: same reason.
            $portComplement = @(Get-PortComplementRanges -AllowedPorts $ports)
            if ($portComplement.Count -gt 0) {
                $tcpRuleName = "DevRelay-SandboxGen-$gen-tcp-$tcpIndex"
                $expectedRuleNames.Add($tcpRuleName)
                if (-not (Test-FirewallRuleExists -Name $tcpRuleName)) {
                    New-NetFirewallRule -Name $tcpRuleName -DisplayName "DevRelay Sandbox - Block TCP except allowed ports for $ipKey (gen $gen)" `
                        -Group $FirewallGroup -Direction Outbound -LocalUser $LocalUserSddl -Action Block -Protocol TCP `
                        -RemoteAddress $ipKey -RemotePort $portComplement -ErrorAction Stop | Out-Null
                    $createdThisRun.Add($tcpRuleName)
                }
            }
            $tcpIndex++
        }

        if ($destinations.Count -gt 0) {
            $udpRuleName = "DevRelay-SandboxGen-$gen-udp"
            $expectedRuleNames.Add($udpRuleName)
            if (-not (Test-FirewallRuleExists -Name $udpRuleName)) {
                # $sortedIps already holds each IP exactly once (it was built
                # from $portsByIp's keys above), so no further de-dup is
                # needed here.
                New-NetFirewallRule -Name $udpRuleName -DisplayName "DevRelay Sandbox - Block UDP to allowed destinations (gen $gen)" `
                    -Group $FirewallGroup -Direction Outbound -LocalUser $LocalUserSddl -Action Block -Protocol UDP `
                    -RemoteAddress $sortedIps -ErrorAction Stop | Out-Null
                $createdThisRun.Add($udpRuleName)
            }
        }
    } catch {
        # Roll back only what THIS run created; the previous generation is
        # left exactly as it was (never a widening moment). $err is captured
        # first so rollback's own swallowed removals can't overwrite it.
        $err = $_
        foreach ($name in $createdThisRun) {
            try { Remove-NetFirewallRule -Name $name -ErrorAction Stop } catch { }
        }
        Write-SandboxAllowState @{
            reconcilerVersion = $ReconcilerVersion
            result            = "error"
            appliedAt         = [DateTimeOffset]::UtcNow.ToString("o")
            digest            = $null
            applied           = @()
            rejectedCount     = 0
            rejected          = @()
            ruleNames         = @(Get-ManagedRuleNames)
            error             = "rule_creation_failed: $(Format-ErrorCode $err)"
        }
        Write-Host "[ERROR] Firewall rule creation failed (line $($err.InvocationInfo.ScriptLineNumber)); rolled back this run's new rules. Previous generation left unchanged. $err" -ForegroundColor Red
        exit 1
    }

    # Cycle SB-2.1.3 (hp630g9 real-machine bug): verify every rule this
    # generation needs is actually present -- via a fresh firewall query, not
    # by trusting that the New-NetFirewallRule calls above didn't silently
    # fail -- BEFORE deleting the stale generation or the fail-closed
    # rule below. If even one is missing, delete nothing except what this run
    # just created; the previous generation and the fail-closed rule are left
    # standing exactly as they were.
    $missingRuleNames = @($expectedRuleNames.ToArray() | Where-Object { -not (Test-FirewallRuleExists -Name $_) })
    if ($missingRuleNames.Count -gt 0) {
        foreach ($name in $createdThisRun) {
            try { Remove-NetFirewallRule -Name $name -ErrorAction Stop } catch { }
        }
        Write-SandboxAllowState @{
            reconcilerVersion = $ReconcilerVersion
            result            = "error"
            appliedAt         = [DateTimeOffset]::UtcNow.ToString("o")
            digest            = $null
            applied           = @()
            rejectedCount     = 0
            rejected          = @()
            ruleNames         = @(Get-ManagedRuleNames)
            error             = "rule_verification_failed: $($missingRuleNames.Count) missing"
        }
        Write-Host "[ERROR] Rule verification failed after creation: $($missingRuleNames.Count) expected rule(s) not found. Rolled back this run's new rules; previous generation and fail-closed rule left unchanged." -ForegroundColor Red
        exit 1
    }

    # --- new generation fully created AND verified present: delete any OTHER
    #     generation now, AND remove the fail-closed rule install-sandbox-host.ps1
    #     created before ever invoking this script (SB-2.1.2). Both removals
    #     happen only here, after every new-generation rule above was confirmed
    #     to exist -- never before, and never inside a catch block above. ---
    $staleRules = @(Get-FirewallRulesInGroup | Where-Object { $_.Name -like 'DevRelay-SandboxGen-*' -and $_.Name -notlike "DevRelay-SandboxGen-$gen-*" })
    if ($staleRules.Count -gt 0) {
        $staleRules | Remove-NetFirewallRule -ErrorAction Stop
    }
    if (Test-FirewallRuleExists -Name $FailClosedRuleName) {
        Remove-NetFirewallRule -Name $FailClosedRuleName -ErrorAction Stop
    }

    Write-SandboxAllowState @{
        reconcilerVersion = $ReconcilerVersion
        result            = "ok"
        appliedAt         = [DateTimeOffset]::UtcNow.ToString("o")
        digest            = $digest
        applied           = @($destinations)
        rejectedCount     = 0
        rejected          = @()
        ruleNames         = @(Get-ManagedRuleNames)
        error             = $null
    }
    Write-Host "[OK] Applied generation $gen ($($destinations.Count) destination(s))." -ForegroundColor Green
    exit 0
} catch {
    # Last-resort catch: an unexpected exception anywhere above (including a
    # failure to delete the stale generation / fail-closed rule just above,
    # which is intentionally NOT swallowed -- the new generation's rules are
    # already verified present at that point, so the overall state stays safe
    # even if this report is "error" rather than "ok"). $err is captured
    # immediately so the best-effort inner Write-SandboxAllowState attempt
    # below can never overwrite it.
    $err = $_
    try {
        Write-SandboxAllowState @{
            reconcilerVersion = $ReconcilerVersion
            result            = "error"
            appliedAt         = [DateTimeOffset]::UtcNow.ToString("o")
            digest            = $null
            applied           = @()
            rejectedCount     = 0
            rejected          = @()
            ruleNames         = @(Get-ManagedRuleNames)
            error             = "unexpected_error: $(Format-ErrorCode $err)"
        }
    } catch {
        # Even state.json could not be written; nothing more we can do here.
    }
    # Cycle SB-2.1.3: Write-Error is never used in this script -- under
    # $ErrorActionPreference = "Stop" it becomes a terminating
    # WriteErrorException itself, which previously masked the real exception
    # (hp630g9: state.json recorded "WriteErrorException at line 578" instead
    # of the actual CimException). Write-Host reports the same information
    # without that risk.
    Write-Host "[ERROR] Unexpected error in apply-sandbox-allowlist.ps1 (line $($err.InvocationInfo.ScriptLineNumber)): $($err.Exception.Message)" -ForegroundColor Red
    exit 1
}
