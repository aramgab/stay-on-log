// === GAME ENTRY POINT ===
// Owns the main loop, game flow, difficulty logic, UI updates, the nickname
// system, and all event wiring.

import { state, lsGet, lsSet } from './state.js';
import {
    MIN_CHANGE_INTERVAL,
    MAX_CHANGE_INTERVAL,
    CHANGE_WARN_MS,
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
    ASSIST_PHASE_FACTOR,
    DANGER_WARN_FROM,
    HINT_JUMP_RUNS,
    HINT_STEER_RUNS,
    HINT_STEER_FROM,
    HINT_STEER_COOLDOWN_MS,
    SHARE_URL,
    TILT_RANGE_DEG,
    TILT_RATE_MAX,
    TILT_EXPO,
    TILT_DEADZONE_DEG,
    TUT_LOG_SPEED,
    TUT_BALANCE_HOLD_MS,
    TUT_BALANCE_ZONE_DEG,
    TUT_JUMPS_TO_PASS,
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
    shareBtn,
    desktopStub,
    stubKeyboardBtn,
    countdownOverlay,
    countdownNumber,
    countdownTextEl,
    logDirArrow,
    fallingPlayerEl,
    splashEl,
    playerNameEl,
    nicknameOverlay,
    nicknameInput,
    nicknameSaveBtn,
    obSideHint,
    dangerVignette,
    hitFlash,
    tapHint,
    steerHint,
    tutorialBanner,
    tutorialSkipBtn,
} from './dom.js';
import { handleMotion, getSensitivity, setSensitivity, getSmooth, setSmooth, getScheme, setScheme } from './input.js';
import { animateFall } from './render.js';
import {
    spawnObstacles,
    renderObstacleLayer,
    stepObstacles,
    resetObstacles,
    isObstacleActive,
    activeObstacleType,
    isObstacleApproaching,
    forceEmerge,
} from './obstacles.js';
import { initAudio, sfx, music, toggleMute, isMuted } from './audio.js';
import { hapticJump, hapticHit, hapticFall, hapticClear, hapticTick, hapticRecord } from './haptics.js';
import { screenShake, burst, floatText } from './fx.js';
import { initTelegram, tgUser, cloudGet, cloudSet, shareScore } from './tg.js';

initTelegram();

// === DESKTOP DETECTION ===
// The game is driven by the device's tilt sensor, which desktops lack. On a
// non-touch device we show a "play on your phone" stub, but it's no longer a
// dead end: a "play with keyboard" button inside it promotes the keyboard
// (arrows + space) into an honest, visible input mode, so shared links opened
// on desktop Telegram/browsers are still playable.
const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
const isDesktop = !isTouchDevice;
if (isDesktop) document.body.classList.add('is-desktop'); // flips on desktop-only CSS hints

// Hidden dev mode (open with ?dev=1): skips the stub entirely and adds the
// live tuning panel. Keyboard control itself is now available to everyone on
// desktop via the stub's button (and stays on for ?dev=1 too, for debugging
// on a phone with a keyboard attached).
const devMode = new URLSearchParams(location.search).has('dev');
const DEV_KEY_SPEED = 2.5; // deg per 60 Hz frame (dt-scaled in the loop)
const devKeys = { left: false, right: false };

// Interactive tutorial (?tut=1): opt-in only for now — the flow is wired up
// end-to-end (including the "seen" flag write), but auto-launching it for
// every newcomer is a separate follow-up commit once this has been played on
// a real device.
const tutParam = new URLSearchParams(location.search).has('tut');

// Timestamp of the previous gameLoop frame (performance.now() domain), for
// delta-time normalization of all per-frame world stepping.
let lastFrameTs = 0;

// Global multiplier on ASSIST_PHASE_FACTOR (steering assist), tunable live via
// the ?dev=1 panel. Loaded the same way input.js loads sensitivity/smooth.
let assistMult = parseFloat(lsGet('stayOnLog_assistMult'));
if (isNaN(assistMult)) assistMult = 1;

function setAssistMult(v) {
    assistMult = v;
    lsSet('stayOnLog_assistMult', String(v));
}

function getAssistMult() {
    return assistMult;
}

// === NEWCOMER HINTS ===
// "Tap to jump" coach banner: shown only during a newcomer's first
// HINT_JUMP_RUNS runs, and only until they've jumped once THIS run (so it
// doesn't nag a player who already got the message mid-run).
let runCount = parseInt(lsGet('stayOnLog_runCount'), 10) || 0;
let jumpedThisRun = false;
// Mirrors the DOM's current .visible state so gameLoop only touches
// classList on an actual change, same pattern as obSideHint's className diff.
let tapHintVisible = false;

// "Steer back" coach banner: shown only during a newcomer's first
// HINT_STEER_RUNS runs, when the danger vignette crosses HINT_STEER_FROM.
// Hysteresis (show above HINT_STEER_FROM, hide only below 0.2) keeps it from
// flickering right at the threshold; the cooldown keeps it from re-popping
// every time danger dips and spikes again in the same close call.
let steerHintVisible = false;
let steerHintShownAt = -Infinity; // performance.now() of the last time it appeared
let steerHintSide = ''; // side the visible hint currently points to ('' = unset)

// Mirrors the on-log direction arrow's current .warning state, same
// classList-diff pattern as tapHintVisible/obSideHint above.
let arrowWarningVisible = false;

// Scheme B (tilt-rate) tuning, loaded/persisted the same way as assistMult
// above. Not wired to a UI yet — the ?dev=1 sliders for these land in a
// follow-up commit — but the getters/setters are ready for them.
let tiltRange = parseFloat(lsGet('stayOnLog_tiltRange'));
if (isNaN(tiltRange)) tiltRange = TILT_RANGE_DEG;

let tiltRateMax = parseFloat(lsGet('stayOnLog_tiltRateMax'));
if (isNaN(tiltRateMax)) tiltRateMax = TILT_RATE_MAX;

let tiltExpo = parseFloat(lsGet('stayOnLog_tiltExpo'));
if (isNaN(tiltExpo)) tiltExpo = TILT_EXPO;

let tiltDeadzone = parseFloat(lsGet('stayOnLog_tiltDeadzone'));
if (isNaN(tiltDeadzone)) tiltDeadzone = TILT_DEADZONE_DEG;

function setTiltRange(v) {
    tiltRange = v;
    lsSet('stayOnLog_tiltRange', String(v));
}

function getTiltRange() {
    return tiltRange;
}

function setTiltRateMax(v) {
    tiltRateMax = v;
    lsSet('stayOnLog_tiltRateMax', String(v));
}

function getTiltRateMax() {
    return tiltRateMax;
}

function setTiltExpo(v) {
    tiltExpo = v;
    lsSet('stayOnLog_tiltExpo', String(v));
}

function getTiltExpo() {
    return tiltExpo;
}

function setTiltDeadzone(v) {
    tiltDeadzone = v;
    lsSet('stayOnLog_tiltDeadzone', String(v));
}

function getTiltDeadzone() {
    return tiltDeadzone;
}

// === INTERACTIVE TUTORIAL ===
// A guided first run, gated behind ?tut=1 for now (see tutParam above). Runs
// its own mini game-flow instead of startGame()'s normal one: slow log,
// scripted obstacle prompts, no scoring/gameOver, an explicit step counter.
let tutorialMode = false;
let tutStep = 0;       // 0 = inactive, 1 = balance, 2 = jump-alone, 3 = jump-over-knot, 4 = done/outro
let tutHoldMs = 0;     // step 1: accumulated in-zone time
let tutJumps = 0;      // step 2: jumps landed so far this step
let tutWasJumping = false; // step 2: previous frame's state.isJumping, to catch the false->true edge
let tutLastEmergeAt = -Infinity; // step 3: performance.now() of the last forceEmerge('knot')
let tutBannerText = ''; // mirrors the DOM text so we only touch it on change
let tutBannerLastSec = -1; // step 1: last whole second shown, to avoid re-rendering every frame

function setTutorialBanner(text) {
    if (text === tutBannerText) return;
    tutBannerText = text;
    tutorialBanner.innerText = text;
}

function showTutorialBanner(text) {
    setTutorialBanner(text);
    tutorialBanner.classList.add('visible');
}

function hideTutorialUI() {
    tutorialBanner.classList.remove('visible');
    tutorialBanner.setAttribute('aria-hidden', 'true');
    tutBannerText = '';
    tutorialSkipBtn.style.display = 'none';
    tutorialSkipBtn.setAttribute('aria-hidden', 'true');
}

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
    music.setMood(next);
    // Mark the transition audibly mid-run (not on the reset back to day).
    if (state.isPlaying && elapsed > 0) { sfx.whoosh(); hapticTick(); }
}

// === MAIN GAME LOOP ===
function gameLoop() {
    if (!state.isPlaying) return;

    // Delta-time normalization: rAF frequency follows the display (60/90/120
    // Hz), so every per-frame world step below is scaled by dtF — 1.0 at
    // exactly 60 fps, ~0.5 per frame on a 120 Hz screen. Speeds in config.js
    // keep their meaning of "degrees per 60 Hz frame" on any display.
    // The clamp keeps tab-switch pauses / GC hiccups from teleporting the
    // world — and, because elapsed is accumulated from these clamped deltas,
    // backgrounding the app no longer farms survival points nor jumps the
    // difficulty/biome ramp (rAF stops, so elapsed stops with it).
    const nowTs = performance.now();
    const dtMs = Math.min(50, Math.max(0, nowTs - lastFrameTs));
    lastFrameTs = nowTs;
    const dtF = dtMs / (1000 / 60);
    // Tutorial: elapsed stays frozen at 0 — this alone disables obstacle
    // auto-spawn (obstacles.js gates on state.elapsed < OBSTACLE_START_MS,
    // which stays permanently true), the direction-change timer, biomes, and
    // survival scoring, without touching any of that logic directly.
    if (!tutorialMode) state.elapsed += dtMs;

    // 0. Keyboard control: dev mode (debugging) or the honest desktop mode
    // reached via the stub's "play with keyboard" button.
    if (devMode || isDesktop) {
        if (devKeys.left) state.userAngle -= DEV_KEY_SPEED * dtF;
        if (devKeys.right) state.userAngle += DEV_KEY_SPEED * dtF;
    }

    // Scheme B (tilt-rate): integrate the held tilt into the character angle,
    // dt-scaled here (NOT in the devicemotion handler — sensor cadence varies by
    // device). Deadzone → normalize to tiltRange → expo curve → rate.
    if (!isDesktop && getScheme() === 'tilt') {
        const t = state.tiltEMA - state.tiltZero;
        const mag = Math.abs(t) - tiltDeadzone;
        if (mag > 0) {
            const n = Math.min(1, mag / tiltRange);
            state.userAngle += Math.sign(t) * Math.pow(n, tiltExpo)
                * tiltRateMax * getSensitivity() * dtF;
        }
        // Keep both angle domains coherent so steering assist (which adjusts
        // both) and any scheme switch mid-session stay consistent.
        state.contAngle = state.userAngle;
    }

    // 1. Rotate the log
    state.logAngle += state.logSpeed * state.logDirection * dtF;
    logWrapper.style.transform = `rotate(${state.logAngle}deg)`;

    // 1b. The jump no longer freezes the player: being airborne only grants the
    // obstacle clear (via the isJumping flag in obstacles.js), so the player keeps
    // responding to tilt the whole time — no stuck-in-place feel while hopping.

    // 1c. Steering assist ("power steering" for newcomers): the game quietly
    // compensates a fraction of the log's own rotation each frame, so a
    // beginner who isn't tilting perfectly still drifts back toward the top
    // instead of sliding off. Strongest in phase 1, nearly gone by phase 3 so
    // late-game (once the player has learned the controls) stays skill-based.
    const phase = state.elapsed < PHASE1_MS ? 0 : (state.elapsed < PHASE2_MS ? 1 : 2);
    const assist = ASSIST_PHASE_FACTOR[phase] * assistMult;
    if (assist > 0) {
        // Must adjust BOTH angles: input.js low-passes userAngle toward
        // contAngle every sample, so nudging only one gets smoothed away —
        // the assist would be silently eaten by the very next devicemotion tick.
        state.contAngle -= state.logSpeed * state.logDirection * assist * dtF;
        state.userAngle -= state.logSpeed * state.logDirection * assist * dtF;
    }

    // 2. Player position
    let playerPosition = state.logAngle + state.userAngle;
    orbitEl.style.transform = `rotate(${playerPosition}deg)`;

    // 2b. Obstacles (rotate with the log, then handle the collision event)
    renderObstacleLayer();
    const obEvent = stepObstacles(Math.abs(state.logSpeed) * dtF);
    if (tutorialMode) {
        // Step 3 only: no score/combo, no hp/gameOver — soft feedback either
        // way, and the step counter is what actually advances. If the knot
        // dives unbeaten, tutorialTick() re-summons it (no event needed here).
        // The step guard also protects against a stray event right after a
        // softReset (which rewinds to step 1) re-triggering the outro.
        if (tutStep === 3 && obEvent === 'cleared') {
            tutStep = 4;
            tutBannerLastSec = -1;
            // Freeze the world for the outro: with the log stopped the
            // character can't drift off the top during the "Готов!" beat
            // (the step-4 softReset guard would otherwise let them hang
            // past FALL_THRESHOLD with no recovery).
            state.logSpeed = 0;
            showTutorialBanner('Готов! Погнали по-настоящему 🎉');
            lsSet('stayOnLog_seenTutorial_v1', '1');
            setTimeout(exitTutorial, 1400);
        } else if (tutStep === 3 && obEvent === 'hit') {
            sfx.hit();
            showTutorialBanner('Ой! Тапни ПЕРЕД сучком');
        }
    } else if (obEvent === 'cleared') {
        // Skill reward: consecutive clears build a combo that multiplies the
        // clear points (reset on hit), + a ping + chips + floating popup.
        state.combo += 1;
        const mult = Math.min(state.combo, COMBO_MAX_MULT);
        const pts = OBSTACLE_CLEAR_POINTS * mult;
        state.eventScore += pts;
        if (mult > 1) sfx.combo(mult);
        else sfx.point();
        hapticClear(mult);
        const xy = playerXY();
        // Combo escalation: a bigger multiplier earns a bigger visual beat.
        // Plain clear (mult 1) keeps the modest default burst; mult >= 3 gets
        // a light shake + larger burst; mult at the cap (5) gets the heavy
        // shake normally reserved for hits/falls.
        if (mult >= COMBO_MAX_MULT) {
            screenShake(true);
            burst(xy.x, xy.y, { color: '#ffd93d', count: 22, size: 11, up: 90, spread: 130 });
        } else if (mult >= 3) {
            screenShake(false);
            burst(xy.x, xy.y, { color: '#6b4423', count: 18, size: 10, up: 80, spread: 115 });
        } else {
            burst(xy.x, xy.y, { color: '#6b4423', count: 15, size: 9, up: 75 });
        }
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

    // 2e. Newcomer coach banner: "tap to jump", only for the first
    // HINT_JUMP_RUNS runs and only until the player has jumped this run.
    // classList is only touched on an actual state change (mirrors the
    // obSideHint pattern above, adapted to a single boolean flag).
    const wantsTapHint = !tutorialMode && isObstacleApproaching() && runCount <= HINT_JUMP_RUNS && !jumpedThisRun;
    if (wantsTapHint !== tapHintVisible) {
        tapHintVisible = wantsTapHint;
        tapHint.classList.toggle('visible', tapHintVisible);
    }

    // 3. Score = small survival trickle + event points (skill-weighted).
    // Skipped in the tutorial: no run should end in a false "new record".
    if (!tutorialMode) {
        state.score = Math.floor(state.elapsed / SURVIVAL_MS_PER_POINT) + state.eventScore;
        scoreEl.innerText = "Очки: " + state.score;

        // Check for new record during gameplay
        if (state.score > state.highScore) {
            newRecordEl.style.display = 'block';
            // Celebrate once per run — skip on a brand-new player's very first run
            // (highScore === 0), otherwise this fires within the first second.
            if (!state.recordCelebrated && state.highScore > 0) {
                state.recordCelebrated = true;
                hapticRecord();
                const r = scoreEl.getBoundingClientRect();
                const sx = r.left + r.width / 2;
                const sy = r.top + r.height / 2;
                burst(sx, sy, { color: '#ffd93d', count: 24, size: 10, up: 85, spread: 120 });
                floatText(sx, sy - 30, 'РЕКОРД!', '#ffd93d');
            }
        }
    }

    // 4. Direction/speed change. Elapsed is frozen at 0 in the tutorial, which
    // normally keeps this from firing (nextChangeTime is always scheduled in
    // the future) — EXCEPT on a brand-new session with ?tut=1 as the very
    // first run ever, before scheduleNextChange() has run once: state.js
    // defaults nextChangeTime to 0, so 0 >= 0 would be true on the tutorial's
    // first frame. The explicit gate closes that edge case.
    if (!tutorialMode && state.elapsed >= state.nextChangeTime) {
        scheduleNextChange();
        changeDirectionOrSpeed();
    }

    // 5. Warning before change: blink the on-log arrow (mirrors the
    // obSideHint pattern — only touch classList on an actual state change).
    const wantsArrowWarning = state.nextChangeTime - state.elapsed < CHANGE_WARN_MS
        && state.nextChangeTime - state.elapsed > 0;
    if (wantsArrowWarning !== arrowWarningVisible) {
        arrowWarningVisible = wantsArrowWarning;
        logDirArrow.classList.toggle('warning', arrowWarningVisible);
    }

    // 6. Check loss (can't slip off while airborne)
    let normPos = ((playerPosition % 360) + 540) % 360 - 180;

    // 6b. Danger vignette: red glow on the screen edge the player is sliding
    // toward, ramping in from DANGER_WARN_FROM to full at FALL_THRESHOLD.
    // normPos > 0 = player has drifted clockwise = to the RIGHT of the top
    // (matches render.js animateFall, where normPos > 0 sets fallDirection = 1
    // and moves the falling stickman toward increasing X = screen right).
    const danger = Math.min(1, Math.max(0, (Math.abs(normPos) - DANGER_WARN_FROM) / (FALL_THRESHOLD - DANGER_WARN_FROM)));
    dangerVignette.style.opacity = danger;
    dangerVignette.className = danger > 0 ? (normPos > 0 ? 'right' : 'left') : '';

    // 6b2. Tutorial step logic (balance hold / jump prompt / outro timing).
    if (tutorialMode) tutorialTick(dtMs, normPos);

    // 6c. Newcomer coach banner: "steer back" while drifting dangerously off
    // the top, for the first HINT_STEER_RUNS runs only. Hysteresis (appear
    // above HINT_STEER_FROM, disappear only below 0.2) stops it flickering
    // right at the threshold; the cooldown (measured from the moment it last
    // APPEARED) stops it re-popping on every little wobble during one close
    // call. While visible, the text keeps following whichever side the
    // player is currently drifting toward.
    if (!tutorialMode && runCount <= HINT_STEER_RUNS) {
        const nowMs = performance.now();
        if (!steerHintVisible) {
            if (danger > HINT_STEER_FROM && nowMs - steerHintShownAt >= HINT_STEER_COOLDOWN_MS) {
                steerHintVisible = true;
                steerHintShownAt = nowMs;
                steerHint.classList.add('visible');
            }
        } else if (danger < 0.2) {
            steerHintVisible = false;
            steerHintSide = '';
            steerHint.classList.remove('visible');
        }
        if (steerHintVisible) {
            // Steer opposite the drift: normPos > 0 = blown to the RIGHT of
            // the top (same convention as the vignette/animateFall above),
            // so the way back is LEFT — and symmetrically for normPos < 0.
            // Rewrite the text only when the side actually flips, not per frame.
            const side = normPos > 0 ? 'left' : 'right';
            if (side !== steerHintSide) {
                steerHintSide = side;
                steerHint.innerText = side === 'left'
                    ? (isDesktop ? '⬅ ЖМИ ВЛЕВО' : schemeText('⟲ КРУТИ ВЛЕВО', '⬅ НАКЛОНЯЙ ВЛЕВО'))
                    : (isDesktop ? 'ЖМИ ВПРАВО ➡' : schemeText('КРУТИ ВПРАВО ⟳', 'НАКЛОНЯЙ ВПРАВО ➡'));
            }
        }
    }

    if (!state.isJumping && Math.abs(normPos) > FALL_THRESHOLD) {
        if (tutorialMode) {
            tutorialSoftReset();
        } else {
            gameOver(normPos);
            return;
        }
    }

    requestAnimationFrame(gameLoop);
}

// === DIRECTION / SPEED ===
function scheduleNextChange() {
    let interval = MIN_CHANGE_INTERVAL + Math.random() * (MAX_CHANGE_INTERVAL - MIN_CHANGE_INTERVAL);
    state.nextChangeTime = state.elapsed + interval;
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

// Scheme-aware copy: scheme A ("wind the phone") and scheme B ("hold the
// tilt") teach opposite muscle memory, so every player-facing string that
// tells the player HOW to move must match whichever scheme is active. Keyboard
// mode's own strings are untouched — desktop never runs scheme B.
function schemeText(windText, tiltText) {
    return getScheme() === 'tilt' ? tiltText : windText;
}

function updateDirectionUI() {
    if (state.logDirection === 1) {
        statusEl.innerText = schemeText("КРУТИ ВЛЕВО", "НАКЛОНЯЙ ВЛЕВО");
        arrowEl.innerText = "←";
    } else {
        statusEl.innerText = schemeText("КРУТИ ВПРАВО", "НАКЛОНЯЙ ВПРАВО");
        arrowEl.innerText = "→";
    }
    let speedPercent = Math.round(getSpeedPercent(state.logSpeed));
    speedFillEl.style.width = speedPercent + "%";
    // logDirection === 1 -> logAngle increases -> log spins clockwise on
    // screen; the arrow's built-in arc already reads as clockwise, so only
    // flip it for the other direction.
    logDirArrow.classList.toggle('flip', state.logDirection !== 1);
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

// Full-screen red pulse on impact (hit or fatal fall). Restart trick mirrors
// screenShake() in fx.js: drop the class, force reflow, re-add it so a hit
// landing mid-animation still restarts the pulse from 0.
function triggerHitFlash() {
    hitFlash.classList.remove('active');
    void hitFlash.offsetWidth;
    hitFlash.classList.add('active');
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
    triggerHitFlash();
    const xy = playerXY();
    burst(xy.x, xy.y, { color: '#ff5252', count: 12, size: 8 });
    state.invulnerable = true;
    playerEl.classList.add('hit');
    arrowWarningVisible = false;
    logDirArrow.classList.remove('warning');
    setTimeout(() => {
        state.invulnerable = false;
        playerEl.classList.remove('hit');
    }, INVULN_DURATION);
    return false;
}

function doJump() {
    if (!state.isPlaying || state.isJumping) return;
    state.isJumping = true;
    jumpedThisRun = true;
    state.jumpStartTime = Date.now();
    playerEl.classList.add('jumping');
    sfx.jump();
    hapticJump();
    setTimeout(() => {
        state.isJumping = false;
        playerEl.classList.remove('jumping');
    }, JUMP_DURATION);
}

// === INTERACTIVE TUTORIAL: STEP LOGIC ===
// Advances the scripted 4-step flow. Called once per frame from gameLoop,
// AFTER obstacles have been stepped for this frame (so step 3 can react to
// this frame's stepObstacles() result) but the obEvent itself is handled by
// the caller (gameLoop's own tutorialMode branch) — this function only owns
// the step counter / banner text / forceEmerge scheduling.
function tutorialTick(dtMs, normPos) {
    const nowMs = performance.now();

    if (tutStep === 1) {
        if (Math.abs(normPos) <= TUT_BALANCE_ZONE_DEG) {
            tutHoldMs += dtMs;
            const secLeft = Math.ceil((TUT_BALANCE_HOLD_MS - tutHoldMs) / 1000);
            if (secLeft !== tutBannerLastSec) {
                tutBannerLastSec = secLeft;
                showTutorialBanner('Удерживай человечка наверху! ' + Math.max(0, secLeft) + ' сек');
            }
        }
        // Outside the zone: progress just freezes (no reset) — see design note
        // in the task, this keeps step 1 from feeling punishing.
        if (tutHoldMs >= TUT_BALANCE_HOLD_MS) {
            tutStep = 2;
            tutBannerLastSec = -1;
            tutJumps = 0;
            tutWasJumping = state.isJumping;
            showTutorialBanner('А теперь — ТАПНИ по экрану! Человечек прыгнет');
        }
        return;
    }

    if (tutStep === 2) {
        // No obstacle yet — just teach the tap-to-jump gesture in isolation.
        // Count a jump on the false->true edge of state.isJumping so this
        // doesn't touch doJump() itself; multiple taps mid-air don't double count
        // because isJumping stays true for the whole JUMP_DURATION.
        const isJumpingNow = state.isJumping;
        if (isJumpingNow && !tutWasJumping) {
            tutJumps += 1;
            if (tutJumps < TUT_JUMPS_TO_PASS) {
                showTutorialBanner('Отлично! Ещё раз!');
            } else {
                tutStep = 3;
                tutBannerLastSec = -1;
                showTutorialBanner('Сучок! Перепрыгни его — тапни в нужный момент!');
                forceEmerge('knot');
                tutLastEmergeAt = nowMs;
            }
        }
        tutWasJumping = isJumpingNow;
        return;
    }

    if (tutStep === 3) {
        // Re-summon the knot if it dove back under unbeaten (dive() clears
        // isObstacleActive()) — give the dive/splash animation ~1.2s to play
        // out before forcing it back up, matching the task's guidance.
        if (!isObstacleActive() && nowMs - tutLastEmergeAt > 1200) {
            forceEmerge('knot');
            tutLastEmergeAt = nowMs;
        }
        return;
    }

    if (tutStep === 4) {
        // Outro: nothing to tick — exitTutorial() is scheduled by whoever set
        // tutStep to 4 (see the 'cleared' handling in gameLoop).
        return;
    }
}

// Soft "fall" recovery for the tutorial: replaces gameOver() while
// tutorialMode is active (see the gameLoop gate). Re-centers the CHARACTER,
// rewinds progress to step 1 (falling on any later step means the player
// hasn't really learned to balance yet either), and leaves tiltZero alone —
// that's the scheme-B neutral-posture calibration, unrelated to a fall and
// still valid.
function tutorialSoftReset() {
    if (tutStep === 4) return; // outro is already wrapping up via exitTutorial's setTimeout

    // playerPosition = logAngle + userAngle, and unlike the countdown reset
    // the log has been spinning here (logAngle is arbitrary) — zeroing
    // userAngle would drop the character wherever the log happens to point,
    // possibly still past FALL_THRESHOLD and re-triggering this reset every
    // frame. Counter-rotate instead so the character lands back on top.
    state.userAngle = -state.logAngle;
    state.contAngle = state.userAngle;
    state.velEMA = 0;
    state.rawLastAngle = null;

    tutStep = 1;
    tutHoldMs = 0;
    tutJumps = 0;
    tutBannerLastSec = -1;
    screenShake(false);
    showTutorialBanner('Оп! Крути против вращения — удерживай наверху');
}

// Ends the tutorial (either completed or skipped) and hands off to the
// normal game flow's own full reset (showCountdown does resetObstacles,
// score, angles, etc. — no need to duplicate any of that here).
// Idempotent: the step-3 outro schedules this via setTimeout, but a skip-tap
// during that same 1400ms window would otherwise fire it a second time and
// re-launch the countdown on top of the just-started real run.
function exitTutorial() {
    if (!tutorialMode) return;
    tutorialMode = false;
    tutStep = 0;
    tutHoldMs = 0;
    tutJumps = 0;
    tutWasJumping = false;
    tutLastEmergeAt = -Infinity;
    tutBannerLastSec = -1;
    // Stop the tutorial's game loop BEFORE handing off to the countdown.
    // Without this the loop keeps running (in normal mode now!) through the
    // whole 3-2-1: the log carries the character past FALL_THRESHOLD and the
    // "real" run gameOvers itself before it even starts — the player lands on
    // a fallen stickman and a restart screen instead of a fresh game.
    state.isPlaying = false;
    hideTutorialUI();
    directionPill.style.display = '';
    showCountdown();
}

tutorialSkipBtn.addEventListener('click', function () {
    lsSet('stayOnLog_seenTutorial_v1', '1');
    exitTutorial();
});

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
    nameSource = 'user';
    cloudSet('stayOnLog_playerName', state.playerName);
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
    // Guided tutorial: forced via ?tut=1 (re-testable anytime), and launched
    // automatically for a newcomer who hasn't completed/skipped it yet. The
    // flag is written by the tutorial itself (finish or skip), so a player
    // who bails mid-tutorial by reloading gets offered it again.
    const wantsTutorial = tutParam || !lsGet('stayOnLog_seenTutorial_v1');
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
        DeviceMotionEvent.requestPermission()
            .then(response => {
                if (response === 'granted') {
                    showCountdown(wantsTutorial);
                } else {
                    alert("Нужен доступ к датчикам, чтобы крутить бревно!");
                }
            })
            .catch(console.error);
    } else {
        showCountdown(wantsTutorial);
    }
}

function showCountdown(startTutorialMode) {
    // Desktop plays with the keyboard (dev mode too — a keyboard is the only
    // input desktop ever has), so the countdown copy should match what the
    // player is about to do instead of always mentioning the phone. On a
    // phone, the wording also depends on the active control scheme.
    countdownTextEl.innerText = startTutorialMode
        ? 'Сейчас потренируемся!'
        : (isDesktop
            ? 'Клавиатура: ←/→ — баланс, пробел — прыжок!'
            : schemeText('Готовься крутить телефон!', 'Наклоняй телефон и держись наверху!'));

    startBtn.style.display = 'none';
    shareBtn.style.display = 'none';
    directionPill.style.display = 'none';
    logDirArrow.classList.remove('on', 'warning');
    arrowWarningVisible = false;
    heartsEl.style.display = 'none';
    newRecordEl.style.display = 'none';
    statusEl.innerText = '';
    playerEl.classList.remove('visible', 'falling', 'jumping', 'hit');
    playerEl.style.opacity = '0';
    dangerVignette.style.opacity = 0;
    dangerVignette.className = '';
    tapHint.classList.remove('visible');
    tapHintVisible = false;
    steerHint.classList.remove('visible');
    steerHintVisible = false;
    steerHintShownAt = -Infinity;
    steerHintSide = '';
    // Defensive: the normal flow never shows these, but guard anyway (mirrors
    // the tap/steer-hint resets right above).
    hideTutorialUI();

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
    hapticTick();

    let interval = setInterval(() => {
        count--;
        if (count > 0) {
            countdownNumber.innerText = count;
            countdownNumber.style.animation = 'none';
            void countdownNumber.offsetWidth;
            countdownNumber.style.animation = 'countPop 0.5s ease-out';
            hapticTick();
        } else {
            clearInterval(interval);
            countdownOverlay.classList.remove('active');

            state.userAngle = 0;
            state.contAngle = 0;
            state.velEMA = 0;
            state.rawLastAngle = null;
            state.tiltZero = state.tiltEMA; // scheme B: current posture becomes neutral

            dropPlayer(startTutorialMode);
        }
    }, 1000);
}

function dropPlayer(startTutorialMode) {
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
            if (startTutorialMode) startTutorial();
            else startGame();
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
    state.recordCelebrated = false;

    // Newcomer hints: count this run, reset the per-run "already jumped" flag.
    runCount += 1;
    lsSet('stayOnLog_runCount', String(runCount));
    jumpedThisRun = false;

    // Lives & obstacles
    state.hp = START_HP;
    state.isJumping = false;
    state.invulnerable = false;
    playerEl.classList.remove('jumping', 'hit');
    spawnObstacles();
    updateHearts();
    heartsEl.style.display = 'block';

    directionPill.style.display = 'flex';
    logDirArrow.classList.add('on');
    updateDirectionUI();
    scheduleNextChange();
    music.start();
    lastFrameTs = performance.now();
    gameLoop();
}

// Guided first run (?tut=1 only for now, see tutParam/requestPermissionAndStart).
// Runs the same rAF loop as startGame() but gameLoop's tutorialMode gates skip
// the score/difficulty/gameOver machinery — see the gameLoop gates below and
// tutorialTick() for the actual 4-step script.
function startTutorial() {
    tutorialMode = true;
    tutStep = 1;
    tutHoldMs = 0;
    tutJumps = 0;
    tutWasJumping = false;
    tutLastEmergeAt = -Infinity;
    tutBannerLastSec = -1;

    state.isPlaying = true;
    state.logSpeed = TUT_LOG_SPEED;
    state.logDirection = 1;
    // Lives are full but hidden — the tutorial's soft hit-feedback (see
    // gameLoop's 'hit' handling) never actually spends them, so a lives
    // display would just be inert chrome. Hidden alongside directionPill,
    // which the tutorial banner replaces as the "what do I do" cue.
    state.hp = START_HP;
    state.isJumping = false;
    state.invulnerable = false;
    playerEl.classList.remove('jumping', 'hit');
    heartsEl.style.display = 'none';
    directionPill.style.display = 'none';
    logDirArrow.classList.add('on');
    updateDirectionUI(); // sets arrow orientation for logDirection = 1 above

    spawnObstacles(); // container for forceEmerge('knot') in step 3

    // Owner playtest feedback: the tutorial felt dead-silent next to the real
    // game. Same music as a run — elapsed is frozen at 0 here, so setMood
    // stays on the day palette; start() is idempotent (schedulerId guard).
    music.start();

    tutorialSkipBtn.style.display = 'block';
    tutorialSkipBtn.removeAttribute('aria-hidden');
    tutorialBanner.removeAttribute('aria-hidden');
    showTutorialBanner(isDesktop
        ? 'Держи ←/→ — как штурвал корабля'
        : schemeText('Крути телефон, как штурвал корабля 🚢', 'Наклоняй телефон, как руль ⛵'));

    lastFrameTs = performance.now();
    gameLoop();
}

function gameOver(normPos) {
    state.isPlaying = false;
    arrowWarningVisible = false;
    logDirArrow.classList.remove('warning', 'on');
    obSideHint.className = '';
    tapHint.classList.remove('visible');
    tapHintVisible = false;
    steerHint.classList.remove('visible');
    steerHintVisible = false;
    steerHintShownAt = -Infinity;
    steerHintSide = '';
    dangerVignette.style.opacity = 0;
    dangerVignette.className = '';
    directionPill.style.display = 'none';
    heartsEl.style.display = 'none';
    // Defensive: the normal flow never reaches gameOver while tutorialMode is
    // active (see the gameLoop gates), but guard the UI anyway.
    hideTutorialUI();
    window.removeEventListener('devicemotion', handleMotion);
    music.stop();
    sfx.splash();
    hapticFall();
    screenShake(true);
    triggerHitFlash();

    // Clear obstacles
    resetObstacles();

    // Hide stickman on log
    playerEl.classList.remove('visible', 'jumping', 'hit');
    playerEl.style.opacity = '0';

    // Save high score
    if (state.score > state.highScore) {
        state.highScore = state.score;
        lsSet('stayOnLog_highScore_v2', state.highScore);
        cloudSet('stayOnLog_highScore_v2', String(state.highScore));
        updateHighScoreDisplay();
    }
    newRecordEl.style.display = 'none';

    // === FALL ANIMATION ===
    animateFall(normPos);
}

// === EVENT WIRING ===
// (Replaces the inline onclick handlers from the original single-file version.)
startBtn.addEventListener('click', handleStartClick);
shareBtn.addEventListener('click', function () {
    initAudio(); // any tap may be the session's first gesture
    const text = 'Я набрал ' + state.highScore + ' очков в «Stay on Log» 🪵 Удержишься дольше?';
    const method = shareScore(text, SHARE_URL);
    if (method === 'copy') {
        // No share sheet on this platform — we copied instead; say so.
        const r = shareBtn.getBoundingClientRect();
        floatText(r.left + r.width / 2, r.top - 8, 'Скопировано!');
    }
});
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
    if (e.target.closest && e.target.closest('#mute-btn, #howto-btn, #howto-overlay, #dev-tune, #tutorial-skip')) return;
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
// The one-time how-to auto-popup is retired: newcomers now get the
// interactive tutorial on their first Start instead (see
// requestPermissionAndStart), which teaches by doing rather than by reading.
// The ? button still opens this overlay as reference + settings.

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
// Exception: hidden dev mode (?dev=1) skips the stub entirely.
if (isDesktop && !devMode) {
    desktopStub.classList.add('active');
    startBtn.disabled = true;
}

// "Play with keyboard" promotes the desktop stub from a dead end into an
// honest (if second-class) input mode — shared links opened on desktop
// Telegram/browsers can actually be played now.
if (stubKeyboardBtn) {
    stubKeyboardBtn.addEventListener('click', function () {
        initAudio(); // may be the first gesture of the session
        desktopStub.classList.remove('active');
        startBtn.disabled = false;
    });
}

// Keyboard control: ←/→ balance, Space/↑ jump. Active on desktop (the stub's
// button unlocks it) and in dev mode (debugging on a phone with a keyboard).
if (devMode || isDesktop) {
    window.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowLeft') devKeys.left = true;
        else if (e.key === 'ArrowRight') devKeys.right = true;
        else if (e.key === ' ' || e.key === 'ArrowUp') { e.preventDefault(); doJump(); }
    });
    window.addEventListener('keyup', function (e) {
        if (e.key === 'ArrowLeft') devKeys.left = false;
        else if (e.key === 'ArrowRight') devKeys.right = false;
    });
}

// Live tuning panel + console note: dev mode only.
if (devMode) {
    console.log('[dev] keyboard control: ←/→ balance, Space = jump');
    buildTunePanel();
}

// Live input-tuning panel (?dev=1). Works with the real tilt sensor on a phone —
// drag the sliders mid-session to find the right feel; values persist in localStorage.
function buildTunePanel() {
    const panel = document.createElement('div');
    panel.id = 'dev-tune';
    panel.innerHTML =
        '<label>sens <b id="dt-sv"></b><input id="dt-s" type="range" min="0.3" max="2" step="0.05"></label>' +
        '<label>smooth <b id="dt-mv"></b><input id="dt-m" type="range" min="0.05" max="0.6" step="0.01"></label>' +
        '<label>assist <b id="dt-av"></b><input id="dt-a" type="range" min="0" max="2" step="0.05"></label>';
    document.body.appendChild(panel);

    const s = panel.querySelector('#dt-s');
    const m = panel.querySelector('#dt-m');
    const a = panel.querySelector('#dt-a');
    const sv = panel.querySelector('#dt-sv');
    const mv = panel.querySelector('#dt-mv');
    const av = panel.querySelector('#dt-av');
    s.value = getSensitivity();
    m.value = getSmooth();
    a.value = getAssistMult();
    sv.textContent = (+s.value).toFixed(2);
    mv.textContent = (+m.value).toFixed(2);
    av.textContent = (+a.value).toFixed(2);
    s.addEventListener('input', () => { setSensitivity(+s.value); sv.textContent = (+s.value).toFixed(2); });
    m.addEventListener('input', () => { setSmooth(+m.value); mv.textContent = (+m.value).toFixed(2); });
    a.addEventListener('input', () => { setAssistMult(+a.value); av.textContent = (+a.value).toFixed(2); });

    // Scheme B ("hold the tilt") controls — a wind⇄tilt switch plus its four
    // response-curve sliders. Added below the existing rows without touching
    // them. Mid-run scheme switches are allowed here (dev-only, at your own
    // risk); nothing else needs to react beyond what schemeText()/handleMotion
    // already branch on by reading getScheme() live.
    const schemeRow = document.createElement('label');
    schemeRow.innerHTML =
        'scheme <b id="dt-schv"></b>' +
        '<span id="dt-sch-wind" class="dt-seg-btn">wind</span>' +
        '<span id="dt-sch-tilt" class="dt-seg-btn">tilt</span>';
    panel.appendChild(schemeRow);

    const schv = schemeRow.querySelector('#dt-schv');
    const schWind = schemeRow.querySelector('#dt-sch-wind');
    const schTilt = schemeRow.querySelector('#dt-sch-tilt');
    // Compact inline styling so the two segments read as one control without
    // needing a new CSS rule in styles.css for this one panel row.
    [schWind, schTilt].forEach((btn) => {
        btn.style.cssText =
            'padding:2px 8px;border-radius:6px;background:rgba(255,255,255,0.12);cursor:pointer;';
    });
    function refreshSchemeUI() {
        const active = getScheme();
        schv.textContent = active;
        schWind.style.background = active === 'wind' ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.12)';
        schWind.style.color = active === 'wind' ? '#000' : '#fff';
        schTilt.style.background = active === 'tilt' ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.12)';
        schTilt.style.color = active === 'tilt' ? '#000' : '#fff';
    }
    schWind.addEventListener('click', () => { setScheme('wind'); refreshSchemeUI(); });
    schTilt.addEventListener('click', () => { setScheme('tilt'); refreshSchemeUI(); });
    refreshSchemeUI();

    // Four scheme-B response-curve sliders, built with the same value-label +
    // input + live-readout shape as sens/smooth/assist above, factored into a
    // helper since there are four of them (vs. copy-pasting the block again).
    addTuneSlider(panel, 'tilt range', getTiltRange, setTiltRange, 10, 60, 1, 0);
    addTuneSlider(panel, 'tilt rate', getTiltRateMax, setTiltRateMax, 1.0, 6.0, 0.1, 1);
    addTuneSlider(panel, 'tilt expo', getTiltExpo, setTiltExpo, 1.0, 2.5, 0.05, 2);
    addTuneSlider(panel, 'tilt dz', getTiltDeadzone, setTiltDeadzone, 0, 8, 0.25, 2);
}

// Shared row-builder for the tilt sliders: same markup/wiring pattern as the
// hand-written sens/smooth/assist rows above (label + live value + range
// input, get() seeds the initial value, set() persists on input), just
// parameterized so four near-identical rows don't get copy-pasted.
function addTuneSlider(panel, labelText, get, set, min, max, step, decimals) {
    const row = document.createElement('label');
    row.innerHTML = labelText + ' <b></b><input type="range" min="' + min + '" max="' + max + '" step="' + step + '">';
    panel.appendChild(row);
    const valEl = row.querySelector('b');
    const input = row.querySelector('input');
    input.value = get();
    valEl.textContent = (+input.value).toFixed(decimals);
    input.addEventListener('input', () => {
        set(+input.value);
        valEl.textContent = (+input.value).toFixed(decimals);
    });
}

// === TG IDENTITY ===
// Inside Telegram the profile name is already known — adopt it as the default
// nick so a first-time player skips the "who are you" overlay entirely.
// A nick the player typed in themselves (kept in localStorage) always wins;
// nameSource lets the CloudStorage sync tell the two apart.
let nameSource = state.playerName ? 'user' : '';
if (!state.playerName) {
    const u = tgUser();
    const tgName = u && (u.first_name || u.username);
    if (tgName) {
        state.playerName = String(tgName).slice(0, 16);
        nameSource = 'tg';
        lsSet('stayOnLog_playerName', state.playerName);
    }
}

// === CLOUD SYNC (Telegram CloudStorage) ===
// Pull the record/nick saved on other devices. Values arrive async (possibly
// after first paint) — merge without blocking, prefer the larger record and
// an explicitly chosen nick over the TG-profile default.
cloudGet('stayOnLog_highScore_v2', function (v) {
    const cloud = parseInt(v, 10) || 0;
    if (cloud > state.highScore) {
        state.highScore = cloud;
        lsSet('stayOnLog_highScore_v2', String(cloud));
        updateHighScoreDisplay();
    } else if (state.highScore > cloud) {
        cloudSet('stayOnLog_highScore_v2', String(state.highScore));
    }
});
cloudGet('stayOnLog_playerName', function (v) {
    if (v && nameSource !== 'user') {
        state.playerName = String(v).slice(0, 16);
        lsSet('stayOnLog_playerName', state.playerName);
        updatePlayerNameDisplay();
    } else if (state.playerName && !v) {
        cloudSet('stayOnLog_playerName', state.playerName);
    }
});

// Show high score and nickname on load
updateHighScoreDisplay();
shareBtn.style.display = state.highScore > 0 ? 'inline-block' : 'none';
updatePlayerNameDisplay();
applyBiome(0);
