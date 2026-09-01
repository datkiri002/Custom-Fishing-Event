# WORKFLOW — Stress Test Scenarios (A→Q)

Manual test plan cho Stage 1 Cast→Hook association engine. 17 scenarios từ ChatGPT review v2.

Mục tiêu:
- **Right owner > wrong owner > unresolved owner** (ưu tiên giảm wrong owner, kể cả khi phải bỏ sót).
- Mỗi scenario xác minh: confidence state, evidence breakdown, telemetry counter.

## Setup

- Bedrock 1.26.33+, behavior pack load OK.
- `DEBUG = true` trong `config.js` → log evidence per hook.
- `WORLD_DIR/com.mojang/development_behavior_packs/Custom-Fishing-Event/scripts/`.
- Test trong singleplayer hoặc 2-player LAN.

---

## A. Solo cast (baseline CONFIRMED)

| Field | Value |
|-------|-------|
| Setup | 1 player, đứng yên trên bờ, nhìn thẳng xuống nước. |
| Action | Cast 1 lần. |
| Expected | `confidence=CONFIRMED`, score ≥ 900, no second candidate. |
| Evidence | T≈150, S≈200, R≈200, A≈150, H≈100, M≈100, B≈100. |
| Telemetry | `totalHooks+1, confirmed+1`. |

## B. 2 players cùng tick (1 CONFIRMED + 1 AMBIGUOUS)

| Field | Value |
|-------|-------|
| Setup | P1 + P2 cách 2 blocks, cùng nhìn pond. |
| Action | Cả 2 cast trong cùng 1 tick. |
| Expected | Hook sớm: `CONFIRMED` (top chênh projection). Hook sau: `AMBIGUOUS` (margin < 150). |
| Evidence | Top score 700-800, second 650-700, margin 50-100. |
| Telemetry | `confirmed+1, ambiguous+1`. |

## C. Cast khi đang chạy (FALLBACK)

| Field | Value |
|-------|-------|
| Setup | Player sprint + cast. |
| Expected | `score < 400` (playerMomentum=0, angular thấp) → `UNKNOWN` → fallback → `FALLBACK`. |
| Telemetry | `fallback+1`. |
| Verify | `session.associationMethod === 'FALLBACK'`. |

## D. Cast quay đầu 180° (UNKNOWN → FALLBACK)

| Field | Value |
|-------|-------|
| Setup | Player cast, quay đầu 180° ngay sau cast. |
| Expected | viewDir trước != viewDir sau. Hook bay theo trước. |
| Expected state | `UNKNOWN` (margin thấp) → `FALLBACK`. |

## E. Hook spawn sau cast > 2 ticks (skip candidate)

| Field | Value |
|-------|-------|
| Setup | Cast rồi đợi 3-4 tick trước khi hook bay. |
| Expected | Tick delta > `CAST_TO_HOOK_TICK_WINDOW=10`? Không, vẫn pass. Hook spawn 1-2 tick sau cast là bình thường. |
| Verify | Temporal score vẫn cao nếu delta < 10. |

## F. Hook bay ngược hướng view (UNKNOWN)

| Field | Value |
|-------|-------|
| Setup | Cast rồi ngay lập tức quay 180° → hook có thể bay lùi. |
| Expected | `projection < 0`, perpendicular cao → G4 reject. |
| State | `UNKNOWN` → fallback. |

## G. 2 players gần nhau, cùng view, hook rơi giữa (AMBIGUOUS)

| Field | Value |
|-------|-------|
| Setup | P1 + P2 đứng cạnh nhau, cùng nhìn pond, hook rơi chính giữa. |
| Expected | `AMBIGUOUS` (cả 2 candidate cùng score, margin < 150). |

## H. Player ở dimension khác

| Field | Value |
|-------|-------|
| Setup | P1 Overworld, P2 Nether. P1 cast → hook Overworld. |
| Expected | P2's session bị G1 reject (dimension mismatch). P1 được CONFIRMED. |
| Telemetry | P1 = `confirmed+1`, P2 session expire bình thường. |

## I. Pre-cast snapshot race (consistency < 50)

| Field | Value |
|-------|-------|
| Setup | Cast nhanh liên tục, before/after capture có thể miss. |
| Expected | `playerConsistency = 30` (fallback khi không có before). Total score giảm do `consistencyMultiplier < 1`. |
| Verify | `session.before === undefined`. |

## J. Multi-hook cùng session (TENTATIVE)

| Field | Value |
|-------|-------|
| Setup | Cast khiến game spawn 2 hook cùng tick. |
| Expected | Hook #1: `CONFIRMED`/AMBIGUOUS bình thường. Hook #2: backfill `TENTATIVE` (chỉ 1 hook, không upgrade). |
| Verify | `session.associationMethod === 'TENTATIVE'`. |
| Telemetry | `ambiguous+1` HOẶC `fallback+1` (không bao giờ `confirmed+1` cho backfill). |

## K. Bobber bay xa > 12 blocks (spatial fail)

| Field | Value |
|-------|-------|
| Setup | Cast mạnh, hook bay xa 15+ blocks. |
| Expected | G3 distance fail → candidate bị skip. UNKNOWN → fallback. |
| Verify | `score.spatial ≈ 0`. |

## L. Player disconnect giữa cast

| Field | Value |
|-------|-------|
| Setup | Cast → disconnect. |
| Expected | Session không có playerId hợp lệ → expire sau TTL. |
| Verify | Cleanup interval xoá session. |

## M. Cancel pickup trước khi catch (cancel priority)

| Field | Value |
|-------|-------|
| Setup | `beforeEvents.catch.subscribe` set `event.cancel = true`. |
| Expected | Không có diamond spawn từ consumer. `afterEvents.catch` không fire. |
| Verify | `cancelSignal` chạy, original entity bị kill. |

## N. Item spawn ở dimension khác

| Field | Value |
|-------|-------|
| Setup | Cast Overworld, teleport Nether → catch Nether. |
| Expected | Stage 1 OK (gán owner theo session ở Overworld). Stage 2 correlation thất bại (dimension mismatch). |

## O. Re-cast liên tục trong 3s (session pool)

| Field | Value |
|-------|-------|
| Setup | Cast 3 lần liên tục. |
| Expected | Pool có 3 session. Hook mới nhất luôn ưu tiên vì `castTick` mới nhất. |
| Verify | `selectBestCastSession` chọn session gần nhất (temporal cao nhất). |

## P. Hook velocity = 0 (vừa spawn 1 tick)

| Field | Value |
|-------|-------|
| Setup | Hook vừa spawn, `safeGetVelocity` trả 0. |
| Expected | `angularScore = rayScore` (fallback). `expectedScore = 50` (neutral). Score vẫn pass nếu spatial/ray cao. |

## Q. Player di chuyển giữa cast và hook spawn (playerConsistency penalty)

| Field | Value |
|-------|-------|
| Setup | Cast → chạy 5 blocks → hook spawn. |
| Expected | `positionDelta ≈ 5`. `playerConsistency` thấp. `consistencyMultiplier ≈ 0.5-0.7`. |
| State | CONFIRMED/AMBIGUOUS giảm khả năng, UNKNOWN/FALLBACK tăng. |

---

## Telemetry counters (verify in logs)

```js
telemetry.totalHooks     // tổng hooks xử lý
telemetry.confirmed      // CONFIRMED
telemetry.ambiguous      // AMBIGUOUS
telemetry.unknown        // UNKNOWN
telemetry.fallback       // FALLBACK (heuristic)
telemetry.skipped        // bỏ qua (cancel/timeout)
```

Mục tiêu trong 1 session test thường:
- `confirmed / totalHooks` ≥ 0.7 (cast solo yên tĩnh)
- `wrong owner` (nếu phát hiện khi review log) = 0
- `unknown + fallback` ≤ 0.3 (acceptable cho edge cases)

## Known limitations

- **Hook rotation/spin**: API không expose, skip.
- **Bobber trajectory time-series**: chỉ dùng velocity tại spawn, không lấy 2-5 tick sau.
- **ML/auto-tune weights**: weights hardcode, đủ evidence ở runtime.
- **Per-player confidence history**: không có, evidence 1 lần đủ.
