// === CHAT BATTLES (client) ===
// Data core + score submission. The UI half (overlay, ⚔️ button, polling)
// arrives in the same module a commit later — this file deliberately does
// NOT touch the DOM yet, so game.js can import submitBattleScore while the
// interface is still being built.
//
// The player's active battle lives in localStorage as the UI's source of
// truth; the server keeps its own bt:u pointer purely as an anti-spam
// "one battle per user" guard. Shape:
//   stayOnLog_activeBattle = JSON { id, side, ends, nameA, nameB,
//                                   scoreA, scoreB, myTotal, finished? }

import { lsGet, lsSet } from './state.js';
import { isInTelegram, tgInitData } from './tg.js';

const LS_KEY = 'stayOnLog_activeBattle';

export function getActiveBattle() {
    try {
        const raw = lsGet(LS_KEY);
        if (!raw) return null;
        const b = JSON.parse(raw);
        return b && b.id ? b : null;
    } catch (e) {
        return null;
    }
}

export function setActiveBattle(b) {
    lsSet(LS_KEY, JSON.stringify(b));
}

export function clearActiveBattle() {
    lsSet(LS_KEY, '');
}

// Merge fresh server numbers into the stored battle (badge/overlay read it).
export function cacheBattleScores(patch) {
    const b = getActiveBattle();
    if (!b) return null;
    const merged = Object.assign(b, patch);
    setActiveBattle(merged);
    return merged;
}

// POST helper for api/battle.js ops. Resolves to the parsed JSON with the
// HTTP status attached (callers branch on flags, not exceptions).
export function battleApi(op, payload) {
    return fetch('/api/battle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ op, initData: tgInitData() }, payload)),
    }).then((r) => r.json().then((data) => {
        data.httpStatus = r.status;
        return data;
    }));
}

export function battleState(id, uid) {
    const q = '/api/battle?op=state&id=' + encodeURIComponent(id) +
        (uid ? '&uid=' + encodeURIComponent(uid) : '');
    return fetch(q).then((r) => r.json().then((data) => {
        data.httpStatus = r.status;
        return data;
    }));
}

// Fire-and-forget from gameOver (same contract as leaderboard submitScore):
// every game over of a run submits (runId, score); the server only counts
// the positive delta per runId, so the second game over after a revive adds
// the growth, never a double. Guards keep it a no-op without an active
// battle, outside Telegram, or past the battle window.
export function submitBattleScore(runId, score) {
    const b = getActiveBattle();
    if (!b || b.finished || !isInTelegram() || !(score > 0) || !runId) return;
    if (b.ends && Date.now() > b.ends) return;
    battleApi('submit', { id: b.id, runId, score })
        .then((resp) => {
            if (resp.finished || resp.httpStatus === 410) {
                cacheBattleScores({ finished: true });
                return;
            }
            if (resp.ok) {
                cacheBattleScores({
                    scoreA: resp.scoreA,
                    scoreB: resp.scoreB,
                    myTotal: resp.myTotal != null ? resp.myTotal : b.myTotal,
                });
            }
        })
        .catch(() => { /* best-effort, like the leaderboard */ });
}
