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
$SupportedRequestVersion = 1
$ReconcilerVersion = 1
$MaxDestinations = 20
$MaxRequestFileBytes = 65536

# Required directories must already exist with the correct ACLs (created by
# install-sandbox-host.ps1). This script never creates or widens them.
if (-not (Test-Path (Split-Path $StateJsonPath))) {
    Write-Error "allowlist-result directory is missing: $(Split-Path $StateJsonPath). Re-run install-sandbox-host.ps1."
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
    $v = $Value
    $o4 = $v % 256; $v = [uint64]($v / 256)
    $o3 = $v % 256; $v = [uint64]($v / 256)
    $o2 = $v % 256; $v = [uint64]($v / 256)
    $o1 = $v % 256
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
    $sorted = $holeList | Sort-Object { $_['Start'] }
    $merged = New-Object System.Collections.Generic.List[object]
    foreach ($r in $sorted) {
        if ($merged.Count -gt 0 -and $r['Start'] -le ($merged[$merged.Count - 1]['End'] + 1)) {
            if ($r['End'] -gt $merged[$merged.Count - 1]['End']) {
                $merged[$merged.Count - 1]['End'] = $r['End']
            }
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

    return @{ Merged = $merged; Complement = $complement }
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

# Port complement over [1, 65535] for a single IP's allowed TCP ports.
function Get-PortComplementRanges {
    param([int[]]$AllowedPorts)
    $sorted = @($AllowedPorts | Sort-Object -Unique)
    $merged = New-Object System.Collections.Generic.List[object]
    foreach ($p in $sorted) {
        if ($merged.Count -gt 0 -and $p -le ($merged[$merged.Count - 1]['End'] + 1)) {
            if ($p -gt $merged[$merged.Count - 1]['End']) { $merged[$merged.Count - 1]['End'] = $p }
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

function Get-ManagedRuleNames {
    $rules = Get-NetFirewallRule -Group $FirewallGroup -ErrorAction SilentlyContinue
    if (-not $rules) { return @() }
    return @($rules | Where-Object { $_.Name -like 'DevRelay-SandboxGen-*' } | Select-Object -ExpandProperty Name)
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
            rejected          = @($violations)
            ruleNames         = @(Get-ManagedRuleNames)
            error             = $null
        }
        Write-Host "[REJECTED] $($violations.Count) entr(y/ies) rejected; firewall rules unchanged." -ForegroundColor Yellow
        exit 0
    }

    # --- compute the desired generation from the validated set (source of
    #     truth; the canonical/digest fields the Agent sent are informational
    #     only and are not trusted here) ---
    $destinations = @($validDestinations)
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
        Write-Error "IPv4 complement self-check failed. Aborting without changing any firewall rule."
        exit 1
    }
    $ipv4RangeStrings = Format-Ipv4RangeStrings -Ranges $ipv4['Complement']

    # --- create the new generation's rules (idempotent: skip any rule whose
    #     exact Name already exists). Track what THIS run actually created so
    #     a failure partway through can be rolled back without touching the
    #     previous generation. ---
    $createdThisRun = New-Object System.Collections.Generic.List[string]
    try {
        $ipv4RuleName = "DevRelay-SandboxGen-$gen-ipv4"
        if (-not (Get-NetFirewallRule -Name $ipv4RuleName -ErrorAction SilentlyContinue)) {
            New-NetFirewallRule -Name $ipv4RuleName -DisplayName "DevRelay Sandbox - Block IPv4 except allowed (gen $gen)" `
                -Group $FirewallGroup -Direction Outbound -LocalUser $LocalUserSddl -Action Block -Protocol Any `
                -RemoteAddress $ipv4RangeStrings | Out-Null
            $createdThisRun.Add($ipv4RuleName)
        }

        $byIp = $destinations | Group-Object -Property ip
        $tcpIndex = 0
        foreach ($group in $byIp) {
            $ports = @($group.Group | Select-Object -ExpandProperty port)
            $portComplement = Get-PortComplementRanges -AllowedPorts $ports
            if ($portComplement.Count -gt 0) {
                $tcpRuleName = "DevRelay-SandboxGen-$gen-tcp-$tcpIndex"
                if (-not (Get-NetFirewallRule -Name $tcpRuleName -ErrorAction SilentlyContinue)) {
                    New-NetFirewallRule -Name $tcpRuleName -DisplayName "DevRelay Sandbox - Block TCP except allowed ports for $($group.Name) (gen $gen)" `
                        -Group $FirewallGroup -Direction Outbound -LocalUser $LocalUserSddl -Action Block -Protocol TCP `
                        -RemoteAddress $group.Name -RemotePort $portComplement | Out-Null
                    $createdThisRun.Add($tcpRuleName)
                }
            }
            $tcpIndex++
        }

        if ($destinations.Count -gt 0) {
            $udpRuleName = "DevRelay-SandboxGen-$gen-udp"
            if (-not (Get-NetFirewallRule -Name $udpRuleName -ErrorAction SilentlyContinue)) {
                $allIps = @($destinations | Select-Object -ExpandProperty ip -Unique)
                New-NetFirewallRule -Name $udpRuleName -DisplayName "DevRelay Sandbox - Block UDP to allowed destinations (gen $gen)" `
                    -Group $FirewallGroup -Direction Outbound -LocalUser $LocalUserSddl -Action Block -Protocol UDP `
                    -RemoteAddress $allIps | Out-Null
                $createdThisRun.Add($udpRuleName)
            }
        }
    } catch {
        # Roll back only what THIS run created; the previous generation is
        # left exactly as it was (never a widening moment).
        foreach ($name in $createdThisRun) {
            Remove-NetFirewallRule -Name $name -ErrorAction SilentlyContinue
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
            error             = "rule_creation_failed: $($_.Exception.Message)"
        }
        Write-Error "Firewall rule creation failed; rolled back this run's new rules. Previous generation left unchanged."
        exit 1
    }

    # --- new generation fully created: delete any OTHER generation now ---
    $staleRules = Get-NetFirewallRule -Group $FirewallGroup -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like 'DevRelay-SandboxGen-*' -and $_.Name -notlike "DevRelay-SandboxGen-$gen-*" }
    if ($staleRules) {
        $staleRules | Remove-NetFirewallRule -ErrorAction SilentlyContinue
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
} catch {
    # Last-resort catch: an unexpected exception anywhere above. Always try
    # to leave a state.json behind so the Agent can fail closed instead of
    # waiting indefinitely for a file that never appears.
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
            error             = "unexpected_error: $($_.Exception.Message)"
        }
    } catch {
        # Even state.json could not be written; nothing more we can do here.
    }
    Write-Error "Unexpected error in apply-sandbox-allowlist.ps1: $($_.Exception.Message)"
    exit 1
}
