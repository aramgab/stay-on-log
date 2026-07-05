// === GAME CONFIG ===
// Tunable constants for physics, difficulty timing, and geometry.

// Direction/speed change timers (ms)
export const MIN_CHANGE_INTERVAL = 5000;
export const MAX_CHANGE_INTERVAL = 10000;
// Blink the on-log direction arrow this long before a change fires.
export const CHANGE_WARN_MS = 1500;
// On-log arrow v2: arc span (deg) at MIN_SPEED / MAX_SPEED — the arc length
// IS the speedometer, so even the slowest spin must still read as an arrow.
export const ARROW_ARC_MIN_DEG = 40;
export const ARROW_ARC_MAX_DEG = 150;

// Log rotation speed bounds, in degrees per 60 Hz frame (the game loop
// dt-normalizes, so real-time pace is the same on 60/90/120 Hz displays).
// MAX_SPEED 2.5 → 2.2 after the July-2026 playtest: the late game (~180 pts)
// spiked too hard and read as "the accelerometer went aggressive".
export const MIN_SPEED = 0.3;
export const MAX_SPEED = 2.2;

// === INPUT (phone "winding" control) ===
// The player rotates the phone to wind the stickman around the log; input.js
// accumulates the continuous rotation. These tune feel without breaking that.
// Position-domain low-pass toward the accumulated angle (higher = snappier, less lag).
// Lower = smoother/calmer. 0.35 felt too sharp in playtest; softened to 0.18.
export const INPUT_SMOOTH = 0.18;
// Low-pass on the incoming rotation RATE before it accumulates. This restores the
// old "floaty"/intuitive glide: without it, raw sensor jitter (hand shake, tap shocks)
// rides straight into the angle and the control feels twitchy. Lower = calmer.
export const INPUT_VEL_SMOOTH = 0.2;
// Ignore per-sample jitter below this many degrees (kills resting drift).
export const INPUT_DEADZONE = 0.25;
// Reject per-sample deltas above this (deg) as sensor glitches / unwrap errors.
export const INPUT_MAX_STEP = 80;
// Default control sensitivity (rotation multiplier); overridable via localStorage.
export const DEFAULT_SENSITIVITY = 1.0;

// === CONTROL SCHEME B: TILT-RATE ("hold the tilt") ===
// Alternative input scheme: instead of endlessly winding the phone (scheme A
// above), the player HOLDS a tilt and the character drifts at a rate
// proportional to it — the familiar "steer like a mobile racing game" gesture.
// Dormant unless localStorage stayOnLog_controlScheme === 'tilt'.
export const TILT_RANGE_DEG = 30;      // tilt (deg from neutral) at which rate reaches max
export const TILT_RATE_MAX = 4.0;      // deg per 60 Hz frame at full tilt (dt-scaled in the loop)
export const TILT_DEADZONE_DEG = 2.5;  // no drift while the phone is near neutral
export const TILT_EXPO = 1.4;          // response curve; >1 = softer near center, sharper at edge
export const TILT_SMOOTH = 0.25;       // EMA factor on the sampled tilt position (per sensor sample)
export const TILT_GLITCH_DEG = 120;    // reject single-sample jumps beyond this as sensor glitches

// === STEERING ASSIST ("power steering" for newcomers) ===
// Fraction of the log's own rotation the game silently compensates for the
// player each frame, indexed by difficulty phase (see PHASE1_MS/PHASE2_MS
// below). Strongest early so beginners don't fall in the first few seconds;
// eases off toward phase 3 so late-game stays skill-based. 0 = disabled.
// Phases 2-3 raised (0.18/0.10 → 0.22/0.15) after the July-2026 playtest —
// the late-game difficulty cliff was too steep on a real phone.
export const ASSIST_PHASE_FACTOR = [0.30, 0.22, 0.15];

// Radius (px) at which the player orbits the center of the log.
// Matches the outer ring of the log SVG (circle r=135).
export const ORBIT_RADIUS = 135;

// === OBSTACLES & JUMP ===
// Radius (px) at which the obstacle sits on the rotating log surface.
export const OBSTACLE_RADIUS = 118;
// No obstacles at all for this long after the start (grace period, ms).
// 25s felt empty for a hyper-casual opening; 12s keeps the warm-up short.
export const OBSTACLE_START_MS = 12000;
// After an obstacle is passed it submerges for this many full log rotations.
export const OBSTACLE_COOLDOWN_MIN_ROT = 1;
export const OBSTACLE_COOLDOWN_MAX_ROT = 3;
// Cooldown multiplier per difficulty phase — obstacles come denser over time
// (phase 1: 1-3 rotations, phase 2: ~0.7-2.1, phase 3: 0.5-1.5).
export const OBSTACLE_COOLDOWN_PHASE_SCALE = [1, 0.7, 0.5];
// Rotations to wait before the very first obstacle surfaces once past the grace score.
export const FIRST_EMERGE_ROT = 0.7;
// Angular window (deg) within which the obstacle collides with the player.
export const COLLIDE_WINDOW = 16;
// Obstacle type table. Each type carries its collision window and CSS class;
// obstacles.js reads geometry/behavior from here so new types stay data-driven.
export const OBSTACLE_TYPES = {
    // Classic mossy knot: any jump clears it.
    knot: { cssClass: 'ob-knot', collideWindow: COLLIDE_WINDOW },
    // Tall branch: needs a well-timed jump — contact during the very first or
    // last midAirMarginMs of the jump counts as clipping it (= hit).
    branch: { cssClass: 'ob-branch', collideWindow: COLLIDE_WINDOW, midAirMarginMs: 80 },
    // Double knot: two collision points, one jump each (rhythm). Spawns only
    // below maxSpeed so the speed-scaled gap stays sane.
    double: { cssClass: 'ob-knot', collideWindow: COLLIDE_WINDOW, maxSpeed: 1.2 },
};
// How long the jump lasts (ms). Collisions are ignored while airborne.
// Must equal the #player.jumping CSS animation duration (playerJump keyframes
// in css/styles.css) — keep both in sync when tuning.
export const JUMP_DURATION = 620;
// Lives. First hit warns, last hit drops the player into the water.
export const START_HP = 2;
// Invulnerability window (ms) after a non-fatal hit.
export const INVULN_DURATION = 900;
// Slip-off threshold (deg). The player falls past ±this angle (symmetric).
export const FALL_THRESHOLD = 110;
// Deg from the top where the danger vignette starts fading in; full opacity
// at FALL_THRESHOLD. Gives players a visual cue for why they're about to fall.
export const DANGER_WARN_FROM = 55;

// === SCORING (event-based) ===
// Score = a small survival trickle + bonuses for actually doing things, so that
// skill earns points instead of just time. (See P0.3 in the plan.)
// One survival point per this many ms alive (500 = 2 pts/sec).
export const SURVIVAL_MS_PER_POINT = 500;
// Points awarded for jumping over (clearing) an obstacle.
export const OBSTACLE_CLEAR_POINTS = 25;
// Consecutive clears without a hit multiply the clear points, capped here.
export const COMBO_MAX_MULT = 5;

// === DIFFICULTY PHASES (time-based, ms) ===
// Decoupled from score now that score is event-based. Timings match the old
// 250/400/800-score thresholds (~25/40/80 s).
export const PHASE1_MS = 40000;
export const PHASE2_MS = 80000;

// When the new obstacle types join the spawn pool (elapsed ms) — aligned with
// the difficulty phases so variety ramps with skill.
export const BRANCH_FROM_MS = PHASE1_MS;
export const DOUBLE_FROM_MS = PHASE2_MS;

// === BIOMES (time-based scene palette: day -> sunset -> night -> storm) ===
// Sunset/night are aligned with the difficulty phases so the difficulty ramp
// is visible in the scenery; storm is the "you are good" late-game look.
export const BIOME_SUNSET_MS = PHASE1_MS;
export const BIOME_NIGHT_MS = PHASE2_MS;
export const BIOME_STORM_MS = 140000;

// === NEWCOMER HINTS ===
// Coach banners for the first runs only; veterans never see them.
export const HINT_JUMP_RUNS = 3;   // show the "tap to jump" banner during the first N runs

export const HINT_STEER_RUNS = 5;         // steering hint only during the first N runs
export const HINT_STEER_FROM = 0.45;      // danger fraction (0..1) at which the hint appears
export const HINT_STEER_COOLDOWN_MS = 6000; // don't re-show more often than this

// === INTERACTIVE TUTORIAL ===
export const TUT_LOG_SPEED = 0.5;        // slow log speed during the tutorial
export const TUT_BALANCE_HOLD_MS = 4000; // total in-zone time to pass step 1
export const TUT_BALANCE_ZONE_DEG = 45;  // "in zone" = within ±this of the top
export const TUT_JUMPS_TO_PASS = 2;      // step 2: taps needed before moving to the obstacle step

// === SHARING ===
// Landing URL for the "brag" share button. The game is published as a
// Telegram Mini App (@StayOnLog_bot, short name "game"), so shares open
// straight inside Telegram; append ?startapp=<payload> here if we ever need
// referral/deep-link payloads. Plain-browser visitors still reach the game
// via the t.me page's open-in-app flow.
export const SHARE_URL = 'https://t.me/StayOnLog_bot/game';
