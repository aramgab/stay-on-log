// === OBSTACLE ===
// A single obstacle that surfaces from the water at the bottom of the log,
// rides up to the player as the log rotates, and after it has been passed dives
// back into the water for 1-3 rotations before surfacing again. There are no
// obstacles at all for the first OBSTACLE_START_MS of a run (grace period).
//
// The obstacle is pinned to the log surface at a fixed angle, so a collision
// happens when its angle lines up with the player's angle (state.userAngle) —
// independent of frame rate or log direction. Tap to jump clears it.

import { state } from './state.js';
import {
    OBSTACLE_RADIUS,
    OBSTACLE_START_MS,
    OBSTACLE_COOLDOWN_MIN_ROT,
    OBSTACLE_COOLDOWN_MAX_ROT,
    FIRST_EMERGE_ROT,
    OBSTACLE_TYPES,
    BRANCH_FROM_MS,
    DOUBLE_FROM_MS,
    JUMP_DURATION,
} from './config.js';
import { obstacleLayer, obstacleSplash } from './dom.js';

// Normalize an angle to the range (-180, 180].
function normalizeAngle(deg) {
    return ((deg % 360) + 540) % 360 - 180;
}

// Module-local state machine: 'submerged' <-> 'active'.
let phase = 'submerged';
let accum = 0;            // accumulated |rotation| (deg) while submerged
let cooldownTarget = 0;   // deg of rotation to wait before surfacing
// ob = { angle, traveled, passedTop, type, def, el,
//        parts: [{ off, armed, passed, inner }] }
// Types with one collision point have a single part at off 0; the double has
// a second part trailing the first by a speed-scaled gap.
let ob = null;

function randomCooldownDeg() {
    const span = OBSTACLE_COOLDOWN_MAX_ROT - OBSTACLE_COOLDOWN_MIN_ROT;
    return (OBSTACLE_COOLDOWN_MIN_ROT + Math.random() * span) * 360;
}

// Which type surfaces next: variety unlocks with the difficulty phases.
function pickType() {
    const pool = ['knot'];
    if (state.elapsed >= BRANCH_FROM_MS) pool.push('branch');
    if (state.elapsed >= DOUBLE_FROM_MS &&
        Math.abs(state.logSpeed) <= OBSTACLE_TYPES.double.maxSpeed) {
        pool.push('double');
    }
    return pool[Math.floor(Math.random() * pool.length)];
}

// A jump clears a part unless the type demands mid-air timing (branch): being
// within the first/last midAirMarginMs of the jump counts as clipping it.
function jumpClears(def) {
    if (!def.midAirMarginMs) return true;
    const t = Date.now() - state.jumpStartTime;
    return t >= def.midAirMarginMs && t <= JUMP_DURATION - def.midAirMarginMs;
}

function showSplash() {
    obstacleSplash.classList.remove('active');
    void obstacleSplash.offsetWidth; // restart the animation
    obstacleSplash.classList.add('active');
}

// Build the (hidden) obstacle container once per game; parts are built on
// each emerge because their count/offsets depend on the rolled type.
export function spawnObstacles() {
    obstacleLayer.innerHTML = '';

    const el = document.createElement('div');
    el.className = 'obstacle';
    obstacleLayer.appendChild(el);

    ob = { angle: 0, traveled: 0, passedTop: false, type: null, def: null, parts: [], el };
    el.style.display = 'none';

    phase = 'submerged';
    accum = 0;
    cooldownTarget = FIRST_EMERGE_ROT * 360;
}

// Clear everything (used on countdown reset / game over).
export function resetObstacles() {
    obstacleLayer.innerHTML = '';
    obstacleSplash.classList.remove('active');
    ob = null;
    phase = 'submerged';
    accum = 0;
}

// Keep the obstacle layer rotating in lock-step with the log.
export function renderObstacleLayer() {
    obstacleLayer.style.transform = `rotate(${state.logAngle}deg)`;
}

// Fairness probes for game.js (reversal gating + approach-side hint).
export function isObstacleActive() {
    return phase === 'active';
}

export function activeObstacleType() {
    return phase === 'active' ? ob.type : null;
}

// Approaching = riding the log and not yet past the player's top position.
export function isObstacleApproaching() {
    return phase === 'active' && !ob.passedTop;
}

function emerge() {
    ob.type = pickType();
    ob.def = OBSTACLE_TYPES[ob.type];

    // Pin to the log's bottom point (screen angle 180) so it surfaces at the water.
    ob.angle = normalizeAngle(180 - state.logAngle);
    ob.traveled = 0;
    ob.passedTop = false;

    // Part offsets. The double's second knot trails the first (against the
    // rotation direction) by a gap the current jump can't cover in one hop.
    const offsets = [0];
    if (ob.type === 'double') {
        const jumpCoverDeg = Math.abs(state.logSpeed) * 60 * (JUMP_DURATION / 1000);
        const gap = Math.max(24, jumpCoverDeg * 1.5);
        offsets.push(-state.logDirection * gap);
    }

    ob.el.style.display = 'block';
    ob.el.innerHTML = '';
    ob.parts = offsets.map((off) => {
        const holder = document.createElement('div');
        holder.className = 'ob-part';
        holder.style.transform =
            `rotate(${ob.angle + off}deg) translateY(-${OBSTACLE_RADIUS}px)`;
        const inner = document.createElement('div');
        inner.className = 'obstacle-inner ' + ob.def.cssClass;
        holder.appendChild(inner);
        ob.el.appendChild(holder);
        void inner.offsetWidth;
        inner.classList.add('emerging');
        return { off, armed: true, passed: false, inner };
    });
    showSplash();

    phase = 'active';
}

function dive() {
    for (const part of ob.parts) {
        part.inner.classList.remove('emerging');
        part.inner.classList.add('diving');
    }
    showSplash();

    phase = 'submerged';
    accum = 0;
    cooldownTarget = randomCooldownDeg();
}

// Advance the obstacle for this frame. `logSpeedAbs` is |deg rotated this frame|.
// Returns 'hit' (non-jumped collision), 'cleared' (jumped over), or null.
export function stepObstacles(logSpeedAbs) {
    if (!ob) return null;

    if (phase === 'submerged') {
        // Grace period: nothing surfaces for the first OBSTACLE_START_MS.
        if (state.elapsed < OBSTACLE_START_MS) return null;
        accum += logSpeedAbs;
        if (accum >= cooldownTarget) emerge();
        return null;
    }

    // phase === 'active'
    let event = null;
    for (const part of ob.parts) {
        if (!part.armed) continue;
        const d = Math.abs(normalizeAngle(ob.angle + part.off - state.userAngle));
        if (d < ob.def.collideWindow) {
            part.armed = false;
            if (state.isJumping && jumpClears(ob.def)) {
                part.inner.classList.add('cleared');
                event = 'cleared';
            } else if (!state.invulnerable) {
                part.inner.classList.add('struck');
                event = 'hit';
            }
            break; // at most one collision event per frame
        }
    }

    // Track the trip around the log to decide when to dive back into the water.
    ob.traveled += logSpeedAbs;
    if (!ob.passedTop) {
        let allPassed = true;
        for (const part of ob.parts) {
            if (!part.passed) {
                const sa = normalizeAngle(state.logAngle + ob.angle + part.off);
                if (Math.abs(sa) < 30) part.passed = true;
                else allPassed = false;
            }
        }
        if (allPassed) ob.passedTop = true;
    }
    const screenAngle = normalizeAngle(state.logAngle + ob.angle);
    if (ob.passedTop && ob.traveled > 200 && Math.abs(normalizeAngle(screenAngle - 180)) < 25) {
        dive();
    }

    return event;
}
