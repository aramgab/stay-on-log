// === GAME ENTRY POINT ===
// Owns the main loop, game flow, difficulty logic, UI updates, the nickname
// system, and all event wiring.

import { state, lsSet } from './state.js';
import {
    MIN_CHANGE_INTERVAL,
    MAX_CHANGE_INTERVAL,
    MIN_SPEED,
    MAX_SPEED,
    JUMP_DURATION,
    START_HP,
    INVULN_DURATION,
} from './config.js';
import {
    logWrapper,
    orbitEl,
    playerEl,
    scoreEl,
    highScoreEl,
    heartsEl,
    newRecordEl,
    statusEl,
    arrowEl,
    speedEl,
    startBtn,
    obstacleLayer,
    desktopStub,
    countdownOverlay,
    countdownNumber,
    dirWarning,
    fallingPlayerEl,
    splashEl,
    playerNameEl,
    nicknameOverlay,
    nicknameInput,
    nicknameSaveBtn,
} from './dom.js';
import { handleMotion } from './input.js';
import { animateFall } from './render.js';
import { spawnObstacles, renderObstacleLayer, stepObstacles } from './obstacles.js';

// === TELEGRAM MINI APP (guarded; no-op outside Telegram) ===
if (window.Telegram && window.Telegram.WebApp) {
    try {
        window.Telegram.WebApp.ready();
        window.Telegram.WebApp.expand();
    } catch (e) {
        /* not in a Telegram context — ignore */
    }
}

// === DESKTOP DETECTION ===
// The game is driven by the device's tilt sensor, which desktops lack. On a
// non-touch device we show a "play on your phone" stub and never start play.
const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
const isDesktop = !isTouchDevice;

// === MAIN GAME LOOP ===
function gameLoop() {
    if (!state.isPlaying) return;

    // 1. Rotate the log
    state.logAngle += state.logSpeed * state.logDirection;
    logWrapper.style.transform = `rotate(${state.logAngle}deg)`;

    // 2. Player position
    let playerPosition = state.logAngle + state.userAngle;
    orbitEl.style.transform = `rotate(${playerPosition}deg)`;

    // 2b. Obstacles (rotate with the log, then test for a collision)
    renderObstacleLayer();
    if (stepObstacles() && registerHit(playerPosition)) {
        return; // fatal hit — loop stopped inside gameOver
    }

    // 3. Score
    let now = Date.now();
    state.score = Math.floor((now - state.startTime) / 100);
    scoreEl.innerText = "Очки: " + state.score;

    // Check for new record during gameplay
    if (state.score > state.highScore) {
        newRecordEl.style.display = 'block';
    }

    // 4. Direction/speed change
    if (now >= state.nextChangeTime) {
        scheduleNextChange();
        changeDirectionOrSpeed();
    }

    // 5. Warning before change
    if (state.nextChangeTime - now < 1500 && state.nextChangeTime - now > 0) {
        dirWarning.style.display = 'block';
    } else {
        dirWarning.style.display = 'none';
    }

    // 6. Check loss
    let normPos = ((playerPosition % 360) + 540) % 360 - 180;
    if (normPos > 90 || normPos < -90) {
        gameOver(normPos);
        return;
    }

    requestAnimationFrame(gameLoop);
}

// === DIRECTION / SPEED ===
function scheduleNextChange() {
    let interval = MIN_CHANGE_INTERVAL + Math.random() * (MAX_CHANGE_INTERVAL - MIN_CHANGE_INTERVAL);
    state.nextChangeTime = Date.now() + interval;
}

// Returns speed percent 0-100 from actual speed value
function getSpeedPercent(speed) {
    return ((speed - MIN_SPEED) / (MAX_SPEED - MIN_SPEED)) * 100;
}

function changeDirectionOrSpeed() {
    let rand = Math.random();
    let wantsReverse = rand < 0.4 || rand >= 0.7;
    let wantsSpeedChange = rand >= 0.4;

    let newSpeed = state.logSpeed;
    let newDirection = state.logDirection;

    // Determine new speed
    if (wantsSpeedChange) {
        newSpeed = MIN_SPEED + Math.random() * (MAX_SPEED - MIN_SPEED);
    }

    // Determine new direction
    if (wantsReverse) {
        newDirection = state.logDirection * -1;
    }

    // === DIFFICULTY BALANCE ===
    if (state.score < 400) {
        // Phase 1 (0-399): cap speed at 50%
        let maxSpeedPhase1 = MIN_SPEED + (MAX_SPEED - MIN_SPEED) * 0.5;
        if (newSpeed > maxSpeedPhase1) {
            newSpeed = MIN_SPEED + Math.random() * (maxSpeedPhase1 - MIN_SPEED);
        }
    } else if (state.score < 800) {
        // Phase 2 (400-799): block high-speed reversal combos
        // If reversing AND both old and new speed > 75%, re-roll new speed lower
        let threshold75 = MIN_SPEED + (MAX_SPEED - MIN_SPEED) * 0.75;
        let oldSpeedHigh = state.logSpeed > threshold75;
        let newSpeedHigh = newSpeed > threshold75;
        if (newDirection !== state.logDirection && oldSpeedHigh && newSpeedHigh) {
            // Re-roll speed to be within 0-75%
            newSpeed = MIN_SPEED + Math.random() * (threshold75 - MIN_SPEED);
        }
    }
    // Phase 3 (800+): no restrictions

    state.logSpeed = newSpeed;
    state.logDirection = newDirection;
    updateDirectionUI();
}

function updateDirectionUI() {
    if (state.logDirection === 1) {
        statusEl.innerText = "КРУТИ ВЛЕВО";
        arrowEl.innerText = "←";
    } else {
        statusEl.innerText = "КРУТИ ВПРАВО";
        arrowEl.innerText = "→";
    }
    let speedPercent = Math.round(getSpeedPercent(state.logSpeed));
    speedEl.innerText = "Скорость: " + speedPercent + "%";
}

function updateHighScoreDisplay() {
    if (state.highScore > 0) {
        highScoreEl.innerText = "Рекорд: " + state.highScore;
        highScoreEl.style.display = 'block';
    } else {
        highScoreEl.style.display = 'none';
    }
}

// === LIVES / JUMP / OBSTACLE HITS ===

function updateHearts() {
    heartsEl.innerText = '❤️'.repeat(Math.max(0, state.hp)) +
        '🤍'.repeat(Math.max(0, START_HP - state.hp));
}

// Normalize a screen angle to (-180, 180] — same convention as the loss check.
function normalizePos(playerPosition) {
    return ((playerPosition % 360) + 540) % 360 - 180;
}

// Apply an obstacle hit. Returns true if it was fatal (game over triggered).
function registerHit(playerPosition) {
    state.hp -= 1;
    updateHearts();

    if (state.hp <= 0) {
        gameOver(normalizePos(playerPosition));
        return true;
    }

    // Non-fatal: brief invulnerability + visual flash so a single obstacle
    // can't drain two lives in consecutive frames.
    state.invulnerable = true;
    playerEl.classList.add('hit');
    dirWarning.style.display = 'none';
    setTimeout(() => {
        state.invulnerable = false;
        playerEl.classList.remove('hit');
    }, INVULN_DURATION);
    return false;
}

function doJump() {
    if (!state.isPlaying || state.isJumping) return;
    state.isJumping = true;
    playerEl.classList.add('jumping');
    setTimeout(() => {
        state.isJumping = false;
        playerEl.classList.remove('jumping');
    }, JUMP_DURATION);
}

// === NICKNAME SYSTEM ===

function updatePlayerNameDisplay() {
    if (state.playerName) {
        playerNameEl.innerText = '👤 ' + state.playerName;
        playerNameEl.style.display = 'block';
    } else {
        playerNameEl.style.display = 'none';
    }
}

function showNicknameOverlay() {
    if (state.isPlaying) return;
    nicknameInput.value = state.playerName;
    nicknameOverlay.classList.add('active');
    setTimeout(() => nicknameInput.focus(), 100);
}

let saveNickname = function () {
    let name = nicknameInput.value.trim();
    if (!name) {
        nicknameInput.style.borderColor = '#ff6b6b';
        setTimeout(() => nicknameInput.style.borderColor = '', 1000);
        return;
    }
    state.playerName = name;
    lsSet('stayOnLog_playerName', state.playerName);
    nicknameOverlay.classList.remove('active');
    updatePlayerNameDisplay();
};

// === GAME FLOW ===

function handleStartClick() {
    if (!state.playerName) {
        showNicknameOverlay();
        // After saving nickname, auto-start
        const origSave = saveNickname;
        saveNickname = function () {
            origSave();
            if (state.playerName) {
                saveNickname = origSave;
                requestPermissionAndStart();
            }
        };
        return;
    }
    requestPermissionAndStart();
}

function requestPermissionAndStart() {
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
        DeviceMotionEvent.requestPermission()
            .then(response => {
                if (response === 'granted') {
                    showCountdown();
                } else {
                    alert("Нужен доступ к датчикам, чтобы крутить бревно!");
                }
            })
            .catch(console.error);
    } else {
        showCountdown();
    }
}

function showCountdown() {
    startBtn.style.display = 'none';
    arrowEl.style.display = 'none';
    speedEl.style.display = 'none';
    heartsEl.style.display = 'none';
    newRecordEl.style.display = 'none';
    statusEl.innerText = '';
    playerEl.classList.remove('visible', 'falling', 'jumping', 'hit');
    playerEl.style.opacity = '0';

    // Reset jump / invulnerability and clear any obstacles from a prev game.
    state.isJumping = false;
    state.invulnerable = false;
    state.obstacles = [];
    obstacleLayer.innerHTML = '';

    // Hide falling player & splash from prev game — full reset
    fallingPlayerEl.classList.remove('active');
    fallingPlayerEl.removeAttribute('style');
    fallingPlayerEl.style.display = 'none';
    splashEl.classList.remove('active');
    splashEl.removeAttribute('style');
    splashEl.style.display = 'none';

    countdownOverlay.classList.add('active');

    window.addEventListener('devicemotion', handleMotion);

    // Reset
    state.logAngle = 0;
    state.userAngle = 0;
    state.smoothedDelta = 0;
    state.rawLastAngle = null;
    state.logSpeed = 0.8;
    state.logDirection = 1;
    logWrapper.style.transform = 'rotate(0deg)';
    orbitEl.style.transform = 'rotate(0deg)';

    let count = 3;
    countdownNumber.innerText = count;
    countdownNumber.style.animation = 'none';
    void countdownNumber.offsetWidth;
    countdownNumber.style.animation = 'countPop 0.5s ease-out';

    let interval = setInterval(() => {
        count--;
        if (count > 0) {
            countdownNumber.innerText = count;
            countdownNumber.style.animation = 'none';
            void countdownNumber.offsetWidth;
            countdownNumber.style.animation = 'countPop 0.5s ease-out';
        } else {
            clearInterval(interval);
            countdownOverlay.classList.remove('active');

            state.userAngle = 0;
            state.smoothedDelta = 0;
            state.rawLastAngle = null;

            dropPlayer();
        }
    }, 1000);
}

function dropPlayer() {
    playerEl.classList.remove('visible', 'falling');
    playerEl.style.opacity = '0';

    requestAnimationFrame(() => {
        playerEl.classList.add('falling');

        playerEl.addEventListener('animationend', function onEnd() {
            playerEl.removeEventListener('animationend', onEnd);
            playerEl.classList.remove('falling');
            playerEl.classList.add('visible');
            playerEl.style.opacity = '';
            playerEl.style.top = '-25px';
            startGame();
        }, { once: true });
    });
}

function startGame() {
    state.isPlaying = true;
    state.startTime = Date.now();
    state.score = 0;

    // Lives & obstacles
    state.hp = START_HP;
    state.isJumping = false;
    state.invulnerable = false;
    playerEl.classList.remove('jumping', 'hit');
    spawnObstacles();
    updateHearts();
    heartsEl.style.display = 'block';

    arrowEl.style.display = 'block';
    speedEl.style.display = 'block';
    updateDirectionUI();
    scheduleNextChange();
    gameLoop();
}

function gameOver(normPos) {
    state.isPlaying = false;
    dirWarning.style.display = 'none';
    arrowEl.style.display = 'none';
    speedEl.style.display = 'none';
    heartsEl.style.display = 'none';
    window.removeEventListener('devicemotion', handleMotion);

    // Clear obstacles
    state.obstacles = [];
    obstacleLayer.innerHTML = '';

    // Hide stickman on log
    playerEl.classList.remove('visible', 'jumping', 'hit');
    playerEl.style.opacity = '0';

    // Save high score
    if (state.score > state.highScore) {
        state.highScore = state.score;
        lsSet('stayOnLog_highScore', state.highScore);
        updateHighScoreDisplay();
    }
    newRecordEl.style.display = 'none';

    // === FALL ANIMATION ===
    animateFall(normPos);
}

// === EVENT WIRING ===
// (Replaces the inline onclick handlers from the original single-file version.)
startBtn.addEventListener('click', handleStartClick);
playerNameEl.addEventListener('click', showNicknameOverlay);
// Arrow wrapper so the re-assignable `saveNickname` (auto-start trick) is
// resolved at click time, not at wiring time.
nicknameSaveBtn.addEventListener('click', () => saveNickname());
nicknameInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') saveNickname();
});

// Tap anywhere during play to jump over obstacles.
document.addEventListener('pointerdown', function () {
    if (state.isPlaying) doJump();
});

// On desktop (no tilt sensor) show the "play on your phone" stub and disable start.
if (isDesktop) {
    desktopStub.classList.add('active');
    startBtn.disabled = true;
}

// Show high score and nickname on load
updateHighScoreDisplay();
updatePlayerNameDisplay();
