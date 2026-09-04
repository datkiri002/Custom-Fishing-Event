# run_p3_tests.ps1 - P3 combined runner: solo re-test + fixtures + telemetry.
# 12 solo scenarios from ground_truth_p1.csv + 6 fixture scenarios (B, AC, AG, AH, AL, AM).
# All P3 verifications in one go.

param(
  [string]$LogFile = "ContentLog2026-09-02_18-10-33_2.txt",
  [string]$GroundTruth = "ground_truth_p1.csv",
  [string]$OutDir = "p3_results"
)

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }

$scenarios = @("B_2p_same_tick", "AC_2hooks_uncertain", "AG_margin_low", "AH_3p_density", "AL_full_chain", "AM_empty_reel")
$results = @()

"===== P3 SUITE START $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ====="
""

# 1. Real-log re-test (if exists)
if (Test-Path $LogFile) {
  "--- P3.0 Real log re-test: $LogFile ---"
  $realOut = Join-Path $OutDir "real_metrics.json"
  powershell -ExecutionPolicy Bypass -File "analyze_full.ps1" -LogFile $LogFile -GroundTruth $GroundTruth -OutFile $realOut
  $results += [PSCustomObject]@{ name = "real"; file = $LogFile; status = "ran" }
  ""
}

# 2. Fixture scenarios
foreach ($s in $scenarios) {
  "--- P3.1 Fixture: $s ---"
  $fix = powershell -ExecutionPolicy Bypass -File "fixture_gen.ps1" -Scenario $s 2>&1 | Out-String
  $fixPath = ($fix | Select-String -Pattern 'Generated fixture: (.*)').Matches.Groups[1].Value.Trim()
  if (-not (Test-Path $fixPath)) {
    Write-Host "FAIL: fixture not generated" -ForegroundColor Red
    $results += [PSCustomObject]@{ name = $s; file = ""; status = "fixture_missing" }
    continue
  }
  $out = Join-Path $OutDir "$s.json"
  powershell -ExecutionPolicy Bypass -File "analyze_full.ps1" -LogFile $fixPath -GroundTruth $GroundTruth -OutFile $out
  $results += [PSCustomObject]@{ name = $s; file = $fixPath; status = "ran" }
  ""
}

"===== P3 SUITE SUMMARY ====="
$results | Format-Table -AutoSize | Out-String | Write-Host
"Total scenarios: $($results.Count)"
"Results in: $OutDir"
"===== P3 SUITE END ====="
