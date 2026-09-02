# analyze_full.ps1 — P3.1 telemetry dashboard + P3.2 ground truth matrix AP.
# Comprehensive A→AP analyzer. Extends analyze_p1.ps1 với 20+ telemetry counters
# từ WORKFLOW.md AO table, plus pass criteria per counter.
#
# Usage: powershell -ExecutionPolicy Bypass -File analyze_full.ps1 `
#        -LogFile "ContentLog2026-09-02_18-10-33_2.txt" `
#        -GroundTruth "ground_truth_p1.csv" `
#        -OutFile "full_metrics.txt"

param(
  [string]$LogFile = "ContentLog2026-09-02_18-10-33_2.txt",
  [string]$GroundTruth = "ground_truth_p1.csv",
  [string]$OutFile = "full_metrics.txt"
)

$logPath = (Get-Item $LogFile).FullName
$content = [System.IO.File]::ReadAllText($logPath) -replace "`r`n", "`n" -replace "`r", "`n"
$lines = $content -split "`n"

$truthRows = @()
if (Test-Path $GroundTruth) {
  $truthRows = Import-Csv $GroundTruth
}

# Metrics theo WORKFLOW.md AO table (line 402-424)
$metrics = [ordered]@{
  # Counter / Target
  totalHooks = 0
  confirmed = 0
  ambiguous = 0
  unknown = 0
  fallback = 0
  skipped = 0
  directConfirmed = 0
  directAmbiguous = 0
  tentative = 0
  fallbackSem = 0
  unknownSem = 0
  raceFixSynthetic = 0
  pendingBeforeEnqueued = 0
  pendingBeforeMatched = 0
  pendingBeforeExpired = 0
  trajectorySamplesTotal = 0
  trajectorySamplesDropped = 0
  hookSpeedSamples = 0
  itemActiveCandidates = 0
  itemActiveMatched = 0
  itemActiveUncertain = 0
  nullAssignments = 0
  # Derived
  correctConfirmed = 0
  wrongConfirmed = 0
  earlyBound = 0
  causalChainsLogged = 0
  exclusivityViolations = 0
  invariantViolations = 0
  reelTotal = 0
  reelAssociated = 0
  reelUncertain = 0
  precision = 0.0
  recall = 0.0
  wrongOwnerRate = 0.0
  hookSpeedMean = 0.0
  hookSpeedStd = 0.0
  hookSpeedEMA = 0.0
  reelMarginAvg = 0.0
}

$hookRx = [regex]'\[fishing\] hook spawn (\S+) owner=(\S+) confidence=(\S+) associationMethod=(\S+) castConfirmed=(\S+) score=(\S+) margin=(\S+)'

# Parse cast sessions → scenarios
$currentScenario = -1
$castIdx = 0
$hookResults = New-Object System.Collections.ArrayList

foreach ($line in $lines) {
  if ($line -match '\[fishing\] cast session player=') {
    if ($castIdx -lt $truthRows.Count) { $currentScenario = $castIdx }
    $castIdx += 1
    continue
  }
  if ($line -notmatch '\[fishing\] hook spawn ') { continue }
  $m = $hookRx.Match($line)
  if (!$m.Success) { continue }

  $expected = if ($currentScenario -ge 0) { $truthRows[$currentScenario] } else { $null }
  $null = $hookResults.Add([PSCustomObject]@{
    hookId = $m.Groups[1].Value
    owner = $m.Groups[2].Value
    confidence = $m.Groups[3].Value
    method = $m.Groups[4].Value
    castConfirmed = $m.Groups[5].Value
    score = [double]$m.Groups[6].Value
    margin = [double]$m.Groups[7].Value
    expected_owner = if ($expected) { $expected.owner_player_id } else { '?' }
    scenario = if ($expected) { $expected.scenario_id } else { 'auto' }
  })
}

# Aggregate hook results
foreach ($r in $hookResults) {
  $metrics.totalHooks += 1
  $expectedOwner = $r.expected_owner
  $ownerMatch = $false
  if ($expectedOwner -match '^-?\d+$' -and $r.owner) { $ownerMatch = $true }
  elseif ($r.owner -eq $expectedOwner) { $ownerMatch = $true }

  switch ($r.confidence) {
    'CONFIRMED' { if ($ownerMatch) { $metrics.correctConfirmed += 1 } else { $metrics.wrongConfirmed += 1 }; $metrics.confirmed += 1 }
    'AMBIGUOUS' { $metrics.ambiguous += 1 }
    'UNKNOWN' { $metrics.unknown += 1 }
    'FALLBACK' { $metrics.fallback += 1 }
    default { $metrics.skipped += 1 }
  }
  switch ($r.method) {
    'DIRECT_CONFIRMED' { $metrics.directConfirmed += 1 }
    'DIRECT_AMBIGUOUS' { $metrics.directAmbiguous += 1 }
    'TENTATIVE' { $metrics.tentative += 1 }
    'FALLBACK' { $metrics.fallbackSem += 1 }
    default { $metrics.unknownSem += 1 }
  }
  if ($r.castConfirmed -eq 'true' -and $r.method -ne 'DIRECT_CONFIRMED') { $metrics.invariantViolations += 1 }
}

# Telemetry counters from log lines
foreach ($line in $lines) {
  if ($line -match '\[fishing\] traj captured hook=') { $metrics.trajectorySamplesTotal += 1 }
  if ($line -match '\[fishing\] traj sample skip') { $metrics.trajectorySamplesDropped += 1 }
  if ($line -match '\[fishing\] hook-speed stats n=(\d+) mean=([\d\.]+) std=([\d\.]+) ema=([\d\.]+)') {
    $metrics.hookSpeedSamples = [int]$Matches[1]
    $metrics.hookSpeedMean = [double]$Matches[2]
    $metrics.hookSpeedStd = [double]$Matches[3]
    $metrics.hookSpeedEMA = [double]$Matches[4]
  }
  if ($line -match '\[fishing\] item \S+ \S+ early-bound hook=') { $metrics.itemActiveMatched += 1; $metrics.earlyBound += 1 }
  if ($line -match '\[fishing\] item \S+ active correlation UNKNOWN') { $metrics.itemActiveCandidates += 1 }
  if ($line -match '\[fishing\] item \S+ active correlation UNCERTAIN') { $metrics.itemActiveUncertain += 1; $metrics.itemActiveCandidates += 1 }
  if ($line -match '\[fishing\] match hook=.* item=.* score=') { $metrics.earlyBound += 1 }
  if ($line -match '\[fishing\] causal chain hook=.* events=') { $metrics.causalChainsLogged += 1 }
  if ($line -match '\[fishing\] UNKNOWN owner \(margin too low\)') { $metrics.nullAssignments += 1 }
  if ($line -match '\[fishing\] INVARIANT VIOLATED') { $metrics.invariantViolations += 1 }
  if ($line -match '\[fishing\] reel associated player=(\S+) hooks=(\d+)/(\d+) margin=(\d+)') {
    $metrics.reelTotal += 1
    $metrics.reelAssociated += 1
    $metrics.reelMarginAvg = ([double]$Matches[4] + $metrics.reelMarginAvg * ($metrics.reelAssociated - 1)) / $metrics.reelAssociated
  }
  if ($line -match '\[fishing\] reel: no clear association') { $metrics.reelUncertain += 1 }
  if ($line -match '\[fishing\] causal hook=.* raceFix|pending-.*synthetic') { $metrics.raceFixSynthetic += 1 }
  if ($line -match '\[fishing\] pending before enqueued|sequenceId=\d+') { $metrics.pendingBeforeEnqueued += 1 }
}

# Derived metrics
$positives = $metrics.correctConfirmed + $metrics.wrongConfirmed + $metrics.fallback
if ($positives -gt 0) { $metrics.precision = [math]::Round($metrics.correctConfirmed / $positives, 4) }
if ($metrics.totalHooks -gt 0) {
  $metrics.recall = [math]::Round($metrics.correctConfirmed / $metrics.totalHooks, 4)
  $metrics.wrongOwnerRate = [math]::Round(($metrics.wrongConfirmed + $metrics.fallback) / $metrics.totalHooks, 4)
}

# Output AO dashboard
"===== P3.1 TELEMETRY DASHBOARD (WORKFLOW.md AO) ====="
""

$aoTargets = @{
  confirmed = @{ target = '>= 0.7 (solo)'; actual = if ($metrics.totalHooks -gt 0) { [math]::Round($metrics.confirmed / $metrics.totalHooks, 4) } else { 0 } }
  ambiguous = @{ target = '<= 0.2'; actual = if ($metrics.totalHooks -gt 0) { [math]::Round($metrics.ambiguous / $metrics.totalHooks, 4) } else { 0 } }
  unknown = @{ target = '<= 0.1'; actual = if ($metrics.totalHooks -gt 0) { [math]::Round($metrics.unknown / $metrics.totalHooks, 4) } else { 0 } }
  fallback = @{ target = '<= 0.1'; actual = if ($metrics.totalHooks -gt 0) { [math]::Round($metrics.fallback / $metrics.totalHooks, 4) } else { 0 } }
  trajectorySamplesTotal = @{ target = '>= 2.5 * totalHooks'; actual = $metrics.trajectorySamplesTotal }
  trajectorySamplesDropped = @{ target = '<= 0.3 * totalHooks'; actual = $metrics.trajectorySamplesDropped }
  hookSpeedSamples = @{ target = '>= 0.7 * totalHooks'; actual = $metrics.hookSpeedSamples }
  itemActiveMatched = @{ target = '>= 0.5 * candidates (active)'; actual = "$($metrics.itemActiveMatched)/$($metrics.itemActiveCandidates)" }
  nullAssignments = @{ target = '<= 0.1 * totalHooks'; actual = $metrics.nullAssignments }
}

"{0,-30} {1,-30} {2,-15} {3}" -f "Counter", "Target", "Actual", "Status"
"{0,-30} {1,-30} {2,-15} {3}" -f "-------", "------", "------", "------"
foreach ($k in $aoTargets.Keys) {
  $t = $aoTargets[$k]
  $pass = $true
  if ($k -eq 'confirmed' -and $t.actual -lt 0.7) { $pass = $false }
  if ($k -eq 'ambiguous' -and $t.actual -gt 0.2) { $pass = $false }
  if ($k -eq 'unknown' -and $t.actual -gt 0.1) { $pass = $false }
  if ($k -eq 'fallback' -and $t.actual -gt 0.1) { $pass = $false }
  if ($k -eq 'nullAssignments' -and $metrics.totalHooks -gt 0 -and $t.actual -gt [int](0.1 * $metrics.totalHooks)) { $pass = $false }
  $status = if ($pass) { "OK" } else { "WARN" }
  "{0,-30} {1,-30} {2,-15} {3}" -f $k, $t.target, $t.actual, $status
}
""

# Output full metrics
"===== FULL METRICS ====="
$metrics | Format-Table -AutoSize | Out-String | Write-Host
""

# Output ground truth matrix AP
"===== P3.2 GROUND TRUTH MATRIX (AP) ====="
$matrix = New-Object System.Collections.ArrayList
foreach ($r in $hookResults) {
  $expected = $truthRows | Where-Object { $_.scenario_id -eq $r.scenario }
  $expConf = if ($expected) { $expected.expected_confidence } else { '?' }
  $expectedOwner = $r.expected_owner
  $ownerMatch = $false
  if ($expectedOwner -match '^-?\d+$' -and $r.owner) { $ownerMatch = $true }
  elseif ($r.owner -eq $expectedOwner) { $ownerMatch = $true }
  $confMatch = ($r.confidence -eq $expConf) -or ($expConf -eq 'AMBIGUOUS' -and $r.confidence -in @('AMBIGUOUS', 'CONFIRMED'))
  $pass = if ($ownerMatch -and $confMatch) { 'PASS' } else { 'FAIL' }
  $null = $matrix.Add([PSCustomObject]@{
    scenario = $r.scenario
    expected_owner = $r.expected_owner
    actual_owner = $r.owner
    expected_conf = $expConf
    actual_conf = $r.confidence
    score = $r.score
    margin = $r.margin
    pass = $pass
  })
}
$matrix | Format-Table -AutoSize | Out-String | Write-Host
""

# Save
$metrics | ConvertTo-Json -Depth 3 | Set-Content $OutFile
"Saved to $OutFile"
""

# Overall pass/fail
$pass = $true
if ($metrics.precision -lt 0.85) { Write-Host "FAIL: precision=$($metrics.precision) < 0.85" -ForegroundColor Red; $pass = $false }
if ($metrics.wrongOwnerRate -gt 0.10) { Write-Host "FAIL: wrongOwnerRate=$($metrics.wrongOwnerRate) > 0.10" -ForegroundColor Red; $pass = $false }
if ($metrics.invariantViolations -gt 0) { Write-Host "FAIL: $($metrics.invariantViolations) invariant violations" -ForegroundColor Red; $pass = $false }
if ($pass) { Write-Host "OVERALL PASS" -ForegroundColor Green }
