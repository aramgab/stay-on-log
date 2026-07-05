// === ON-LOG DIRECTION ARROWS (v2) ===
// Two concentric arc arrows drawn on the log face. The wrapper (#dir-arrows)
// is a SIBLING of #log-wrapper, so the arrows stand upright while the log
// spins under them:
//   - main arrow (outer, R=62): where the log is spinning RIGHT NOW,
//     arc length = current speed;
//   - preview arrow (inner, R=38, dimmer): what the NEXT scheduled change
//     will do (direction + speed), read from state.pendingChange.
// Paths are regenerated only on events (roll / apply / run start) — never
// per frame; the elements themselves never rotate.

import {
    MIN_SPEED,
    MAX_SPEED,
    ARROW_ARC_MIN_DEG,
    ARROW_ARC_MAX_DEG,
} from './config.js';
import { dirArrows, dirArrowMain, dirArrowPreview } from './dom.js';

// Geometry in viewBox units (0 0 200 200, center 100,100 = log face center).
// The radii ratio feeds the promote animation: CSS .promoting scales the
// preview by R_MAIN / R_PREV ≈ 1.632 to land exactly on the main arc —
// keep that CSS scale in sync if these change.
const R_MAIN = 62;
const R_PREV = 38;
const HEAD_LEN = 14; // arrowhead length along the direction of motion
const HEAD_HALF = 7; // half-width of the arrowhead base

const mainArc = dirArrowMain.querySelector('.arc');
const mainHead = dirArrowMain.querySelector('.head');
const prevArc = dirArrowPreview.querySelector('.arc');
const prevHead = dirArrowPreview.querySelector('.head');

const rad = (deg) => deg * Math.PI / 180;
// Azimuth convention: 0° = 12 o'clock, positive = clockwise on screen.
function pt(r, az) {
    return [100 + r * Math.sin(rad(az)), 100 - r * Math.cos(rad(az))];
}
function vec(az) {
    return [Math.sin(rad(az)), -Math.cos(rad(az))];
}
const fmt = (n) => Math.round(n * 10) / 10;

// Speed -> arc span (deg). Clamped so even off-range speeds stay readable.
function spanFor(speed) {
    const f = Math.min(1, Math.max(0,
        (Math.abs(speed) - MIN_SPEED) / (MAX_SPEED - MIN_SPEED)));
    return ARROW_ARC_MIN_DEG + f * (ARROW_ARC_MAX_DEG - ARROW_ARC_MIN_DEG);
}

// Redraw one arrow: an arc symmetric around 12 o'clock (where the player
// stands — that's where the eye already is) plus a triangular head at the
// end the log is moving toward. Direction is baked into the path (sweep
// flag + which end carries the head) instead of a CSS scaleX(-1), keeping
// transform free for the promote animation.
function drawArrow(arcEl, headEl, r, dir, speed) {
    const span = spanFor(speed);
    const cw = dir === 1; // logDirection 1 = logAngle grows = clockwise on screen
    const a0 = cw ? -span / 2 : span / 2;
    const a1 = cw ? span / 2 : -span / 2;
    const [x0, y0] = pt(r, a0);
    const [x1, y1] = pt(r, a1);
    arcEl.setAttribute('d',
        `M ${fmt(x0)} ${fmt(y0)} A ${r} ${r} 0 0 ${cw ? 1 : 0} ${fmt(x1)} ${fmt(y1)}`);

    // Head: apex points along the tangent of motion at the arc's end.
    const headAz = a1 + (cw ? 90 : -90);
    const [ux, uy] = vec(headAz);
    const [px, py] = vec(headAz + 90);
    headEl.setAttribute('d',
        `M ${fmt(x1 + ux * HEAD_LEN)} ${fmt(y1 + uy * HEAD_LEN)}` +
        ` L ${fmt(x1 + px * HEAD_HALF)} ${fmt(y1 + py * HEAD_HALF)}` +
        ` L ${fmt(x1 - px * HEAD_HALF)} ${fmt(y1 - py * HEAD_HALF)} Z`);
}

export function setMainArrow(dir, speed) {
    drawArrow(mainArc, mainHead, R_MAIN, dir, speed);
}

// pending = { dir, speed } | null (null hides the preview: tutorial, or no
// roll yet).
export function setPreviewArrow(pending) {
    if (!pending) {
        dirArrowPreview.style.display = 'none';
        return;
    }
    dirArrowPreview.style.display = '';
    drawArrow(prevArc, prevHead, R_PREV, pending.dir, pending.speed);
}

// Instantly clear every arrow state (visibility, warning, pending preview).
// Called on gameOver/countdown so no stale warning/preview survives into
// the next run's first frames.
export function resetArrows() {
    dirArrows.classList.remove('on', 'warning');
    setPreviewArrow(null);
}
