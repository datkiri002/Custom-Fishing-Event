# run_p1_solo_tests.ps1 — manual test instructions cho 12 solo scenarios.
# In-game, làm theo thứ tự dưới đây. Mỗi scenario = 1 cast session. Sau khi
# xong, copy ContentLog vào working dir rồi chạy analyze_p1.ps1.
#
# Setup: World có 1 pond (water), 1 player ILwHee. 1 hook active = test.

$scenarios = @(
  @{ id="1_solo"; cast="Đứng yên, nhìn về pond, cast"; reel="Đợi hook vào nước, reel ngay" },
  @{ id="8_multi_session_same_p"; cast="Cast #1 → reel → cast #2 liên tục"; reel="Reel mỗi hook" },
  @{ id="9_same_tick_rapid"; cast="Bấm chuột phải 2-3 lần liên tục nhanh"; reel="Reel từng hook" },
  @{ id="10_player_running"; cast="Chạy tới pond, cast trong lúc chạy"; reel="Reel" },
  @{ id="11_player_jumping"; cast="Nhảy tại chỗ, cast khi đang trên không"; reel="Reel sau khi tiếp đất" },
  @{ id="12_player_turning"; cast="Xoay người 180° trong lúc cast"; reel="Reel" },
  @{ id="13_cast_immediate_reel"; cast="Cast → bấm chuột phải lại ngay (reel)"; reel="Reel ngay" },
  @{ id="14_old_hook_new_cast"; cast="Cast #1 (không reel) → cast #2"; reel="Reel #1 rồi #2" },
  @{ id="15_multi_active_hooks"; cast="Cast 2 lần liên tiếp, cả 2 active"; reel="Reel từng hook" },
  @{ id="16_hook_spawn_after_itemUse"; cast="Cast rồi đợi 2-3 tick, hook spawn sau"; reel="Reel" },
  @{ id="17_trajectory_distractor"; cast="Đứng cạnh player khác đang cast"; reel="Reel" },
  @{ id="18_ambiguous_near_equal"; cast="Cast 2 lần cách nhau 1 tick"; reel="Reel" }
)

Write-Host "===== P1 SOLO TEST INSTRUCTIONS =====" -ForegroundColor Cyan
Write-Host "Cast player_id: -8589934591 (ILwHee)"
Write-Host "12 scenarios. Mỗi scenario = 1 cast session."
Write-Host ""

for ($i = 0; $i -lt $scenarios.Count; $i++) {
  $s = $scenarios[$i]
  Write-Host ("[{0:D2}/{1}] {2}" -f ($i+1), $scenarios.Count, $s.id) -ForegroundColor Yellow
  Write-Host "  CAST:  $($s.cast)"
  Write-Host "  REEL:  $($s.reel)"
  Write-Host ""
}

Write-Host "===== SAU KHI CHẠY =====" -ForegroundColor Cyan
Write-Host "1. Copy ContentLog mới nhất vào working dir:"
Write-Host "   cp (Get-ChildItem 'C:\path\to\mcpelauncher\logs\ContentLog*' | Sort LastWriteTime | Select -Last 1).FullName ."
Write-Host "2. Chạy analyzer:"
Write-Host "   powershell -ExecutionPolicy Bypass -File analyze_p1.ps1 -LogFile 'ContentLog*.txt'"
Write-Host ""
Write-Host "Pass criteria:"
Write-Host "  precision >= 0.85"
Write-Host "  wrongOwnerRate <= 0.10"
Write-Host "  invariantViolations = 0"
