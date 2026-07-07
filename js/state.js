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

    // Coin wallet (persisted) + coins picked up during the current run
    // (banked into the wallet by gameOver) + last run's haul for the result
    // screen ("+N 🪙 за забег").
    coins: parseInt(lsGet('stayOnLog_coins'), 10) || 0,
    runCoins: 0,
    lastRunCoins: 0,
    lastRunQuests: [], // quest titles completed during the last run (result screen)

    // Physics
    logAngle: 0,
    logSpeed: 0.8,      // live speed (ramps toward targetSpeed in gameLoop)
    targetSpeed: 0.8,   // speed the current/last change rolled; logSpeed chases it
    logDirection: 1,
    userAngle: 0,
    contAngle: 0,        // accumulated phone rotation (winding); userAngle low-passes toward it
    velEMA: 0,           // low-passed rotation rate (deg/sample) fed into contAngle
    rawLastAngle: null,
    tiltEMA: 0,          // scheme B: smoothed absolute phone tilt, written by input.js
    tiltZero: 0,         // scheme B: neutral tilt, calibrated at the end of the countdown

    // Direction/speed change timer: elapsed-domain ms at which the next change fires
    nextChangeTime: 0,
    // The change that will fire at nextChangeTime, rolled in advance so the
    // on-log preview arrow can show the future: { dir: ±1, speed } or null.
    pendingChange: null,

    // Combo: consecutive obstacle clears without a hit (multiplies clear points)
    combo: 0,

    // Whether the "new record" haptic has already fired this run (fire once, not every frame)
    recordCelebrated: false,

    // elapsed-domain ms of the last applied direction/speed change (for the
    // "the change got you" death quip); -Infinity until the first change.
    lastChangeAt: -Infinity,
    // The quip picked by gameOver for this death; render.js shows it on the
    // result screen after the fall animation.
    deathQuip: '',

    // One paid revive per run (reset by startGame).
    revivedThisRun: false,

    // Run identifier for the battle delta-dedup: generated ONLY in startGame
    // and deliberately kept through a revive — both game overs of one run
    // submit under the same id, the server counts the growth once.
    runId: '',

    // Jump / lives
    isJumping: false,
    jumpStartTime: 0,   // Date.now() of the last jump start (branch timing check)
    invulnerable: false,
    hp: 2,
};
