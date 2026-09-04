# diagnose_log.ps1 - Auto-scan ContentLog for common issues.
# Usage: powershell -ExecutionPolicy Bypass -File diagnose_log.ps1 -LogFile <path>

param(
  [string]$LogFile = "ContentLog2026-09-02_18-10-33_2.txt",
  [string]$OutFile = ""
)

if (-not (Test-Path $LogFile)) {
  Write-Host "Log not found: $LogFile" -ForegroundColor Red
  exit 1
}

$content = [System.IO.File]::ReadAllText($LogFile) -replace "`r`n", "`n" -replace "`r", "`n"
$lines = $content -split "`n"

$diag = [ordered]@{
  totalHooks = 0
  lowTrajMatch = 0
  lowMTScore = 0
  lowKSScore = 0
  nullAssignments = 0
  invariantViolations = 0
  trajCaptured = 0
  trajDropped = 0
  causalChains = 0
  emptyReel = 0
  pickupCancels = 0
  preRemoveMatches = 0
  replSuccess = 0
  replMiss = 0
}

# Per-hook issue map
$perHook = @{}

foreach ($line in $lines) {
  if ($line -match '\[fishing\] hook spawn (\S+)') {
    $hk = $Matches[1]
    $diag.totalHooks += 1
    $perHook[$hk] = [PSCustomObject]@{
      hookId = $hk
      trajMatch = 0
      mT = 0
      kS = 0
      score = 0
      issues = @()
    }
    if ($line -match 'trajMatch=(\d+)') {
      $perHook[$hk].trajMatch = [int]$Matches[1]
      if ([int]$Matches[1] -lt 50) {
        $diag.lowTrajMatch += 1
        $perHook[$hk].issues += "trajMatch<50"
      }
    }
    if ($line -match 'mT=(\d+)') {
      $perHook[$hk].mT = [int]$Matches[1]
      if ([int]$Matches[1] -lt 70) {
        $diag.lowMTScore += 1
        $perHook[$hk].issues += "mT<70"
      }
    }
    if ($line -match 'kS=(\d+)') {
      $perHook[$hk].kS = [int]$Matches[1]
      if ([int]$Matches[1] -lt 30) {
        $diag.lowKSScore += 1
        $perHook[$hk].issues += "kS<30"
      }
    }
    if ($line -match 'score=(\d+)') { $perHook[$hk].score = [int]$Matches[1] }
  }
  if ($line -match '\[fishing\] UNKNOWN owner \(margin too low\)') {
    $diag.nullAssignments += 1
  }
  if ($line -match '\[fishing\] INVARIANT VIOLATED') {
    $diag.invariantViolations += 1
  }
  if ($line -match '\[fishing\] traj captured') {
    $diag.trajCaptured += 1
  }
  if ($line -match '\[fishing\] traj sample skip|\[fishing\] trajectory dropped') {
    $diag.trajDropped += 1
  }
  if ($line -match '\[fishing\] causal chain hook=.* events=') {
    $diag.causalChains += 1
  }
  if ($line -match '\[fishing\] EMPTY_REEL') {
    $diag.emptyReel += 1
  }
  if ($line -match '\[fishing\] pickup cancel') {
    $diag.pickupCancels += 1
  }
  if ($line -match '\[fishing\] causal hook=.* item_spawn.*postRemove":true') {
    $diag.preRemoveMatches += 1
  }
  if ($line -match '\[fishing\] SUCCESS.*replaced=true') {
    $diag.replSuccess += 1
  }
  if ($line -match '\[fishing\] SUCCESS.*primary=missing.*vanilla auto-pickup') {
    $diag.replMiss += 1
  }
}

# Output
"===== DIAGNOSTIC REPORT ====="
"Log: $LogFile"
""
"Counter                  | Value"
"-------------------------|------"
foreach ($k in $diag.Keys) {
  "{0,-25} | {1}" -f $k, $diag[$k]
}
""

# Issues
$issues = @()
if ($diag.invariantViolations -gt 0) { $issues += "INVARIANT violations ($($diag.invariantViolations)) - check castConfirmed/method mapping" }
if ($diag.nullAssignments -gt 0) { $issues += "NULL assignments ($($diag.nullAssignments)) - margin too low, tune CONFIRMED_MIN_MARGIN" }
if ($diag.totalHooks -gt 0 -and $diag.lowTrajMatch -gt ($diag.totalHooks * 0.5)) { $issues += ">50% low trajMatch - Bedrock bobber, position-only OK" }
if ($diag.totalHooks -gt 0 -and $diag.causalChains -lt $diag.totalHooks) { $issues += "causalChains ($($diag.causalChains)) < totalHooks ($($diag.totalHooks)) - some chains missing" }
if ($diag.trajDropped -gt $diag.trajCaptured) { $issues += "trajDropped > trajCaptured - hook removed before T1/T2 fire" }
if ($diag.replSuccess -eq 0 -and $diag.replMiss -gt 0) { $issues += "0 successful replacements but $diag.replMiss vanilla pickups - check beforeCatchSignal trigger" }

if ($issues.Count -eq 0) {
  Write-Host "NO ISSUES FOUND" -ForegroundColor Green
} else {
  Write-Host "ISSUES:" -ForegroundColor Yellow
  foreach ($i in $issues) { Write-Host "  - $i" -ForegroundColor Yellow }
}

# Per-hook table (only issues)
""
"===== HOOKS WITH ISSUES ====="
$withIssues = $perHook.Values | Where-Object { $_.issues.Count -gt 0 }
if ($withIssues.Count -eq 0) {
  Write-Host "  (none)" -ForegroundColor Green
} else {
  $withIssues | Format-Table hookId, score, mT, kS, trajMatch, @{N='issues';E={$_.issues -join ', '}} -AutoSize | Out-String | Write-Host
}

# Save
if ($OutFile) {
  $diag | ConvertTo-Json -Depth 3 | Set-Content $OutFile
  "Saved: $OutFile"
}
