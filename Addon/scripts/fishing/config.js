// @ts-check

export const CORRELATION_WINDOW_MS = 1000;
export const MAX_HOOK_TO_ITEM_DISTANCE = 8;
export const MAX_ITEM_TO_PLAYER_DISTANCE = 24;
export const MAX_TICK_DELTA = 20;
export const MAX_TIME_DELTA_MS = 1000;
export const MIN_TIME_DELTA_MS = -100;
export const MIN_CORRELATION_SCORE = 1200;

export const SCORE_SESSION_ASSOCIATION = 1000;
export const SCORE_TIME_PROXIMITY = 200;
export const SCORE_TICK_PROXIMITY = 200;
export const SCORE_HOOK_DISTANCE = 150;
export const SCORE_PLAYER_DISTANCE = 100;
export const SCORE_TRAJECTORY = 100;
export const SCORE_RAY_ALIGNMENT = 80;
export const SCORE_NEGATIVE_TRAJECTORY = 60;

export const CAST_TO_HOOK_TICK_WINDOW = 10;
export const CAST_TO_HOOK_DISTANCE = 12;
export const CAST_TTL_MS = 3000;

export const MAX_ITEMS_PER_CATCH = 5;
export const ITEM_CANDIDATE_TTL_MS = 5000;
export const CLEANUP_INTERVAL_TICKS = 20;
export const FALLBACK_OWNER_MAX_DISTANCE = 30;
export const FALLBACK_OWNER_MIN_SCORE = 65;
export const FALLBACK_OWNER_SCORE_MARGIN = 20;
export const ENABLE_PICKUP_INTERCEPTION = true;

// ===== Stage 1 evidence weights (tổng = 1000) =====
// P1.4: de-correlate thành Spatial / Kinematic / Model groups.
// Spatial (location + drift): 250, Kinematic (ray + direction + angular + speed): 350,
// Model (motion-comp + trajectory): 300, Temporal: 100.
export const WEIGHT_TEMPORAL = 100;
export const WEIGHT_SPATIAL = 250;
export const CAST_KINEMATIC_WEIGHT = 350;  // ray + direction + angular + speed (gom)
export const CAST_MODEL_WEIGHT = 300;      // motion compensation + trajectory match

// P1.4: Kinematic sub-weights (tổng 325)
export const KINEMATIC_RAY_WEIGHT = 100;
export const KINEMATIC_DIRECTION_WEIGHT = 100;
export const KINEMATIC_ANGULAR_WEIGHT = 100;
export const KINEMATIC_HOOKSPEED_WEIGHT = 25;  // P9: hook thực tế bobber, speed unreliable

// P1.4: Model sub-weights (tổng 325) — P9: tăng trajectory weight
export const MODEL_MOTIONCOMP_WEIGHT = 100;
export const MODEL_TRAJECTORY_WEIGHT = 225;

// P1.2: Expected trajectory calibration (Bedrock hook physics).
// Hook spawns at player head + viewDir * EXPECTED_HOOK_SPAWN_DIST.
// Velocity starts at EXPECTED_HOOK_V0, drag 0.98/tick, no gravity (2 tick đầu).
export const EXPECTED_HOOK_SPAWN_DIST = 1.5;
export const EXPECTED_HOOK_V0 = 0.5;   // Bedrock hook thực tế ~0.3-1.0 m/s tại T1 (1 tick sau spawn)
export const EXPECTED_HOOK_DRAG = 0.92;
export const EXPECTED_HOOK_TRAJECTORY_TOLERANCE = 3.0;  // hook thật dao động mạnh do nước/grav

// P1.10: Reel weights (lifetime giảm, distance + session tăng).
// Tổng 1000.
export const REEL_WEIGHT_DISTANCE = 400;
export const REEL_WEIGHT_SESSION = 350;
export const REEL_WEIGHT_STATE = 150;
export const REEL_WEIGHT_LIFETIME = 50;
export const REEL_WEIGHT_SEQUENCE = 50;

// Cast→Hook thresholds (ray projection)
export const CAST_RAY_MIN_PROJECTION = 0.5;       // <0.5 = nhìn ngược hướng hook
export const CAST_RAY_MAX_PERPENDICULAR = 2.5;    // |S - (P + D*proj)| max blocks

// Hook velocity
export const CAST_HOOK_VEL_MIN = 0.05;            // hook tĩnh = loại
export const CAST_HOOK_VEL_EXPECT = 0.3;          // magnitude kỳ vọng 1-2 tick từ cast

// Player momentum penalty
export const CAST_PLAYER_SPEED_MAX = 0.1;         // >0.1 block/tick = moving penalty

// Before→After consistency
export const CAST_BEFORE_AFTER_MAX_DRIFT = 0.5;   // |player@spawn - player@beforeUse| max

// Angular
export const CAST_ANGULAR_MAX_DEG = 35;           // max angle giữa viewDir & hookVelocity

// Confidence state thresholds (điểm tổng 0-1000)
export const CONFIRMED_MIN_SCORE = 600;
export const CONFIRMED_MIN_MARGIN = 150;
export const AMBIGUOUS_MIN_SCORE = 400;
export const AMBIGUOUS_MIN_MARGIN = 50;

export const DEBUG = true;
export const DEBUG_TO_CHAT = false;
