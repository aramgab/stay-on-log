// === COINS ===
// One collectible coin at a time, run by the same pin-to-log state machine
// as obstacles.js: surfaces from the water at the log's bottom, rides up to
// the player as the log rotates, and — unlike an obstacle — is COLLECTED on
// angular contact. Ground coins collect on any contact; "high" coins float
// above the surface and only collect while the player is mid-jump.
// A missed coin rides on and dives back into the water like a passed
// obstacle. Coins never spawn while an obstacle is approaching the player,
// so a jump for a coin is never secretly a jump into a knot.

import { state } from './state.js';
import {
    COIN_START_MS,
    COIN_COOLDOWN_MIN_ROT,
    COIN_COOLDOWN_MAX_ROT,
    COIN_COLLECT_WINDOW,
    COIN_HIGH_CHANCE,
    COIN_VALUE,
    COIN_HIGH_VALUE,
    COIN_RADIUS_LOW,
    COIN_RADIUS_HIGH,
} from './config.js';
import { coinLayer } from './dom.js';
import { isObstacleApproaching } from './obstacles.js';

// Normalize an angle to the range (-180, 180] — same helper as obstacles.js.
function normalizeAngle(deg) {
    return ((deg % 360) + 540) % 360 - 180;
}

// Module-local state machine: 'submerged' <-> 'active'.
let phase = 'submerged';
let accum = 0;          // accumulated |rotation| (deg) while submerged
let cooldownTarget = 0; // deg of rotation to wait before surfacing
// coin = { angle, high, traveled, passedTop, el (holder), inner }
let coin = null;

function randomCooldownDeg() {
    const span = COIN_COOLDOWN_MAX_ROT - COIN_COOLDOWN_MIN_ROT;
    return (COIN_COOLDOWN_MIN_ROT + Math.random() * span) * 360;
}

// Build the (hidden) coin holder once per run; the visible coin is rebuilt
// on each emerge because its kind (ground/high) is rolled then.
export function spawnCoins() {
    coinLayer.innerHTML = '';

    const el = document.createElement('div');
    el.className = 'coin-holder';
    coinLayer.appendChild(el);

    coin = { angle: 0, high: false, traveled: 0, passedTop: false, el, inner: null };
    el.style.display = 'none';

    phase = 'submerged';
    accum = 0;
    cooldownTarget = randomCooldownDeg();
}

// Clear everything (used on countdown reset / game over).
export function resetCoins() {
    coinLayer.innerHTML = '';
    coin = null;
    phase = 'submerged';
    accum = 0;
}

// Keep the coin layer rotating in lock-step with the log (called every
// frame from gameLoop, right next to renderObstacleLayer).
export function renderCoinLayer() {
    coinLayer.style.transform = `rotate(${state.logAngle}deg)`;
}

function emerge() {
    coin.high = Math.random() < COIN_HIGH_CHANCE;
    // Pin to the log's bottom point (screen angle 180), like obstacles.
    coin.angle = normalizeAngle(180 - state.logAngle);
    coin.traveled = 0;
    coin.passedTop = false;

    const r = coin.high ? COIN_RADIUS_HIGH : COIN_RADIUS_LOW;
    coin.el.style.display = 'block';
    coin.el.innerHTML = '';
    const holder = document.createElement('div');
    holder.className = 'coin-part';
    holder.style.transform = `rotate(${coin.angle}deg) translateY(-${r}px)`;
    coin.inner = document.createElement('div');
    coin.inner.className = 'coin' + (coin.high ? ' high' : '');
    holder.appendChild(coin.inner);
    coin.el.appendChild(holder);
    void coin.inner.offsetWidth;
    coin.inner.classList.add('emerging');

    phase = 'active';
}

function despawn(collectedNow) {
    if (coin.inner) {
        coin.inner.classList.remove('emerging');
        coin.inner.classList.add(collectedNow ? 'collected' : 'diving');
    }
    phase = 'submerged';
    accum = 0;
    cooldownTarget = randomCooldownDeg();
}

// Advance the coin for this frame. `logSpeedAbs` is |deg rotated this frame|.
// Returns the collected wallet value (COIN_VALUE / COIN_HIGH_VALUE), or 0.
export function stepCoins(logSpeedAbs) {
    if (!coin) return 0;

    if (phase === 'submerged') {
        // Grace period, and elapsed stays 0 in the tutorial — no coins there.
        if (state.elapsed < COIN_START_MS) return 0;
        accum += logSpeedAbs;
        // Fairness: never surface while an obstacle is riding toward the
        // player — a coin jump must not turn into a surprise knot meeting.
        // The cooldown keeps accumulating, so the coin pops right after.
        if (accum >= cooldownTarget && !isObstacleApproaching()) emerge();
        return 0;
    }

    // phase === 'active'
    let value = 0;
    const d = Math.abs(normalizeAngle(coin.angle - state.userAngle));
    if (d < COIN_COLLECT_WINDOW && (!coin.high || state.isJumping)) {
        value = coin.high ? COIN_HIGH_VALUE : COIN_VALUE;
        despawn(true);
        return value;
    }

    // Ride around and dive back into the water once past the player, same
    // trip-tracking as obstacles.
    coin.traveled += logSpeedAbs;
    if (!coin.passedTop) {
        const sa = normalizeAngle(state.logAngle + coin.angle);
        if (Math.abs(sa) < 30) coin.passedTop = true;
    }
    const screenAngle = normalizeAngle(state.logAngle + coin.angle);
    if (coin.passedTop && coin.traveled > 200 && Math.abs(normalizeAngle(screenAngle - 180)) < 25) {
        despawn(false);
    }

    return 0;
}
