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
    if (h) { try { h.impactOccurred('light'); return; } catch (e) { /* fall through */ } }
    vibrate(15);
}

export function hapticHit() {
    const h = tgHaptics();
    if (h) { try { h.impactOccurred('medium'); return; } catch (e) { /* fall through */ } }
    vibrate(40);
}

export function hapticFall() {
    const h = tgHaptics();
    if (h) { try { h.notificationOccurred('error'); return; } catch (e) { /* fall through */ } }
    vibrate([60, 40, 80]);
}
