// === FX (juice) ===
// Cheap game-feel: screen-shake, particle bursts, and a score count-up. DOM-based
// to match the rest of the project (no canvas). Particles use the Web Animations
// API and clean themselves up.

import { gameArea } from './dom.js';

// Particle container (above the play field, ignores input).
const layer = document.createElement('div');
layer.id = 'fx-layer';
document.body.appendChild(layer);

gameArea.addEventListener('animationend', () => {
    gameArea.classList.remove('shake-sm', 'shake-lg');
});

// Shake the play field. big = heavy (fall), otherwise light (hit).
export function screenShake(big = false) {
    const cls = big ? 'shake-lg' : 'shake-sm';
    gameArea.classList.remove('shake-sm', 'shake-lg');
    void gameArea.offsetWidth; // restart the animation
    gameArea.classList.add(cls);
}

// Burst of particles from a viewport point (x, y).
export function burst(x, y, opts = {}) {
    const {
        count = 8,
        color = '#6b4423',
        size = 6,
        spread = 70,
        up = 40,
    } = opts;

    for (let i = 0; i < count; i++) {
        const p = document.createElement('div');
        p.className = 'fx-particle';
        p.style.left = x + 'px';
        p.style.top = y + 'px';
        p.style.width = size + 'px';
        p.style.height = size + 'px';
        p.style.background = color;
        layer.appendChild(p);

        const ang = Math.random() * Math.PI * 2;
        const dist = spread * (0.4 + Math.random() * 0.6);
        const dx = Math.cos(ang) * dist;
        const dy = Math.sin(ang) * dist - up;     // bias upward at launch
        const rot = Math.random() * 720 - 360;

        const anim = p.animate(
            [
                { transform: 'translate(-50%, -50%) rotate(0deg)', opacity: 1 },
                { transform: `translate(${dx}px, ${dy + 90}px) rotate(${rot}deg)`, opacity: 0 },
            ],
            { duration: 600 + Math.random() * 300, easing: 'cubic-bezier(.2,.7,.4,1)' }
        );
        anim.onfinish = () => p.remove();
    }
}

// Animate a number in `el` from 0 up to `to` (ease-out), with an optional prefix.
export function countUp(el, to, dur = 700, prefix = '') {
    const start = Date.now();
    function tick() {
        const t = Math.min(1, (Date.now() - start) / dur);
        const eased = 1 - Math.pow(1 - t, 3);
        el.innerText = prefix + Math.floor(eased * to);
        if (t < 1) requestAnimationFrame(tick);
        else el.innerText = prefix + to;
    }
    tick();
}
