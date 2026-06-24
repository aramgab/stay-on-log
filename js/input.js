// === ACCELEROMETER INPUT ===
// Converts device tilt into an angular delta and accumulates it into
// state.userAngle, smoothed by a low-pass filter.

import { state } from './state.js';
import { SMOOTH_ALPHA } from './config.js';

export function handleMotion(event) {
    let x = event.accelerationIncludingGravity.x;
    let y = event.accelerationIncludingGravity.y;

    let rad = Math.atan2(y, x);
    let deg = rad * (180 / Math.PI) - 90;

    if (state.rawLastAngle !== null) {
        let delta = deg - state.rawLastAngle;
        if (delta < -180) delta += 360;
        if (delta > 180) delta -= 360;

        state.smoothedDelta = state.smoothedDelta * (1 - SMOOTH_ALPHA) + delta * SMOOTH_ALPHA;
        state.userAngle += state.smoothedDelta;
    }

    state.rawLastAngle = deg;
}
