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
// P1.3: de-correlate. Ray + direction + angular gom vào CAST_KINEMATIC_WEIGHT.
// playerMomentum penalty đổi thành motion compensation prediction.
export const WEIGHT_TEMPORAL = 150;
export const WEIGHT_SPATIAL = 200;
export const CAST_KINEMATIC_WEIGHT = 400;  // ray + direction + angular (gom)
export const WEIGHT_HOOK_VELOCITY = 100;
export const CAST_PREDICTION_WEIGHT = 100; // motion compensation (P1.1)
export const CAST_EXPECTED_WEIGHT = 50;    // hook velocity vs expected trajectory
// Tổng: 150+200+400+100+100+50 = 1000

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
