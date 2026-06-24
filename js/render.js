// === FALL / SPLASH ANIMATION ===
// Renders the player falling off the log into the water after a loss.

import { state } from './state.js';
import { ORBIT_RADIUS } from './config.js';
import {
    gameContainer,
    waterContainer,
    fallingPlayerEl,
    splashEl,
    statusEl,
    startBtn,
} from './dom.js';
import { countUp } from './fx.js';

export function animateFall(normPos) {
    // Determine fall direction: positive normPos = fell to the right
    let fallDirection = normPos > 0 ? 1 : -1;

    // Get game container position
    let containerRect = gameContainer.getBoundingClientRect();
    let centerX = containerRect.left + containerRect.width / 2;
    let centerY = containerRect.top + containerRect.height / 2;

    // Calculate exact position based on angle.
    // The player orbits at ORBIT_RADIUS from center. normPos is angle in degrees.
    // 0 deg is top of log, 90 deg is right, -90 is left.
    // Subtract 90 to convert to standard math angle (0 deg = up = -90 in JS Math).
    let rad = (normPos - 90) * (Math.PI / 180);
    let pX = centerX + Math.cos(rad) * ORBIT_RADIUS;
    let pY = centerY + Math.sin(rad) * ORBIT_RADIUS;

    // Offset for the player element bounds (44x55 px), centering it on the orbit point.
    let startX = pX - 22;
    let startY = pY - 27;

    // Water position
    let waterRect = waterContainer.getBoundingClientRect();
    let waterTop = waterRect.top + 30;

    // Full reset before animation
    fallingPlayerEl.classList.remove('active');
    fallingPlayerEl.removeAttribute('style');

    // Set initial position (no transition yet)
    fallingPlayerEl.style.position = 'fixed';
    fallingPlayerEl.style.display = 'block';
    fallingPlayerEl.style.left = startX + 'px';
    fallingPlayerEl.style.top = startY + 'px';
    fallingPlayerEl.style.opacity = '1';
    fallingPlayerEl.style.transform = 'rotate(0deg)';
    fallingPlayerEl.style.transition = 'none';

    // Double-rAF ensures the browser has painted the initial state
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            // Now apply transition and target values
            fallingPlayerEl.style.transition = 'left 0.8s ease-in, top 0.8s ease-in, transform 0.8s ease-in, opacity 0.8s ease-in';
            fallingPlayerEl.style.left = (startX + fallDirection * 30) + 'px';
            fallingPlayerEl.style.top = waterTop + 'px';
            fallingPlayerEl.style.transform = `rotate(${fallDirection * 90}deg)`;
            fallingPlayerEl.style.opacity = '0.3';
        });
    });

    // Show splash when player hits water
    setTimeout(() => {
        splashEl.removeAttribute('style');
        splashEl.style.position = 'fixed';
        splashEl.style.left = (startX + fallDirection * 30 - 18) + 'px';
        splashEl.style.top = (waterTop - 30) + 'px';
        splashEl.style.display = 'block';
        splashEl.classList.remove('active');
        void splashEl.offsetWidth;
        splashEl.classList.add('active');
    }, 700);

    // Show results after animation, counting the score up for a bit of juice.
    setTimeout(() => {
        fallingPlayerEl.style.display = 'none';
        const trophy = state.score >= state.highScore ? ' 🏆' : '';
        countUp(statusEl, state.score, 700, 'УПАЛ! Очки: ');
        if (trophy) {
            setTimeout(() => { statusEl.innerText = 'УПАЛ! Очки: ' + state.score + trophy; }, 720);
        }
        startBtn.style.display = 'inline-block';
        startBtn.innerText = "Попробовать снова";
    }, 1200);
}
