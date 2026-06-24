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
    score: 0,
    startTime: 0,
    highScore: parseInt(lsGet('stayOnLog_highScore'), 10) || 0,
    playerName: lsGet('stayOnLog_playerName') || '',

    // Physics
    logAngle: 0,
    logSpeed: 0.8,
    logDirection: 1,
    userAngle: 0,
    smoothedDelta: 0,
    rawLastAngle: null,

    // Direction/speed change timer
    nextChangeTime: 0,

    // Jump / lives
    isJumping: false,
    invulnerable: false,
    hp: 2,
};
