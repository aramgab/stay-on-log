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
//
// This file now dispatches between two control schemes: the winding path above
// (scheme A, default) and an alternative "hold the tilt" path (scheme B, see
// handleMotionTilt below). Scheme A's logic is untouched — handleMotion just
// branches to the other handler up front when scheme B is selected.

import { state, lsGet, lsSet } from './state.js';
import {
    INPUT_SMOOTH,
    INPUT_VEL_SMOOTH,
    INPUT_DEADZONE,
    INPUT_MAX_STEP,
    DEFAULT_SENSITIVITY,
    TILT_SMOOTH,
    TILT_GLITCH_DEG,
} from './config.js';

let sensitivity = parseFloat(lsGet('stayOnLog_sensitivity')) || DEFAULT_SENSITIVITY;
let smooth = parseFloat(lsGet('stayOnLog_inputSmooth')) || INPUT_SMOOTH;

const rawScheme = lsGet('stayOnLog_controlScheme');
let scheme = rawScheme === 'wind' || rawScheme === 'tilt' ? rawScheme : 'wind';

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

export function setScheme(v) {
    scheme = v === 'wind' || v === 'tilt' ? v : 'wind';
    lsSet('stayOnLog_controlScheme', scheme);
}

export function getScheme() {
    return scheme;
}

export function handleMotion(event) {
    if (scheme === 'tilt') { handleMotionTilt(event); return; }

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
            // Low-pass the RATE before integrating: kills the sensor jitter that
            // made raw accumulation feel jerky, restoring a smooth, intuitive glide.
            // The deadzone above still prevents any resting drift through this stage.
            state.velEMA = state.velEMA * (1 - INPUT_VEL_SMOOTH) + delta * INPUT_VEL_SMOOTH;
            state.contAngle += state.velEMA * sensitivity;
        }
    }
    state.rawLastAngle = deg;

    // Low-pass the position toward the accumulated target — smooth but responsive.
    state.userAngle += (state.contAngle - state.userAngle) * smooth;
}

// Scheme B ("hold the tilt") only smooths the sampled tilt POSITION here — it
// does not integrate a rate into userAngle/contAngle the way scheme A does.
// devicemotion sample frequency isn't normalized against frame dt at this
// layer, so any rate-style integration done per-sample (rather than per-frame)
// would run at a different real-world speed on every device. That integration
// belongs in gameLoop, driven by dtF, and lands in a follow-up commit — this
// function just maintains a clean, glitch-guarded tiltEMA for it to read.
let tiltSeeded = false;

function handleMotionTilt(event) {
    const g = event.accelerationIncludingGravity;
    if (!g) return;

    const deg = Math.atan2(g.y, g.x) * (180 / Math.PI) - 90;

    // Seed the EMA from the very first sample: neutral deg differs by platform
    // (gravity sign conventions), and measuring the first delta against the 0
    // initializer could exceed TILT_GLITCH_DEG — rejecting every sample forever.
    if (!tiltSeeded) {
        state.tiltEMA = deg;
        tiltSeeded = true;
        return;
    }

    let d = deg - state.tiltEMA;
    if (d < -180) d += 360;
    else if (d > 180) d -= 360;
    if (Math.abs(d) > TILT_GLITCH_DEG) return; // sensor glitch — skip the sample
    state.tiltEMA += d * TILT_SMOOTH;
}
