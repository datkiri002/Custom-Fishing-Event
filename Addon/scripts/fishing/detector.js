// @ts-check
// FishingEvent Detector — hookId-first session model cho Bedrock Script API.
//
// ItemUse Rod
//   -> CastCandidate
//   -> fishing_hook spawn
//   -> HookSession (Map<hookId, Session> + Map<playerId, Set<hookId>>)
//   -> beforeEvents.entityRemove
//   -> PendingCatch
//   -> minecraft:item spawn
//   -> Correlation Engine
//   -> FishingCatchEvent

import { world, system } from '@minecraft/server';
import {
  CORRELATION_WINDOW_MS,
  MAX_HOOK_TO_ITEM_DISTANCE,
  MAX_ITEM_TO_PLAYER_DISTANCE,
  MAX_TICK_DELTA,
  MAX_TIME_DELTA_MS,
  MIN_TIME_DELTA_MS,
  MIN_CORRELATION_SCORE,
  SCORE_SESSION_ASSOCIATION,
  SCORE_TIME_PROXIMITY,
  SCORE_TICK_PROXIMITY,
  SCORE_HOOK_DISTANCE,
  SCORE_PLAYER_DISTANCE,
  SCORE_TRAJECTORY,
  SCORE_RAY_ALIGNMENT,
  SCORE_NEGATIVE_TRAJECTORY,
  CAST_TO_HOOK_TICK_WINDOW,
  CAST_TO_HOOK_DISTANCE,
  CAST_TTL_MS,
  MAX_ITEMS_PER_CATCH,
  ITEM_CANDIDATE_TTL_MS,
  CLEANUP_INTERVAL_TICKS,
  FALLBACK_OWNER_MAX_DISTANCE,
  FALLBACK_OWNER_MIN_SCORE,
  FALLBACK_OWNER_SCORE_MARGIN,
  ENABLE_PICKUP_INTERCEPTION,
  WEIGHT_TEMPORAL,
  WEIGHT_SPATIAL,
  WEIGHT_RAY_PROJECTION,
  WEIGHT_ANGULAR,
  WEIGHT_HOOK_VELOCITY,
  WEIGHT_PLAYER_MOMENTUM,
  CAST_DIRECTION_WEIGHT,
  CAST_EXPECTED_WEIGHT,
  CAST_RAY_MAX_PERPENDICULAR,
  CAST_HOOK_VEL_MIN,
  CAST_HOOK_VEL_EXPECT,
  CAST_PLAYER_SPEED_MAX,
  CAST_BEFORE_AFTER_MAX_DRIFT,
  CAST_ANGULAR_MAX_DEG,
  CONFIRMED_MIN_SCORE,
  CONFIRMED_MIN_MARGIN,
  AMBIGUOUS_MIN_SCORE,
  AMBIGUOUS_MIN_MARGIN,
  DEBUG,
  DEBUG_TO_CHAT,
} from './config.js';

/** @typedef {import('./types.js').CastSession} CastSession */
/** @typedef {import('./types.js').CastSnapshot} CastSnapshot */
/** @typedef {import('./types.js').Rotation} Rotation */
/** @typedef {import('./types.js').FishingSession} FishingSession */
/** @typedef {import('./types.js').RemovedHook} RemovedHook */
/** @typedef {import('./types.js').ItemCandidate} ItemCandidate */
/** @typedef {import('./types.js').CaughtItem} CaughtItem */
/** @typedef {import('./types.js').FishingCatchEvent} FishingCatchEvent */
/** @typedef {import('./types.js').FishingCatchBeforeEvent} FishingCatchBeforeEvent */
/** @typedef {import('./types.js').FishingState} FishingState */
/** @typedef {import('./types.js').ConfidenceState} ConfidenceState */
/** @typedef {import('./types.js').EvidenceBreakdown} EvidenceBreakdown */
/** @typedef {import('./types.js').CastAssessment} CastAssessment */
/** @typedef {import('@minecraft/server').Entity} Entity */
/** @typedef {import('@minecraft/server').Player} Player */

/** @template T */
export class FishingEventSignal {
  constructor() {
    /** @type {Set<(payload: T) => void>} */
    this._subs = new Set();
  }

  /** @param {(payload: T) => void} cb */
  subscribe(cb) {
    this._subs.add(cb);
    return () => this._subs.delete(cb);
  }

  /** @param {T} payload */
  trigger(payload) {
    for (const cb of [...this._subs]) {
      try {
        cb(payload);
      } catch (e) {
        console.warn(`[fishing] subscriber error: ${e}`);
      }
    }
  }
}

/** hookId -> session */
const sessionsByHook = new Map();
/** playerId -> Set<hookId> */
const hooksByPlayer = new Map();
/** playerId -> CastSession[] (mỗi Rod use = 1 session) */
const castSessionsByPlayer = new Map();
/** sessionId -> CastSession (lookup nhanh) */
const castSessionsById = new Map();
/** playerId -> CastSnapshot (BEFORE snapshot chờ AFTER event) */
const pendingBeforeSnapshots = new Map();
/** hookId -> removed hook awaiting item correlation */
const pending = new Map();
/** entityId -> item candidate */
const itemCandidates = new Map();

/** Counter cho sessionId duy nhất */
let sessionIdCounter = 0;
function newSessionId() {
  sessionIdCounter += 1;
  return `s${sessionIdCounter}`;
}

export const catchSignal = new FishingEventSignal();
export const castSignal = new FishingEventSignal();
export const reelSignal = new FishingEventSignal();
export const cancelSignal = new FishingEventSignal();
export const beforeCatchSignal = new FishingEventSignal();

// ===== Telemetry counters (precision/recall tracking) =====
const telemetry = {
  totalHooks: 0,
  confirmed: 0,
  ambiguous: 0,
  unknown: 0,
  fallback: 0,
  skipped: 0,
};

/** @param {string} msg @param {string|undefined} [ownerId] */
function log(msg, ownerId) {
  if (!DEBUG) return;
  const line = `[fishing] ${msg}`;
  console.warn(line);
  if (DEBUG_TO_CHAT && ownerId) {
    const player = world.getEntity(ownerId);
    if (player && player.typeId === 'minecraft:player') {
      player.sendMessage(`§7${line}`);
    }
  }
}

/** @param {FishingSession} session @param {FishingState} next */
function transition(session, next) {
  log(`session ${session.hookId} player=${session.playerId} ${session.state}→${next}`, session.playerId);
  session.state = next;
}

/** @param {{x:number,y:number,z:number}} vec */
function cloneVector(vec) {
  return { x: vec.x, y: vec.y, z: vec.z };
}

/** @param {{x:number,y:number,z:number}} a @param {{x:number,y:number,z:number}} b */
function distance3D(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** @param {{x:number,y:number,z:number}} vec */
function magnitude3D(vec) {
  return Math.sqrt(vec.x * vec.x + vec.y * vec.y + vec.z * vec.z);
}

/** @param {{x:number,y:number,z:number}} vec */
function normalize3D(vec) {
  const mag = magnitude3D(vec);
  if (mag < 0.0001) {
    return { x: 0, y: 0, z: 0 };
  }
  return { x: vec.x / mag, y: vec.y / mag, z: vec.z / mag };
}

/** @param {{x:number,y:number,z:number}} a @param {{x:number,y:number,z:number}} b */
function dot3D(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/**
 * Bắn item theo quỹ đạo parabola về phía player. Utility cho subscriber
 * dùng trong beforeEvents handler (hoặc bất kỳ đâu cần ném item về người chơi).
 * @param {Entity} item
 * @param {Player} player
 */
export function throwItemToPlayer(item, player) {
  const from = item.location;
  const to = player.location;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const horizontalDistance = Math.sqrt(dx * dx + dz * dz);
  if (horizontalDistance < 0.01) return;

  const flightTime = 12;
  const gravity = 0.08;
  const dirX = dx / horizontalDistance;
  const dirZ = dz / horizontalDistance;
  const horizontalSpeed = horizontalDistance / flightTime;
  const verticalSpeed = (dy + 0.5 * gravity * flightTime * flightTime) / flightTime;

  try { item.clearVelocity(); } catch { /* ignore */ }
  try {
    item.applyImpulse({
      x: dirX * horizontalSpeed,
      y: verticalSpeed,
      z: dirZ * horizontalSpeed,
    });
  } catch { /* ignore */ }
}

/** @param {string} playerId */
function getSessionsForPlayer(playerId) {
  const hookIds = hooksByPlayer.get(playerId);
  if (!hookIds) return [];

  /** @type {FishingSession[]} */
  const result = [];
  for (const hookId of hookIds) {
    const session = sessionsByHook.get(hookId);
    if (session) result.push(session);
  }
  return result;
}

/** @param {FishingSession} session */
function trackSession(session) {
  sessionsByHook.set(session.hookId, session);
  let hookIds = hooksByPlayer.get(session.playerId);
  if (!hookIds) {
    hookIds = new Set();
    hooksByPlayer.set(session.playerId, hookIds);
  }
  hookIds.add(session.hookId);
}

/** @param {string} hookId */
function untrackSession(hookId) {
  const session = sessionsByHook.get(hookId);
  if (!session) return undefined;

  sessionsByHook.delete(hookId);
  const hookIds = hooksByPlayer.get(session.playerId);
  if (hookIds) {
    hookIds.delete(hookId);
    if (hookIds.size === 0) hooksByPlayer.delete(session.playerId);
  }
  return session;
}

/**
 * Derive yaw + pitch từ viewDirection vector (đã normalize).
 * yaw: atan2(-x, z), pitch: asin(-y).
 * @param {Vector3} viewDir
 * @returns {Rotation}
 */
function viewDirToRotation(viewDir) {
  const yaw = Math.atan2(-viewDir.x, viewDir.z);
  const pitch = Math.asin(clamp(-viewDir.y, -1, 1));
  return { yaw, pitch };
}

/**
 * Capture full snapshot tại 1 thời điểm (Before hoặc After).
 * @param {Player} player
 * @returns {CastSnapshot}
 */
function captureSnapshot(player) {
  const viewDir = safeGetViewDirection(player);
  return {
    location: cloneVector(player.location),
    headLocation: safeGetHeadLocation(player),
    viewDirection: cloneVector(viewDir),
    rotation: viewDirToRotation(viewDir),
    velocity: safeGetVelocity(player),
    tick: system.currentTick,
    time: Date.now(),
    dimensionId: player.dimension.id,
  };
}

/**
 * Lưu BEFORE snapshot chờ AFTER event link tới.
 * @param {Player} player
 * @returns {CastSnapshot}
 */
function captureBeforeSnapshot(player) {
  const snap = captureSnapshot(player);
  pendingBeforeSnapshots.set(player.id, snap);
  return snap;
}

/**
 * Hoàn thiện 1 CastSession: tạo mới hoặc complete (link BEFORE + AFTER).
 * Trước đây gọi là `registerCastCandidate`. Giờ mỗi session = 1 lần Rod use.
 * @param {Player} player
 * @returns {CastSession}
 */
function registerCastSession(player) {
  const after = captureSnapshot(player);
  const before = pendingBeforeSnapshots.get(player.id);
  /** @type {CastSession} */
  const session = {
    sessionId: newSessionId(),
    playerId: player.id,
    dimensionId: player.dimension.id,
    after,
    createdAt: Date.now(),
    expiresAt: Date.now() + CAST_TTL_MS,
  };
  if (before) {
    session.before = before;
    session.beforeAfterTimeDelta = after.time - before.time;
    session.beforeAfterTickDelta = after.tick - before.tick;
    session.positionDelta = distance3D(before.location, after.location);
    const dot = before.viewDirection.x * after.viewDirection.x +
                before.viewDirection.y * after.viewDirection.y +
                before.viewDirection.z * after.viewDirection.z;
    session.directionAngleDelta = Math.acos(clamp(dot, -1, 1));
    // Player consistency: càng ít drift càng tốt
    // positionDelta ≤ 0.5 + angleDelta ≤ 0.3 rad → 100
    // tăng đều khi drift
    const posScore = clamp(100 * (1 - session.positionDelta / 2.0), 0, 100);
    const angScore = clamp(100 * (1 - session.directionAngleDelta / 0.6), 0, 100);
    session.playerConsistency = Math.round((posScore + angScore) / 2);
  } else {
    // Không có BEFORE (race condition) → consistency thấp
    session.playerConsistency = 30;
  }
  pendingBeforeSnapshots.delete(player.id);

  // Push vào pool
  const sessions = getOpenCastSessions(player.id);
  sessions.push(session);
  castSessionsByPlayer.set(player.id, sessions);
  castSessionsById.set(session.sessionId, session);
  return session;
}

/** @param {string} playerId */
function getOpenCastSessions(playerId) {
  const now = Date.now();
  const sessions = castSessionsByPlayer.get(playerId) ?? [];
  const kept = sessions.filter((s) => now <= s.expiresAt);
  // Xoá session đã expire khỏi id map
  for (const s of sessions) {
    if (now > s.expiresAt) castSessionsById.delete(s.sessionId);
  }
  if (kept.length > 0) {
    castSessionsByPlayer.set(playerId, kept);
  } else {
    castSessionsByPlayer.delete(playerId);
  }
  return kept;
}

/**
 * Restrict backfill: CHỈ tentative recovery cho 1 hook (hook mới nhất chưa
 * confirmed). KHÔNG backfill hàng loạt. KHÔNG nâng confidence lên CONFIRMED —
 * chỉ mark TENTATIVE association.
 * @param {Player} player
 * @returns {boolean}
 */
function backfillFallbackCast(player) {
  const sessions = getSessionsForPlayer(player.id);
  const candidates = sessions.filter((session) =>
    !session.castConfirmed &&
    session.associationMethod !== 'DIRECT' &&
    system.currentTick - session.hookSpawnTick <= 2
  );
  // Chỉ lấy 1 hook mới nhất (theo hookSpawnTick)
  if (candidates.length === 0) return false;
  candidates.sort((a, b) => b.hookSpawnTick - a.hookSpawnTick);
  const session = candidates[0];

  const before = pendingBeforeSnapshots.get(player.id);
  session.castLocation = cloneVector(player.location);
  session.castTime = Date.now();
  session.castTick = system.currentTick;
  session.lastKnownPlayerLocation = cloneVector(player.location);
  session.castConfirmed = false;
  session.associationMethod = 'TENTATIVE';
  if (before) {
    session.castViewDirection = cloneVector(before.viewDirection);
    session.castPlayerVelocity = cloneVector(before.velocity);
  }
  pendingBeforeSnapshots.delete(player.id);

  castSignal.trigger({
    player,
    location: cloneVector(player.location),
    tick: system.currentTick,
    timestamp: Date.now(),
  });
  log(
    `backfilled cast TENTATIVE: hook=${session.hookId} player=${player.name} ` +
    `(skipped ${candidates.length - 1} other hook(s))`,
    player.id
  );
  return true;
}

/**
 * Tính projection và perpendicular error từ 1 point tới ray (origin, dir).
 * @param {Vector3} origin  P (player head)
 * @param {Vector3} dir D (normalized view direction)
 * @param {Vector3} point S (hook location)
 * @returns {{ projection: number, perpendicularError: number }}
 */

/** @param {number} v @param {number} lo @param {number} hi */
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function projectOntoRay(origin, dir, point) {
  const wx = point.x - origin.x;
  const wy = point.y - origin.y;
  const wz = point.z - origin.z;
  const projection = wx * dir.x + wy * dir.y + wz * dir.z;
  const cpx = origin.x + dir.x * projection;
  const cpy = origin.y + dir.y * projection;
  const cpz = origin.z + dir.z * projection;
  const dx = point.x - cpx;
  const dy = point.y - cpy;
  const dz = point.z - cpz;
  const perpendicularError = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return { projection, perpendicularError };
}

/**
 * Tính magnitude của vector 3D. Trả 0 nếu null/undefined.
 * @param {Vector3 | undefined} v
 */
function vecMagnitude(v) {
  if (!v) return 0;
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

/**
 * Đánh giá 1 CastSession → Hook hypothesis. Hard gates (G1-G5) đã được áp dụng
 * bởi `selectBestCastSession` — function này giả định session hợp lệ.
 * Trả null nếu thiếu data bắt buộc (viewDirection ở before hoặc after).
 * @param {Entity} hook
 * @param {Player | undefined} player
 * @param {CastSession} session
 * @param {Vector3} hookVelocity
 * @returns {CastAssessment | null}
 */
function assessCastHookAssociation(hook, player, session, hookVelocity) {
  // Ưu tiên BEFORE viewDirection (chính xác hơn cho cast intent).
  // Fallback về AFTER nếu BEFORE thiếu.
  const before = session.before;
  const after = session.after;
  const viewDir = (before?.viewDirection) ?? (after?.viewDirection);
  if (!viewDir) return null;
  if (!player) return null;

  // Anchor point: BEFORE head location nếu có, fallback AFTER.
  const anchorLoc = before?.headLocation ?? after?.headLocation ?? after?.location;
  if (!anchorLoc) return null;
  // Hook location at spawn
  const hookLoc = hook.location;

  // Temporal: dùng before tick nếu có, else after
  const castTick = before?.tick ?? after?.tick ?? session.createdAt;
  const tickDelta = Math.abs(system.currentTick - castTick);

  // Spatial: |cast location - hook|
  const castLoc = before?.location ?? after?.location;
  const distance = castLoc ? distance3D(castLoc, hookLoc) : 999;

  // === Evidence groups ===

  // Temporal (0-100)
  const temporalScore = clamp(100 * (1 - tickDelta / CAST_TO_HOOK_TICK_WINDOW), 0, 100);

  // Spatial (0-100)
  const spatialScore = clamp(100 * (1 - distance / CAST_TO_HOOK_DISTANCE), 0, 100);

  // Ray projection: anchor (P) theo viewDir (D) tới hook (S)
  const { projection, perpendicularError } = projectOntoRay(anchorLoc, viewDir, hookLoc);
  const projectionScore = clamp(100 * (1 - perpendicularError / CAST_RAY_MAX_PERPENDICULAR), 0, 100);
  // Forward direction: projection < 0 → hook ở phía sau player
  const forwardScore = projection >= 0 ? 100 : clamp(100 * (1 + projection / 5), 0, 100);
  // Combined ray score = perpendicular × forward
  const rayScore = projectionScore * forwardScore / 100;

  // Direction error: angle giữa viewDir và vector tới hook
  const toHook = {
    x: hookLoc.x - anchorLoc.x,
    y: hookLoc.y - anchorLoc.y,
    z: hookLoc.z - anchorLoc.z,
  };
  const toHookMag = vecMagnitude(/** @type {Vector3} */ (toHook));
  let directionErrorScore = 0;
  if (toHookMag >= 0.5) {
    const dot = viewDir.x * (toHook.x / toHookMag) +
                viewDir.y * (toHook.y / toHookMag) +
                viewDir.z * (toHook.z / toHookMag);
    const angleRad = Math.acos(clamp(dot, -1, 1));
    const angleDeg = angleRad * (180 / Math.PI);
    directionErrorScore = clamp(100 * (1 - angleDeg / CAST_ANGULAR_MAX_DEG), 0, 100);
  } else {
    directionErrorScore = rayScore; // proxy
  }

  // Angular: viewDir vs hookVelocity
  const hookVelMag = vecMagnitude(hookVelocity);
  let angularScore = 0;
  if (hookVelMag >= CAST_HOOK_VEL_MIN) {
    const dot = viewDir.x * (hookVelocity.x / hookVelMag) +
                viewDir.y * (hookVelocity.y / hookVelMag) +
                viewDir.z * (hookVelocity.z / hookVelMag);
    const angleRad = Math.acos(clamp(dot, -1, 1));
    const angleDeg = angleRad * (180 / Math.PI);
    angularScore = clamp(100 * (1 - angleDeg / CAST_ANGULAR_MAX_DEG), 0, 100);
  } else {
    angularScore = rayScore;
  }

  // Expected trajectory: Vexpected = viewDir * EXPECTED_HOOK_SPEED
  // + playerVelocity nhỏ (player di chuyển thì hook cũng drag theo)
  // Sau đó so hookVelocity với Vexpected
  let expectedScore = 50; // neutral khi không tính được
  if (hookVelMag >= CAST_HOOK_VEL_MIN) {
    const playerVel = before?.velocity ?? after?.velocity;
    const Vexpected = {
      x: viewDir.x * CAST_HOOK_VEL_EXPECT + (playerVel?.x ?? 0) * 0.3,
      y: viewDir.y * CAST_HOOK_VEL_EXPECT + (playerVel?.y ?? 0) * 0.3,
      z: viewDir.z * CAST_HOOK_VEL_EXPECT + (playerVel?.z ?? 0) * 0.3,
    };
    const VexpectedMag = vecMagnitude(/** @type {Vector3} */ (Vexpected));
    if (VexpectedMag > 0.01) {
      const error = distance3D(hookVelocity, Vexpected);
      expectedScore = clamp(100 * (1 - error / (VexpectedMag * 2)), 0, 100);
    }
  }

  // Hook velocity magnitude: hook bay xa = tốt
  const hookVelocityScore = clamp(100 * (hookVelMag / CAST_HOOK_VEL_EXPECT), 0, 100);

  // Player momentum: đứng yên = tốt
  const playerVel = before?.velocity ?? after?.velocity;
  const playerSpeed = vecMagnitude(/** @type {Vector3} */ (playerVel));
  const playerMomentumScore = clamp(100 * (1 - playerSpeed / CAST_PLAYER_SPEED_MAX), 0, 100);

  // Player-state consistency: before→after drift + playerConsistency field
  const playerStateScore = session.playerConsistency ?? 30;

  // Apply consistency penalty: session không reliable (low playerConsistency)
  // sẽ giảm tổng điểm
  const consistencyMultiplier = 0.5 + (playerStateScore / 200); // 0.5-1.0

  // Weighted total (0-1000)
  const total = Math.round(
    (temporalScore * WEIGHT_TEMPORAL +
     spatialScore * WEIGHT_SPATIAL +
     rayScore * WEIGHT_RAY_PROJECTION +
     angularScore * WEIGHT_ANGULAR +
     hookVelocityScore * WEIGHT_HOOK_VELOCITY +
     playerMomentumScore * WEIGHT_PLAYER_MOMENTUM +
     directionErrorScore * CAST_DIRECTION_WEIGHT +
     expectedScore * CAST_EXPECTED_WEIGHT) / 100 * consistencyMultiplier
  );

  /** @type {EvidenceBreakdown} */
  const evidence = {
    temporal: Math.round(temporalScore),
    spatial: Math.round(spatialScore),
    rayProjection: Math.round(rayScore),
    angular: Math.round(angularScore),
    hookVelocity: Math.round(hookVelocityScore),
    playerMomentum: Math.round(playerMomentumScore),
    beforeAfterConsistency: playerStateScore,
    total,
  };

  return {
    session,
    playerId: session.playerId,
    confidence: 'CONFIRMED',  // caller re-evaluate dựa trên margin
    score: total,
    evidence,
  };
}

/**
 * Chọn top + second best CastSession cho hook. KHÔNG pop session.
 * Áp dụng hard gates (G1-G5) trước khi score. Trả về top 2 để caller
 * tính margin → CONFIRMED / AMBIGUOUS / UNKNOWN.
 * @param {Entity} hook
 * @param {Vector3} hookVelocity
 * @returns {{ top: CastAssessment | null, second: CastAssessment | null }}
 */
function selectBestCastSession(hook, hookVelocity) {
  const now = Date.now();
  /** @type {CastAssessment[]} */
  const assessments = [];

  for (const [playerId, sessions] of castSessionsByPlayer) {
    // Cleanup TTL inline
    const kept = sessions.filter((s) => now <= s.expiresAt);
    for (const s of sessions) {
      if (now > s.expiresAt) castSessionsById.delete(s.sessionId);
    }
    if (kept.length > 0) castSessionsByPlayer.set(playerId, kept);
    else castSessionsByPlayer.delete(playerId);

    const player = world.getEntity(playerId);
    if (!player || player.typeId !== 'minecraft:player') continue;

    for (const session of kept) {
      const anchorTick = session.before?.tick ?? session.after?.tick;
      const anchorLoc = session.before?.location ?? session.after?.location;

      // G1: dimension
      if (session.dimensionId !== hook.dimension.id) continue;
      // G2: tick window
      if (anchorTick === undefined) continue;
      const tickDelta = Math.abs(system.currentTick - anchorTick);
      if (tickDelta > CAST_TO_HOOK_TICK_WINDOW) continue;
      // G3: distance
      if (!anchorLoc) continue;
      const distance = distance3D(anchorLoc, hook.location);
      if (distance > CAST_TO_HOOK_DISTANCE) continue;
      // G4: hook ở phía sau player theo ray quá xa
      const viewDir = session.before?.viewDirection ?? session.after?.viewDirection;
      const headLoc = session.before?.headLocation ?? session.after?.headLocation;
      if (viewDir && headLoc) {
        const { projection, perpendicularError } = projectOntoRay(headLoc, viewDir, hook.location);
        // Hook ở phía sau (projection < 0) VÀ perpendicular > ngưỡng → reject
        if (projection < -2 && perpendicularError > CAST_RAY_MAX_PERPENDICULAR) continue;
      }
      // G5: viewDirection required
      if (!viewDir) continue;

      const assessment = assessCastHookAssociation(hook, player, session, hookVelocity);
      if (assessment) assessments.push(assessment);
    }
  }

  if (assessments.length === 0) return { top: null, second: null };

  assessments.sort((a, b) => b.score - a.score);
  const top = assessments[0];
  const second = assessments[1] ?? null;

  // State mapping dựa trên score + margin
  const secondScore = second?.score ?? 0;
  const margin = top.score - secondScore;
  top.secondBestScore = secondScore;
  top.margin = margin;

  if (top.score >= CONFIRMED_MIN_SCORE && margin >= CONFIRMED_MIN_MARGIN) {
    top.confidence = 'CONFIRMED';
  } else if (top.score >= AMBIGUOUS_MIN_SCORE && margin >= AMBIGUOUS_MIN_MARGIN) {
    top.confidence = 'AMBIGUOUS';
  } else {
    top.confidence = 'UNKNOWN';
  }

  return { top, second };
}

/** @param {Entity} entity */
function safeGetVelocity(entity) {
  try {
    const velocity = entity.getVelocity();
    if (velocity) return cloneVector(velocity);
  } catch { /* ignore */ }
  return { x: 0, y: 0, z: 0 };
}

/** @param {Player} player */
function safeGetViewDirection(player) {
  try {
    const dir = player.getViewDirection();
    if (dir) return cloneVector(dir);
  } catch { /* ignore */ }
  return { x: 0, y: 0, z: 0 };
}

/** @param {Player} player */
function safeGetHeadLocation(player) {
  try {
    const head = player.getHeadLocation();
    if (head) return cloneVector(head);
  } catch { /* ignore */ }
  return cloneVector(player.location);
}

/** @param {RemovedHook} hook @param {ItemCandidate} item */
function scoreTrajectory(hook, item) {
  const speed = magnitude3D(item.velocity);
  if (speed < 0.01) return 0;

  const toPlayer = normalize3D({
    x: hook.playerLocation.x - item.location.x,
    y: hook.playerLocation.y - item.location.y,
    z: hook.playerLocation.z - item.location.z,
  });
  const direction = normalize3D(item.velocity);
  const alignment = dot3D(direction, toPlayer);
  if (alignment > 0) return alignment * SCORE_TRAJECTORY;
  // Negative evidence: item bay ngược chiều player → trừ điểm
  return alignment * SCORE_NEGATIVE_TRAJECTORY;
}

/**
 * Phase 8 (Workflow V2): Ray A = viewDirection từ beforeEvents.itemUse
 * vs Ray B = hookVelocity tại spawn. Cùng hướng = cast chính xác.
 * @param {Vector3|undefined} viewDirection
 * @param {Vector3|undefined} hookVelocity
 */
function scoreRayAlignment(viewDirection, hookVelocity) {
  if (!viewDirection || !hookVelocity) return 0;
  const viewMag = magnitude3D(viewDirection);
  const hookMag = magnitude3D(hookVelocity);
  if (viewMag < 0.01 || hookMag < 0.01) return 0;
  const a = normalize3D(viewDirection);
  const b = normalize3D(hookVelocity);
  const alignment = dot3D(a, b);
  // alignment ∈ [-1, 1]; map sang [0, 1] bằng (alignment + 1) / 2
  return Math.max(0, alignment) * SCORE_RAY_ALIGNMENT;
}

/** @param {number} value @param {number} maxValue @param {number} weight */
function weightedProximity(value, maxValue, weight) {
  if (maxValue <= 0) return weight;
  const normalized = Math.min(Math.abs(value) / maxValue, 1);
  return Math.max(0, weight * (1 - normalized));
}

/** @param {RemovedHook} removedHook @param {number} [now] */
export function getFinalizeOutcome(removedHook, now = Date.now()) {
  if (removedHook.items.length >= MAX_ITEMS_PER_CATCH) {
    return 'SUCCESS';
  }
  if (now > removedHook.expiresAt) {
    return removedHook.items.length > 0 ? 'SUCCESS' : 'EMPTY_REEL';
  }
  return undefined;
}

/**
 * @param {RemovedHook} hook
 * @param {ItemCandidate} item
 * @returns {number}
 */
function scoreMatch(hook, item) {
  if (hook.dimensionId !== item.dimensionId) return -Infinity;

  const timeDelta = item.spawnTime - hook.removeTime;
  if (timeDelta < MIN_TIME_DELTA_MS || timeDelta > MAX_TIME_DELTA_MS) return -Infinity;

  const tickDelta = item.spawnTick - hook.removeTick;
  if (tickDelta < -1 || tickDelta > MAX_TICK_DELTA) return -Infinity;

  const hookDistance = distance3D(item.location, hook.location);
  if (hookDistance > MAX_HOOK_TO_ITEM_DISTANCE) return -Infinity;

  const playerDistance = distance3D(item.location, hook.playerLocation);
  if (playerDistance > MAX_ITEM_TO_PLAYER_DISTANCE) return -Infinity;

  let score = SCORE_SESSION_ASSOCIATION;
  score += weightedProximity(timeDelta, MAX_TIME_DELTA_MS, SCORE_TIME_PROXIMITY);
  score += weightedProximity(tickDelta, MAX_TICK_DELTA, SCORE_TICK_PROXIMITY);
  score += weightedProximity(hookDistance, MAX_HOOK_TO_ITEM_DISTANCE, SCORE_HOOK_DISTANCE);
  score += weightedProximity(playerDistance, MAX_ITEM_TO_PLAYER_DISTANCE, SCORE_PLAYER_DISTANCE);
  score += scoreTrajectory(hook, item);
  score += scoreRayAlignment(hook.viewDirection, hook.hookVelocity);

  if (hook.reelRequested) score += 25;
  if (hook.inventoryChanged) score += 10;
  return score;
}

/**
 * Global correlation pass: build all viable hook<->item edges first, then
 * commit the highest scoring non-conflicting assignments.
 * @param {RemovedHook[]} removedHooks
 * @param {ItemCandidate[]} items
 * @param {number} [now]
 * @returns {Map<string, { item: ItemCandidate, score: number }[]>}
 */
export function correlatePendingHooks(removedHooks, items, now = Date.now()) {
  /** @type {Map<string, RemovedHook>} */
  const activeHooks = new Map();
  for (const hook of removedHooks) {
    if (now > hook.expiresAt) continue;
    if (hook.items.length >= MAX_ITEMS_PER_CATCH) continue;
    activeHooks.set(hook.hookId, hook);
  }

  /** @type {{ hookId: string, item: ItemCandidate, score: number }[]} */
  const edges = [];
  for (const hook of activeHooks.values()) {
    for (const item of items) {
      if (item.matched) continue;
      const score = scoreMatch(hook, item);
      if (score < MIN_CORRELATION_SCORE) continue;
      edges.push({ hookId: hook.hookId, item, score });
    }
  }

  edges.sort((a, b) => b.score - a.score || a.item.spawnTick - b.item.spawnTick);

  /** @type {Map<string, { item: ItemCandidate, score: number }[]>} */
  const assignments = new Map();
  const claimedItems = new Set();
  const claimedCountByHook = new Map();

  for (const edge of edges) {
    if (claimedItems.has(edge.item.entityId)) continue;

    const hook = activeHooks.get(edge.hookId);
    if (!hook) continue;

    const claimedCount = claimedCountByHook.get(edge.hookId) ?? 0;
    if (hook.items.length + claimedCount >= MAX_ITEMS_PER_CATCH) continue;

    claimedItems.add(edge.item.entityId);
    claimedCountByHook.set(edge.hookId, claimedCount + 1);

    const matches = assignments.get(edge.hookId) ?? [];
    matches.push({ item: edge.item, score: edge.score });
    assignments.set(edge.hookId, matches);
  }

  return assignments;
}

/** @param {ItemCandidate} item */
function createCaughtItemFromCandidate(item) {
  return {
    entityId: item.entityId,
    itemTypeId: item.itemTypeId,
    location: cloneVector(item.location),
  };
}

/** @param {Entity} entity @param {CaughtItem} fallback */
function createCaughtItemFromEntity(entity, fallback) {
  return {
    entityId: entity.id,
    itemTypeId: getItemTypeId(entity, fallback.itemTypeId),
    location: cloneVector(entity.location),
  };
}

/** @param {Entity | undefined} entity @param {string} fallbackTypeId */
function getItemTypeId(entity, fallbackTypeId) {
  if (!entity) return fallbackTypeId;
  try {
    const itemComponent = entity.getComponent('minecraft:item');
    if (itemComponent) {
      return itemComponent.itemStack.typeId;
    }
    if (entity.typeId) {
      return entity.typeId;
    }
  } catch { /* ignore */ }
  return fallbackTypeId;
}

/**
 * Lookup entity. Bedrock 1.21+ occasionally returns undefined from
 * `dimension.getEntity` for an id that JUST spawned, even though the entity
 * is in the same dimension. Try `world.getEntity` (which uses the runtime
 * registry, not the per-dimension cache) before giving up.
 * @param {import('@minecraft/server').Dimension} dimension
 * @param {string} entityId
 */
function getEntityIfPresent(dimension, entityId) {
  try {
    const ent = dimension.getEntity(entityId);
    if (ent) return ent;
  } catch { /* fall through */ }
  try {
    const ent = world.getEntity(entityId);
    if (ent) return ent;
  } catch { /* ignore */ }
  return undefined;
}

function tryMatchAll() {
  const now = Date.now();
  for (const removedHook of pending.values()) {
    const outcome = getFinalizeOutcome(removedHook, now);
    if (outcome) {
      finalize(removedHook, outcome);
    }
  }

  const assignments = correlatePendingHooks(
    [...pending.values()],
    [...itemCandidates.values()],
    now
  );

  for (const [hookId, matches] of assignments) {
    const removedHook = pending.get(hookId);
    if (!removedHook) continue;

    for (const match of matches) {
      match.item.matched = true;
      removedHook.items.push(createCaughtItemFromCandidate(match.item));
      // Kill entity gốc NGAY khi match (trước khi vanilla retry pickup).
      // Bedrock 1.21+ auto-pickup rất nhanh, nếu chờ tới processCatch thì
      // entity đã mất → primary missing path → không kill được.
      try {
        const dim = world.getDimension(match.item.dimensionId);
        const entity = getEntityIfPresent(dim, match.item.entityId);
        if (entity) entity.kill();
      } catch { /* ignore */ }
      log(
        `match hook=${hookId} item=${match.item.itemTypeId} score=${match.score.toFixed(1)} ` +
        `count=${removedHook.items.length}/${MAX_ITEMS_PER_CATCH}`,
        removedHook.playerId
      );
    }

    // Finalize NGAY khi đã có ít nhất 1 item match — không đợi window
    // expire hay cleanup interval. Vanilla Bedrock 1.21+ auto-pickup rất
    // nhanh, nếu chờ ta sẽ miss entity trước khi processCatch chạy.
    if (removedHook.items.length > 0) {
      finalize(removedHook, 'SUCCESS');
    }
  }
}

/**
 * @param {RemovedHook} removedHook
 * @param {Player} player
 */
function processCatch(removedHook, player) {
  const dimension = player.dimension;
  const resolvedItems = removedHook.items.map((item) => ({
    original: item,
    entity: getEntityIfPresent(dimension, item.entityId),
  }));
  const primaryResolved = resolvedItems.find((item) => item.entity);
  log(
    `processCatch player=${player.name} dim=${dimension.id} hookDim=${removedHook.dimensionId} ` +
    `items=${removedHook.items.length} resolved=${resolvedItems.length} ` +
    `primaryFound=${Boolean(primaryResolved)} ` +
    `ids=${removedHook.items.map((i) => i.entityId).join(',')}`,
    removedHook.playerId
  );

  if (!primaryResolved || !primaryResolved.entity) {
    // Kill tất cả entity item còn sống (nếu có). Thường thì vanilla đã
    // consume hết (Bedrock 1.21+ auto-pickup nhanh), nhưng đôi khi entity
    // còn sống nếu pickup interception hoạt động. tryMatchAll đã kill
    // trước đó, double-check ở đây cho chắc.
    for (const resolvedItem of resolvedItems) {
      if (resolvedItem.entity) {
        try { resolvedItem.entity.kill(); } catch { /* ignore */ }
      }
    }
    log(
      `SUCCESS player=${player.name} items=${removedHook.items.length} primary=missing ` +
      `(vanilla auto-pickup) — spawn replacement via beforeCatchSignal`,
      removedHook.playerId
    );
    // Item gốc đã bị vanilla consume (auto-pickup nhanh). Vẫn fire
    // beforeCatchSignal với item=null để consumer có cơ hội spawn item
    // thay thế (vd diamond). Nếu consumer không set event.item → fall
    // back về item gốc (null = giữ catch nhưng không spawn gì).
    const fallbackItem = removedHook.items[0];
    const fallbackLocation = fallbackItem ? cloneVector(fallbackItem.location) : cloneVector(removedHook.location);
    const fallbackTypeId = fallbackItem?.itemTypeId ?? 'minecraft:cod';

    /** @type {FishingCatchBeforeEvent} */
    const beforeEvent = {
      player,
      item: null,
      itemTypeId: fallbackTypeId,
      location: fallbackLocation,
      dimension,
      hookId: removedHook.hookId,
      tick: system.currentTick,
      timestamp: Date.now(),
      cancel: false,
    };
    log(
      `trigger beforeCatchSignal item=${beforeEvent.itemTypeId} hookId=${beforeEvent.hookId} subs=${beforeCatchSignal._subs.size}`,
      removedHook.playerId
    );
    beforeCatchSignal.trigger(beforeEvent);
    log(
      `after beforeCatchSignal trigger item=${beforeEvent.item?.id ?? 'null'} cancel=${beforeEvent.cancel}`,
      removedHook.playerId
    );

    if (beforeEvent.cancel === true) {
      cancelSignal.trigger({
        playerId: removedHook.playerId,
        hookId: removedHook.hookId,
        reason: 'CANCELLED',
        tick: system.currentTick,
        timestamp: Date.now(),
      });
      return;
    }

    const replacement = beforeEvent.item;
    const replacementValid = replacement != null && typeof replacement.id === 'string';
    if (replacementValid) {
      // Consumer spawn replacement → bắn parabola về player (giống path
      // entity còn). originalItem = null (vanilla đã consume), không cần kill.
      throwItemToPlayer(/** @type {Entity} */ (replacement), player);
    }
    const afterItems = removedHook.items.map((caught) => {
      if (replacementValid && caught === fallbackItem) {
        return {
          entityId: /** @type {Entity} */ (replacement).id,
          itemTypeId: getItemTypeId(/** @type {Entity} */ (replacement), caught.itemTypeId),
          location: cloneVector(/** @type {Entity} */ (replacement).location),
        };
      }
      return {
        entityId: caught.entityId,
        itemTypeId: caught.itemTypeId,
        location: cloneVector(caught.location),
      };
    });

    /** @type {FishingCatchEvent} */
    const afterEvent = {
      player,
      hookId: removedHook.hookId,
      items: afterItems,
      location: cloneVector(removedHook.location),
      dimension,
      tick: system.currentTick,
      timestamp: Date.now(),
    };
    log(
      `SUCCESS player=${player.name} primary=missing replaced=${replacementValid} items=${afterItems.length}`,
      removedHook.playerId
    );
    catchSignal.trigger(afterEvent);
    return;
  }

  const originalItem = primaryResolved.entity;
  const originalItemTypeId = primaryResolved.original.itemTypeId;

  /** @type {FishingCatchBeforeEvent} */
  const beforeEvent = {
    player,
    item: originalItem,
    itemTypeId: originalItemTypeId,
    location: cloneVector(originalItem.location),
    dimension,
    hookId: removedHook.hookId,
    tick: system.currentTick,
    timestamp: Date.now(),
    cancel: false,
  };

  beforeCatchSignal.trigger(beforeEvent);

  if (beforeEvent.cancel === true) {
    log(`CANCELLED player=${player.name} hook=${removedHook.hookId}`, removedHook.playerId);
    for (const resolvedItem of resolvedItems) {
      if (!resolvedItem.entity) continue;
      try { resolvedItem.entity.kill(); } catch { /* ignore */ }
    }
    cancelSignal.trigger({
      playerId: removedHook.playerId,
      hookId: removedHook.hookId,
      reason: 'CANCELLED',
      tick: system.currentTick,
      timestamp: Date.now(),
    });
    return;
  }

  const finalItem = beforeEvent.item;
  const itemValid = finalItem != null && typeof finalItem.id === 'string';
  if (!itemValid) {
    console.warn(
      '[fishing] event.item was set to null or invalid value. ' +
      'Use "event.cancel = true" to cancel the catch. Falling back to original item.'
    );
  }

  const effectiveItem = itemValid ? finalItem : originalItem;
  const itemReplaced = effectiveItem !== originalItem;
  if (itemReplaced) {
    throwItemToPlayer(effectiveItem, player);
    try { originalItem.kill(); } catch { /* ignore */ }
  }

  /** @type {CaughtItem[]} */
  const afterItems = [];
  for (const resolvedItem of resolvedItems) {
    if (resolvedItem === primaryResolved) {
      afterItems.push(createCaughtItemFromEntity(effectiveItem, primaryResolved.original));
      continue;
    }
    if (resolvedItem.entity) {
      afterItems.push(createCaughtItemFromEntity(resolvedItem.entity, resolvedItem.original));
    } else {
      afterItems.push({
        entityId: resolvedItem.original.entityId,
        itemTypeId: resolvedItem.original.itemTypeId,
        location: cloneVector(resolvedItem.original.location),
      });
    }
  }

  const finalItemTypeId = getItemTypeId(effectiveItem, originalItemTypeId);

  /** @type {FishingCatchEvent} */
  const afterEvent = {
    player,
    hookId: removedHook.hookId,
    items: afterItems,
    location: cloneVector(removedHook.location),
    dimension,
    tick: system.currentTick,
    timestamp: Date.now(),
  };
  log(
    `SUCCESS player=${player.name} original=${originalItemTypeId} final=${finalItemTypeId} ` +
    `replaced=${itemReplaced} items=${afterItems.length}`,
    removedHook.playerId
  );
  catchSignal.trigger(afterEvent);
}

/**
 * @param {RemovedHook} removedHook
 * @param {'SUCCESS' | 'EMPTY_REEL'} outcome
 */
function finalize(removedHook, outcome) {
  pending.delete(removedHook.hookId);
  if (outcome === 'SUCCESS' && removedHook.items.length === 0) {
    outcome = 'EMPTY_REEL';
  }

  const playerEntity = removedHook.playerId ? world.getEntity(removedHook.playerId) : undefined;
  if (outcome === 'SUCCESS') {
    if (!playerEntity || playerEntity.typeId !== 'minecraft:player') {
      log(`finalize SUCCESS skipped: owner gone id=${removedHook.playerId}`, removedHook.playerId);
      cancelSignal.trigger({
        playerId: removedHook.playerId,
        hookId: removedHook.hookId,
        reason: 'OWNER_GONE',
        tick: system.currentTick,
        timestamp: Date.now(),
      });
      return;
    }

    const dimension = playerEntity.dimension;
    // Luôn gọi processCatch — nó tự xử lý cả 2 path: entity còn (full
    // beforeCatchSignal flow) hoặc entity missing (spawn replacement via
    // beforeCatchSignal). Trước đây short-circuit ở đây bỏ lỡ
    // beforeCatchSignal cho vanilla auto-pickup.
    processCatch(removedHook, /** @type {Player} */ (playerEntity));
    return;
  }

  log(`EMPTY_REEL hook=${removedHook.hookId} player=${removedHook.playerId ?? '?'}`, removedHook.playerId);
  cancelSignal.trigger({
    playerId: removedHook.playerId,
    hookId: removedHook.hookId,
    reason: 'EMPTY_REEL',
    tick: system.currentTick,
    timestamp: Date.now(),
  });
}

/** @param {Player} player */
function requestReel(player) {
  const sessions = getSessionsForPlayer(player.id).filter((session) =>
    session.state === 'FISHING' ||
    session.state === 'INVENTORY_CHANGED' ||
    session.state === 'REEL_REQUESTED'
  );
  if (sessions.length === 0) return false;

  for (const session of sessions) {
    session.lastKnownPlayerLocation = cloneVector(player.location);
    if (session.state !== 'REEL_REQUESTED') {
      transition(session, 'REEL_REQUESTED');
    }
    reelSignal.trigger({
      player,
      hookId: session.hookId,
      location: cloneVector(session.castLocation),
      tick: system.currentTick,
      timestamp: Date.now(),
    });
  }

  return true;
}

/** @param {string} playerId @param {Entity} hook */
function scoreRecentCastFallback(playerId, hook) {
  let bestBonus = 0;
  for (const session of getOpenCastSessions(playerId)) {
    const anchorLoc = session.before?.location ?? session.after?.location;
    const anchorTick = session.before?.tick ?? session.after?.tick;
    if (!anchorLoc || anchorTick === undefined) continue;
    if (session.dimensionId !== hook.dimension.id) continue;

    const tickDelta = Math.abs(system.currentTick - anchorTick);
    const castDistance = distance3D(anchorLoc, hook.location);
    if (tickDelta > CAST_TO_HOOK_TICK_WINDOW * 2) continue;
    if (castDistance > FALLBACK_OWNER_MAX_DISTANCE) continue;

    let bonus = 40;
    bonus += weightedProximity(castDistance, FALLBACK_OWNER_MAX_DISTANCE, 40);
    bonus += weightedProximity(tickDelta, CAST_TO_HOOK_TICK_WINDOW * 2, 40);
    if (bonus > bestBonus) {
      bestBonus = bonus;
    }
  }
  return bestBonus;
}

/**
 * Heuristic fallback: tìm player gần hook trong FALLBACK_OWNER_MAX_DISTANCE,
 * có recent cast bonus. Caller set `confidence='FALLBACK'` + `castConfirmed=false`
 * trên FishingSession.
 * @param {Entity} hook
 * @returns {{ player: Player, distance: number, score: number } | undefined}
 */
function pickFallbackOwnerForHook(hook) {
  const players = hook.dimension.getPlayers({
    location: hook.location,
    maxDistance: FALLBACK_OWNER_MAX_DISTANCE,
  });
  if (players.length === 0) return undefined;

  /** @type {{ player: Player, score: number, distance: number } | undefined} */
  let best = undefined;
  let secondBestScore = -Infinity;

  for (const player of players) {
    const distance = distance3D(player.location, hook.location);
    let score = weightedProximity(distance, FALLBACK_OWNER_MAX_DISTANCE, 80);
    score += scoreRecentCastFallback(player.id, hook);

    if (!best || score > best.score) {
      secondBestScore = best?.score ?? secondBestScore;
      best = { player, score, distance };
    } else if (score > secondBestScore) {
      secondBestScore = score;
    }
  }

  if (!best) return undefined;
  if (best.score < FALLBACK_OWNER_MIN_SCORE) return undefined;
  if (players.length > 1 && best.score - secondBestScore < FALLBACK_OWNER_SCORE_MARGIN) {
    return undefined;
  }
  return best;
}

/** @param {import('@minecraft/server').ItemUseAfterEvent} event */
function onFishingRodUse(event) {
  const player = event.source;
  if (!player || player.typeId !== 'minecraft:player') return;

  const item = event.itemStack;
  if (!item || item.typeId !== 'minecraft:fishing_rod') return;

  // Register session TRƯỚC backfill/reel để session có trong pool khi
  // backfillFallbackCast cần re-evaluate.
  const session = registerCastSession(player);

  if (backfillFallbackCast(player)) {
    return;
  }

  if (requestReel(player)) {
    log(`reel requested player=${player.name} hooks=${getSessionsForPlayer(player.id).length}`, player.id);
    return;
  }
  castSignal.trigger({
    player,
    location: cloneVector(session.after?.location ?? player.location),
    tick: session.after?.tick ?? system.currentTick,
    timestamp: session.after?.time ?? Date.now(),
  });
  log(
    `cast session player=${player.name} sessionId=${session.sessionId} tick=${session.after?.tick ?? system.currentTick} ` +
    `consistency=${session.playerConsistency ?? 0}`,
    player.id
  );
}

/** @param {import('@minecraft/server').EntitySpawnAfterEvent} event */
function onEntitySpawn(event) {
  const entity = event.entity;
  if (entity.typeId === 'minecraft:fishing_hook') {
    // RACE FIX: nếu hook spawn TRƯỚC khi afterEvents.itemUse chạy, AFTER
    // session chưa được build. Quét pendingBeforeSnapshots → build session
    // ngay với AFTER = snapshot tại spawn moment.
    const now = Date.now();
    for (const [pid, before] of pendingBeforeSnapshots) {
      const p = world.getEntity(pid);
      if (!p || p.typeId !== 'minecraft:player') continue;
      if (p.dimension.id !== entity.dimension.id) continue;
      // Player có pendingBefore → likely vừa cast trong tick này
      // Build session ngay nếu chưa có session mới
      const existing = getOpenCastSessions(pid);
      const lastSession = existing[existing.length - 1];
      const lastTick = lastSession?.after?.tick ?? -1;
      if (lastTick >= before.tick) continue;  // đã có session mới hơn

      // Capture AFTER tại spawn moment
      const after = captureSnapshot(/** @type {Player} */ (p));
      /** @type {CastSession} */
      const session = {
        sessionId: newSessionId(),
        playerId: pid,
        dimensionId: p.dimension.id,
        before,
        after,
        createdAt: now,
        expiresAt: now + CAST_TTL_MS,
      };
      session.beforeAfterTimeDelta = after.time - before.time;
      session.beforeAfterTickDelta = after.tick - before.tick;
      session.positionDelta = distance3D(before.location, after.location);
      const dot = before.viewDirection.x * after.viewDirection.x +
                  before.viewDirection.y * after.viewDirection.y +
                  before.viewDirection.z * after.viewDirection.z;
      session.directionAngleDelta = Math.acos(clamp(dot, -1, 1));
      const posScore = clamp(100 * (1 - session.positionDelta / 2.0), 0, 100);
      const angScore = clamp(100 * (1 - session.directionAngleDelta / 0.6), 0, 100);
      session.playerConsistency = Math.round((posScore + angScore) / 2);

      existing.push(session);
      castSessionsByPlayer.set(pid, existing);
      castSessionsById.set(session.sessionId, session);
      log(
        `cast session (race-fix) player=${p.name} sessionId=${session.sessionId} ` +
        `tick=${after.tick} consistency=${session.playerConsistency}`,
        pid
      );
    }

    const hookVelocity = safeGetVelocity(entity);
    const { top, second } = selectBestCastSession(entity, hookVelocity);

    /** @type {Player|undefined} */
    let player = undefined;
    /** @type {CastSession|undefined} */
    let castSession = undefined;
    /** @type {ConfidenceState} */
    let confidence = 'UNKNOWN';
    /** @type {EvidenceBreakdown | undefined} */
    let evidence = undefined;

    if (top && (top.confidence === 'CONFIRMED' || top.confidence === 'AMBIGUOUS')) {
      player = /** @type {Player|undefined} */ (world.getEntity(top.playerId));
      castSession = top.session;
      confidence = top.confidence;
      evidence = top.evidence;
      if (top.confidence === 'AMBIGUOUS') {
        const secondScore = second?.score ?? 0;
        log(
          `AMBIGUOUS owner: top=${top.score} second=${secondScore} margin=${top.score - secondScore} ` +
          `player=${player?.name ?? '?'} hook=${entity.id} sessionId=${castSession?.sessionId ?? '?'}`,
          player?.id
        );
      }
    } else {
      // UNKNOWN hoặc top null → thử fallback
      const fb = pickFallbackOwnerForHook(entity);
      if (fb) {
        player = fb.player;
        confidence = 'FALLBACK';
        log(
          `FALLBACK owner: player=${player.name} d=${fb.distance.toFixed(1)} score=${fb.score.toFixed(1)} ` +
          `hook=${entity.id}`,
          player.id
        );
      } else {
        log(`UNKNOWN owner, no fallback, skip hook=${entity.id}`, undefined);
        return;
      }
    }

    if (!player || player.typeId !== 'minecraft:player') {
      log(`skip hook=${entity.id} owner resolved invalid`, undefined);
      return;
    }

    // Derive castLocation / castTick / castViewDirection / castPlayerVelocity
    // từ session.before ưu tiên, fallback về session.after
    const sb = castSession?.before;
    const sa = castSession?.after;
    const castLoc = sb?.location ?? sa?.location ?? player.location;
    const castTick = sb?.tick ?? sa?.tick ?? system.currentTick;
    const castTime = sb?.time ?? sa?.time ?? Date.now();
    const castViewDir = sb?.viewDirection ?? sa?.viewDirection;
    const castPlayerVel = sb?.velocity ?? sa?.velocity;

    /** @type {FishingSession} */
    const session = {
      hookId: entity.id,
      playerId: player.id,
      dimensionId: entity.dimension.id,
      sessionId: castSession?.sessionId,
      associationMethod:
        confidence === 'CONFIRMED' ? 'DIRECT' :
        confidence === 'AMBIGUOUS' ? 'DIRECT' :
        confidence === 'FALLBACK' ? 'FALLBACK' : 'UNKNOWN',
      castLocation: cloneVector(castLoc),
      castTime,
      castTick,
      castViewDirection: castViewDir,
      castPlayerVelocity: castPlayerVel,
      hookLocation: cloneVector(entity.location),
      hookVelocity,
      hookSpawnTime: Date.now(),
      hookSpawnTick: system.currentTick,
      lastKnownPlayerLocation: cloneVector(player.location),
      castConfirmed: Boolean(castSession),
      inventoryChanged: false,
      state: 'CASTING',
      confidence,
      evidence: DEBUG ? evidence : undefined,
    };
    trackSession(session);
    transition(session, 'FISHING');

    // Telemetry
    telemetry.totalHooks += 1;
    if (confidence === 'CONFIRMED') telemetry.confirmed += 1;
    else if (confidence === 'AMBIGUOUS') telemetry.ambiguous += 1;
    else if (confidence === 'FALLBACK') telemetry.fallback += 1;
    else telemetry.unknown += 1;

    if (DEBUG) {
      log(
        `hook spawn ${entity.id} owner=${player.name} confidence=${confidence} ` +
        `score=${top?.score ?? 0} margin=${top ? top.score - (second?.score ?? 0) : 0} ` +
        `T=${evidence?.temporal ?? 0} S=${evidence?.spatial ?? 0} ` +
        `R=${evidence?.rayProjection ?? 0} A=${evidence?.angular ?? 0} ` +
        `H=${evidence?.hookVelocity ?? 0} M=${evidence?.playerMomentum ?? 0} ` +
        `B=${evidence?.beforeAfterConsistency ?? 0}`,
        player.id
      );
    }
    return;
  }

  if (entity.typeId !== 'minecraft:item') return;

  let itemTypeId = '';
  try {
    const itemComponent = entity.getComponent('minecraft:item');
    if (!itemComponent) return;
    itemTypeId = itemComponent.itemStack.typeId;
  } catch {
    return;
  }

  if (entity.getDynamicProperty('fishing_reward') === true) return;

  // Debug: log dimension để xác định tại sao primary missing
  try {
    log(`item spawn ${itemTypeId} id=${entity.id} dim=${entity.dimension.id} loc=${JSON.stringify(entity.location)}`, undefined);
  } catch (e) {
    log(`item spawn ${itemTypeId} id=${entity.id} dim=<error: ${e}>`, undefined);
  }

  /** @type {ItemCandidate} */
  const itemCandidate = {
    entityId: entity.id,
    itemTypeId,
    dimensionId: entity.dimension.id,
    location: cloneVector(entity.location),
    velocity: safeGetVelocity(entity),
    spawnTime: Date.now(),
    spawnTick: system.currentTick,
    matched: false,
  };
  itemCandidates.set(entity.id, itemCandidate);
  try { entity.setDynamicProperty('fishing_caught', true); } catch { /* ignore */ }
  log(`item spawn ${itemTypeId} id=${entity.id}`, undefined);
  tryMatchAll();
}

/** @param {import('@minecraft/server').EntityRemoveBeforeEvent} event */
function onBeforeEntityRemove(event) {
  const entity = event.removedEntity;
  if (entity.typeId !== 'minecraft:fishing_hook') return;

  const session = untrackSession(entity.id);
  if (!session) {
    log(`hook remove ${entity.id} no session`, undefined);
    return;
  }

  const owner = /** @type {Player|undefined} */ (session.playerId ? world.getEntity(session.playerId) : undefined);
  const playerLocation = owner && owner.typeId === 'minecraft:player'
    ? cloneVector(owner.location)
    : cloneVector(session.lastKnownPlayerLocation);
  const previousState = session.state;

  session.lastKnownPlayerLocation = playerLocation;
  transition(session, 'PENDING_RESULT');
  log(`hook remove ${entity.id} player=${session.playerId} state=${previousState}`, session.playerId);

  /** @type {RemovedHook} */
  const removedHook = {
    hookId: entity.id,
    playerId: session.playerId,
    dimensionId: entity.dimension.id,
    location: cloneVector(entity.location),
    playerLocation,
    removeTime: Date.now(),
    removeTick: system.currentTick,
    expiresAt: Date.now() + CORRELATION_WINDOW_MS,
    reelRequested: previousState === 'REEL_REQUESTED',
    inventoryChanged: session.inventoryChanged,
    viewDirection: session.castViewDirection,
    hookVelocity: session.hookVelocity,
    items: [],
  };
  pending.set(removedHook.hookId, removedHook);
  tryMatchAll();
}

/** @param {import('@minecraft/server').PlayerInventoryItemChangeAfterEvent} event */
function onInventoryChange(event) {
  const sessions = getSessionsForPlayer(event.player.id);
  if (sessions.length === 0) return;

  for (const session of sessions) {
    session.inventoryChanged = true;
    session.lastKnownPlayerLocation = cloneVector(event.player.location);
    if (session.state === 'FISHING') {
      transition(session, 'INVENTORY_CHANGED');
    }
  }

  log(
    `inventory changed during fishing player=${event.player.name} slot=${event.slot} ` +
    `item=${event.itemStack?.typeId ?? '?'} amount=${event.itemStack?.amount ?? '?'}`,
    event.player.id
  );
}

function startCleanupInterval() {
  system.runInterval(() => {
    const now = Date.now();

    for (const removedHook of pending.values()) {
      if (now > removedHook.expiresAt) {
        finalize(removedHook, removedHook.items.length > 0 ? 'SUCCESS' : 'EMPTY_REEL');
      }
    }

    for (const [entityId, item] of itemCandidates) {
      if (now - item.spawnTime > ITEM_CANDIDATE_TTL_MS) {
        itemCandidates.delete(entityId);
      }
    }

    for (const [playerId] of castSessionsByPlayer) {
      getOpenCastSessions(playerId);
    }
  }, CLEANUP_INTERVAL_TICKS);
}

export function init() {
  world.afterEvents.itemUse.subscribe(onFishingRodUse);
  world.afterEvents.entitySpawn.subscribe(onEntitySpawn);
  world.beforeEvents.entityRemove.subscribe(onBeforeEntityRemove);

  // Phase 0 (Workflow V2): capture BEFORE snapshot TRƯỚC khi itemUse xảy ra.
  // Dùng để compute before→after consistency + ray A vs hookVelocity alignment.
  const beforeItemUse = /** @type {any} */ (world.beforeEvents).itemUse;
  if (beforeItemUse) {
    beforeItemUse.subscribe((/** @type {any} */ event) => {
      const player = event.source;
      if (!player || player.typeId !== 'minecraft:player') return;
      const item = event.itemStack;
      if (!item || item.typeId !== 'minecraft:fishing_rod') return;
      captureBeforeSnapshot(/** @type {Player} */ (player));
    });
    log('beforeEvents.itemUse subscribed', undefined);
  } else {
    log('beforeEvents.itemUse NOT available', undefined);
  }

  const inventoryEvent = /** @type {any} */ (world.afterEvents).playerInventoryItemChange;
  if (inventoryEvent) inventoryEvent.subscribe(onInventoryChange);

  startCleanupInterval();
  log('detector initialized v2026-09-01-race-fix-castsession', undefined);

  if (!ENABLE_PICKUP_INTERCEPTION) {
    log('pickup interception disabled', undefined);
    return;
  }

  const pickupBefore = /** @type {any} */ (world.beforeEvents).entityItemPickup;
  if (!pickupBefore) {
    log('pickupBefore NOT available', undefined);
    return;
  }

  pickupBefore.subscribe((/** @type {any} */ event) => {
    const item = event.item;
    if (!item) return;

    for (const removedHook of pending.values()) {
      if (removedHook.dimensionId !== item.dimension.id) continue;

      const hookDistance = distance3D(removedHook.location, item.location);
      if (hookDistance > MAX_HOOK_TO_ITEM_DISTANCE * 2) continue;

      const ageMs = Date.now() - removedHook.removeTime;
      if (ageMs > 2000) continue;

      // Cancel MỌI pickup retry cho hook này. Bedrock 1.21+ retry mỗi tick
      // khi entity còn trong range. Luôn cancel — không dùng flag skip.
      event.cancel = true;
      log(
        `pickup cancel item=${item.id} near hook=${removedHook.hookId} ` +
        `d=${hookDistance.toFixed(1)} age=${ageMs}ms`,
        removedHook.playerId
      );
      return;
    }
  });
}
