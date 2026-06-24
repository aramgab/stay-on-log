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
