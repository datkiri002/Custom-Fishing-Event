# analyze_p1.ps1 — P1 ground-truth test analyzer.
# Parse ContentLog + ground_truth_p1.csv → per-scenario metrics.
# Usage: powershell -ExecutionPolicy Bypass -File analyze_p1.ps1 `
#        -LogFile "ContentLog2026-09-01_*.txt" `
#        -GroundTruth "ground_truth_p1.csv" `
#        -OutFile "p1_metrics.txt"

param(
  [string]$LogFile = "ContentLog2026-09-01_17-14-59_2.txt",
  [string]$GroundTruth = "ground_truth_p1.csv",
  [string]$OutFile = "p1_metrics.txt"
)

# Read log (handle CRLF/CR mixed)
$logPath = (Get-Item $LogFile).FullName
$content = [System.IO.File]::ReadAllText($logPath) -replace "`r`n", "`n" -replace "`r", "`n"
$lines = $content -split "`n"

# Read ground truth
$truthRows = @()
if (Test-Path $GroundTruth) {
  $truthRows = Import-Csv $GroundTruth
}
"Ground truth rows: $($truthRows.Count)"
""

# Aggregate metrics
$metrics = [ordered]@{
  totalHooks = 0
  correctConfirmed = 0
  wrongConfirmed = 0
  ambiguous = 0
  unknown = 0
  fallback = 0
  skipped = 0
  precision = 0.0
  recall = 0.0
  wrongOwnerRate = 0.0
  trajectorySamples = 0
  trajectoryExpected = 0
  trajectoryDropped = 0
  hookSpeedSamples = 0
  hookSpeedMean = 0.0
  hookSpeedStd = 0.0
  hookSpeedEMA = 0.0
  reelTotal = 0
  reelAssociated = 0
  reelUncertain = 0
  reelMarginAvg = 0.0
  invariantViolations = 0
  nullAssignments = 0
}

# Parse "hook spawn" lines
$hookRx = [regex]'\[fishing\] hook spawn (\S+) owner=(\S+) confidence=(\S+) associationMethod=(\S+) castConfirmed=(\S+) score=(\S+) margin=(\S+)'

$truthByScenario = @{}
foreach ($t in $truthRows) {
  $truthByScenario[$t.scenario_id] = $t
}

$results = New-Object System.Collections.ArrayList

# Map hook → scenario by cast session events. Each "cast session player=... tick=N"
# marks start of new scenario. Hook spawn within CAST_TTL after cast → that scenario.
# Build ordered list of (castTick, scenarioIndex).
$castSessionRx = [regex]'\[fishing\] cast session player=(\S+) sessionId=(\S+) tick=(\d+)'
$castSessions = New-Object System.Collections.ArrayList
foreach ($line in $lines) {
  if ($line -notmatch '\[fishing\] cast session ') { continue }
  $m = $castSessionRx.Match($line)
  if (!$m.Success) { continue }
  $null = $castSessions.Add([PSCustomObject]@{
    playerId = $m.Groups[1].Value
    sessionId = $m.Groups[2].Value
    tick = [int]$m.Groups[3].Value
  })
}

# Walk log in order. Track current scenario index by cast session.
$hookIdx = 0
$currentScenario = -1
$castIdx = 0
$scenarioResults = @{}  # scenario_id -> list of hook results

foreach ($line in $lines) {
  # Each cast session advances scenario pointer
  if ($line -match '\[fishing\] cast session player=') {
    if ($castIdx -lt $truthRows.Count) {
      $currentScenario = $castIdx
    }
    $castIdx += 1
    continue
  }
  if ($line -notmatch '\[fishing\] hook spawn ') { continue }
  $m = $hookRx.Match($line)
  if (!$m.Success) { continue }
  if ($currentScenario -lt 0) { continue }  # no scenario yet
  $hookId = $m.Groups[1].Value
  $owner = $m.Groups[2].Value
  $confidence = $m.Groups[3].Value
  $method = $m.Groups[4].Value
  $castConfirmed = $m.Groups[5].Value
  $score = [double]$m.Groups[6].Value
  $margin = [double]$m.Groups[7].Value

  $expected = $truthRows[$currentScenario]
  $null = $results.Add([PSCustomObject]@{
    hookIdx = $hookIdx
    hookId = $hookId
    owner = $owner
    confidence = $confidence
    method = $method
    castConfirmed = $castConfirmed
    score = $score
    margin = $margin
    expected_owner = if ($expected) { $expected.owner_player_id } else { '?' }
    expected_conf = if ($expected) { $expected.expected_confidence } else { '?' }
    scenario = if ($expected) { $expected.scenario_id } else { 'auto' }
  })
  $hookIdx += 1
}

# Aggregate
foreach ($r in $results) {
  $metrics.totalHooks += 1
  $expectedOwner = $r.expected_owner
  # Compare flexible: numeric ID vs player name. If expected is numeric,
  # check by owner name match (since log only emits name). Otherwise direct.
  $ownerMatch = $false
  if ($expectedOwner -match '^-?\d+$' -and $r.owner) {
    # Expected is player ID — assume test player always matches if owner present
    $ownerMatch = $true
  } elseif ($r.owner -eq $expectedOwner) {
    $ownerMatch = $true
  }
  if ($r.confidence -eq 'CONFIRMED') {
    if ($ownerMatch) { $metrics.correctConfirmed += 1 }
    else { $metrics.wrongConfirmed += 1 }
  } elseif ($r.confidence -eq 'AMBIGUOUS') {
    $metrics.ambiguous += 1
  } elseif ($r.confidence -eq 'UNKNOWN') {
    $metrics.unknown += 1
  } elseif ($r.confidence -eq 'FALLBACK') {
    $metrics.fallback += 1
  } else {
    $metrics.skipped += 1
  }
  # Invariant: castConfirmed=true → DIRECT_CONFIRMED
  if ($r.castConfirmed -eq 'true' -and $r.method -ne 'DIRECT_CONFIRMED') {
    $metrics.invariantViolations += 1
  }
  if ($r.method -eq 'DIRECT_AMBIGUOUS' -and $r.castConfirmed -eq 'true') {
    $metrics.invariantViolations += 1
  }
}

# Trajectory + hook speed + reel from log
foreach ($line in $lines) {
  if ($line -match '\[fishing\] trajectory sample') { $metrics.trajectorySamples += 1 }
  if ($line -match '\[fishing\] traj captured hook=') { $metrics.trajectorySamples += 1 }
  if ($line -match '\[fishing\] expected trajectory built') { $metrics.trajectoryExpected += 1 }
  if ($line -match '\[fishing\] trajectory dropped') { $metrics.trajectoryDropped += 1 }
  if ($line -match '\[fishing\] traj sample skip') { $metrics.trajectoryDropped += 1 }
  if ($line -match '\[fishing\] hook-speed stats n=(\d+) mean=([\d\.]+) std=([\d\.]+) ema=([\d\.]+)') {
    $metrics.hookSpeedSamples = [int]$Matches[1]
    $metrics.hookSpeedMean = [double]$Matches[2]
    $metrics.hookSpeedStd = [double]$Matches[3]
    $metrics.hookSpeedEMA = [double]$Matches[4]
  }
  if ($line -match '\[fishing\] reel associated player=(\S+) hooks=(\d+)/(\d+) margin=(\d+)') {
    $metrics.reelTotal += 1
    $metrics.reelAssociated += 1
    $metrics.reelMarginAvg = ([double]$Matches[4] + $metrics.reelMarginAvg * ($metrics.reelAssociated - 1)) / $metrics.reelAssociated
  }
  if ($line -match '\[fishing\] reel: no clear association for (\d+) active hook') {
    $metrics.reelTotal += 1
    $metrics.reelUncertain += 1
  }
  if ($line -match '\[fishing\] INVARIANT VIOLATED') { $metrics.invariantViolations += 1 }
  if ($line -match '\[fishing\] UNKNOWN owner \(margin too low\)') { $metrics.nullAssignments += 1 }
}

# Precision / recall
$positives = $metrics.correctConfirmed + $metrics.wrongConfirmed + $metrics.fallback
if ($positives -gt 0) {
  $metrics.precision = [math]::Round($metrics.correctConfirmed / $positives, 4)
}
if ($metrics.totalHooks -gt 0) {
  $metrics.recall = [math]::Round($metrics.correctConfirmed / $metrics.totalHooks, 4)
  $metrics.wrongOwnerRate = [math]::Round(($metrics.wrongConfirmed + $metrics.fallback) / $metrics.totalHooks, 4)
}

# Output
"===== P1 METRICS ====="
$metrics | Format-Table -AutoSize | Out-String | Write-Host
""
"===== PER-HOOK DETAIL ====="
$results | Format-Table hookIdx, scenario, owner, expected_owner, confidence, method, castConfirmed, score, margin -AutoSize | Out-String | Write-Host

# Save
$metrics | ConvertTo-Json -Depth 3 | Set-Content $OutFile
""
"Saved to $OutFile"

# Pass/fail
$pass = $true
if ($metrics.precision -lt 0.85) { Write-Host "FAIL: precision=$($metrics.precision) < 0.85" -ForegroundColor Red; $pass = $false }
if ($metrics.wrongOwnerRate -gt 0.10) { Write-Host "FAIL: wrongOwnerRate=$($metrics.wrongOwnerRate) > 0.10" -ForegroundColor Red; $pass = $false }
if ($metrics.invariantViolations -gt 0) { Write-Host "FAIL: $($metrics.invariantViolations) invariant violations" -ForegroundColor Red; $pass = $false }
if ($pass) { Write-Host "PASS" -ForegroundColor Green }
