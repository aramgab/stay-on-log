// === OBSTACLES ===
// Obstacles are pinned to the rotating log surface at fixed angles. The player
// stands on the log at angle `state.userAngle`, so a collision happens whenever
// an obstacle's angle lines up with the player's angle — independent of frame
// rate or log direction. Tap to jump clears the obstacle underfoot.

import { state } from './state.js';
import {
    OBSTACLE_RADIUS,
    OBSTACLE_COUNT,
    OBSTACLE_SAFE_ZONE,
    COLLIDE_WINDOW,
    REARM_WINDOW,
} from './config.js';
import { obstacleLayer } from './dom.js';

// Normalize an angle to the range (-180, 180].
function normalizeAngle(deg) {
    return ((deg % 360) + 540) % 360 - 180;
}

// Spread obstacles roughly evenly around the log with jitter, skipping a safe
// zone around the player's starting position (userAngle = 0). Builds the DOM
// for the obstacle layer fresh each game.
export function spawnObstacles() {
    state.obstacles = [];
    obstacleLayer.innerHTML = '';

    // Spread obstacles only across the arc [SAFE_ZONE, 360 - SAFE_ZONE] so that,
    // after normalization, none land within the safe zone around the player's
    // start (userAngle = 0). Otherwise high angles wrap back toward 0 and cause
    // an instant hit on the first frame.
    const arc = 360 - 2 * OBSTACLE_SAFE_ZONE;
    const step = arc / OBSTACLE_COUNT;
    for (let i = 0; i < OBSTACLE_COUNT; i++) {
        // Even slot within the arc + bounded jitter (kept inside the slot).
        const jitter = (((i * 73 + 19) % 100) / 100 - 0.5) * step * 0.6;
        let angle = OBSTACLE_SAFE_ZONE + i * step + jitter;
        angle = normalizeAngle(angle);

        const el = document.createElement('div');
        el.className = 'obstacle';
        el.style.transform = `translate(-50%, -50%) rotate(${angle}deg) translateY(-${OBSTACLE_RADIUS}px)`;
        obstacleLayer.appendChild(el);

        state.obstacles.push({ angle, armed: true, el });
    }
}

// Keep the obstacle layer rotating in lock-step with the log.
export function renderObstacleLayer() {
    obstacleLayer.style.transform = `rotate(${state.logAngle}deg)`;
}

// Advance obstacle arming/clearing for this frame.
// Returns true if the player took a (non-jumped) hit this frame.
export function stepObstacles() {
    let hit = false;

    for (const o of state.obstacles) {
        const d = Math.abs(normalizeAngle(o.angle - state.userAngle));

        if (o.armed && d < COLLIDE_WINDOW) {
            o.armed = false;
            if (state.isJumping) {
                o.el.classList.add('cleared');
            } else if (!state.invulnerable) {
                o.el.classList.add('struck');
                hit = true;
            }
        } else if (!o.armed && d > REARM_WINDOW) {
            // Player has moved well past — ready it for the next pass.
            o.armed = true;
            o.el.classList.remove('cleared', 'struck');
        }
    }

    return hit;
}
