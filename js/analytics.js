// === ANALYTICS (PostHog) ===
// Thin wrapper around the PostHog browser SDK: every other module calls
// track() through here instead of touching `window.posthog` directly — same
// seam pattern as js/tg.js for the Telegram SDK. Self-hiding like the
// leaderboard: with POSTHOG_KEY left empty (its default in config.js),
// initAnalytics() never even loads the PostHog script — zero network calls,
// track() silently no-ops — so a checkout with no key configured behaves
// exactly like the game did before this file existed. Setup: docs/ANALYTICS_SETUP.md.

import { POSTHOG_KEY, POSTHOG_HOST } from './config.js';
import { isInTelegram, tgUser } from './tg.js';

let ready = false;

// Official posthog-js "HTML snippet" loader (posthog.com/docs/libraries/js),
// left in its vendored form (not restyled to our 4-space/single-quote
// convention) so a future official snippet can be pasted straight over this
// function body. Runs only from inside initAnalytics() — never at
// module-import time — so importing this file is always side-effect-free.
function loadSnippet() {
    !function (t, e) {
        var o, n, p, r;
        e.__SV || ((window.posthog = e), (e._i = []), (e.init = function (i, s, a) {
            function g(t, e) {
                var o = e.split(".");
                (2 == o.length && ((t = t[o[0]]), (e = o[1])),
                    (t[e] = function () {
                        t.push([e].concat(Array.prototype.slice.call(arguments, 0)));
                    }));
            }
            (((p = t.createElement("script")).type = "text/javascript"),
                (p.crossOrigin = "anonymous"),
                (p.async = !0),
                (p.src = s.api_host.replace(".i.posthog.com", "-assets.i.posthog.com") + "/static/array.js"),
                (r = t.getElementsByTagName("script")[0]).parentNode.insertBefore(p, r));
            var u = e;
            for (
                void 0 !== a ? (u = e[a] = []) : (a = "posthog"),
                u.people = u.people || [],
                u.toString = function (t) {
                    var e = "posthog";
                    return ("posthog" !== a && (e += "." + a), t || (e += " (stub)"), e);
                },
                u.people.toString = function () {
                    return u.toString(1) + ".people (stub)";
                },
                o = "init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagResult isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),
                n = 0;
                n < o.length;
                n++
            )
                g(u, o[n]);
            e._i.push([i, s, a]);
        }), (e.__SV = 1));
    }(document, window.posthog || []);
}

// Call once at boot (see game.js). Safe to call even when POSTHOG_KEY is
// empty — becomes a no-op, matching the rest of this function's
// never-throw contract (analytics must not be able to break the game).
export function initAnalytics() {
    if (!POSTHOG_KEY || ready) return;
    try {
        loadSnippet();
        window.posthog.init(POSTHOG_KEY, {
            api_host: POSTHOG_HOST,
            // Dated defaults bundle (autocapture, exception capture, etc.) —
            // pins behavior so a future SDK bump can't silently change it.
            // Session *replay* (screen recording) is deliberately left off:
            // we only asked for session length/last-event, not video, and
            // replay eats a much smaller free quota. Bump this date only
            // after checking posthog.com/docs/libraries/js for the current one.
            defaults: '2026-05-30',
            // Anonymous (pre-identify) visitors don't consume a person
            // profile — only real Telegram users (post-identify()) do.
            person_profiles: 'identified_only',
        });
        ready = true;

        const u = isInTelegram() && tgUser();
        if (u && u.id) {
            // Stable distinct_id across sessions/devices for the same
            // Telegram account — required for retention/cohorts to mean
            // anything (without this every session looks like a new visitor).
            window.posthog.identify(String(u.id), {
                name: u.first_name || u.username || undefined,
                platform: 'telegram',
            });
        }

        // Crash visibility: right now a broken run is invisible to us unless
        // a friend notices and reports it. Own handler (not the SDK's
        // auto-instrumentation) so behavior here is fully known/verifiable.
        window.addEventListener('error', (e) => {
            track('js_error', {
                message: String(e.message || '').slice(0, 300),
                source: (String(e.filename || '').slice(0, 200)) + ':' + e.lineno,
                stack: e.error && e.error.stack ? String(e.error.stack).slice(0, 1000) : '',
            });
        });
        window.addEventListener('unhandledrejection', (e) => {
            const reason = e.reason;
            track('js_error', {
                message: 'unhandledrejection: ' + String((reason && reason.message) || reason).slice(0, 300),
                stack: reason && reason.stack ? String(reason.stack).slice(0, 1000) : '',
            });
        });
    } catch (e) {
        /* analytics must never break the game — stay silent */
    }
}

// Fire-and-forget custom event. No-op until initAnalytics() has actually
// configured a key — every call site can call this unconditionally, same
// "always safe to call" contract as haptics.js.
export function track(event, props) {
    if (!ready) return;
    try {
        window.posthog.capture(event, props || {});
    } catch (e) { /* best-effort, never break gameplay */ }
}
