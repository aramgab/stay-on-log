// === OBSTACLE ===
// A single obstacle that surfaces from the water at the bottom of the log,
// rides up to the player as the log rotates, and after it has been passed dives
// back into the water for 1-3 rotations before surfacing again. There are no
// obstacles at all until the player reaches OBSTACLE_START_SCORE.
//
// The obstacle is pinned to the log surface at a fixed angle, so a collision
// happens when its angle lines up with the player's angle (state.userAngle) —
// independent of frame rate or log direction. Tap to jump clears it.

import { state } from './state.js';
import {
    OBSTACLE_RADIUS,
    OBSTACLE_START_SCORE,
    OBSTACLE_COOLDOWN_MIN_ROT,
    OBSTACLE_COOLDOWN_MAX_ROT,
    FIRST_EMERGE_ROT,
    COLLIDE_WINDOW,
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
let ob = null;            // { angle, armed, traveled, passedTop, inner }

function randomCooldownDeg() {
    const span = OBSTACLE_COOLDOWN_MAX_ROT - OBSTACLE_COOLDOWN_MIN_ROT;
    return (OBSTACLE_COOLDOWN_MIN_ROT + Math.random() * span) * 360;
}

function showSplash() {
    obstacleSplash.classList.remove('active');
    void obstacleSplash.offsetWidth; // restart the animation
    obstacleSplash.classList.add('active');
}

// Build the (hidden) obstacle element once per game.
export function spawnObstacles() {
    obstacleLayer.innerHTML = '';

    const el = document.createElement('div');
    el.className = 'obstacle';
    const inner = document.createElement('div');
    inner.className = 'obstacle-inner';
    el.appendChild(inner);
    obstacleLayer.appendChild(el);

    ob = { angle: 0, armed: false, traveled: 0, passedTop: false, el, inner };
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

function emerge() {
    // Pin to the log's bottom point (screen angle 180) so it surfaces at the water.
    ob.angle = normalizeAngle(180 - state.logAngle);
    ob.armed = true;
    ob.traveled = 0;
    ob.passedTop = false;

    ob.el.style.display = 'block';
    ob.el.style.transform =
        `translate(-50%, -50%) rotate(${ob.angle}deg) translateY(-${OBSTACLE_RADIUS}px)`;
    ob.inner.classList.remove('cleared', 'struck', 'diving');
    ob.inner.classList.remove('emerging');
    void ob.inner.offsetWidth;
    ob.inner.classList.add('emerging');
    showSplash();

    phase = 'active';
}

function dive() {
    ob.inner.classList.remove('emerging');
    ob.inner.classList.add('diving');
    showSplash();

    phase = 'submerged';
    accum = 0;
    cooldownTarget = randomCooldownDeg();
}

// Advance the obstacle for this frame. `logSpeedAbs` is |deg rotated this frame|.
// Returns true if the player took a (non-jumped) hit this frame.
export function stepObstacles(logSpeedAbs) {
    if (!ob) return false;

    if (phase === 'submerged') {
        // Grace period: nothing surfaces until the player has earned enough score.
        if (state.score < OBSTACLE_START_SCORE) return false;
        accum += logSpeedAbs;
        if (accum >= cooldownTarget) emerge();
        return false;
    }

    // phase === 'active'
    let hit = false;
    const d = Math.abs(normalizeAngle(ob.angle - state.userAngle));

    if (ob.armed && d < COLLIDE_WINDOW) {
        ob.armed = false;
        if (state.isJumping) {
            ob.inner.classList.add('cleared');
        } else if (!state.invulnerable) {
            ob.inner.classList.add('struck');
            hit = true;
        }
    }

    // Track the trip around the log to decide when to dive back into the water.
    ob.traveled += logSpeedAbs;
    const screenAngle = normalizeAngle(state.logAngle + ob.angle);
    if (!ob.passedTop && Math.abs(screenAngle) < 30) {
        ob.passedTop = true;
    }
    if (ob.passedTop && ob.traveled > 200 && Math.abs(normalizeAngle(screenAngle - 180)) < 25) {
        dive();
    }

    return hit;
}
