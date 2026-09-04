# fixture_gen.ps1 - synthetic ContentLog generator cho multi-player scenarios.
# Solo only environment -> multi-player scenarios (B, G, AC, AJ) can mock logs
# dua tren log format that. Tao fixture mo phong expected output tu
# WORKFLOW.md R->AP.

param(
  [string]$Scenario = "B_2p_same_tick",
  [string]$OutDir = "fixtures"
)

if (-not (Test-Path $OutDir)) {
  New-Item -ItemType Directory -Path $OutDir | Out-Null
}

$ts = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$outFile = Join-Path $OutDir "ContentLog_fixture_$Scenario`_$ts.txt"

# Common header
$hdr = @"
[Scripting][warning]-[fishing] beforeEvents.itemUse subscribed
[Scripting][warning]-[fishing] detector initialized v2026-09-02-p2-refine
"@

switch ($Scenario) {
  "B_2p_same_tick" {
    # WORKFLOW.md B: 2 player same-tick cast. Hook #1 CONFIRMED, hook #2 AMBIGUOUS.
    $body = @'
[Scripting][warning]-[fishing] cast session player=P1 sessionId=s1 tick=1000 consistency=100
[Scripting][warning]-[fishing] cast session player=P2 sessionId=s2 tick=1000 consistency=100
[Scripting][warning]-[fishing] session -100 player=-1111111111 CASTING->FISHING
[Scripting][warning]-[fishing] causal hook=-100 cast {"playerId":"-1111111111","sessionId":"s1","sequenceId":1,"synthetic":true,"tick":1000}
[Scripting][warning]-[fishing] hook spawn -100 owner=P1 confidence=CONFIRMED associationMethod=DIRECT_CONFIRMED castConfirmed=true score=750 margin=120 sT=100 sL=90 sD=100 kR=85 kD=80 kA=90 kS=70 mC=80 mT=70 mE=75 trajMatch=70
[Scripting][warning]-[fishing] session -101 player=-2222222222 CASTING->FISHING
[Scripting][warning]-[fishing] causal hook=-101 cast {"playerId":"-2222222222","sessionId":"s2","sequenceId":1,"synthetic":true,"tick":1000}
[Scripting][warning]-[fishing] hook spawn -101 owner=P2 confidence=AMBIGUOUS associationMethod=DIRECT_AMBIGUOUS castConfirmed=false score=680 margin=70 sT=100 sL=85 sD=100 kR=80 kD=75 kA=85 kS=65 mC=75 mT=65 mE=70 trajMatch=65
[Scripting][warning]-[fishing] causal chain hook=-100 events=6: cast -> hook_spawn -> hook_active -> reel -> hook_remove -> item_spawn
[Scripting][warning]-[fishing] causal chain hook=-101 events=6: cast -> hook_spawn -> hook_active -> reel -> hook_remove -> item_spawn
'@
  }
  "AC_2hooks_uncertain" {
    # AC: 2 hooks active, item spawn o giua -> UNCERTAIN
    $body = @'
[Scripting][warning]-[fishing] cast session player=P1 sessionId=s3 tick=2000 consistency=100
[Scripting][warning]-[fishing] cast session player=P2 sessionId=s4 tick=2000 consistency=100
[Scripting][warning]-[fishing] session -200 player=-1111111111 CASTING->FISHING
[Scripting][warning]-[fishing] causal hook=-200 cast {"playerId":"-1111111111","sessionId":"s3","sequenceId":1,"synthetic":true,"tick":2000}
[Scripting][warning]-[fishing] session -201 player=-2222222222 CASTING->FISHING
[Scripting][warning]-[fishing] causal hook=-201 cast {"playerId":"-2222222222","sessionId":"s4","sequenceId":1,"synthetic":true,"tick":2000}
[Scripting][warning]-[fishing] item minecraft:cod id=-202 active correlation UNCERTAIN best=1200 second=1150 margin=50
[Scripting][warning]-[fishing] causal chain hook=-200 events=4: cast -> hook_spawn -> hook_active -> hook_remove
[Scripting][warning]-[fishing] causal chain hook=-201 events=4: cast -> hook_spawn -> hook_active -> hook_remove
'@
  }
  "AG_margin_low" {
    # AG: 2 player same view, margin < CONFIRMED_MIN_MARGIN -> UNKNOWN
    $body = @'
[Scripting][warning]-[fishing] cast session player=P1 sessionId=s5 tick=3000 consistency=100
[Scripting][warning]-[fishing] session -300 player=-1111111111 CASTING->FISHING
[Scripting][warning]-[fishing] causal hook=-300 cast {"playerId":"-1111111111","sessionId":"s5","sequenceId":1,"synthetic":true,"tick":3000}
[Scripting][warning]-[fishing] UNKNOWN owner (margin too low), skip hook=-300 top.score=700 margin=50
'@
  }
  "AH_3p_density" {
    # AH: 3 player -> density bonus = 2*25 = 50, requiredConfirmedMargin = 200
    $body = @'
[Scripting][warning]-[fishing] cast session player=P1 sessionId=s6 tick=4000 consistency=100
[Scripting][warning]-[fishing] session -400 player=-1111111111 CASTING->FISHING
[Scripting][warning]-[fishing] causal hook=-400 cast {"playerId":"-1111111111","sessionId":"s6","sequenceId":1,"synthetic":true,"tick":4000}
[Scripting][warning]-[fishing] UNKNOWN owner (margin too low), skip hook=-400 top.score=750 margin=150
'@
  }
  "AL_full_chain" {
    # AL: Full causal chain
    $body = @'
[Scripting][warning]-[fishing] cast session player=P1 sessionId=s7 tick=5000 consistency=100
[Scripting][warning]-[fishing] session -500 player=-1111111111 CASTING->FISHING
[Scripting][warning]-[fishing] causal hook=-500 cast {"playerId":"-1111111111","sessionId":"s7","sequenceId":1,"synthetic":true,"tick":5000}
[Scripting][warning]-[fishing] hook spawn -500 owner=P1 confidence=CONFIRMED associationMethod=DIRECT_CONFIRMED castConfirmed=true score=2200 margin=2200 sT=100 sL=99 sD=100 kR=94 kD=84 kA=100 kS=99 mC=96 mT=78 mE=87 trajMatch=78
[Scripting][warning]-[fishing] causal chain hook=-500 events=6: cast -> hook_spawn -> hook_active -> reel -> hook_remove -> item_spawn
'@
  }
  "AM_empty_reel" {
    # AM: Cast + remove khong reel (empty reel)
    $body = @'
[Scripting][warning]-[fishing] cast session player=P1 sessionId=s8 tick=6000 consistency=100
[Scripting][warning]-[fishing] session -600 player=-1111111111 CASTING->FISHING
[Scripting][warning]-[fishing] causal hook=-600 cast {"playerId":"-1111111111","sessionId":"s8","sequenceId":1,"synthetic":true,"tick":6000}
[Scripting][warning]-[fishing] hook spawn -600 owner=P1 confidence=CONFIRMED associationMethod=DIRECT_CONFIRMED castConfirmed=true score=2100 margin=2100 sT=100 sL=99 sD=100 kR=94 kD=84 kA=100 kS=99 mC=96 mT=78 mE=87 trajMatch=78
[Scripting][warning]-[fishing] causal chain hook=-600 events=4: cast -> hook_spawn -> hook_active -> hook_remove
'@
  }
  default {
    Write-Host "Unknown scenario: $Scenario" -ForegroundColor Red
    Write-Host "Available: B_2p_same_tick, AC_2hooks_uncertain, AG_margin_low, AH_3p_density, AL_full_chain, AM_empty_reel"
    exit 1
  }
}

# Write
$content = $hdr + "`n" + $body + "`n"
Set-Content -Path $outFile -Value $content -Encoding UTF8
Write-Host "Generated fixture: $outFile" -ForegroundColor Green
Write-Host "Run analyzer: powershell -ExecutionPolicy Bypass -File analyze_full.ps1 -LogFile `"$outFile`""
