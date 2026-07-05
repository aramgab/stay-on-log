// === HAPTICS ===
// Vibration feedback. Prefers Telegram's HapticFeedback when running inside a
// Telegram Mini App, otherwise falls back to the Web Vibration API. No-ops where
// neither is available (desktop, iOS Safari).

// Re-read the Telegram object on every call (cheap) instead of caching once at
// module load: some Telegram clients attach/populate window.Telegram.WebApp
// (and its HapticFeedback sub-object) slightly after script evaluation, and
// older clients may expose WebApp without HapticFeedback at all.
function tgHaptics() {
    try {
        return window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.HapticFeedback;
    } catch (e) {
        return null;
    }
}

function vibrate(pattern) {
    if (typeof navigator.vibrate === 'function') {
        try { navigator.vibrate(pattern); } catch (e) { /* ignore */ }
    }
}

export function hapticJump() {
    const h = tgHaptics();
    if (h) { try { h.impactOccurred('medium'); return; } catch (e) { /* fall through */ } }
    vibrate(25);
}

export function hapticHit() {
    const h = tgHaptics();
    if (h) {
        try {
            h.impactOccurred('heavy');
            h.notificationOccurred('error');
            return;
        } catch (e) { /* fall through */ }
    }
    vibrate([70, 30, 40]);
}

// Long, unmistakable buzz — the run just ended.
export function hapticFall() {
    const h = tgHaptics();
    if (h) { try { h.notificationOccurred('error'); return; } catch (e) { /* fall through */ } }
    vibrate([100, 60, 100, 60, 140]);
}

// Obstacle cleared. Stronger buzz once a combo (mult > 1) kicks in so the
// escalating reward is felt, not just seen/heard. A high combo (>= 3) gets a
// double-pulse "thump-thump" instead of a single hit.
export function hapticClear(mult) {
    const h = tgHaptics();
    if (h) {
        try {
            if (mult >= 3) {
                h.impactOccurred('heavy');
                setTimeout(() => { try { h.impactOccurred('heavy'); } catch (e) { /* ignore */ } }, 90);
            } else {
                h.impactOccurred(mult > 1 ? 'medium' : 'light');
            }
            return;
        } catch (e) { /* fall through */ }
    }
    if (mult >= 3) {
        vibrate([25, 90, 25]);
    } else {
        vibrate(mult > 1 ? [20, 60, 25] : 18);
    }
}

// Countdown tick (3-2-1) and biome transitions — a light pulse so the game
// keeps feeling "alive" between the sparser jump/hit/clear events. Left
// untouched: it's frequent and shouldn't compete with the bigger events.
export function hapticTick() {
    const h = tgHaptics();
    if (h) { try { h.selectionChanged(); return; } catch (e) { /* fall through */ } }
    vibrate(8);
}

// Coin pickup — the lightest touch in the vocabulary: frequent and pleasant,
// must never compete with jump/clear feedback.
export function hapticCoin() {
    const h = tgHaptics();
    if (h) { try { h.impactOccurred('light'); return; } catch (e) { /* fall through */ } }
    vibrate(12);
}

// First time this run the player beats their all-time high score — the
// biggest celebration in the game: success notification + a triple pulse.
export function hapticRecord() {
    const h = tgHaptics();
    if (h) {
        try {
            h.notificationOccurred('success');
            setTimeout(() => { try { h.impactOccurred('heavy'); } catch (e) { /* ignore */ } }, 90);
            setTimeout(() => { try { h.impactOccurred('heavy'); } catch (e) { /* ignore */ } }, 220);
            return;
        } catch (e) { /* fall through */ }
    }
    vibrate([30, 60, 30, 60, 30, 80, 55]);
}
