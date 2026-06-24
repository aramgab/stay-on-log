// === HAPTICS ===
// Vibration feedback. Prefers Telegram's HapticFeedback when running inside a
// Telegram Mini App, otherwise falls back to the Web Vibration API. No-ops where
// neither is available (desktop, iOS Safari).

function tgHaptics() {
    return window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.HapticFeedback;
}

function vibrate(pattern) {
    if (navigator.vibrate) {
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
