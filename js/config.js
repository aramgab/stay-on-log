// === GAME CONFIG ===
// Tunable constants for physics, difficulty timing, and geometry.

// Direction/speed change timers (ms)
export const MIN_CHANGE_INTERVAL = 5000;
export const MAX_CHANGE_INTERVAL = 10000;

// Log rotation speed bounds
export const MIN_SPEED = 0.3;
export const MAX_SPEED = 2.5;

// Low-pass filter coefficient for accelerometer smoothing
export const SMOOTH_ALPHA = 0.15;

// Radius (px) at which the player orbits the center of the log.
// Matches the outer ring of the log SVG (circle r=135).
export const ORBIT_RADIUS = 135;

// === OBSTACLES & JUMP ===
// Radius (px) at which obstacles sit on the rotating log surface.
export const OBSTACLE_RADIUS = 118;
// Number of obstacles placed around the log at game start.
export const OBSTACLE_COUNT = 8;
// Keep this angular zone (deg) around the player's start clear of obstacles.
export const OBSTACLE_SAFE_ZONE = 40;
// Angular window (deg) within which an obstacle collides with the player.
export const COLLIDE_WINDOW = 16;
// Re-arm an obstacle once the player is this far (deg) past it again.
export const REARM_WINDOW = 45;
// How long the jump lasts (ms). Collisions are ignored while airborne.
export const JUMP_DURATION = 480;
// Lives. First hit warns, last hit drops the player into the water.
export const START_HP = 2;
// Invulnerability window (ms) after a non-fatal hit.
export const INVULN_DURATION = 900;
