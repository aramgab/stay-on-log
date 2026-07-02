// === GAME ENTRY POINT ===
// Owns the main loop, game flow, difficulty logic, UI updates, the nickname
// system, and all event wiring.

import { state, lsGet, lsSet } from './state.js';
import {
    MIN_CHANGE_INTERVAL,
    MAX_CHANGE_INTERVAL,
    MIN_SPEED,
    MAX_SPEED,
    JUMP_DURATION,
    START_HP,
    INVULN_DURATION,
    FALL_THRESHOLD,
    SURVIVAL_MS_PER_POINT,
    OBSTACLE_CLEAR_POINTS,
    COMBO_MAX_MULT,
    PHASE1_MS,
    PHASE2_MS,
    BIOME_SUNSET_MS,
    BIOME_NIGHT_MS,
    BIOME_STORM_MS,
} from './config.js';
import {
    logWrapper,
    orbitEl,
    playerEl,
    scoreEl,
    highScoreEl,
    heartsEl,
    muteBtn,
    howtoBtn,
    howtoOverlay,
    howtoGoBtn,
    howtoSensRange,
    howtoSensVal,
    newRecordEl,
    statusEl,
    arrowEl,
    speedFillEl,
    directionPill,
    startBtn,
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
    obSideHint,
} from './dom.js';
import { handleMotion, getSensitivity, setSensitivity, getSmooth, setSmooth } from './input.js';
import { animateFall } from './render.js';
import {
    spawnObstacles,
    renderObstacleLayer,
    stepObstacles,
    resetObstacles,
    isObstacleActive,
    activeObstacleType,
    isObstacleApproaching,
} from './obstacles.js';
import { initAudio, sfx, music, toggleMute, isMuted } from './audio.js';
import { hapticJump, hapticHit, hapticFall } from './haptics.js';
import { screenShake, burst, floatText } from './fx.js';

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

// Hidden dev mode (open with ?dev=1): lets us play on desktop with the keyboard
// to inspect mechanics. Real desktop users still get the "play on your phone"
// stub — the tilt sensor is the whole point of the game.
const devMode = new URLSearchParams(location.search).has('dev');
const DEV_KEY_SPEED = 2.5; // deg/frame the arrow keys move the player on the log
const devKeys = { left: false, right: false };

// === BIOMES (scene palette follows the difficulty ramp) ===
const BIOME_CLASSES = ['biome-day', 'biome-sunset', 'biome-night', 'biome-storm'];
let currentBiome = '';

function biomeFor(elapsed) {
    if (elapsed >= BIOME_STORM_MS) return 'biome-storm';
    if (elapsed >= BIOME_NIGHT_MS) return 'biome-night';
    if (elapsed >= BIOME_SUNSET_MS) return 'biome-sunset';
    return 'biome-day';
}

function applyBiome(elapsed) {
    const next = biomeFor(elapsed);
    if (next === currentBiome) return;
    currentBiome = next;
    document.body.classList.remove(...BIOME_CLASSES);
    document.body.classList.add(next);
    // Mark the transition audibly mid-run (not on the reset back to day).
    if (state.isPlaying && elapsed > 0) sfx.whoosh();
}

// === MAIN GAME LOOP ===
function gameLoop() {
    if (!state.isPlaying) return;

    let now = Date.now();
    state.elapsed = now - state.startTime;

    // 0. Dev keyboard control (desktop testing only)
    if (devMode) {
        if (devKeys.left) state.userAngle -= DEV_KEY_SPEED;
        if (devKeys.right) state.userAngle += DEV_KEY_SPEED;
    }

    // 1. Rotate the log
    state.logAngle += state.logSpeed * state.logDirection;
    logWrapper.style.transform = `rotate(${state.logAngle}deg)`;

    // 1b. The jump no longer freezes the player: being airborne only grants the
    // obstacle clear (via the isJumping flag in obstacles.js), so the player keeps
    // responding to tilt the whole time — no stuck-in-place feel while hopping.

    // 2. Player position
    let playerPosition = state.logAngle + state.userAngle;
    orbitEl.style.transform = `rotate(${playerPosition}deg)`;

    // 2b. Obstacles (rotate with the log, then handle the collision event)
    renderObstacleLayer();
    const obEvent = stepObstacles(Math.abs(state.logSpeed));
    if (obEvent === 'cleared') {
        // Skill reward: consecutive clears build a combo that multiplies the
        // clear points (reset on hit), + a ping + chips + floating popup.
        state.combo += 1;
        const mult = Math.min(state.combo, COMBO_MAX_MULT);
        const pts = OBSTACLE_CLEAR_POINTS * mult;
        state.eventScore += pts;
        if (mult > 1) sfx.combo(mult);
        else sfx.point();
        const xy = playerXY();
        burst(xy.x, xy.y, { color: '#6b4423', count: 10, size: 6, up: 50 });
        floatText(xy.x, xy.y - 26, '+' + pts + (mult > 1 ? ' ×' + mult : ''));
    } else if (obEvent === 'hit' && registerHit(playerPosition)) {
        return; // fatal hit — loop stopped inside gameOver
    }

    // 2c. Scene palette follows elapsed time (day -> sunset -> night -> storm)
    applyBiome(state.elapsed);

    // 2d. Approach-side hint: while an obstacle is riding up, show which side
    // of the log it will come from.
    obSideHint.className = isObstacleApproaching()
        ? (state.logDirection === 1 ? 'left' : 'right')
        : '';

    // 3. Score = small survival trickle + event points (skill-weighted)
    state.score = Math.floor(state.elapsed / SURVIVAL_MS_PER_POINT) + state.eventScore;
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

    // 6. Check loss (can't slip off while airborne)
    let normPos = ((playerPosition % 360) + 540) % 360 - 180;
    if (!state.isJumping && Math.abs(normPos) > FALL_THRESHOLD) {
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
    // Fairness: while a double is riding the log its gap was computed for the
    // current speed — freeze both speed and direction until it dives.
    if (activeObstacleType() === 'double') return;

    let rand = Math.random();
    let wantsReverse = rand < 0.4 || rand >= 0.7;
    let wantsSpeedChange = rand >= 0.4;

    // Fairness: a reversal while an obstacle is approaching would swing it
    // back down / flip its side — convert reversals into speed-only changes
    // (skipping entirely would leave long stretches without any variety).
    if (isObstacleActive() && wantsReverse) {
        wantsReverse = false;
        wantsSpeedChange = true;
    }

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

    // === DIFFICULTY BALANCE (time-based) ===
    if (state.elapsed < PHASE1_MS) {
        // Phase 1: cap speed at 50%
        let maxSpeedPhase1 = MIN_SPEED + (MAX_SPEED - MIN_SPEED) * 0.5;
        if (newSpeed > maxSpeedPhase1) {
            newSpeed = MIN_SPEED + Math.random() * (maxSpeedPhase1 - MIN_SPEED);
        }
    } else if (state.elapsed < PHASE2_MS) {
        // Phase 2: block high-speed reversal combos
        // If reversing AND both old and new speed > 75%, re-roll new speed lower
        let threshold75 = MIN_SPEED + (MAX_SPEED - MIN_SPEED) * 0.75;
        let oldSpeedHigh = state.logSpeed > threshold75;
        let newSpeedHigh = newSpeed > threshold75;
        if (newDirection !== state.logDirection && oldSpeedHigh && newSpeedHigh) {
            // Re-roll speed to be within 0-75%
            newSpeed = MIN_SPEED + Math.random() * (threshold75 - MIN_SPEED);
        }
    }
    // Phase 3 (after PHASE2_MS): no restrictions

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
    speedFillEl.style.width = speedPercent + "%";
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

// Viewport coords of the stickman (for spawning particles at the player).
function playerXY() {
    const r = playerEl.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

// Apply an obstacle hit. Returns true if it was fatal (game over triggered).
function registerHit(playerPosition) {
    state.hp -= 1;
    state.combo = 0;
    updateHearts();

    if (state.hp <= 0) {
        gameOver(normalizePos(playerPosition));
        return true;
    }

    // Non-fatal: brief invulnerability + visual flash so a single obstacle
    // can't drain two lives in consecutive frames.
    sfx.hit();
    hapticHit();
    screenShake(false);
    const xy = playerXY();
    burst(xy.x, xy.y, { color: '#ff5252', count: 8, size: 5 });
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
    state.jumpStartTime = Date.now();
    playerEl.classList.add('jumping');
    sfx.jump();
    hapticJump();
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
    initAudio(); // unlock/resume the AudioContext within this user gesture
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
    directionPill.style.display = 'none';
    heartsEl.style.display = 'none';
    newRecordEl.style.display = 'none';
    statusEl.innerText = '';
    playerEl.classList.remove('visible', 'falling', 'jumping', 'hit');
    playerEl.style.opacity = '0';

    // Reset jump / invulnerability and clear any obstacles from a prev game.
    state.isJumping = false;
    state.invulnerable = false;
    resetObstacles();
    applyBiome(0); // back to day for the new run

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
    state.contAngle = 0;
    state.velEMA = 0;
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
            state.contAngle = 0;
            state.velEMA = 0;
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
    state.eventScore = 0;
    state.combo = 0;
    state.elapsed = 0;

    // Lives & obstacles
    state.hp = START_HP;
    state.isJumping = false;
    state.invulnerable = false;
    playerEl.classList.remove('jumping', 'hit');
    spawnObstacles();
    updateHearts();
    heartsEl.style.display = 'block';

    directionPill.style.display = 'flex';
    updateDirectionUI();
    scheduleNextChange();
    music.start();
    gameLoop();
}

function gameOver(normPos) {
    state.isPlaying = false;
    dirWarning.style.display = 'none';
    obSideHint.className = '';
    directionPill.style.display = 'none';
    heartsEl.style.display = 'none';
    window.removeEventListener('devicemotion', handleMotion);
    music.stop();
    sfx.splash();
    hapticFall();
    screenShake(true);

    // Clear obstacles
    resetObstacles();

    // Hide stickman on log
    playerEl.classList.remove('visible', 'jumping', 'hit');
    playerEl.style.opacity = '0';

    // Save high score
    if (state.score > state.highScore) {
        state.highScore = state.score;
        lsSet('stayOnLog_highScore_v2', state.highScore);
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
// resolved at click time, not at wiring time. Also unlocks audio: for a
// first-time player this "Играть!" tap can be the first gesture of the
// whole session (nickname overlay appears before Start ever gets clicked).
nicknameSaveBtn.addEventListener('click', () => { initAudio(); saveNickname(); });
nicknameInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') saveNickname();
});

// Tap anywhere during play to jump over obstacles (but not on the mute button / dev panel).
// Also doubles as a cheap audio-unlock hook: iOS can suspend/interrupt the
// AudioContext after it was first created (backgrounding, notifications, the
// silent-switch), so re-running initAudio() on every tap keeps it resumed
// instead of relying solely on the one-time unlock at Start.
document.addEventListener('pointerdown', function (e) {
    if (e.target.closest && e.target.closest('#mute-btn, #howto-btn, #howto-overlay, #dev-tune')) return;
    initAudio();
    if (state.isPlaying) doJump();
});

// === HOW-TO / ONBOARDING ===
function syncHowtoSens() {
    howtoSensRange.value = getSensitivity();
    howtoSensVal.textContent = (+howtoSensRange.value).toFixed(2);
}
function openHowto() {
    if (state.isPlaying) return;
    syncHowtoSens();
    howtoOverlay.classList.add('active');
}
function closeHowto() {
    howtoOverlay.classList.remove('active');
    lsSet('stayOnLog_seenHowto', '1');
}
howtoBtn.addEventListener('click', openHowto);
howtoGoBtn.addEventListener('click', function () {
    initAudio(); // this "Поехали!" tap may be the very first user gesture
    closeHowto();
});
howtoSensRange.addEventListener('input', function () {
    setSensitivity(+howtoSensRange.value);
    howtoSensVal.textContent = (+howtoSensRange.value).toFixed(2);
});
// First launch: show how-to-play once.
if (!lsGet('stayOnLog_seenHowto')) openHowto();

// === SOUND TOGGLE ===
function updateMuteBtn() {
    muteBtn.innerText = isMuted ? '🔇' : '🔊';
}
muteBtn.addEventListener('click', function () {
    toggleMute();
    updateMuteBtn();
});
updateMuteBtn();

// On desktop (no tilt sensor) show the "play on your phone" stub and disable start.
// Exception: hidden dev mode (?dev=1) keeps desktop playable via the keyboard.
if (isDesktop && !devMode) {
    desktopStub.classList.add('active');
    startBtn.disabled = true;
}

// Dev keyboard: ←/→ balance, Space/↑ jump. Active only in dev mode.
if (devMode) {
    console.log('[dev] keyboard control: ←/→ balance, Space = jump');
    window.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowLeft') devKeys.left = true;
        else if (e.key === 'ArrowRight') devKeys.right = true;
        else if (e.key === ' ' || e.key === 'ArrowUp') { e.preventDefault(); doJump(); }
    });
    window.addEventListener('keyup', function (e) {
        if (e.key === 'ArrowLeft') devKeys.left = false;
        else if (e.key === 'ArrowRight') devKeys.right = false;
    });
    buildTunePanel();
}

// Live input-tuning panel (?dev=1). Works with the real tilt sensor on a phone —
// drag the sliders mid-session to find the right feel; values persist in localStorage.
function buildTunePanel() {
    const panel = document.createElement('div');
    panel.id = 'dev-tune';
    panel.innerHTML =
        '<label>sens <b id="dt-sv"></b><input id="dt-s" type="range" min="0.3" max="2" step="0.05"></label>' +
        '<label>smooth <b id="dt-mv"></b><input id="dt-m" type="range" min="0.05" max="0.6" step="0.01"></label>';
    document.body.appendChild(panel);

    const s = panel.querySelector('#dt-s');
    const m = panel.querySelector('#dt-m');
    const sv = panel.querySelector('#dt-sv');
    const mv = panel.querySelector('#dt-mv');
    s.value = getSensitivity();
    m.value = getSmooth();
    sv.textContent = (+s.value).toFixed(2);
    mv.textContent = (+m.value).toFixed(2);
    s.addEventListener('input', () => { setSensitivity(+s.value); sv.textContent = (+s.value).toFixed(2); });
    m.addEventListener('input', () => { setSmooth(+m.value); mv.textContent = (+m.value).toFixed(2); });
}

// Show high score and nickname on load
updateHighScoreDisplay();
updatePlayerNameDisplay();
applyBiome(0);
