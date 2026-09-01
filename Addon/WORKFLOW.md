# WORKFLOW — Stress Test Scenarios (A→Q + R→AP)

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

---

# Phase R→AP — Stage 2 + High-precision stress (33 scenarios)

Test plan bổ sung cho Stage 2 (item ↔ hook active correlation), cast/reel
discrimination, hook velocity calibration, density-adaptive threshold, NULL
assignment, cast exclusivity. Mỗi scenario tập trung 1 khía cạnh edge case
mà Stage 1 (A→Q) chưa cover.

Cấu trúc mỗi scenario giống A→Q: Setup / Action / Expected / Verify / Telemetry.

## Cast vs Reel discrimination (P1.5)

### R. Rod use khi hook đã active (REEL path, no new session)

| Field | Value |
|-------|-------|
| Setup | Cast, đợi hook spawn xong, đứng yên. |
| Action | Right-click Rod lần 2 (khi hook còn bay). |
| Expected | KHÔNG tạo CastSession mới. Trigger `reelSignal`. Session chuyển → `REEL_REQUESTED`. |
| Verify | `castSessionsByPlayer[player].length` KHÔNG tăng. |
| Causal | chain có `cast → hook_spawn → hook_active → reel` (không có `cast` thứ 2). |

### S. Rod use khi KHÔNG có active hook (CAST path)

| Field | Value |
|-------|-------|
| Setup | Đứng yên, chưa cast. |
| Action | Right-click Rod. |
| Expected | Tạo CastSession mới. Hook spawn. |
| Verify | `castSessionsByPlayer[player].length` +1. Causal chain có `cast → hook_spawn`. |

### T. Rapid cast (3 lần trong 1s, mỗi lần active hook đã remove)

| Field | Value |
|-------|-------|
| Setup | Đứng yên, hook cũ đã kết thúc. |
| Action | Cast 3 lần liên tiếp (đợi hook remove sau mỗi lần). |
| Expected | Mỗi lần = 1 CastSession riêng, sequenceId tăng 1-2-3. |
| Verify | `sequenceByPlayer[player]` = 3 sau test. |

### U. Rapid cast trong khi hook cũ còn active (chỉ lần 1 là cast, 2-3 là reel)

| Field | Value |
|-------|-------|
| Setup | Cast (hook active), tiếp tục right-click 2 lần ngay sau đó. |
| Expected | Lần 1 = CAST. Lần 2-3 = REEL candidates. Không cast mới. |
| Verify | `castSessionsByPlayer[player].length` = 1. |

## Hook trajectory time-series (P1.2)

### V. Hook bay đúng hướng, stable trajectory (high directionStability)

| Field | Value |
|-------|-------|
| Setup | Cast bình thường, hook bay thẳng về phía trước. |
| Expected | `directionStability` > 80. `velocityConsistency` > 70. |
| Telemetry | `trajectorySamplesTotal+3` (T0+T1+T2). |

### W. Hook bị block ngay sau spawn (low directionStability)

| Field | Value |
|-------|-------|
| Setup | Cast vào tường cách 2 blocks. |
| Expected | T1/T2 direction lệch mạnh → `directionStability` < 30. Score bị penalty. |
| Telemetry | `trajectorySamplesDropped+1` (nếu hook bị remove trước T2). |

### X. Hook remove trước T2 (incomplete trajectory)

| Field | Value |
|-------|-------|
| Setup | Cast, hook rơi xuống nước rồi bobber pickup ngay. |
| Expected | `samples.length` = 1 hoặc 2. Không crash. |
| Telemetry | `trajectorySamplesDropped+1`. |

## Hook velocity calibration (P1.4)

### Y. EMA calibration sau 5+ CONFIRMED hooks

| Field | Value |
|-------|-------|
| Setup | Cast 5 lần CONFIRMED liên tiếp. |
| Expected | `telemetryHookSpeedEMA` converges về giá trị thật của bobber. |
| Telemetry | `hookSpeedSamples+5`. |

### Z. Hook tĩnh (vel = 0) — early cast tick

| Field | Value |
|-------|-------|
| Setup | Cast, hook spawn nhưng velocity = 0 (vừa spawn 1 tick). |
| Expected | `CAST_HOOK_VEL_MIN` gate fail → score thấp nhưng không crash. |
| Verify | `evidence.hookVelocity` ≈ 0. Dùng expected 50 neutral. |

## Item ↔ Hook active correlation (P2.1)

### AA. Item spawn khi hook còn active (early bind)

| Field | Value |
|-------|-------|
| Setup | Cast, đợi hook spawn, đợi 1-2s, hook pickup → item spawn tại hook location. |
| Expected | `correlateItemToActiveHook` chạy. Score cao, margin cao → early bind. |
| Telemetry | `itemActiveCandidates+1, itemActiveMatched+1`. |
| Causal | chain có `... → item_spawn → hook_remove`. |

### AB. Item spawn ở dimension khác với hook

| Field | Value |
|-------|-------|
| Setup | Cast Overworld, teleport Nether, catch Nether. |
| Expected | `correlateItemToActiveHook` skip (dimension mismatch). Item không bind. |
| Verify | `itemActiveMatched` không tăng. |

### AC. 2 hooks active cùng lúc, item spawn giữa (uncertain)

| Field | Value |
|-------|-------|
| Setup | 2 player, mỗi người 1 hook, item spawn ở giữa cách đều. |
| Expected | Score cả 2 session gần nhau → margin < 100 → `UNCERTAIN`, không early bind. |
| Telemetry | `itemActiveUncertain+1`. |

### AD. Item spawn xa hook (> MAX_HOOK_TO_ITEM_DISTANCE * 1.5)

| Field | Value |
|-------|-------|
| Setup | Cast, hook pickup, teleport xa 30 blocks, item spawn. |
| Expected | Distance gate fail → skip. |
| Verify | `itemActiveCandidates` không tăng. |

## Item trajectory 3D (P2.2)

### AE. Item bay thẳng về player (high alignment)

| Field | Value |
|-------|-------|
| Setup | Hook pickup → item bay parabola về player. |
| Expected | `scoreActiveCorrelation` cao do trajectory alignment > 80. |
| Telemetry | `itemActiveMatched+1`. |

### AF. Item bobbing ngẫu nhiên (no direction)

| Field | Value |
|-------|-------|
| Setup | Item spawn với velocity ≈ 0 (rơi xuống đất). |
| Expected | Trajectory alignment = 0. Spatial + temporal vẫn pass. |
| Verify | Score giảm nhưng vẫn có thể match. |

## NULL assignment + density-adaptive threshold (P2.4)

### AG. Margin dưới CONFIRMED_MIN_MARGIN → UNKNOWN (NULL)

| Field | Value |
|-------|-------|
| Setup | 2 player gần nhau, cùng cast, cùng view. |
| Expected | Top score 700, second 650, margin 50 < CONFIRMED_MIN_MARGIN=150. → `UNKNOWN`. |
| Telemetry | `nullAssignments+1, unknown+1`. |

### AH. 3+ candidates, density bonus (margin tăng theo n-1)

| Field | Value |
|-------|-------|
| Setup | 3 player cùng cast cùng tick, cùng vị trí. |
| Expected | `requiredConfirmedMargin = 150 + (3-1)*25 = 200`. Margin thấp hơn → UNKNOWN. |
| Telemetry | `nullAssignments+1`. |

### AI. 1 candidate, margin 200, score 750 → CONFIRMED (no density bonus)

| Field | Value |
|-------|-------|
| Setup | Solo cast bình thường. |
| Expected | CONFIRMED. Margin cao. |
| Telemetry | `confirmed+1, directConfirmed+1`. |

## Cast exclusivity (P2.5)

### AJ. 2 hook spawn cùng tick, 2 session khác nhau (P2.5 hard rule)

| Field | Value |
|-------|-------|
| Setup | 2 session khác nhau (P1 cast, P2 cast), cùng tick spawn 2 hook gần nhau. |
| Expected | Mỗi hook bind 1 session, không share. `boundHookBySessionId.size` = 2. |
| Verify | `session.sessionId` của 2 hook khác nhau. |

### AK. Session cũ hết hạn, hook mới bind lại (cleanup)

| Field | Value |
|-------|-------|
| Setup | Cast, đợi > 3s (CAST_TTL_MS), cast lại. |
| Expected | Session cũ expire. Session mới bind. |
| Verify | `castSessionsByPlayer[player].length` không vượt quá 3 (TTL limit). |

## Causal chain log (P2.3)

### AL. Full chain: cast → spawn → active → reel → item → remove

| Field | Value |
|-------|-------|
| Setup | Cast, đợi hook spawn, đợi bobber, reel, catch item, hook remove. |
| Expected | Causal chain có 6 events theo thứ tự. |
| Verify | Log `causal chain hook=... events=6: cast → hook_spawn → hook_active → reel → item_spawn → hook_remove`. |

### AM. Empty reel: cast → spawn → active → remove (no item)

| Field | Value |
|-------|-------|
| Setup | Cast, hook pickup không có fish. |
| Expected | Causal chain: 4 events, không có `item_spawn` và `reel`. |
| Verify | `events=4: cast → hook_spawn → hook_active → hook_remove`. |

### AN. Cancelled by user (R-key): cast → spawn → active → remove

| Field | Value |
|-------|-------|
| Setup | Cast rồi switch slot khác (cancel). |
| Expected | Causal chain tương tự AM, hook bị remove bởi player. |
| Telemetry | `cancelled+1`. |

## Telemetry dashboard (P3)

### AO. Telemetry counters tổng hợp

| Counter | Mục đích | Mục tiêu |
|---------|----------|----------|
| `totalHooks` | Tổng hook xử lý | — |
| `confirmed` | Hook CONFIRMED | ≥ 0.7 (cast solo) |
| `ambiguous` | Hook AMBIGUOUS | ≤ 0.2 |
| `unknown` | Hook UNKNOWN | ≤ 0.1 |
| `fallback` | Hook FALLBACK | ≤ 0.1 |
| `directConfirmed` | DIRECT_CONFIRMED method | = confirmed |
| `directAmbiguous` | DIRECT_AMBIGUOUS method | = ambiguous |
| `tentative` | TENTATIVE (backfill) | ≤ 0.05 |
| `fallbackSem` | FALLBACK semantic | = fallback |
| `unknownSem` | UNKNOWN semantic | = unknown |
| `raceFixSynthetic` | Race fix v2 dùng synthetic session | phụ thuộc timing |
| `pendingBeforeEnqueued` | BEFORE snapshot push queue | = total casts |
| `pendingBeforeMatched` | BEFORE matched khi register | ≥ 0.95 (rest = race fix) |
| `pendingBeforeExpired` | BEFORE expire stale | ≤ 0.05 |
| `trajectorySamplesTotal` | T0+T1+T2 samples captured | ≥ 2.5 * totalHooks |
| `trajectorySamplesDropped` | Hook remove trước T2 | ≤ 0.3 * totalHooks |
| `hookSpeedSamples` | EMA update từ CONFIRMED | ≥ 0.7 * totalHooks |
| `itemActiveCandidates` | Item considered for early bind | — |
| `itemActiveMatched` | Item early-bound | ≥ 0.5 * itemActiveCandidates (khi active) |
| `itemActiveUncertain` | Item UNCERTAIN, skip | ≤ 0.3 * itemActiveCandidates |
| `nullAssignments` | UNKNOWN do margin thấp | ≤ 0.1 * totalHooks |

### AP. Ground truth comparison matrix

In-game test phải điền matrix:

| Scenario | Expected Owner | Actual Owner | Expected Confidence | Actual Confidence | Pass/Fail |
|----------|---------------|--------------|---------------------|-------------------|-----------|
| A | P1 | ___ | CONFIRMED | ___ | ___ |
| B | P1 (top) | ___ | CONFIRMED | ___ | ___ |
| ... | ... | ... | ... | ... | ... |
| R | (no cast) | ___ | (reel) | ___ | ___ |
| ... | ... | ... | ... | ... | ... |
| AL | P1 | ___ | CONFIRMED | ___ | ___ |

**Mục tiêu cuối cùng**:
- `correct owner / totalHooks` ≥ 0.85
- `wrong owner` = 0 (RIGHT > WRONG > UNRESOLVED)
- `null + unknown` ≤ 0.15
- Causal chain đầy đủ cho 100% Stage 2 catches (AA-AL).
