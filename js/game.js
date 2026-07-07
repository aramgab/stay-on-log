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
    PHASE3_CHANGE_INTERVAL_SCALE,
    SPEED_RAMP_K,
    REVERSAL_SPEED_DIP,
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
    TUT_ARROW_WARN_AT_MS,
    TUT_ARROW_HOLD_MS,
    QUIP_RECENT_CHANGE_MS,
    QUIP_FAST_FRAC,
    REVIVE_COST,
    REVIVE_HP,
    REVIVE_INVULN_MS,
    REVIVE_COUNT_FROM,
    REVIVE_COUNT_TICK_MS,
    REVIVE_MIN_CHANGE_GAP_MS,
    DAY_STORM_MS,
    DAY_CYCLE_MS,
    BOSS_DEFEAT_POINTS,
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
    deathQuipEl,
    runCoinsEl,
    questResultEl,
    questToastEl,
    questHudEl,
    coinsDisplayEl,
    startBtn,
    reviveBtn,
    shareBtn,
    desktopStub,
    stubKeyboardBtn,
    countdownOverlay,
    countdownNumber,
    countdownTextEl,
    dirArrows,
    fallingPlayerEl,
    splashEl,
    playerNameEl,
    nicknameOverlay,
    nicknameInput,
    nicknameSaveBtn,
    shopBtn,
    mapBtn,
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
import { spawnCoins, renderCoinLayer, stepCoins, resetCoins } from './coins.js';
import { initShop, hasPendingHeart, consumePendingHeart, spendCoins } from './shop.js';
import { initLeaderboard, submitScore } from './leaderboard.js';
import { submitBattleScore, initBattle } from './battle.js';
import { setMainArrow, setPreviewArrow, promoteArrows, cancelPromote, resetArrows } from './dirarrow.js';
import { deathQuip } from './quips.js';
import { DAY_PHASE_CLASSES, dayPhaseFor, cycleOf, BIOMES, BOSSES, questsFor } from './biomes.js';
import { cycleCompleted, flushCampaign, syncCampaignFromCloud, getSelectedBiome, questEvent, questCount, devCompleteAllQuests } from './campaign.js';
import { initMap, updateMapBtnLabel } from './map.js';
import { initAudio, sfx, music, toggleMute, isMuted } from './audio.js';
import { hapticJump, hapticHit, hapticFall, hapticClear, hapticTick, hapticRecord, hapticCoin } from './haptics.js';
import { screenShake, burst, floatText } from './fx.js';
import { initTelegram, tgUser, cloudGet, cloudSet, shareScore } from './tg.js';
import { stepBoss, isBossActive, bossReset, bossHide, bossResume, bossSpeedFactor, activeBossId, bossHitDir } from './boss.js';

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
let tutStep = 0;       // 0 = inactive, 1 = balance, 2 = read-the-arrow, 3 = jump-alone, 4 = jump-over-knot, 5 = done/outro
let tutHoldMs = 0;     // step 1: accumulated in-zone time
let tutArrowMs = 0;    // step 2: time since the arrow step began
let tutArrowPhase = 0; // step 2: 0 = watch, 1 = warning blink, 2 = hold after the reversal
let tutArrowHoldMs = 0; // step 2 phase 2: accumulated in-zone time after the scripted reversal
let tutJumps = 0;      // jump step: jumps landed so far this step
let tutWasJumping = false; // jump step: previous frame's state.isJumping, to catch the false->true edge
let tutLastEmergeAt = -Infinity; // knot step: performance.now() of the last forceEmerge('knot')
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

// === DAY CYCLE (scene palette follows the difficulty ramp; js/biomes.js
// owns the elapsed -> segment mapping) ===
let currentBiome = '';
let runCycle = 0; // full days survived this run (for the wrap badge)

let runQuestTitles = []; // quests completed THIS run (shown on the result screen)

// Quest completion beat: fanfare + haptic; the visual is the quest CARD
// flashing right after with the line turned green («✓ …») — a separate
// «задание выполнено» toast used to pile up on top of the card in the same
// screen spot, so the card owns the moment alone now.
function celebrateQuests(completedQuests) {
    if (!completedQuests || !completedQuests.length) return;
    completedQuests.forEach((q) => runQuestTitles.push(q.title));
    sfx.combo(3);
    hapticClear(3);
}

// In-run quest tracker: a card FLASHED for a few seconds — at run start and
// again on every progress tick — so it informs without ever sitting over
// the play field (owner feedback: a permanent panel felt in the way).
let questHudTimer = 0;

function updateQuestHud(showForMs) {
    const quests = questsFor(getSelectedBiome());
    const open = quests.filter((q) => questCount(q.id) < q.target);
    clearTimeout(questHudTimer);
    if (tutorialMode || !state.isPlaying || !quests.length || !open.length) {
        questHudEl.classList.remove('visible');
        return;
    }
    questHudEl.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'qh-title';
    const b = BIOMES[getSelectedBiome()];
    title.textContent = 'Задания · ' + (b ? b.title : '');
    questHudEl.appendChild(title);
    quests.forEach((q) => {
        const n = Math.min(questCount(q.id), q.target);
        const line = document.createElement('div');
        const done = n >= q.target;
        line.className = 'qh-line' + (done ? ' done' : '');
        line.textContent = done ? '✓ ' + q.title : '• ' + q.title + ' — ' + n + '/' + q.target;
        questHudEl.appendChild(line);
    });
    questHudEl.classList.add('visible');
    questHudTimer = setTimeout(() => questHudEl.classList.remove('visible'), showForMs || 2500);
}

function applyBiome(elapsed) {
    const next = dayPhaseFor(elapsed, runBiomeId).cssClass;
    if (next === currentBiome) return;
    currentBiome = next;
    document.body.classList.remove(...DAY_PHASE_CLASSES);
    document.body.classList.add(next);
    music.setMood(next);
    // Mark the transition audibly mid-run (not on the reset back to day).
    if (state.isPlaying && elapsed > 0) { sfx.whoosh(); hapticTick(); }
}

// Per-world reskin: swaps the body world-* class (bark/wood palette vars,
// obstacle art — css/styles.css). The tutorial always runs on Земля.
let currentWorld = '';
let runBiomeId = 'earth'; // the biome this run actually plays (tutorial forces earth)

function applyWorld(biomeId) {
    runBiomeId = BIOMES[biomeId] ? biomeId : 'earth';
    const cls = (BIOMES[runBiomeId] && BIOMES[runBiomeId].worldClass) || 'world-earth';
    if (cls === currentWorld) return;
    if (currentWorld) document.body.classList.remove(currentWorld);
    currentWorld = cls;
    document.body.classList.add(cls);
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
    // Chase-boss world acceleration: one factor, applied to every consumer of
    // the log's rotation this frame (log step, obstacle/coin stepping, assist
    // compensation) so collisions stay in sync. 1.0 outside a chase.
    const bossFac = tutorialMode ? 1 : bossSpeedFactor();
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

    // 1. Rotate the log. Speed changes ramp: logSpeed chases targetSpeed
    // exponentially, so a change (especially a reversal, which also dips the
    // speed — see applyPendingChange) surges in over ~0.6s instead of
    // snapping. Every reader of logSpeed (obstacle stepping, double gap)
    // sees the smooth value for free.
    if (state.logSpeed !== state.targetSpeed) {
        const step = (state.targetSpeed - state.logSpeed) * Math.min(1, SPEED_RAMP_K * dtF);
        state.logSpeed = Math.abs(state.targetSpeed - state.logSpeed) < 0.01
            ? state.targetSpeed
            : state.logSpeed + step;
    }
    state.logAngle += state.logSpeed * state.logDirection * dtF * bossFac;
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
        state.contAngle -= state.logSpeed * state.logDirection * assist * dtF * bossFac;
        state.userAngle -= state.logSpeed * state.logDirection * assist * dtF * bossFac;
    }

    // 2. Player position
    let playerPosition = state.logAngle + state.userAngle;
    orbitEl.style.transform = `rotate(${playerPosition}deg)`;

    // 2b. Obstacles (rotate with the log, then handle the collision event)
    renderObstacleLayer();
    const obEvent = stepObstacles(Math.abs(state.logSpeed) * dtF * bossFac);
    if (tutorialMode) {
        // Knot step only: no score/combo, no hp/gameOver — soft feedback
        // either way, and the step counter is what actually advances. If the
        // knot dives unbeaten, tutorialTick() re-summons it (no event needed
        // here). The step guard also protects against a stray event right
        // after a softReset (which rewinds to step 1) re-triggering the outro.
        if (tutStep === 4 && obEvent === 'cleared') {
            tutStep = 5;
            tutBannerLastSec = -1;
            // Freeze the world for the outro: with the log stopped the
            // character can't drift off the top during the "Готов!" beat
            // (the outro softReset guard would otherwise let them hang
            // past FALL_THRESHOLD with no recovery).
            state.logSpeed = 0;
            state.targetSpeed = 0;
            showTutorialBanner('Готов! Погнали по-настоящему 🎉');
            lsSet('stayOnLog_seenTutorial_v1', '1');
            setTimeout(exitTutorial, 1400);
        } else if (tutStep === 4 && obEvent === 'hit') {
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
        // Campaign quest tick: the obstacle is still active while 'cleared'
        // fires (it dives later), so its type is readable right here.
        celebrateQuests(questEvent('clear', { obType: activeObstacleType() }));
        updateQuestHud(2500);
    } else if (obEvent === 'hit' && registerHit(playerPosition)) {
        return; // fatal hit — loop stopped inside gameOver
    }

    // 2b2. Coins (pinned to the log like obstacles; touching one collects it,
    // high coins need a jump). Gated by elapsed internally, so the tutorial
    // (elapsed frozen at 0) never spawns any.
    renderCoinLayer();
    const coinVal = stepCoins(Math.abs(state.logSpeed) * dtF * bossFac);
    if (coinVal) {
        state.runCoins += coinVal;
        sfx.coin();
        hapticCoin();
        const cxy = playerXY();
        floatText(cxy.x, cxy.y - 42, '+' + coinVal + ' 🪙', '#ffd93d');
        updateCoinsDisplay();
        // Campaign quest tick: a pickup counts as ONE coin regardless of its
        // wallet value (the quest text says "монетки", not "кошелёк").
        celebrateQuests(questEvent('coin', { dayPhase: dayPhaseFor(state.elapsed).id }));
        updateQuestHud(2500);
    }

    // 2c. Scene palette follows elapsed time (day -> sunset -> night -> storm)
    applyBiome(state.elapsed);

    // 2c2. Full-day wrap: surviving a whole cycle is the campaign beat —
    // celebrate loudly. Difficulty stays maxed (it reads raw elapsed, which
    // never resets); only the palette loops back to noon.
    const cyc = cycleOf(state.elapsed);
    if (!tutorialMode && cyc > runCycle) {
        runCycle = cyc;
        cycleCompleted(getSelectedBiome());
        hapticRecord();
        sfx.combo(COMBO_MAX_MULT);
        const cxy2 = playerXY();
        burst(cxy2.x, cxy2.y, { color: '#ffd93d', count: 26, size: 12, up: 95, spread: 140 });
        floatText(window.innerWidth / 2, window.innerHeight * 0.32, '🌞 СУТКИ! Биом пройден', '#ffd93d');
    }

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
        // Fairness: while a double is riding the log its gap was computed for
        // the current speed — postpone the change entirely (pendingChange
        // survives, so the preview keeps promising the same thing) until it
        // dives. Same postponement while the boss is on stage: while it owns
        // the arena a reversal would be unreadable — the pending promise
        // survives untouched.
        if (activeObstacleType() === 'double' || isBossActive()) {
            scheduleNextChange();
        } else {
            applyPendingChange();
            scheduleNextChange();
            rollNextChange();
            // "The small arrow takes the big one's place", then the fresh
            // roll becomes the new preview once the morph lands.
            promoteArrows(
                // Arc length reads the TARGET speed — the arrow promises
                // where the ramp is heading, not the mid-ramp instant.
                { dir: state.logDirection, speed: state.targetSpeed },
                state.pendingChange
            );
        }
    }

    // 5. Warning before change: blink the on-log arrow (mirrors the
    // obSideHint pattern — only touch classList on an actual state change).
    // Gated off in the tutorial: its arrow step drives .warning by hand.
    const wantsArrowWarning = !tutorialMode
        && state.nextChangeTime - state.elapsed < CHANGE_WARN_MS
        && state.nextChangeTime - state.elapsed > 0;
    if (wantsArrowWarning !== arrowWarningVisible) {
        arrowWarningVisible = wantsArrowWarning;
        // Entering the warning window: make the promise honest before the
        // player starts reading it (an approaching obstacle vetoes reversals),
        // then redraw the preview in case the reconcile changed it.
        if (arrowWarningVisible) {
            reconcilePendingChange();
            setPreviewArrow(state.pendingChange);
        }
        dirArrows.classList.toggle('warning', arrowWarningVisible);
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

    // 6b3. Boss fight (storm segment; js/boss.js owns the state machine —
    // obstacle/coin spawns freeze and direction changes postpone while it
    // is on stage). Hits ride the same hp/invuln path as obstacles.
    if (!tutorialMode) {
        const bossEvent = stepBoss(dtMs, normPos);
        if (bossEvent === 'hit' && registerHit(playerPosition, 'boss')) {
            return; // fatal — loop stopped inside gameOver
        }
        if (bossEvent === 'victory') {
            state.eventScore += BOSS_DEFEAT_POINTS;
            sfx.combo(COMBO_MAX_MULT);
            hapticRecord();
            const bxy = playerXY();
            burst(bxy.x, bxy.y, { color: '#ff5252', count: 26, size: 12, up: 95, spread: 140 });
            const beatEmoji = (BOSSES[activeBossId()] && BOSSES[activeBossId()].emoji) || '🏆';
            floatText(window.innerWidth / 2, window.innerHeight * 0.32, beatEmoji + ' ПОБЕДА! +' + BOSS_DEFEAT_POINTS, '#ffd93d');
            celebrateQuests(questEvent('boss', { bossId: activeBossId() }));
        }
    }

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
            gameOver(normPos, 'fall');
            return;
        }
    }

    requestAnimationFrame(gameLoop);
}

// === DIRECTION / SPEED ===
function scheduleNextChange() {
    let interval = MIN_CHANGE_INTERVAL + Math.random() * (MAX_CHANGE_INTERVAL - MIN_CHANGE_INTERVAL);
    // Phase 3 softening: changes come less often once the speeds are at full
    // range and assist is at its floor (playtest: "the log goes rabid").
    if (state.elapsed >= PHASE2_MS) interval *= PHASE3_CHANGE_INTERVAL_SCALE;
    state.nextChangeTime = state.elapsed + interval;
}

// Roll a fresh speed for a change firing at applyAtElapsed, honoring the
// phase-1 cap AS OF that moment (the preview arrow promises the future, so
// caps are computed against fire time, not roll time; they only loosen with
// elapsed, so an early roll can never turn illegal by waiting).
function rollSpeed(applyAtElapsed) {
    let speed = MIN_SPEED + Math.random() * (MAX_SPEED - MIN_SPEED);
    if (applyAtElapsed < PHASE1_MS) {
        // Phase 1: cap speed at 50%
        const maxSpeedPhase1 = MIN_SPEED + (MAX_SPEED - MIN_SPEED) * 0.5;
        if (speed > maxSpeedPhase1) {
            speed = MIN_SPEED + Math.random() * (maxSpeedPhase1 - MIN_SPEED);
        }
    }
    return speed;
}

// The "decide" half of the old changeDirectionOrSpeed(): rolls what the
// change scheduled for state.nextChangeTime will do and parks it in
// state.pendingChange, so the preview arrow can show it during the whole
// wait. No world side effects here. logSpeed/logDirection can't move between
// roll and apply (only applyPendingChange mutates them), so rolling against
// the current values now stays valid at fire time.
function rollNextChange() {
    const applyAt = state.nextChangeTime;
    const rand = Math.random();
    const wantsReverse = rand < 0.4 || rand >= 0.7;
    const wantsSpeedChange = rand >= 0.4;

    // Inherit from targetSpeed, not the mid-ramp live value — "keep the
    // speed" must mean the speed the log was heading toward.
    let newSpeed = state.targetSpeed;
    let newDirection = state.logDirection;

    if (wantsSpeedChange) {
        newSpeed = MIN_SPEED + Math.random() * (MAX_SPEED - MIN_SPEED);
    }
    if (wantsReverse) {
        newDirection = state.logDirection * -1;
    }

    // === DIFFICULTY BALANCE (time-based, evaluated at fire time) ===
    if (applyAt < PHASE1_MS) {
        // Phase 1: cap speed at 50%
        const maxSpeedPhase1 = MIN_SPEED + (MAX_SPEED - MIN_SPEED) * 0.5;
        if (newSpeed > maxSpeedPhase1) {
            newSpeed = MIN_SPEED + Math.random() * (maxSpeedPhase1 - MIN_SPEED);
        }
    } else {
        // Phases 2 AND 3: block high-speed reversal combos — if reversing
        // AND both old and new speed > 75%, re-roll new speed lower. (Was
        // phase-2-only; extended to phase 3 after the July-2026 playtest —
        // unrestricted late-game reversals were the "rabid log" culprit.)
        const threshold75 = MIN_SPEED + (MAX_SPEED - MIN_SPEED) * 0.75;
        const oldSpeedHigh = state.targetSpeed > threshold75;
        const newSpeedHigh = newSpeed > threshold75;
        if (newDirection !== state.logDirection && oldSpeedHigh && newSpeedHigh) {
            // Re-roll speed to be within 0-75%
            newSpeed = MIN_SPEED + Math.random() * (threshold75 - MIN_SPEED);
        }
    }

    state.pendingChange = { dir: newDirection, speed: newSpeed };
}

// Fairness: a reversal while an obstacle is approaching would swing it back
// down / flip its side — convert the pending reversal into a speed-only
// change (skipping entirely would leave long stretches without variety).
// Runs on the warning's rising edge, so the preview is honest for the whole
// blink, and again as a final guard from applyPendingChange() in case the
// obstacle surfaced mid-warning. The speed is re-rolled on conversion,
// matching the old code where a converted reversal always rolled a speed.
function reconcilePendingChange() {
    const p = state.pendingChange;
    if (!p || p.dir === state.logDirection) return;
    if (!isObstacleActive()) return;
    state.pendingChange = { dir: state.logDirection, speed: rollSpeed(state.nextChangeTime) };
}

// The "apply" half of the old changeDirectionOrSpeed(): flips the world to
// the pre-rolled pending change. The double-freeze case is handled by the
// caller (gameLoop postpones the whole change while a double rides the log).
// Arrows are NOT redrawn here — the caller runs the promote animation, which
// owns the visual handover (an instant setMainArrow would break the morph).
function applyPendingChange() {
    reconcilePendingChange();
    const p = state.pendingChange;
    if (!p) return;
    if (p.dir !== state.logDirection) {
        // Reversal: the log "re-grips" — the live speed dips and then ramps
        // back up toward the rolled target, so a flip never explodes into
        // full speed backwards on the very next frame.
        state.logSpeed = Math.max(MIN_SPEED, state.logSpeed * REVERSAL_SPEED_DIP);
    }
    state.targetSpeed = p.speed;
    state.logDirection = p.dir;
    state.pendingChange = null;
    state.lastChangeAt = state.elapsed; // for the "change got you" death quip
}

// Scheme-aware copy: scheme A ("wind the phone") and scheme B ("hold the
// tilt") teach opposite muscle memory, so every player-facing string that
// tells the player HOW to move must match whichever scheme is active. Keyboard
// mode's own strings are untouched — desktop never runs scheme B.
function schemeText(windText, tiltText) {
    return getScheme() === 'tilt' ? tiltText : windText;
}

// Full instant sync of the direction UI (run start / tutorial start) — the
// on-log arrow carries everything: direction and speed are both baked into
// the arc path. Changes mid-run go through promoteArrows() instead.
function updateDirectionUI() {
    setMainArrow(state.logDirection, state.targetSpeed);
}

function updateHighScoreDisplay() {
    if (state.highScore > 0) {
        highScoreEl.innerText = "Рекорд: " + state.highScore;
        highScoreEl.style.display = 'block';
    } else {
        highScoreEl.style.display = 'none';
    }
}

// Wallet + live pickups of the current run; hidden until the player has ever
// held a coin (keeps the first-run HUD minimal).
function updateCoinsDisplay() {
    const total = state.coins + state.runCoins;
    coinsDisplayEl.innerText = '🪙 ' + total;
    coinsDisplayEl.style.display = total > 0 ? 'block' : 'none';
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

// Apply an obstacle (or boss) hit. Returns true if it was fatal (game over
// triggered). `source` is 'boss' for a boss strike, undefined for the
// obstacle path (existing call site is unchanged).
function registerHit(playerPosition, source) {
    state.hp -= 1;
    state.combo = 0;
    updateHearts();

    if (state.hp <= 0) {
        // Which threat killed us — read BEFORE gameOver's resetObstacles.
        // A fatal side-strike from a boss biases the fall AWAY from the
        // impact so the splash direction sells the blow (render.js reads
        // only the sign/offset for the arc; scoring is untouched).
        let pos = normalizePos(playerPosition);
        if (source === 'boss' && bossHitDir() !== 0 && Math.abs(pos) < 30) {
            pos = -bossHitDir() * 35;
        }
        gameOver(pos, source === 'boss'
            ? 'boss-' + (activeBossId() || 'shark')
            : 'hit-' + (activeObstacleType() || 'knot'));
        return true;
    }

    // Non-fatal: brief invulnerability + visual flash so a single obstacle
    // can't drain two lives in consecutive frames. A boss strike hits harder
    // on every channel: big shake, denser burst, and the stickman is visibly
    // KNOCKED by the impact (rig-level animation — the svg root's transform
    // belongs to the jump).
    sfx.hit();
    hapticHit();
    screenShake(source === 'boss');
    triggerHitFlash();
    const xy = playerXY();
    burst(xy.x, xy.y, {
        color: '#ff5252',
        count: source === 'boss' ? 20 : 12,
        size: source === 'boss' ? 10 : 8,
    });
    if (source === 'boss') {
        const dir = bossHitDir(); // attack origin: knock AWAY from it
        const knockCls = dir === -1 ? 'boss-knock-r' : dir === 1 ? 'boss-knock-l' : 'boss-knock-up';
        playerEl.classList.remove('boss-knock-l', 'boss-knock-r', 'boss-knock-up');
        playerEl.getBoundingClientRect(); // reflow so a repeat knock restarts
        playerEl.classList.add(knockCls);
        setTimeout(() => playerEl.classList.remove(knockCls), 480);
    }
    state.invulnerable = true;
    playerEl.classList.add('hit');
    arrowWarningVisible = false;
    dirArrows.classList.remove('warning');
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
            tutArrowMs = 0;
            tutArrowPhase = 0;
            tutArrowHoldMs = 0;
            // Scripted promise for the arrow step: a slow reversal. The real
            // change machinery is gated off in tutorialMode — this step
            // drives the same arrows/warning/promote flow by hand.
            state.pendingChange = { dir: -1, speed: TUT_LOG_SPEED };
            setPreviewArrow(state.pendingChange);
            showTutorialBanner('Большая стрелка — куда крутится бревно. Маленькая — куда потом!');
        }
        return;
    }

    if (tutStep === 2) {
        // Read-the-arrow step: watch → warning blink → the promised reversal
        // fires → hold the top to prove the read. One full telegraph cycle,
        // exactly like the real game will do it.
        tutArrowMs += dtMs;
        if (tutArrowPhase === 0 && tutArrowMs >= TUT_ARROW_WARN_AT_MS) {
            tutArrowPhase = 1;
            dirArrows.classList.add('warning');
            showTutorialBanner('Мигает жёлтым — смена вот-вот!');
        } else if (tutArrowPhase === 1
            && tutArrowMs >= TUT_ARROW_WARN_AT_MS + CHANGE_WARN_MS) {
            tutArrowPhase = 2;
            dirArrows.classList.remove('warning');
            state.logDirection = -1; // the promised reversal (speed stays slow)
            state.pendingChange = null;
            promoteArrows({ dir: -1, speed: TUT_LOG_SPEED }, null);
            tutArrowHoldMs = 0;
            tutBannerLastSec = -1;
        }
        if (tutArrowPhase === 2) {
            if (Math.abs(normPos) <= TUT_BALANCE_ZONE_DEG) tutArrowHoldMs += dtMs;
            const secLeft = Math.ceil((TUT_ARROW_HOLD_MS - tutArrowHoldMs) / 1000);
            if (secLeft !== tutBannerLastSec) {
                tutBannerLastSec = secLeft;
                showTutorialBanner('Смена! Удержись наверху ' + Math.max(0, secLeft) + ' сек');
            }
            if (tutArrowHoldMs >= TUT_ARROW_HOLD_MS) {
                tutStep = 3;
                tutBannerLastSec = -1;
                tutJumps = 0;
                tutWasJumping = state.isJumping;
                showTutorialBanner('А теперь — ТАПНИ по экрану! Человечек прыгнет');
            }
        }
        return;
    }

    if (tutStep === 3) {
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
                tutStep = 4;
                tutBannerLastSec = -1;
                showTutorialBanner('Сучок! Перепрыгни его — тапни в нужный момент!');
                forceEmerge('knot');
                tutLastEmergeAt = nowMs;
            }
        }
        tutWasJumping = isJumpingNow;
        return;
    }

    if (tutStep === 4) {
        // Re-summon the knot if it dove back under unbeaten (dive() clears
        // isObstacleActive()) — give the dive/splash animation ~1.2s to play
        // out before forcing it back up, matching the task's guidance.
        if (!isObstacleActive() && nowMs - tutLastEmergeAt > 1200) {
            forceEmerge('knot');
            tutLastEmergeAt = nowMs;
        }
        return;
    }

    if (tutStep === 5) {
        // Outro: nothing to tick — exitTutorial() is scheduled by whoever set
        // tutStep to 5 (see the 'cleared' handling in gameLoop).
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
    if (tutStep === 5) return; // outro is already wrapping up via exitTutorial's setTimeout

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
    // Arrow-step state: rewinding to step 1 must undo the scripted promise
    // and (possibly) the fired reversal, or step 2 would replay on top of a
    // backwards-spinning log with a stale preview. cancelPromote (not
    // resetArrows) — the arrows stay visible in the tutorial.
    tutArrowMs = 0;
    tutArrowPhase = 0;
    tutArrowHoldMs = 0;
    state.pendingChange = null;
    cancelPromote();
    setPreviewArrow(null);
    dirArrows.classList.remove('warning');
    state.logDirection = 1;
    state.logSpeed = TUT_LOG_SPEED;
    state.targetSpeed = TUT_LOG_SPEED;
    updateDirectionUI();
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
    tutArrowMs = 0;
    tutArrowPhase = 0;
    tutArrowHoldMs = 0;
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

// Hide the fall animation leftovers (falling stickman + splash).
function hideFallFx() {
    fallingPlayerEl.classList.remove('active');
    fallingPlayerEl.removeAttribute('style');
    fallingPlayerEl.style.display = 'none';
    splashEl.classList.remove('active');
    splashEl.removeAttribute('style');
    splashEl.style.display = 'none';
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
    reviveBtn.style.display = 'none';
    shopBtn.style.display = 'none'; // no shopping mid-run (a tap = a jump)
    mapBtn.style.display = 'none'; // no world-hopping mid-run either
    resetArrows();
    state.pendingChange = null;
    arrowWarningVisible = false;
    heartsEl.style.display = 'none';
    newRecordEl.style.display = 'none';
    statusEl.innerText = '';
    deathQuipEl.innerText = '';
    runCoinsEl.innerText = '';
    questResultEl.innerText = '';
    questToastEl.classList.remove('visible');
    questHudEl.classList.remove('visible');
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

    // Reset jump / invulnerability and clear any obstacles/coins from a prev game.
    state.isJumping = false;
    state.invulnerable = false;
    resetObstacles();
    resetCoins();
    bossReset();
    applyWorld(startTutorialMode ? 'earth' : getSelectedBiome());
    applyBiome(0); // back to noon for the new run

    // Hide falling player & splash from prev game — full reset
    hideFallFx();

    countdownOverlay.classList.add('active');

    window.addEventListener('devicemotion', handleMotion);

    // Reset
    state.logAngle = 0;
    state.userAngle = 0;
    state.contAngle = 0;
    state.velEMA = 0;
    state.rawLastAngle = null;
    state.logSpeed = 0.8;
    state.targetSpeed = 0.8;
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

            dropPlayer(startTutorialMode ? startTutorial : startGame);
        }
    }, 1000);
}

// Drop the stickman onto the log, then hand control to onLanded (startGame /
// startTutorial / resumeRun after a revive).
function dropPlayer(onLanded) {
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
            onLanded();
        }, { once: true });
    });
}

function startGame() {
    state.isPlaying = true;
    state.startTime = Date.now();
    // Battle run id: NOT regenerated by resumeRun — a revive continues the
    // same run, and the battle server dedups score by this id.
    state.runId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    state.score = 0;
    state.eventScore = 0;
    state.combo = 0;
    state.elapsed = 0;
    runCycle = 0;
    runQuestTitles = [];
    updateQuestHud(5000); // показать цели биома на старте, потом убраться с глаз
    state.recordCelebrated = false;
    state.revivedThisRun = false;
    state.lastChangeAt = -Infinity;

    // Newcomer hints: count this run, reset the per-run "already jumped" flag.
    runCount += 1;
    lsSet('stayOnLog_runCount', String(runCount));
    jumpedThisRun = false;

    // Boss foreshadowing: fins in the water during real runs only.
    document.body.classList.add('fins-on');

    // Lives & obstacles & coins. A spare heart bought in the shop burns on
    // the next run only — consumed here, +1 hp over the base.
    state.hp = START_HP;
    if (hasPendingHeart()) {
        consumePendingHeart();
        state.hp = START_HP + 1;
    }
    state.isJumping = false;
    state.invulnerable = false;
    playerEl.classList.remove('jumping', 'hit');
    spawnObstacles();
    state.runCoins = 0;
    spawnCoins();
    updateCoinsDisplay();
    updateHearts();
    heartsEl.style.display = 'block';

    dirArrows.classList.add('on');
    updateDirectionUI();
    scheduleNextChange();
    rollNextChange();
    setPreviewArrow(state.pendingChange);
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
    state.targetSpeed = TUT_LOG_SPEED;
    state.logDirection = 1;
    // Lives are full but hidden — the tutorial's soft hit-feedback (see
    // gameLoop's 'hit' handling) never actually spends them, so a lives
    // display would just be inert chrome; the tutorial banner is the
    // "what do I do" cue here.
    state.hp = START_HP;
    state.isJumping = false;
    state.invulnerable = false;
    playerEl.classList.remove('jumping', 'hit');
    heartsEl.style.display = 'none';
    dirArrows.classList.add('on');
    updateDirectionUI(); // sets arrow orientation for logDirection = 1 above
    setPreviewArrow(null); // no scheduled change in the tutorial (yet)

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

// === REVIVE (paid continue on the death screen) ===
// Continues the SAME run: score/elapsed/combo/biome survive, the player gets
// REVIVE_HP and a shield window; obstacles/coins respawn fresh (their reset
// already happened in gameOver). One revive per run.

function handleReviveClick() {
    if (state.isPlaying || state.revivedThisRun
        || countdownOverlay.classList.contains('active')) return;
    initAudio(); // this tap may need to resume the AudioContext
    if (!spendCoins(REVIVE_COST)) return;
    state.revivedThisRun = true; // set synchronously — no double-tap spends
    showReviveCountdown();
}

function showReviveCountdown() {
    // Hide the death screen.
    startBtn.style.display = 'none';
    shareBtn.style.display = 'none';
    reviveBtn.style.display = 'none';
    shopBtn.style.display = 'none';
    statusEl.innerText = '';
    deathQuipEl.innerText = '';
    runCoinsEl.innerText = '';
    questResultEl.innerText = '';
    questToastEl.classList.remove('visible');
    questHudEl.classList.remove('visible');
    hideFallFx();

    // gameOver removed the motion listener — bring the controls back.
    window.addEventListener('devicemotion', handleMotion);

    // Re-center the CHARACTER only (the log keeps its angle/speed/direction —
    // that's the whole point of continuing). Same counter-rotate trick as
    // tutorialSoftReset: zeroing userAngle would drop the player wherever
    // the log happens to point, possibly straight past FALL_THRESHOLD.
    state.userAngle = -state.logAngle;
    state.contAngle = state.userAngle;
    state.velEMA = 0;
    state.rawLastAngle = null;
    playerEl.classList.remove('visible', 'falling', 'jumping', 'hit');
    playerEl.style.opacity = '0';

    // Quick countdown — shorter than the full 3-2-1, the player just died
    // here and knows the drill.
    countdownTextEl.innerText = 'Продолжаем! Держись!';
    countdownOverlay.classList.add('active');
    let count = REVIVE_COUNT_FROM;
    countdownNumber.innerText = count;
    countdownNumber.style.animation = 'none';
    void countdownNumber.offsetWidth;
    countdownNumber.style.animation = 'countPop 0.5s ease-out';
    hapticTick();

    const interval = setInterval(() => {
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
            state.tiltZero = state.tiltEMA; // scheme B: recalibrate posture
            dropPlayer(resumeRun);
        }
    }, REVIVE_COUNT_TICK_MS);
}

function resumeRun() {
    state.isPlaying = true;
    state.hp = REVIVE_HP;
    state.isJumping = false;
    document.body.classList.add('fins-on');
    updateHearts();
    heartsEl.style.display = 'block';

    // Fresh obstacle/coin machines (gameOver reset them): FIRST_EMERGE_ROT
    // of quiet log before anything surfaces again.
    spawnObstacles();
    spawnCoins();
    updateQuestHud(3000);
    bossResume(); // if a boss fight was in progress, restart its current beat

    // Shield: blink without the sad face (.invuln, not .hit).
    state.invulnerable = true;
    playerEl.classList.add('invuln');
    setTimeout(() => {
        state.invulnerable = false;
        playerEl.classList.remove('invuln');
    }, REVIVE_INVULN_MS);

    // Fairness: never resume straight into a direction change.
    if (state.nextChangeTime - state.elapsed < REVIVE_MIN_CHANGE_GAP_MS) {
        state.nextChangeTime = state.elapsed + REVIVE_MIN_CHANGE_GAP_MS;
    }

    dirArrows.classList.add('on');
    updateDirectionUI();
    setPreviewArrow(state.pendingChange); // the promise survived gameOver

    music.start(); // mood is preserved inside audio.js
    lastFrameTs = performance.now();
    gameLoop();
}

function gameOver(normPos, cause) {
    state.isPlaying = false;
    // Pick the funny "why you fell" line while the death context is still
    // hot (biome/speed/last change) — render.js shows it with the result.
    state.deathQuip = deathQuip(cause || 'fall', {
        recentChange: state.elapsed - state.lastChangeAt < QUIP_RECENT_CHANGE_MS,
        storm: dayPhaseFor(state.elapsed).id === 'storm',
        fast: Math.abs(state.logSpeed) > MIN_SPEED + (MAX_SPEED - MIN_SPEED) * QUIP_FAST_FRAC,
    });
    arrowWarningVisible = false;
    resetArrows();
    obSideHint.className = '';
    tapHint.classList.remove('visible');
    tapHintVisible = false;
    steerHint.classList.remove('visible');
    steerHintVisible = false;
    steerHintShownAt = -Infinity;
    steerHintSide = '';
    dangerVignette.style.opacity = 0;
    dangerVignette.className = '';
    heartsEl.style.display = 'none';
    questHudEl.classList.remove('visible');
    // Defensive: the normal flow never reaches gameOver while tutorialMode is
    // active (see the gameLoop gates), but guard the UI anyway.
    hideTutorialUI();
    window.removeEventListener('devicemotion', handleMotion);
    document.body.classList.remove('fins-on');
    bossHide(); // fade the shark out; state survives for a possible revive
    music.stop();
    sfx.splash();
    hapticFall();
    screenShake(true);
    triggerHitFlash();

    // Clear obstacles & coins
    resetObstacles();
    resetCoins();

    // Bank this run's coins into the wallet. runCoins moves to lastRunCoins
    // (render.js shows "+N 🪙" from there) so the wallet display never
    // double-counts between death and the next start.
    state.lastRunCoins = state.runCoins;
    if (state.runCoins > 0) {
        state.coins += state.runCoins;
        state.runCoins = 0;
        lsSet('stayOnLog_coins', String(state.coins));
        updateCoinsDisplay();
    }

    // Result screen reads this snapshot ("✅ title · title" line in render.js).
    state.lastRunQuests = runQuestTitles.slice();

    // Campaign progress accumulated during the run (quest ticks + cycles) —
    // one cloud push per run end.
    flushCampaign();

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

    // Leaderboard: fire-and-forget (validated server-side, ZADD GT — the
    // stored best only ever rises, so every run may submit).
    submitScore(state.score);

    // Battle: same fire-and-forget; the server counts only the positive
    // delta per runId, so the post-revive game over adds growth, not a dupe.
    submitBattleScore(state.runId, state.score);

    // === FALL ANIMATION ===
    animateFall(normPos);
}

// === EVENT WIRING ===
// (Replaces the inline onclick handlers from the original single-file version.)
startBtn.addEventListener('click', handleStartClick);
reviveBtn.addEventListener('click', handleReviveClick);
reviveBtn.innerText = '⚡ Продолжить за ' + REVIVE_COST + ' 🪙';
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
    if (e.target.closest && e.target.closest('#mute-btn, #howto-btn, #howto-overlay, #shop-btn, #shop-overlay, #lb-btn, #lb-overlay, #battle-btn, #battle-overlay, #revive-btn, #dev-tune, #tutorial-skip, #map-btn, #map-overlay')) return;
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

    // Campaign shortcuts: the boss lives 140s into a run — untestable by
    // waiting on every deploy. «→шторм» warps elapsed to just before the
    // storm segment of the CURRENT cycle (nextChangeTime is pushed too, so
    // the warp doesn't instantly fire a stale direction change).
    const devRow = document.createElement('label');
    devRow.innerHTML = 'campaign <span id="dt-storm" class="dt-seg-btn">→шторм</span>' +
        '<span id="dt-unlock" class="dt-seg-btn">анлок</span>';
    panel.appendChild(devRow);
    const stormBtn = devRow.querySelector('#dt-storm');
    const unlockBtn = devRow.querySelector('#dt-unlock');
    [stormBtn, unlockBtn].forEach((btn) => {
        btn.style.cssText = 'padding:2px 8px;border-radius:6px;background:rgba(255,255,255,0.12);cursor:pointer;';
    });
    stormBtn.addEventListener('click', () => {
        if (!state.isPlaying) return;
        state.elapsed = cycleOf(state.elapsed) * DAY_CYCLE_MS + DAY_STORM_MS - 2000;
        state.nextChangeTime = state.elapsed + 8000;
    });
    unlockBtn.addEventListener('click', () => {
        devCompleteAllQuests();
        unlockBtn.textContent = 'анлок ✓';
    });
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

// Shop: wire the overlay, apply the equipped log skin, sync from cloud
initShop(updateCoinsDisplay);

// Leaderboard: wire the overlay + probe the backend (button appears only
// if /api/top answers — a deploy without the env degrades silently)
initLeaderboard();
initBattle();

// Campaign map: wire the overlay, show the selected world on the map button.
initMap();

// Campaign progress: pull the cloud copy and max-merge it into local.
syncCampaignFromCloud();

// Show high score, coin wallet and nickname on load
updateHighScoreDisplay();
updateCoinsDisplay();
shareBtn.style.display = state.highScore > 0 ? 'block' : 'none';
updatePlayerNameDisplay();
applyWorld(getSelectedBiome());
applyBiome(0);
