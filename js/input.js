// === ACCELEROMETER INPUT (phone "winding") ===
// The control scheme is "rotate the phone" (see the countdown "Готовься крутить
// телефон!" and the "КРУТИ ВЛЕВО/ВПРАВО" prompts): the player continuously winds
// the phone to keep the stickman on top of the endlessly rotating log. So we must
// ACCUMULATE the phone's rotation — a plain absolute-angle mapping would clamp at
// ±180° and couldn't keep up with the log.
//
// We accumulate raw per-sample deltas (unwrapped across ±180°) into a continuous
// angle, guard against sensor glitches, and low-pass the OUTPUT position toward it
// (less lag than smoothing the velocity, and no drift from integrating a smoothed
// rate — the previous model's two main problems).

import { state, lsGet, lsSet } from './state.js';
import {
    INPUT_SMOOTH,
    INPUT_DEADZONE,
    INPUT_MAX_STEP,
    DEFAULT_SENSITIVITY,
} from './config.js';

let sensitivity = parseFloat(lsGet('stayOnLog_sensitivity')) || DEFAULT_SENSITIVITY;
let smooth = parseFloat(lsGet('stayOnLog_inputSmooth')) || INPUT_SMOOTH;

export function setSensitivity(v) {
    sensitivity = v;
    lsSet('stayOnLog_sensitivity', String(v));
}

export function getSensitivity() {
    return sensitivity;
}

export function setSmooth(v) {
    smooth = v;
    lsSet('stayOnLog_inputSmooth', String(v));
}

export function getSmooth() {
    return smooth;
}

export function handleMotion(event) {
    const g = event.accelerationIncludingGravity;
    if (!g) return;

    const deg = Math.atan2(g.y, g.x) * (180 / Math.PI) - 90;

    if (state.rawLastAngle !== null) {
        let delta = deg - state.rawLastAngle;
        // Unwrap across the ±180° boundary so continuous winding stays continuous.
        if (delta < -180) delta += 360;
        else if (delta > 180) delta -= 360;

        // Reject sensor glitches / mis-unwraps (implausible single-frame jumps).
        if (Math.abs(delta) <= INPUT_MAX_STEP) {
            // Deadzone removes resting jitter before it accumulates.
            if (Math.abs(delta) < INPUT_DEADZONE) delta = 0;
            state.contAngle += delta * sensitivity;
        }
    }
    state.rawLastAngle = deg;

    // Low-pass the position toward the accumulated target — smooth but responsive.
    state.userAngle += (state.contAngle - state.userAngle) * smooth;
}
