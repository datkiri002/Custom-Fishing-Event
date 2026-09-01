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
  CAST_KINEMATIC_WEIGHT,
  WEIGHT_HOOK_VELOCITY,
  CAST_PREDICTION_WEIGHT,
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
/** playerId -> CastSnapshot[] (queue pending BEFORE, không overwrite).
 *  Mỗi BEFORE ItemUse tạo entry mới; registerCastSession pop phù hợp nhất. */
const pendingBeforeQueue = new Map();
/** playerId -> next sequenceId (monotonic, mỗi BEFORE cast tăng 1) */
const sequenceByPlayer = new Map();
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

/**
 * Per-player monotonic sequence. Mỗi BEFORE ItemUse tăng 1.
 * Dùng để disambiguate rapid cast / same-tick events.
 * @param {string} playerId
 * @returns {number}
 */
function nextSequence(playerId) {
  const next = (sequenceByPlayer.get(playerId) ?? 0) + 1;
  sequenceByPlayer.set(playerId, next);
  return next;
}

export const catchSignal = new FishingEventSignal();
export const castSignal = new FishingEventSignal();
export const reelSignal = new FishingEventSignal();
export const cancelSignal = new FishingEventSignal();
export const beforeCatchSignal = new FishingEventSignal();

// ===== Telemetry counters (precision/recall tracking) =====
const telemetry = {
  totalHooks: 0,
  // confidence (Stage 1 evidence-based)
  confirmed: 0,
  ambiguous: 0,
  unknown: 0,
  // fallback (heuristic)
  fallback: 0,
  skipped: 0,
  // association method (semantic, P0)
  directConfirmed: 0,    // DIRECT_CONFIRMED
  directAmbiguous: 0,    // DIRECT_AMBIGUOUS
  tentative: 0,          // TENTATIVE (backfill)
  fallbackSem: 0,        // FALLBACK (heuristic)
  unknownSem: 0,         // UNKNOWN
  // race fix v2
  raceFixSynthetic: 0,   // hook dùng pending BEFORE (synthetic session)
  // pending queue (P0)
  pendingBeforeEnqueued: 0,
  pendingBeforeMatched: 0,
  pendingBeforeExpired: 0,
  // hook trajectory (P1.2)
  trajectorySamplesTotal: 0,  // tổng sample đã capture
  trajectorySamplesDropped: 0,  // hook bị remove trước khi capture đủ
  // P1.4: hook speed calibration (EMA)
  hookSpeedSamples: 0,
  // P2.1: item active correlation
  itemActiveCandidates: 0,    // tổng item candidate đã consider
  itemActiveMatched: 0,      // early-bound (Stage 2 ready)
  itemActiveUncertain: 0,    // margin thấp → không bind
  // P2.4: NULL assignment
  nullAssignments: 0,
};

/** P1.4: runtime calibration của hook speed. EMA (alpha=0.1). Update từ
 * CONFIRMED hooks. Nếu chưa có sample → dùng CAST_HOOK_VEL_EXPECT. */
let telemetryHookSpeedEMA = 0;
const HOOK_SPEED_EMA_ALPHA = 0.1;

/** P1.2: hookId -> HookTrajectory (samples + derived metrics) */
const hookTrajectories = new Map();

/** P2.5: sessionId -> hookId. Mỗi CastSession bind tối đa 1 hook. */
const boundHookBySessionId = new Map();

/**
 * P4.2: Hysteresis — committed assignment per hook. Khi 1 hook đã được
 * assigned (CONFIRMED), cache decision trong TTL. Nếu hook bị re-evaluate
 * trong TTL (e.g. bởi extra spawn event), skip re-assignment trừ khi
 * evidence mới thay đổi mạnh (delta > REASSIGN_EVIDENCE_DELTA).
 * @type {Map<string, {playerId:string, score:number, confidence:ConfidenceState, expiresAt:number, lockedAt:number}>}
 */
const committedAssignments = new Map();
const COMMITTED_ASSIGNMENT_TTL_MS = 5000;
const REASSIGN_EVIDENCE_DELTA = 200;

/**
 * P2.3: Causal chain log. Map<hookId, chainEvents[]>.
 * Mỗi entry ghi timeline: cast → hook spawn → hook active → reel → item spawn
 * → hook remove. Dùng cho debug + post-mortem analysis.
 * Cleanup khi hook bị remove.
 * @type {Map<string, Array<{event:string, tick:number, time:number, data?:any}>>}
 */
const causalChains = new Map();

/** @param {string} hookId @param {string} event @param {Record<string, any>} [data] */
function recordCausal(hookId, event, data) {
  let chain = causalChains.get(hookId);
  if (!chain) {
    chain = [];
    causalChains.set(hookId, chain);
  }
  chain.push({ event, tick: system.currentTick, time: Date.now(), data });
  log(`causal hook=${hookId} ${event}${data ? ' ' + JSON.stringify(data) : ''}`);
}

/**
 * Schedule T1, T2 samples cho 1 hook. T0 được capture inline tại spawn.
 * Dùng system.runTimeout để polling — KHÔNG tốn event loop nặng.
 * @param {string} hookId
 * @param {number} t0Speed
 */
function scheduleHookTrajectory(hookId, t0Speed) {
  /** @type {HookTrajectory} */
  const traj = {
    hookId,
    samples: [],
    directionStability: 0,
    velocityConsistency: 0,
    acceleration: 0,
    trajectoryDeviation: 0,
    expectedError: 0,
  };
  hookTrajectories.set(hookId, traj);

  // T1: +1 tick
  try {
    system.runTimeout(() => {
      captureTrajectorySample(hookId, 1);
    }, 1);
  } catch { /* ignore */ }

  // T2: +2 tick
  try {
    system.runTimeout(() => {
      captureTrajectorySample(hookId, 2);
    }, 2);
  } catch { /* ignore */ }
}

/**
 * Capture 1 sample cho hook trajectory. Nếu hook không còn tồn tại → skip
 * (không phải lỗi, hook có thể bị remove sớm).
 * @param {string} hookId
 * @param {number} tickOffset  1 hoặc 2 (T1 hoặc T2)
 */
function captureTrajectorySample(hookId, tickOffset) {
  const traj = hookTrajectories.get(hookId);
  if (!traj) return;
  // Tìm entity — có thể ở dimension nào cũng được
  /** @type {Entity | undefined} */
  let entity;
  try {
    entity = world.getEntity(hookId);
  } catch { return; }
  if (!entity) {
    telemetry.trajectorySamplesDropped += 1;
    return;
  }
  try {
    traj.samples.push({
      tick: system.currentTick,
      time: Date.now(),
      location: cloneVector(entity.location),
      velocity: safeGetVelocity(entity),
    });
    telemetry.trajectorySamplesTotal += 1;
    if (traj.samples.length >= 2) {
      computeTrajectoryMetrics(traj);
    }
  } catch { /* ignore */ }
}

/**
 * Tính direction stability + velocity consistency từ ≥2 samples.
 * KHÔNG dùng làm hard gate — soft evidence.
 * @param {HookTrajectory} traj
 */
function computeTrajectoryMetrics(traj) {
  if (traj.samples.length < 2) return;
  // Direction stability: std của angle giữa velocity vectors
  let angleSum = 0;
  let count = 0;
  for (let i = 1; i < traj.samples.length; i++) {
    const a = traj.samples[i - 1].velocity;
    const b = traj.samples[i].velocity;
    const ma = vecMagnitude(a);
    const mb = vecMagnitude(b);
    if (ma < 0.01 || mb < 0.01) continue;
    const dot = a.x * b.x + a.y * b.y + a.z * b.z;
    const cosA = clamp(dot / (ma * mb), -1, 1);
    angleSum += Math.acos(cosA);
    count += 1;
  }
  if (count > 0) {
    const avgAngle = angleSum / count;
    // 0 rad = perfect stability (100), π/2 = unstable (0)
    traj.directionStability = Math.round(clamp(100 * (1 - avgAngle / (Math.PI / 2)), 0, 100));
  }

  // Velocity consistency: 100 - std% / mean
  const speeds = traj.samples.map(s => vecMagnitude(s.velocity));
  const mean = speeds.reduce((a, b) => a + b, 0) / speeds.length;
  const variance = speeds.reduce((acc, s) => acc + (s - mean) ** 2, 0) / speeds.length;
  const std = Math.sqrt(variance);
  if (mean > 0.01) {
    traj.velocityConsistency = Math.round(clamp(100 * (1 - std / mean), 0, 100));
  }

  // Acceleration approx: (v_last - v_first) / tickDelta
  if (traj.samples.length >= 2) {
    const v0 = traj.samples[0].velocity;
    const vN = traj.samples[traj.samples.length - 1].velocity;
    const tickDelta = traj.samples[traj.samples.length - 1].tick - traj.samples[0].tick;
    if (tickDelta > 0) {
      const a = {
        x: (vN.x - v0.x) / tickDelta,
        y: (vN.y - v0.y) / tickDelta,
        z: (vN.z - v0.z) / tickDelta,
      };
      traj.acceleration = vecMagnitude(a);
    }
  }
}

/**
 * Lấy trajectory cho 1 hook. Cleanup sau khi hook bị remove.
 * @param {string} hookId
 * @returns {HookTrajectory | undefined}
 */
function getHookTrajectory(hookId) {
  return hookTrajectories.get(hookId);
}

/** Cleanup trajectory khi hook remove */
function cleanupHookTrajectory(hookId) {
  hookTrajectories.delete(hookId);
}

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
  // Debug: log before applyImpulse — so we can compare replacement arc vs
  // vanilla fish arc (logged in onEntitySpawn for item).
  let dbgVelBefore = /** @type {Vector3} */ ({ x: 0, y: 0, z: 0 });
  try { dbgVelBefore = /** @type {Vector3} */ (item.getVelocity() ?? { x: 0, y: 0, z: 0 }); } catch { /* ignore */ }
  let dbgType = '?';
  try { dbgType = String(item.typeId); } catch { /* ignore */ }
  let dbgItemName = '?';
  try {
    const c = /** @type {any} */ (item).getComponent?.('minecraft:item');
    if (c) dbgItemName = String(c.itemStack?.typeId ?? '?');
  } catch { /* ignore */ }

  const from = item.location;
  const to = /** @type {Player} */ (player).location;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const horizontalDistance = Math.sqrt(dx * dx + dz * dz);
  if (horizontalDistance < 0.01) return;

  // Ballistic fit: target flight time T=8 ticks. Cap vy 0.5 (peak ~3 blocks
  // above start) to avoid shooting item into the sky when dy is large
  // (player far above). Sample 3 had dy=6.46 → vy=1.12, item bay ~15 blocks
  // up — way too high. Capping at 0.5 gives gentle arc.
  // Empirical: 13 samples show mean vy_real ≈ 0.30-0.50, peak at d=7 ≈ 0.95.
  const T = 8;
  const g = 0.04;
  const v_h = horizontalDistance / T;
  let v_y = (dy + 0.5 * g * T * T) / T + 0.15;
  v_y = Math.max(0.18, Math.min(0.55, v_y));
  const dirX = dx / horizontalDistance;
  const dirZ = dz / horizontalDistance;

  try { item.clearVelocity(); } catch { /* ignore */ }
  try {
    item.applyImpulse({
      x: dirX * v_h,
      y: v_y,
      z: dirZ * v_h,
    });
  } catch { /* ignore */ }
  // Debug: log after applyImpulse — confirm impulse applied + log predicted flight
  log(
    `replacement-trajectory ${dbgItemName} type=${dbgType} ` +
    `from=(${from.x.toFixed(2)},${from.y.toFixed(2)},${from.z.toFixed(2)}) ` +
    `to=(${to.x.toFixed(2)},${to.y.toFixed(2)},${to.z.toFixed(2)}) ` +
    `dH=${horizontalDistance.toFixed(2)} dy=${dy.toFixed(2)} ` +
    `velBefore=(${dbgVelBefore.x.toFixed(3)},${dbgVelBefore.y.toFixed(3)},${dbgVelBefore.z.toFixed(3)}) ` +
    `impulse=(${(dirX * v_h).toFixed(3)},${v_y.toFixed(3)},${(dirZ * v_h).toFixed(3)}) ` +
    `speed=${Math.sqrt((dirX * v_h) ** 2 + v_y ** 2 + (dirZ * v_h) ** 2).toFixed(3)}`,
    /** @type {Player} */ (player).id
  );
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

/**
 * P1.5: lấy các FishingSession đang active (FISHING / INVENTORY_CHANGED /
 * PENDING_RESULT / REEL_REQUESTED) của player. Dùng để quyết định Rod use
 * là CAST hay REEL.
 * @param {string} playerId
 * @returns {FishingSession[]}
 */
function getActiveHookSessionsForPlayer(playerId) {
  const all = getSessionsForPlayer(playerId);
  return all.filter((s) =>
    s.state === 'FISHING' ||
    s.state === 'INVENTORY_CHANGED' ||
    s.state === 'PENDING_RESULT' ||
    s.state === 'REEL_REQUESTED'
  );
}

/**
 * P1.6: score Reel candidate ↔ Active hook.
 * Dimensions: temporal proximity (Rod use → hook lifetime), player-to-hook
 * distance, hook state, session consistency, sequence match.
 * @param {Player} player
 * @param {FishingSession} activeSession
 * @param {Vector3} reelLocation   player location tại reel moment
 * @param {number} reelTick
 * @returns {number}  score 0-1000
 */
function scoreReelCandidate(player, activeSession, reelLocation, reelTick) {
  let score = 0;

  // Player-to-hook distance (300)
  const hookLoc = activeSession.hookLocation;
  const d = distance3D(reelLocation, hookLoc);
  const dScore = clamp(100 * (1 - d / FALLBACK_OWNER_MAX_DISTANCE), 0, 100);
  score += dScore * 3;

  // Temporal: hook lifetime tính đến reel moment (200)
  // Hook càng lâu + reel trùng → tốt (hook đã "chín")
  const lifetime = reelTick - activeSession.hookSpawnTick;
  const lifetimeScore = clamp(100 * Math.min(1, lifetime / 20), 0, 100);
  score += lifetimeScore * 2;

  // Session consistency (200)
  // DIRECT_CONFIRMED > DIRECT_AMBIGUOUS > FALLBACK > UNKNOWN
  const conf = activeSession.associationMethod;
  const confScore =
    conf === 'DIRECT_CONFIRMED' ? 100 :
    conf === 'DIRECT_AMBIGUOUS' ? 60 :
    conf === 'TENTATIVE' ? 40 :
    conf === 'FALLBACK' ? 30 : 20;
  score += confScore * 2;

  // Cast exclusivity bonus: nếu session CHƯA được reel-ed (100)
  const stateScore = activeSession.state === 'FISHING' ? 100 : 50;
  score += stateScore;

  // Sequence match bonus (200): nếu session còn mới so với reel tick
  const ageScore = clamp(100 * (1 - lifetime / 100), 0, 100);
  score += ageScore * 2;

  return Math.round(score);
}

/**
 * P1.6: associate Reel event ↔ active hooks.
 * Score TẤT CẢ active hook × Reel candidate. Lấy best + second.
 * Margin check: chỉ return hooks với margin đủ lớn. Nếu best/second
 * margin thấp → return empty (không force assign).
 * @param {Player} player
 * @param {FishingSession[]} activeSessions
 * @returns {{ session: FishingSession, score: number, margin: number }[]}
 */
function associateReelToHook(player, activeSessions) {
  if (activeSessions.length === 0) return [];
  const reelLoc = player.location;
  const reelTick = system.currentTick;
  /** @type {{ session: FishingSession, score: number }[]} */
  const scored = [];
  for (const session of activeSessions) {
    const score = scoreReelCandidate(player, session, reelLoc, reelTick);
    scored.push({ session, score });
  }
  scored.sort((a, b) => b.score - a.score);
  if (scored.length === 0) return [];

  // P1.6: KHÔNG force assign khi margin thấp.
  // Solo: 1 active hook → CONFIRMED thoải mái.
  // Multi: yêu cầu margin ≥ 200.
  const best = scored[0];
  const second = scored[1];
  if (activeSessions.length === 1) {
    return [{ session: best.session, score: best.score, margin: 999 }];
  }
  const margin = best.score - second.score;
  if (margin < 200) {
    log(`reel: best=${best.score} second=${second.score} margin=${margin} — UNCERTAIN, no assign`, player.id);
    return [];
  }
  return [{ session: best.session, score: best.score, margin }];
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
 * Lưu BEFORE snapshot vào queue. KHÔNG overwrite snapshot trước — mỗi
 * BEFORE ItemUse tạo entry mới. Cleanup TTL sẽ drop stale entries.
 * @param {Player} player
 * @returns {CastSnapshot}
 */
function captureBeforeSnapshot(player) {
  const snap = captureSnapshot(player);
  snap.sequenceId = nextSequence(player.id);
  const queue = pendingBeforeQueue.get(player.id) ?? [];
  // Drop stale entries (> 5s) trước khi push
  const cutoff = Date.now() - 5000;
  while (queue.length > 0 && (queue[0].time ?? 0) < cutoff) {
    queue.shift();
    telemetry.pendingBeforeExpired += 1;
  }
  queue.push(snap);
  pendingBeforeQueue.set(player.id, queue);
  telemetry.pendingBeforeEnqueued += 1;
  return snap;
}

/**
 * Pop BEFORE snapshot phù hợp nhất với AFTER hiện tại. Match rule (P0):
 *  1. Cùng dimensionId (BẮT BUỘC)
 *  2. |after.tick - before.tick| ≤ 5 (stale guard)
 *  3. before.time ≤ after.time (BEFORE phải xảy ra trước AFTER)
 *  4. Chọn entry mới nhất pass điều kiện (queue tail → head scan ngược)
 *
 * KHÔNG dùng "lấy entry cuối cùng" vì có thể snapshot stale từ rapid cast
 * trước. Nếu không match → return null (session vẫn được tạo, sequenceId
 * được generate mới).
 * @param {Player} player
 * @param {CastSnapshot} after
 * @returns {CastSnapshot | null}
 */
function popPendingBefore(player, after) {
  const queue = pendingBeforeQueue.get(player.id);
  if (!queue || queue.length === 0) return null;
  for (let i = queue.length - 1; i >= 0; i--) {
    const cand = queue[i];
    if (cand.dimensionId !== after.dimensionId) continue;
    if (Math.abs(after.tick - cand.tick) > 5) continue;
    if ((cand.time ?? 0) > after.time) continue;
    queue.splice(i, 1);
    telemetry.pendingBeforeMatched += 1;
    return cand;
  }
  return null;
}

/**
 * Hoàn thiện 1 CastSession: link BEFORE (từ queue) + AFTER (current snapshot).
 * @param {Player} player
 * @returns {CastSession}
 */
function registerCastSession(player) {
  const after = captureSnapshot(player);
  const before = popPendingBefore(player, after);
  /** @type {CastSession} */
  const session = {
    sessionId: newSessionId(),
    playerId: player.id,
    sequenceId: before?.sequenceId,
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
    const posScore = clamp(100 * (1 - session.positionDelta / 2.0), 0, 100);
    const angScore = clamp(100 * (1 - session.directionAngleDelta / 0.6), 0, 100);
    session.playerConsistency = Math.round((posScore + angScore) / 2);
  } else {
    // Không có BEFORE match → consistency thấp
    session.playerConsistency = 30;
  }

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
    session.associationMethod !== 'DIRECT_CONFIRMED' &&
    session.associationMethod !== 'DIRECT_AMBIGUOUS' &&
    system.currentTick - session.hookSpawnTick <= 2
  );
  // Chỉ lấy 1 hook mới nhất (theo hookSpawnTick)
  if (candidates.length === 0) return false;
  candidates.sort((a, b) => b.hookSpawnTick - a.hookSpawnTick);
  const session = candidates[0];

  // P0: pop từ queue (không dùng Map.get cũ)
  const queue = pendingBeforeQueue.get(player.id) ?? [];
  const before = queue.length > 0 ? queue.shift() : undefined;
  if (before) telemetry.pendingBeforeMatched += 1;
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

  // Hook velocity magnitude: dùng calibration từ telemetry runtime
  // (P1.4 — telemetryHookSpeedEMA). Nếu chưa có calibration dùng
  // CAST_HOOK_VEL_EXPECT làm default. Score dựa trên fit-to-distribution,
  // KHÔNG phải magnitude thuần.
  const expectedSpeed = telemetryHookSpeedEMA > 0.01
    ? telemetryHookSpeedEMA
    : CAST_HOOK_VEL_EXPECT;
  // P1.4: hook speed cao hơn expected KHÔNG đồng nghĩa score cao hơn.
  // Chỉ đo "fit với distribution expected" (gần expected = tốt, quá xa = kém).
  const speedDelta = Math.abs(hookVelMag - expectedSpeed);
  const hookVelocityScore = clamp(100 * (1 - speedDelta / (expectedSpeed * 2)), 0, 100);

  // P1.1: Motion compensation. KHÔNG coi player moving là negative evidence.
  // Dùng P0 + V0*Δt để predict player location khi hook spawn, so với hookSpawn.
  // Nếu prediction fit → strong positive (Player chạy vẫn có thể là owner).
  const playerVel = before?.velocity ?? after?.velocity;
  const playerSpeed = vecMagnitude(/** @type {Vector3} */ (playerVel));
  let predictionErrorScore = 50;  // neutral khi không tính được
  if (playerVel && castLoc && (castTick !== undefined)) {
    const deltaTicks = Math.max(0, system.currentTick - castTick);
    const predictedLoc = {
      x: castLoc.x + playerVel.x * deltaTicks,
      y: castLoc.y + playerVel.y * deltaTicks,
      z: castLoc.z + playerVel.z * deltaTicks,
    };
    const predictedError = distance3D(predictedLoc, hookLoc);
    // Error càng nhỏ → score càng cao. Cùng ngưỡng CAST_TO_HOOK_DISTANCE.
    predictionErrorScore = clamp(100 * (1 - predictedError / CAST_TO_HOOK_DISTANCE), 0, 100);
  }
  // Nếu player đứng yên (playerSpeed ≈ 0) thì predicted = castLoc, error =
  // distance. Vẫn score đúng (không penalty, chỉ là special case).

  // Player-state consistency: before→after drift + playerConsistency field
  const playerStateScore = session.playerConsistency ?? 30;

  // Apply consistency penalty: session không reliable (low playerConsistency)
  // sẽ giảm tổng điểm
  const consistencyMultiplier = 0.5 + (playerStateScore / 200); // 0.5-1.0

  // Weighted total (0-1000)
  // P1.3: de-correlate. Ray + direction + angular → KINEMATIC group (gom).
  // playerMomentum thay bằng predictionError (motion comp).
  const kinematicScore = (rayScore + directionErrorScore + angularScore) / 3;
  const total = Math.round(
    (temporalScore * WEIGHT_TEMPORAL +
     spatialScore * WEIGHT_SPATIAL +
     kinematicScore * CAST_KINEMATIC_WEIGHT +
     hookVelocityScore * WEIGHT_HOOK_VELOCITY +
     predictionErrorScore * CAST_PREDICTION_WEIGHT +
     expectedScore * CAST_EXPECTED_WEIGHT) / 100 * consistencyMultiplier
  );

  /** @type {EvidenceBreakdown} */
  const evidence = {
    temporal: Math.round(temporalScore),
    spatial: Math.round(spatialScore),
    rayProjection: Math.round(rayScore),
    angular: Math.round(angularScore),
    hookVelocity: Math.round(hookVelocityScore),
    playerMomentum: Math.round(predictionErrorScore),  // P1.1: đổi tên field cho log
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
/**
 * Build assessments pool: scan castSessionsByPlayer + pendingBeforeQueue.
 * P4.1: skip sessions already bound to another hook (boundHookBySessionId).
 * @param {Entity} hook
 * @param {Vector3} hookVelocity
 * @returns {CastAssessment[]}
 */
function buildAssessments(hook, hookVelocity) {
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
      // P4.1: skip session already bound to another hook (P2.5 exclusivity)
      if (boundHookBySessionId.has(session.sessionId)) continue;

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
        if (projection < -2 && perpendicularError > CAST_RAY_MAX_PERPENDICULAR) continue;
      }
      // G5: viewDirection required
      if (!viewDir) continue;

      const assessment = assessCastHookAssociation(hook, player, session, hookVelocity);
      if (assessment) assessments.push(assessment);
    }
  }

  // P0 race fix v2: scan pending BEFORE snapshots
  for (const [playerId, queue] of pendingBeforeQueue) {
    const player = world.getEntity(playerId);
    if (!player || player.typeId !== 'minecraft:player') continue;

    for (const before of queue) {
      if (before.dimensionId !== hook.dimension.id) continue;
      const tickDelta = Math.abs(system.currentTick - before.tick);
      if (tickDelta > CAST_TO_HOOK_TICK_WINDOW) continue;
      const distance = distance3D(before.location, hook.location);
      if (distance > CAST_TO_HOOK_DISTANCE) continue;
      if (before.viewDirection && before.headLocation) {
        const { projection, perpendicularError } = projectOntoRay(before.headLocation, before.viewDirection, hook.location);
        if (projection < -2 && perpendicularError > CAST_RAY_MAX_PERPENDICULAR) continue;
      }
      if (!before.viewDirection) continue;

      const synthetic = makeSyntheticSession(player, before);
      const assessment = assessCastHookAssociation(hook, player, synthetic, hookVelocity);
      if (assessment) {
        assessments.push(assessment);
        telemetry.raceFixSynthetic += 1;
      }
    }
  }

  return assessments;
}

/**
 * P4.2: Reconstruct assessment từ committed cache. Dùng khi hysteresis lock
 * active — return CastAssessment với score/player giữ nguyên.
 * @param {{playerId:string, score:number, confidence:ConfidenceState}} committed
 * @returns {CastAssessment}
 */
function assessmentsFromCommitted(committed) {
  return {
    session: /** @type {CastSession} */ ({}),
    playerId: committed.playerId,
    confidence: committed.confidence,
    score: committed.score,
    evidence: /** @type {EvidenceBreakdown} */ ({}),
  };
}

function selectBestCastSession(hook, hookVelocity) {
  const now = Date.now();

  // P4.2: hysteresis — nếu hook đã committed trong TTL, return cache trừ
  // khi evidence mới thay đổi mạnh. Tránh re-evaluation do duplicate event.
  const committed = committedAssignments.get(hook.id);
  if (committed && now <= committed.expiresAt) {
    // Re-evaluate nhanh để xem có nên override
    const freshAssessments = buildAssessments(hook, hookVelocity);
    const freshTop = freshAssessments.sort((a, b) => b.score - a.score)[0];
    if (!freshTop || freshTop.score < committed.score + REASSIGN_EVIDENCE_DELTA) {
      // Cache vẫn hợp lệ — return locked decision
      const locked = assessmentsFromCommitted(committed);
      return { top: locked, second: null, locked: true };
    }
    // Nếu có candidate mới mạnh hơn nhiều → fall through, update cache
    committedAssignments.delete(hook.id);
  }

  /** @type {CastAssessment[]} */
  const assessments = buildAssessments(hook, hookVelocity);

  if (assessments.length === 0) return { top: null, second: null };

  assessments.sort((a, b) => b.score - a.score);
  const top = assessments[0];
  const second = assessments[1] ?? null;

  // State mapping dựa trên score + margin
  const secondScore = second?.score ?? 0;
  const margin = top.score - secondScore;
  top.secondBestScore = secondScore;
  top.margin = margin;

  // P2.4: density-adaptive threshold. Nếu nhiều candidate cùng pass hard
  // gate → CONFIRMED cần margin cao hơn. NULL: nếu top.score quá thấp so
  // với threshold (kể cả sau density bonus) → UNKNOWN + return null.
  const candidateCount = assessments.length;
  const densityMarginBonus = Math.max(0, (candidateCount - 1) * 25);  // mỗi candidate thêm 25pt margin requirement
  const requiredConfirmedMargin = CONFIRMED_MIN_MARGIN + densityMarginBonus;
  const requiredAmbiguousMargin = AMBIGUOUS_MIN_MARGIN + Math.max(0, (candidateCount - 1) * 10);

  if (top.score >= CONFIRMED_MIN_SCORE && margin >= requiredConfirmedMargin) {
    top.confidence = 'CONFIRMED';
  } else if (top.score >= AMBIGUOUS_MIN_SCORE && margin >= requiredAmbiguousMargin) {
    top.confidence = 'AMBIGUOUS';
  } else {
    top.confidence = 'UNKNOWN';
    // P2.4: NULL — không force assignment, nhưng vẫn trả về top với
    // confidence=UNKNOWN để caller log evidence. Caller (onEntitySpawn) sẽ
    // check confidence và fall through to fallback heuristic.
    telemetry.nullAssignments += 1;
  }

  // P4.2: cache committed assignment nếu CONFIRMED. AMBIGUOUS/UNKNOWN không
  // cache (cần re-evaluate khi có evidence mới).
  if (top.confidence === 'CONFIRMED') {
    committedAssignments.set(hook.id, {
      playerId: top.playerId,
      score: top.score,
      confidence: top.confidence,
      expiresAt: now + COMMITTED_ASSIGNMENT_TTL_MS,
      lockedAt: now,
    });
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
      recordCausal(session.hookId, 'reel', { playerId: player.id, source: 'requestReel' });
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

  // P1.5: Cast vs Reel discrimination.
  // Nếu player có active hook (FISHING / INVENTORY_CHANGED / PENDING_RESULT) →
  // Rod use này là REEL, KHÔNG tạo CastSession mới.
  const activeHooks = getActiveHookSessionsForPlayer(player.id);
  if (activeHooks.length > 0) {
    // Reel path: tạo ReelCandidates per active hook, score, associate
    const reelDecisions = associateReelToHook(player, activeHooks);
    if (reelDecisions.length === 0) {
      log(`reel: no clear association for ${activeHooks.length} active hook(s)`, player.id);
      return;
    }
    for (const decision of reelDecisions) {
      const session = decision.session;
      transition(session, 'REEL_REQUESTED');
      recordCausal(session.hookId, 'reel', { playerId: player.id, source: 'onFishingRodUse', score: decision.score });
      session.lastKnownPlayerLocation = cloneVector(player.location);
      reelSignal.trigger({
        player,
        hookId: session.hookId,
        location: cloneVector(session.castLocation),
        tick: system.currentTick,
        timestamp: Date.now(),
      });
    }
    log(`reel associated player=${player.name} hooks=${reelDecisions.length}/${activeHooks.length}`, player.id);
    return;
  }

  // Cast path: tạo CastSession mới (không có active hook)
  const session = registerCastSession(player);

  if (backfillFallbackCast(player)) {
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

/**
 * Build synthetic CastSession từ pending BEFORE snapshot. Dùng cho race case
 * khi hook spawn TRƯỚC afterEvents.itemUse → CastSession thật chưa được
 * registerCastSession tạo.
 *
 * QUAN TRỌNG: synthetic session KHÔNG push vào castSessionsByPlayer.
 * `selectBestCastSession` tạo fresh mỗi lần assessment, không lưu lại.
 * Tránh "tạo hàng loạt CastSession giả chỉ vì 1 hook spawn" (P0 fix).
 * @param {Player} player
 * @param {CastSnapshot} before
 * @returns {CastSession}
 */
function makeSyntheticSession(player, before) {
  const after = captureSnapshot(player);
  /** @type {CastSession} */
  const session = {
    sessionId: `pending-${before.sequenceId ?? 0}`,
    playerId: player.id,
    sequenceId: before.sequenceId,
    dimensionId: before.dimensionId,
    before,
    after,
    createdAt: Date.now(),
    expiresAt: Date.now() + CAST_TTL_MS,
    playerConsistency: 50,
    synthetic: true,
  };
  return session;
}

/** @param {import('@minecraft/server').EntitySpawnAfterEvent} event */
function onEntitySpawn(event) {
  const entity = event.entity;
  if (entity.typeId === 'minecraft:fishing_hook') {
    // P0 race fix v2: KHÔNG materialize session cho mọi pending player.
    // Để selectBestCastSession tự build synthetic session on-the-fly nếu cần.
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
      // P0 fix: tách DIRECT_CONFIRMED vs DIRECT_AMBIGUOUS. AMBIGUOUS KHÔNG
      // phải confirmed owner.
      associationMethod:
        confidence === 'CONFIRMED' ? 'DIRECT_CONFIRMED' :
        confidence === 'AMBIGUOUS' ? 'DIRECT_AMBIGUOUS' :
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
      // P0 fix: castConfirmed CHỈ true khi CONFIRMED. AMBIGUOUS/TENTATIVE/
      // FALLBACK/UNKNOWN → false.
      castConfirmed: confidence === 'CONFIRMED',
      inventoryChanged: false,
      state: 'CASTING',
      confidence,
      evidence: DEBUG ? evidence : undefined,
    };
    trackSession(session);
    // P2.5: cast exclusivity — mark session ↔ hook binding
    if (castSession && !castSession.synthetic) {
      boundHookBySessionId.set(castSession.sessionId, entity.id);
    }
    transition(session, 'FISHING');

    // P2.3: causal chain
    recordCausal(entity.id, 'cast', {
      playerId: player.id,
      sessionId: castSession?.sessionId,
      sequenceId: castSession?.sequenceId,
      synthetic: castSession?.synthetic ?? false,
      tick: castSession?.before?.tick ?? castSession?.after?.tick,
    });
    recordCausal(entity.id, 'hook_spawn', {
      playerId: player.id,
      confidence,
      associationMethod: session.associationMethod,
      score: top?.score ?? 0,
    });

    // Telemetry: confidence counters
    telemetry.totalHooks += 1;
    if (confidence === 'CONFIRMED') telemetry.confirmed += 1;
    else if (confidence === 'AMBIGUOUS') telemetry.ambiguous += 1;
    else if (confidence === 'FALLBACK') telemetry.fallback += 1;
    else telemetry.unknown += 1;

    // P1.4: EMA update hook speed từ CONFIRMED hooks only
    const hookSpeed = vecMagnitude(hookVelocity);
    if (confidence === 'CONFIRMED' && hookSpeed >= CAST_HOOK_VEL_MIN) {
      telemetry.hookSpeedSamples += 1;
      if (telemetryHookSpeedEMA < 0.01) {
        telemetryHookSpeedEMA = hookSpeed;
      } else {
        telemetryHookSpeedEMA = telemetryHookSpeedEMA * (1 - HOOK_SPEED_EMA_ALPHA) + hookSpeed * HOOK_SPEED_EMA_ALPHA;
      }
    }

    // P1.2: schedule hook trajectory samples T1, T2 sau spawn
    scheduleHookTrajectory(entity.id, hookSpeed);
    // P2.3: hook_active ngay khi transition FISHING xong
    recordCausal(entity.id, 'hook_active', { playerId: player.id });

    // Telemetry: associationMethod counters (P0)
    switch (session.associationMethod) {
      case 'DIRECT_CONFIRMED': telemetry.directConfirmed += 1; break;
      case 'DIRECT_AMBIGUOUS': telemetry.directAmbiguous += 1; break;
      case 'TENTATIVE': telemetry.tentative += 1; break;
      case 'FALLBACK': telemetry.fallbackSem += 1; break;
      default: telemetry.unknownSem += 1;
    }

    if (DEBUG) {
      log(
        `hook spawn ${entity.id} owner=${player.name} confidence=${confidence} ` +
        `associationMethod=${session.associationMethod} castConfirmed=${session.castConfirmed} ` +
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

  // Debug: log full trajectory snapshot để user inspect parabola parameters
  // (velocity, direction-to-player, predicted next-tick position). Dùng để
  // tune `applyVelocityToReplacementItem` cho spawn replacement bay về player
  // giống vanilla fish arc.
  const itemVel = /** @type {Vector3} */ (itemCandidate.velocity);
  const itemSpeed = vecMagnitude(itemVel);
  const velDir = itemSpeed > 0.01 ? { x: itemVel.x / itemSpeed, y: itemVel.y / itemSpeed, z: itemVel.z / itemSpeed } : { x: 0, y: 0, z: 0 };
  // Predicted next-tick: vel + gravity (vanilla ~ -0.04 per tick on y, drag 0.98 on xz)
  const predictedNext = {
    x: itemCandidate.location.x + itemVel.x * 0.98,
    y: itemCandidate.location.y + (itemVel.y - 0.04),
    z: itemCandidate.location.z + itemVel.z * 0.98,
  };
  // Per-active-session context (active hook) + per-removed-hook context (post-remove pickup)
  /** @type {Array<{hookId: string, playerId: string|undefined, distHook: number}>} */
  const contexts = [];
  for (const session of sessionsByHook.values()) {
    if (session.dimensionId !== entity.dimension.id) continue;
    const d = distance3D(session.hookLocation, entity.location);
    if (d <= MAX_HOOK_TO_ITEM_DISTANCE * 1.5) contexts.push({ hookId: session.hookId, playerId: session.playerId, distHook: d });
  }
  for (const removedHook of pending.values()) {
    if (removedHook.dimensionId !== entity.dimension.id) continue;
    const d = distance3D(removedHook.location, entity.location);
    if (d <= MAX_HOOK_TO_ITEM_DISTANCE * 1.5) contexts.push({ hookId: removedHook.hookId, playerId: removedHook.playerId, distHook: d });
  }
  for (const ctx of contexts) {
    let playerInfo = '';
    if (ctx.playerId) {
      const player = world.getEntity(ctx.playerId);
      if (player && player.typeId === 'minecraft:player') {
        const pLoc = /** @type {Player} */ (player).location;
        const dx = pLoc.x - itemCandidate.location.x;
        const dy = (pLoc.y + 1.6) - itemCandidate.location.y;
        const dz = pLoc.z - itemCandidate.location.z;
        const dPlayer = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const dDir = dPlayer > 0.01 ? { x: dx / dPlayer, y: dy / dPlayer, z: dz / dPlayer } : { x: 0, y: 0, z: 0 };
        playerInfo = `playerLoc=(${pLoc.x.toFixed(2)},${pLoc.y.toFixed(2)},${pLoc.z.toFixed(2)}) ` +
          `dPlayer=${dPlayer.toFixed(2)} dirToPlayer=(${dDir.x.toFixed(2)},${dDir.y.toFixed(2)},${dDir.z.toFixed(2)}) `;
      }
    }
    log(
      `item-trajectory ${itemTypeId} id=${entity.id} hook=${ctx.hookId} distHook=${ctx.distHook.toFixed(2)} ` +
      `vel=(${itemVel.x.toFixed(3)},${itemVel.y.toFixed(3)},${itemVel.z.toFixed(3)}) ` +
      `speed=${itemSpeed.toFixed(3)} velDir=(${velDir.x.toFixed(2)},${velDir.y.toFixed(2)},${velDir.z.toFixed(2)}) ` +
      `loc=(${itemCandidate.location.x.toFixed(2)},${itemCandidate.location.y.toFixed(2)},${itemCandidate.location.z.toFixed(2)}) ` +
      `predictedNext=(${predictedNext.x.toFixed(2)},${predictedNext.y.toFixed(2)},${predictedNext.z.toFixed(2)}) ` +
      playerInfo,
      ctx.playerId
    );
  }

  // P2.3 + P5.1: item_spawn causal event. Gắn vào chain của TỪNG active
  // session HOẶC removed hook (vanilla pickup spawns item SAU hook_remove)
  // có distance gần item.
  for (const session of sessionsByHook.values()) {
    if (session.state === 'SUCCESS' || session.state === 'CANCELLED' || session.state === 'EMPTY_REEL') continue;
    if (session.dimensionId !== entity.dimension.id) continue;
    const d = distance3D(session.hookLocation, entity.location);
    if (d <= MAX_HOOK_TO_ITEM_DISTANCE * 1.5) {
      recordCausal(session.hookId, 'item_spawn', {
        itemId: entity.id,
        itemTypeId,
        dist: d.toFixed(2),
      });
    }
  }
  // P5.1: scan removedHook (pending) — item spawn có thể xảy ra sau hook_remove
  for (const removedHook of pending.values()) {
    if (removedHook.dimensionId !== entity.dimension.id) continue;
    const d = distance3D(removedHook.location, entity.location);
    if (d <= MAX_HOOK_TO_ITEM_DISTANCE * 1.5) {
      recordCausal(removedHook.hookId, 'item_spawn', {
        itemId: entity.id,
        itemTypeId,
        dist: d.toFixed(2),
        postRemove: true,
      });
    }
  }

  // P2.1: Item ↔ Hook active correlation. Nếu item spawn trong khi
  // FishingSession vẫn active (hook chưa remove) → log + capture context.
  correlateItemToActiveHook(itemCandidate);

  tryMatchAll();
}

/**
 * P2.1: correlate item vừa spawn với active hook sessions. Khác với
 * `tryMatchAll` (chỉ chạy sau hook remove), function này chạy NGAY khi
 * item spawn — capture hookNow + itemNow để tăng evidence cho Stage 2.
 *
 * Nếu match đủ mạnh → mark item.matched = true NGAY (early bind).
 * Nếu ambiguous → KHÔNG bind, để hook remove handler xử lý.
 * @param {ItemCandidate} item
 */
function correlateItemToActiveHook(item) {
  /** @type {{ session: FishingSession, score: number }[]} */
  const scored = [];
  for (const session of sessionsByHook.values()) {
    if (session.state !== 'FISHING' && session.state !== 'PENDING_RESULT' && session.state !== 'REEL_REQUESTED') continue;
    if (session.dimensionId !== item.dimensionId) continue;
    const hookLoc = session.hookLocation;
    const hookDist = distance3D(hookLoc, item.location);
    if (hookDist > MAX_HOOK_TO_ITEM_DISTANCE * 1.5) continue;
    const score = scoreActiveCorrelation(session, item);
    if (score > 0) scored.push({ session, score });
  }
  if (scored.length === 0) return;
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const second = scored[1];
  const margin = best.score - (second?.score ?? 0);

  // P2.4: density-adaptive threshold
  const densityBonus = Math.max(0, (scored.length - 1) * 50);
  const threshold = MIN_CORRELATION_SCORE + densityBonus;

  if (best.score < threshold) {
    log(`item ${item.entityId} active correlation UNKNOWN best=${best.score} threshold=${threshold} count=${scored.length}`, undefined);
    return;
  }
  if (scored.length > 1 && margin < 100) {
    log(`item ${item.entityId} active correlation UNCERTAIN best=${best.score} second=${second?.score ?? 0} margin=${margin}`, undefined);
    return;
  }

  // Early bind
  best.session.itemCandidates ??= [];
  best.session.itemCandidates.push(item);
  item.matched = true;
  log(
    `item ${item.itemTypeId} ${item.entityId} early-bound hook=${best.session.hookId} ` +
    `score=${best.score} margin=${margin} activeCandidates=${scored.length}`,
    best.session.playerId
  );
  telemetry.itemActiveMatched += 1;
}

/**
 * P2.1 + P2.2: score 1 FishingSession ↔ Item (active, hook còn tồn tại).
 * @param {FishingSession} session
 * @param {ItemCandidate} item
 * @returns {number}
 */
function scoreActiveCorrelation(session, item) {
  let score = SCORE_SESSION_ASSOCIATION;
  const hookLoc = session.hookLocation;
  const itemLoc = item.location;
  const itemVel = item.velocity;
  const itemSpeed = vecMagnitude(/** @type {Vector3} */ (itemVel));

  // Spatial: hook → item distance
  const hookDist = distance3D(hookLoc, itemLoc);
  score += weightedProximity(hookDist, MAX_HOOK_TO_ITEM_DISTANCE, SCORE_HOOK_DISTANCE);

  // Temporal: item spawn ngay sau reel (PENDING_RESULT) hoặc active
  const tickDelta = item.spawnTick - session.hookSpawnTick;
  score += weightedProximity(tickDelta, 60, 100);

  // P2.2: item trajectory 3D
  // direction to player
  const playerLoc = session.lastKnownPlayerLocation;
  const toPlayer = {
    x: playerLoc.x - itemLoc.x,
    y: playerLoc.y - itemLoc.y,
    z: playerLoc.z - itemLoc.z,
  };
  const toPlayerMag = vecMagnitude(/** @type {Vector3} */ (toPlayer));

  // direction to hook
  const toHook = {
    x: hookLoc.x - itemLoc.x,
    y: hookLoc.y - itemLoc.y,
    z: hookLoc.z - itemLoc.z,
  };
  const toHookMag = vecMagnitude(/** @type {Vector3} */ (toHook));

  if (itemSpeed >= 0.01 && toHookMag >= 0.01) {
    // Item velocity vs to-hook vector
    const dot = itemVel.x * (toHook.x / toHookMag) +
                itemVel.y * (toHook.y / toHookMag) +
                itemVel.z * (toHook.z / toHookMag);
    const cosA = clamp(dot / itemSpeed, -1, 1);
    const angle = Math.acos(cosA);
    // angle nhỏ = item bay về hook (tốt)
    const trajScore = clamp(100 * (1 - angle / Math.PI), 0, 100);
    score += (trajScore / 100) * SCORE_TRAJECTORY;
  }

  // Item bay về player (positive)
  if (itemSpeed >= 0.01 && toPlayerMag >= 0.01) {
    const dot = itemVel.x * (toPlayer.x / toPlayerMag) +
                itemVel.y * (toPlayer.y / toPlayerMag) +
                itemVel.z * (toPlayer.z / toPlayerMag);
    const cosA = clamp(dot / itemSpeed, -1, 1);
    const angle = Math.acos(cosA);
    // angle < 90° = bay về phía player → positive
    if (angle < Math.PI / 2) {
      score += SCORE_NEGATIVE_TRAJECTORY;  // reuse as positive
    } else {
      score -= SCORE_NEGATIVE_TRAJECTORY;  // bay xa player → negative
    }
  }

  // Reel requested bonus
  if (session.state === 'REEL_REQUESTED') score += 50;

  return score;
}

/** @param {import('@minecraft/server').EntityRemoveBeforeEvent} event */
function onBeforeEntityRemove(event) {
  const entity = event.removedEntity;
  if (entity.typeId !== 'minecraft:fishing_hook') return;

  // P2.5: cleanup session ↔ hook binding
  const session = untrackSession(entity.id);
  if (session?.sessionId) {
    boundHookBySessionId.delete(session.sessionId);
  }
  cleanupHookTrajectory(entity.id);
  // P4.2: cleanup hysteresis cache
  committedAssignments.delete(entity.id);
  // P2.3: log final causal chain, sau đó cleanup
  if (session) {
    recordCausal(entity.id, 'hook_remove', { playerId: session.playerId, state: session.state });
  }
  // P5.1: defer chain cleanup 2s để item_spawn (vanilla pickup) kịp append.
  // Vanilla auto-pickup fire item_spawn SAU hook_remove (vài tick sau). Nếu
  // xoá chain ngay, item_spawn causal event bị miss. Defer 2s = đủ cho
  // vanilla pickup xảy ra, sau đó log final chain.
  const hookIdForChain = entity.id;
  system.runTimeout(() => {
    const chain = causalChains.get(hookIdForChain);
    if (chain) {
      log(`causal chain hook=${hookIdForChain} events=${chain.length}: ${chain.map((c) => c.event).join(' → ')}`, session?.playerId);
      causalChains.delete(hookIdForChain);
    }
  }, 40); // 40 ticks = 2s
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

    // P1.2: cleanup hookTrajectories cũ (> 10s không có sample mới)
    for (const [hookId, traj] of hookTrajectories) {
      const lastSample = traj.samples[traj.samples.length - 1];
      const ref = lastSample ? lastSample.time : (Date.now() - 10000);
      if (now - ref > 10000) {
        cleanupHookTrajectory(hookId);
      }
    }

    // P2.3: cleanup causalChains cũ (> 30s, defensive — bình thường đã bị
    // xoá trong onBeforeEntityRemove). Tránh memory leak nếu hook bị miss.
    for (const [hookId, chain] of causalChains) {
      const last = chain[chain.length - 1];
      if (now - last.time > 30000) {
        log(`causal chain hook=${hookId} events=${chain.length} (timed out): ${chain.map((c) => c.event).join(' → ')}`, undefined);
        causalChains.delete(hookId);
      }
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
  log('detector initialized v2026-09-01-p5-item-fit-arc-v4', undefined);

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
