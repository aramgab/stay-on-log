// === GAME CONFIG ===
// Tunable constants for physics, difficulty timing, and geometry.

// Direction/speed change timers (ms)
export const MIN_CHANGE_INTERVAL = 5000;
export const MAX_CHANGE_INTERVAL = 10000;

// Log rotation speed bounds
export const MIN_SPEED = 0.3;
export const MAX_SPEED = 2.5;

// === INPUT (phone "winding" control) ===
// The player rotates the phone to wind the stickman around the log; input.js
// accumulates the continuous rotation. These tune feel without breaking that.
// Position-domain low-pass toward the accumulated angle (higher = snappier, less lag).
export const INPUT_SMOOTH = 0.35;
// Ignore per-sample jitter below this many degrees (kills resting drift).
export const INPUT_DEADZONE = 0.25;
// Reject per-sample deltas above this (deg) as sensor glitches / unwrap errors.
export const INPUT_MAX_STEP = 80;
// Default control sensitivity (rotation multiplier); overridable via localStorage.
export const DEFAULT_SENSITIVITY = 1.0;

// Radius (px) at which the player orbits the center of the log.
// Matches the outer ring of the log SVG (circle r=135).
export const ORBIT_RADIUS = 135;

// === OBSTACLES & JUMP ===
// Radius (px) at which the obstacle sits on the rotating log surface.
export const OBSTACLE_RADIUS = 118;
// No obstacles at all until the player reaches this score (grace period).
export const OBSTACLE_START_SCORE = 250;
// After an obstacle is passed it submerges for this many full log rotations.
export const OBSTACLE_COOLDOWN_MIN_ROT = 1;
export const OBSTACLE_COOLDOWN_MAX_ROT = 3;
// Rotations to wait before the very first obstacle surfaces once past the grace score.
export const FIRST_EMERGE_ROT = 0.7;
// Angular window (deg) within which the obstacle collides with the player.
export const COLLIDE_WINDOW = 16;
// How long the jump lasts (ms). Collisions are ignored while airborne.
export const JUMP_DURATION = 480;
// Lives. First hit warns, last hit drops the player into the water.
export const START_HP = 2;
// Invulnerability window (ms) after a non-fatal hit.
export const INVULN_DURATION = 900;
// Slip-off threshold (deg). The player falls past ±this angle (symmetric).
export const FALL_THRESHOLD = 110;
