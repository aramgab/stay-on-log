// === GAME STATE ===
// Single mutable state object shared across modules.
// Persisted values (highScore, playerName) are loaded from localStorage.

// localStorage can throw in some webviews / private modes (e.g. when storage
// is disabled). Wrap access so a thrown error never aborts module loading.
export function lsGet(key) {
    try {
        return localStorage.getItem(key);
    } catch (e) {
        return null;
    }
}

export function lsSet(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch (e) {
        /* storage unavailable — ignore */
    }
}

export const state = {
    isPlaying: false,
    score: 0,           // survival trickle + eventScore, recomputed each frame
    eventScore: 0,      // points earned from events (obstacle clears, …) this run
    elapsed: 0,         // ms since this run started (accumulated from clamped frame deltas; background time while rAF is paused does NOT count)
    startTime: 0,       // wall-clock run start (informational; game logic uses elapsed)
    // v2 key: score is event-based now, so the old timer-based record is retired.
    highScore: parseInt(lsGet('stayOnLog_highScore_v2'), 10) || 0,
    playerName: lsGet('stayOnLog_playerName') || '',

    // Physics
    logAngle: 0,
    logSpeed: 0.8,
    logDirection: 1,
    userAngle: 0,
    contAngle: 0,        // accumulated phone rotation (winding); userAngle low-passes toward it
    velEMA: 0,           // low-passed rotation rate (deg/sample) fed into contAngle
    rawLastAngle: null,
    tiltEMA: 0,          // scheme B: smoothed absolute phone tilt, written by input.js
    tiltZero: 0,         // scheme B: neutral tilt, calibrated at the end of the countdown

    // Direction/speed change timer: elapsed-domain ms at which the next change fires
    nextChangeTime: 0,

    // Combo: consecutive obstacle clears without a hit (multiplies clear points)
    combo: 0,

    // Whether the "new record" haptic has already fired this run (fire once, not every frame)
    recordCelebrated: false,

    // Jump / lives
    isJumping: false,
    jumpStartTime: 0,   // Date.now() of the last jump start (branch timing check)
    invulnerable: false,
    hp: 2,
};
