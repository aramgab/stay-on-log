// === GAME STATE ===
// Single mutable state object shared across modules.
// Persisted values (highScore, playerName) are loaded from localStorage.

export const state = {
    isPlaying: false,
    score: 0,
    startTime: 0,
    highScore: parseInt(localStorage.getItem('stayOnLog_highScore')) || 0,
    playerName: localStorage.getItem('stayOnLog_playerName') || '',

    // Physics
    logAngle: 0,
    logSpeed: 0.8,
    logDirection: 1,
    userAngle: 0,
    smoothedDelta: 0,
    rawLastAngle: null,

    // Direction/speed change timer
    nextChangeTime: 0,
};
