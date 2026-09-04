// @ts-check
// JSDoc types cho FishingEvent Detector.

/**
 * @typedef {import('@minecraft/server').Vector3} Vector3
 * @typedef {import('@minecraft/server').Player} Player
 * @typedef {import('@minecraft/server').Dimension} Dimension
 * @typedef {import('@minecraft/server').Entity} Entity
 */

/**
 * @typedef {'CASTING' | 'FISHING' | 'REEL_REQUESTED' | 'INVENTORY_CHANGED' | 'PENDING_RESULT' | 'SUCCESS' | 'CANCELLED' | 'EMPTY_REEL'} FishingState
 */

/**
 * @typedef {Object} Rotation
 * @property {number} yaw    Yaw angle (radian) từ viewDirection.x, z. atan2(-x, z).
 * @property {number} pitch  Pitch angle (radian) từ viewDirection.y. asin(-y).
 */

/**
 * Snapshot tại 1 thời điểm (Before hoặc After ItemUse). Lưu đầy đủ
 * location, head, viewDirection, rotation, velocity, time, tick.
 * @typedef {Object} CastSnapshot
 * @property {Vector3} location           Player feet location
 * @property {Vector3} headLocation       Player head location (getHeadLocation)
 * @property {Vector3} viewDirection      getViewDirection()
 * @property {Rotation} rotation         Yaw + pitch derived từ viewDirection
 * @property {Vector3} velocity           getVelocity()
 * @property {number} tick                system.currentTick
 * @property {number} time                Date.now() — bổ trợ/debug
 * @property {number} dimensionId         Dimension ID
 * @property {number} [sequenceId]        Per-player monotonic counter. Mỗi
 *                                        BEFORE ItemUse tạo 1 sequence mới
 *                                        (không overwrite). Dùng để match
 *                                        BEFORE→AFTER trong rapid cast /
 *                                        same-tick events.
 */

/**
 * CastSession — đối tượng trung tâm cho 1 lần Player dùng Fishing Rod.
 * Mỗi Rod use = 1 session. Nhiều session/player có thể tồn tại đồng thời.
 *
 * BEFORE snapshot từ beforeEvents.itemUse, AFTER từ afterEvents.itemUse
 * (link qua sessionId + playerId).
 *
 * DERIVED fields tính khi session hoàn chỉnh (before + after cùng có).
 * @typedef {Object} CastSession
 * @property {string} sessionId          Unique ID cho session
 * @property {string} playerId
 * @property {number} [sequenceId]        Kế thừa từ before.sequenceId. Dùng
 *                                        để disambiguate rapid cast / same-tick.
 * @property {string} dimensionId
 * @property {CastSnapshot} [before]     Snapshot tại beforeEvents.itemUse
 * @property {CastSnapshot} [after]      Snapshot tại afterEvents.itemUse
 * @property {number} [beforeAfterTimeDelta]  after.time - before.time (ms)
 * @property {number} [beforeAfterTickDelta]  after.tick - before.tick
 * @property {number} [positionDelta]    distance(before.location, after.location)
 * @property {number} [directionAngleDelta] angle giữa before.viewDirection và after.viewDirection (radian)
 * @property {number} [playerConsistency] 0-100, snapshot reliability
 *                                        (cao = before→after consistent, snapshot tin cậy)
 * @property {boolean} [synthetic]        True nếu session được build từ
 *                                        pending BEFORE (race case: hook
 *                                        spawn trước afterEvents.itemUse).
 *                                        Synthetic session KHÔNG push vào
 *                                        castSessionsByPlayer — chỉ dùng
 *                                        cho assessment on-the-fly.
 * @property {number} createdAt          Date.now() tạo session
 * @property {number} expiresAt          Date.now() hết hạn
 */

/**
 * @typedef {Object} FishingSession
 * @property {string} hookId
 * @property {string} playerId
 * @property {string} dimensionId
 * @property {string} [sessionId]            CastSession reference (nếu có direct association)
 * @property {'DIRECT_CONFIRMED' | 'DIRECT_AMBIGUOUS' | 'TENTATIVE' | 'FALLBACK' | 'UNKNOWN'} [associationMethod]
 *                                          Cách hook→player được xác định.
 *                                          P0 fix: tách DIRECT_CONFIRMED vs
 *                                          DIRECT_AMBIGUOUS để semantic rõ —
 *                                          AMBIGUOUS KHÔNG phải confirmed owner.
 * @property {Vector3} castLocation
 * @property {number} castTime
 * @property {number} castTick
 * @property {Vector3} [castViewDirection]  View direction từ beforeEvents.itemUse
 * @property {Vector3} [castPlayerVelocity]  Player velocity tại beforeEvents
 * @property {Vector3} hookLocation
 * @property {Vector3} [hookVelocity]  Hook velocity tại spawn time
 * @property {number} hookSpawnTime
 * @property {number} hookSpawnTick
 * @property {Vector3} lastKnownPlayerLocation
 * @property {boolean} castConfirmed          P0 fix: CHỈ true khi
 *                                            associationMethod = 'DIRECT_CONFIRMED'.
 *                                            AMBIGUOUS/TENTATIVE/FALLBACK/UNKNOWN
 *                                            → castConfirmed = false.
 * @property {boolean} inventoryChanged
 * @property {FishingState} state
 * @property {ConfidenceState} [confidence]  Owner confidence: CONFIRMED | AMBIGUOUS | FALLBACK | UNKNOWN
 * @property {EvidenceBreakdown} [evidence]  Evidence breakdown, populated khi DEBUG=true
 * @property {ItemCandidate[]} [itemCandidates]  P2.1: items đã early-bound khi
 *                                              hook còn active.
 */

/**
 * @typedef {Object} RemovedHook
 * @property {string} hookId
 * @property {string} playerId
 * @property {string} dimensionId
 * @property {Vector3} location
 * @property {Vector3} playerLocation
 * @property {number} removeTime
 * @property {number} removeTick
 * @property {number} expiresAt
 * @property {boolean} reelRequested
 * @property {boolean} inventoryChanged
 * @property {Vector3} [viewDirection]  View direction từ cast (beforeEvents.itemUse)
 * @property {Vector3} [hookVelocity]  Hook velocity tại spawn time
 * @property {boolean} [pickupCancelled]  True nếu pickup bị cancel bởi handler
 * @property {CaughtItem[]} items
 */

/**
 * @typedef {Object} ItemCandidate
 * @property {string} entityId
 * @property {string} itemTypeId
 * @property {string} dimensionId
 * @property {Vector3} location
 * @property {Vector3} velocity
 * @property {number} spawnTime
 * @property {number} spawnTick
 * @property {boolean} matched
 */

/**
 * Confidence state cho Cast → Hook owner association.
 * - CONFIRMED: top score cao + margin top-2 đủ lớn → owner chắc chắn.
 * - AMBIGUOUS: top score tạm được nhưng margin nhỏ → có thể nhầm.
 * - UNKNOWN: top score thấp hoặc không có candidate → cần fallback.
 * - FALLBACK: dùng heuristic (player gần + cast gần) thay vì evidence-based.
 * @typedef {'CONFIRMED' | 'AMBIGUOUS' | 'UNKNOWN' | 'FALLBACK'} ConfidenceState
 */

/**
 * Evidence breakdown cho 1 Cast → Hook hypothesis. P1.4: chia thành 3 group
 * để tránh double-count giữa viewDir/hookVel/hookLoc.
 * @typedef {Object} EvidenceBreakdown
 * @property {SpatialGroup} spatial        Location + drift (temporal, location, before/after drift)
 * @property {KinematicGroup} kinematic    Ray + direction + angular + speed fit
 * @property {ModelEvidence} model         Motion compensation + trajectory match
 * @property {number} total                Tổng weighted (0-1000)
 */

/**
 * Spatial evidence: thời gian + vị trí + player state drift.
 * @typedef {Object} SpatialGroup
 * @property {number} temporal             Cast time → hook spawn tick proximity (0-100)
 * @property {number} location             Cast location → hook location distance (0-100)
 * @property {number} beforeAfterDrift     Player state consistency (BEFORE→AFTER)
 */

/**
 * Kinematic evidence: ray + direction + angular + speed distribution fit.
 * @typedef {Object} KinematicGroup
 * @property {number} rayProjection        viewDir → hook ray perpendicular (0-100)
 * @property {number} directionError       viewDir → hook vector angle (0-100)
 * @property {number} angularAlignment     viewDir ↔ hookVelocity angle (0-100)
 * @property {number} hookSpeedFit         hookVelMag fit to expected distribution (0-100)
 */

/**
 * Model evidence: composite scoring từ physics model.
 * @typedef {Object} ModelEvidence
 * @property {number} motionCompensation   Predicted player@hookspawn vs hookLoc (0-100)
 * @property {number} trajectoryMatch      HookTrajectory.trajectoryMatchScore (0-100)
 * @property {number} expectedTrajectory   Composite (motion + trajectory) (0-100)
 */

/**
 * Kết quả đánh giá 1 CastSession → Hook hypothesis.
 * @typedef {Object} CastAssessment
 * @property {CastSession} session
 * @property {string} playerId
 * @property {ConfidenceState} confidence  Mặc định 'CONFIRMED', caller re-evaluate theo margin
 * @property {number} score
 * @property {EvidenceBreakdown} evidence
 * @property {number} [secondBestScore]   Best alternative's score
 * @property {number} [margin]            self.score - secondBestScore
 */

/**
 * @typedef {Object} CaughtItem
 * @property {string} entityId
 * @property {string} itemTypeId
 * @property {Vector3} location
 */

/**
 * HookTrajectory — time-series samples của hook motion sau spawn.
 * P1.2: capture T0 (spawn), T1 (+1 tick), T2 (+2 tick).
 * Soft evidence, không phải hard gate. Nếu hook bị remove trước T2 thì
 * dùng các sample đã có.
 * @typedef {Object} HookTrajectorySample
 * @property {number} tick
 * @property {number} time
 * @property {Vector3} location
 * @property {Vector3} velocity
 */

/**
 * @typedef {Object} HookTrajectory
 * @property {string} hookId
 * @property {HookTrajectorySample[]} samples
 * @property {ExpectedHookSample[]} expectedSamples  P1.2: model-derived expected trajectory
 * @property {number} directionStability    0-100, std của direction vectors
 * @property {number} velocityConsistency   0-100, std của |velocity|
 * @property {number} acceleration          approx Δvelocity/Δtick
 * @property {number} trajectoryDeviation   deviation so với expected cast trajectory
 * @property {number} expectedError         kinematic fit vs Before snapshot
 * @property {number} expectedPositionError  mean |observedPos - expectedPos| (block)
 * @property {number} expectedVelocityError  mean |observedVel - expectedVel| (m/s)
 * @property {number} expectedDirectionError mean angle (radian) between observed & expected vel
 * @property {number} trajectoryMatchScore  0-100, fit-to-model composite
 */

/**
 * @typedef {Object} ExpectedHookSample
 * @property {number} tick                  predicted tick (before.tick + offset)
 * @property {Vector3} expectedPos           predicted position (block)
 * @property {Vector3} expectedVel           predicted velocity (m/s)
 */

/**
 * @typedef {Object} FishingCatchEvent
 * @property {Player} player
 * @property {string} hookId
 * @property {CaughtItem[]} items
 * @property {Vector3} location
 * @property {Dimension} dimension
 * @property {number} tick
 * @property {number} timestamp
 */

/**
 * @typedef {Object} FishingCastEvent
 * @property {Player} player
 * @property {Vector3} location
 * @property {number} tick
 * @property {number} timestamp
 */

/**
 * @typedef {Object} FishingReelEvent
 * @property {Player} player
 * @property {string|undefined} hookId
 * @property {Vector3} location
 * @property {number} tick
 * @property {number} timestamp
 */

/**
 * @typedef {Object} FishingCancelEvent
 * @property {string|undefined} playerId
 * @property {string|undefined} hookId
 * @property {'EMPTY_REEL' | 'OWNER_GONE' | 'CANCELLED'} reason
 * @property {number} tick
 * @property {number} timestamp
 */

/**
 * FishingCatchBeforeEvent — phát ra TRƯỚC khi detector xử lý catch.
 * Subscriber có thể mutate event nhiều lần; CHỈ TRẠNG THÁI CUỐI CÙNG
 * (sau khi toàn bộ subscriber chain chạy xong) mới quyết định hành vi.
 *
 * Mutation hợp lệ:
 *  - `event.cancel = true`            → huỷ catch (kill gốc + cancelSignal)
 *  - `event.item = entityKhác (hợp lệ)` → thay thế entity gốc
 *  - `event.item = entityGốc`         → giữ nguyên
 *  - Không mutate gì                   → giữ nguyên
 *
 * Mutation KHÔNG hợp lệ (vanilla-style: bị ignore, có warning):
 *  - `event.item = null` / undefined / object không có `.id`
 *      → log warning + FALL BACK về entity gốc + afterEvents chạy bình thường
 *      (giống vanilla events khi set field sai: mutation bị ignore)
 *
 * Thứ tự ưu tiên khi detector áp dụng:
 *   1. `event.cancel === true`        → huỷ (kill gốc + cancelSignal, no afterEvents)
 *   2. `event.item` invalid (null)    → fall back về entity gốc (warning)
 *   3. `event.item !== originalItem`  → replace (kill gốc + auto-throw về player
 *                                       + afterEvents với item mới)
 *   4. `event.item === originalItem`  → keep (giữ gốc + afterEvents với item gốc)
 *
 * Khi gán `event.item` sang entity hợp lệ khác (case 3), detector tự động:
 *   1. Xoá entity gốc
 *   2. Bắn entity mới parabola về player (giả lập "thay đổi entity item cũ
 *      thành entity mới" — entity mới kế thừa vị trí + quỹ đạo)
 *   3. Fire afterEvents với entity mới
 *
 * Khi `event.cancel === true` (case 1):
 *   1. Xoá entity gốc
 *   2. Fire cancelSignal(reason='CANCELLED')
 *   3. KHÔNG fire afterEvents
 *
 * Subscriber CHỊU TRÁCH NHIỆM spawn/quản lý entity thay thế (nếu có).
 *
 * @typedef {Object} FishingCatchBeforeEvent
 * @property {Player} player
 * @property {Entity} item              Entity item gốc. Gán lại = thay thế.
 *                                      Gán null/undefined/object invalid = bị
 *                                      ignore (warning + dùng entity gốc).
 * @property {string} itemTypeId        typeId của item gốc (read-only).
 * @property {Vector3} location         Vị trí item gốc.
 * @property {Dimension} dimension
 * @property {string} hookId
 * @property {number} tick
 * @property {number} timestamp
 * @property {boolean} cancel           true = huỷ catch (ưu tiên cao nhất,
 *                                      kể cả khi đã gán event.item).
 */

export {};
