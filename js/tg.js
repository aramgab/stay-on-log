// === TELEGRAM MINI APP BRIDGE ===
// Single point of access to the Telegram WebApp SDK. Every other module reads
// Telegram state through here instead of touching window.Telegram directly.
// Outside Telegram (a plain browser, no SDK script) everything degrades to a
// no-op / null return, same guarded style as haptics.js.

// Re-read window.Telegram on every call instead of caching once at module
// load: some Telegram clients attach/populate window.Telegram.WebApp slightly
// after script evaluation (see the same note in haptics.js).
function tgApp() {
    try {
        return window.Telegram && window.Telegram.WebApp;
    } catch (e) {
        return null;
    }
}

export function initTelegram() {
    const app = tgApp();
    if (app) {
        try {
            app.ready();
            app.expand();
        } catch (e) {
            /* not in a Telegram context — ignore */
        }
    }
}

// True only when actually running inside the Telegram client. The SDK script
// creates window.Telegram.WebApp even in a plain browser (e.g. opened
// directly, outside Telegram), but in that case initData is an empty string —
// that's the real "are we inside Telegram" signal, not object presence.
export function isInTelegram() {
    try {
        const app = tgApp();
        return !!(app && app.initData);
    } catch (e) {
        return false;
    }
}

export function tgUser() {
    try {
        const app = tgApp();
        return (app && app.initDataUnsafe && app.initDataUnsafe.user) || null;
    } catch (e) {
        return null;
    }
}

// CloudStorage requires a recent client (isVersionAtLeast itself can throw on
// old clients that don't have it at all) — probe defensively before use.
function cloudApi() {
    try {
        const app = tgApp();
        if (app && typeof app.isVersionAtLeast === 'function' && app.isVersionAtLeast('6.9') &&
            app.CloudStorage && typeof app.CloudStorage.getItem === 'function') {
            return app.CloudStorage;
        }
    } catch (e) {
        /* old client / missing API — fall through to null */
    }
    return null;
}

export function cloudGet(key, cb) {
    const api = cloudApi();
    if (!api) { cb(null); return; }
    try {
        api.getItem(key, function (err, value) {
            cb(err ? null : (value || null));
        });
    } catch (e) {
        cb(null);
    }
}

// Fire-and-forget write — callers don't need confirmation, so no callback.
export function cloudSet(key, value) {
    const api = cloudApi();
    if (!api) return;
    try {
        api.setItem(key, value);
    } catch (e) {
        /* ignore — best-effort sync */
    }
}

// Three tiers of sharing, best available wins: Telegram's own share sheet ->
// Web Share API -> clipboard fallback. Returns which one fired ('tg' / 'web'
// / 'copy'), or null if the platform offers none of them, so the caller can
// show its own "copied!" feedback for the clipboard case.
export function shareScore(text, url) {
    const app = tgApp();
    if (isInTelegram() && app && typeof app.openTelegramLink === 'function') {
        try {
            app.openTelegramLink('https://t.me/share/url?url=' + encodeURIComponent(url) + '&text=' + encodeURIComponent(text));
            return 'tg';
        } catch (e) {
            /* fall through to the next tier */
        }
    }
    if (typeof navigator.share === 'function') {
        try {
            navigator.share({ text: text, url: url }).catch(function () {
                /* user closed the share sheet — not an error */
            });
            return 'web';
        } catch (e) {
            /* some desktop browsers throw synchronously — fall through */
        }
    }
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(text + '\n' + url).catch(function () {
            /* ignore — best-effort copy */
        });
        return 'copy';
    }
    return null;
}
