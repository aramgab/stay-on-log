// === CAMPAIGN PROGRESS ===
// Persistent campaign state: selected biome, per-quest counters and full-day
// cycles per biome. One JSON blob under stayOnLog_campaign_v1: localStorage
// via lsGet/lsSet (guarded against private-webview throws) + Telegram
// CloudStorage with a MAX-merge — every value in here is a monotonic counter,
// so max() can never dupe progress between devices (unlike summing a wallet
// would; that's exactly why the coin wallet stays local-only).
//
// Write discipline: every mutation persists to localStorage immediately;
// CloudStorage is pushed only from flushCampaign() (game.js calls it in
// gameOver) so mid-run quest ticks don't spam the TG API.

import { lsGet, lsSet } from './state.js';
import { cloudGet, cloudSet } from './tg.js';
import { QUESTS, questsFor, BIOMES } from './biomes.js';

const KEY = 'stayOnLog_campaign_v1';

// { selected: 'earth', quests: {questId: count}, cycles: {biomeId: count} }
let data = load();

function load() {
    let parsed = null;
    try { parsed = JSON.parse(lsGet(KEY) || ''); } catch (e) { /* fresh profile */ }
    if (!parsed || typeof parsed !== 'object') parsed = {};
    return {
        selected: typeof parsed.selected === 'string' ? parsed.selected : '',
        quests: parsed.quests && typeof parsed.quests === 'object' ? parsed.quests : {},
        cycles: parsed.cycles && typeof parsed.cycles === 'object' ? parsed.cycles : {},
    };
}

function persistLocal() {
    lsSet(KEY, JSON.stringify(data));
}

// Push the whole blob to CloudStorage. Called from gameOver (not per tick).
export function flushCampaign() {
    cloudSet(KEY, JSON.stringify(data));
}

// --- counters ---

export function questCount(questId) {
    return data.quests[questId] || 0;
}

export function bumpQuest(questId, by) {
    data.quests[questId] = (data.quests[questId] || 0) + (by || 1);
    persistLocal();
    return data.quests[questId];
}

// Feed one gameplay event into the quest counters of the currently selected
// biome. Types: 'coin' {dayPhase}, 'clear' {obType}, 'boss' {bossId}.
// Counters freeze at target (so the UI reads "3/3", not "17/3" — and the
// cross-device max-merge stays meaningful). Returns the quests COMPLETED by
// exactly this event, for the in-run toast.
export function questEvent(type, payload) {
    const biome = getSelectedBiome();
    const completed = [];
    QUESTS.forEach((q) => {
        if (q.biome !== biome || q.type !== type) return;
        if (q.dayPhase && (!payload || payload.dayPhase !== q.dayPhase)) return;
        if (q.obTypes && (!payload || q.obTypes.indexOf(payload.obType) === -1)) return;
        const before = questCount(q.id);
        if (before >= q.target) return;
        const after = bumpQuest(q.id, 1);
        if (after >= q.target) completed.push(q);
    });
    return completed;
}

export function isQuestDone(q) {
    return questCount(q.id) >= q.target;
}

// All three quests of a biome done -> the next world unlocks (map UI reads this).
export function allQuestsDone(biomeId) {
    const qs = questsFor(biomeId);
    return qs.length > 0 && qs.every(isQuestDone);
}

export function cyclesOf(biomeId) {
    return data.cycles[biomeId] || 0;
}

// A full day survived in this biome (called on every wrap, so multiple
// cycles in one long run all count).
export function cycleCompleted(biomeId) {
    data.cycles[biomeId] = (data.cycles[biomeId] || 0) + 1;
    persistLocal();
}

// A biome is playable when it has content AND its unlock condition is met.
export function isBiomeUnlocked(biomeId) {
    const b = BIOMES[biomeId];
    if (!b || !b.playable) return false;
    if (!b.unlock) return true;
    if (b.unlock.questsOf) return allQuestsDone(b.unlock.questsOf);
    return false;
}

// --- biome selection ('earth' is the only world unlocked from the start,
// so it is always a safe fallback) ---

export function getSelectedBiome() {
    // A cloud-synced selection must never start a locked/empty world on this
    // device (e.g. quests were only completed elsewhere) — fall back to the
    // one world that's always unlocked.
    return isBiomeUnlocked(data.selected) ? data.selected : 'earth';
}

export function setSelectedBiome(biomeId) {
    data.selected = biomeId;
    persistLocal();
    flushCampaign(); // selection is rare and worth syncing right away
}

// Dev-panel cheat (?dev=1): complete every quest — the unlock chain can't be
// playtested by grinding on every deploy. Writes real progress on purpose.
export function devCompleteAllQuests() {
    QUESTS.forEach((q) => {
        if ((data.quests[q.id] || 0) < q.target) data.quests[q.id] = q.target;
    });
    persistLocal();
    flushCampaign();
}

// --- CloudStorage merge (async, runs once on boot from game.js) ---
// Counters take max() per key; `selected` follows the shop's equipped-skin
// rule: an explicit local choice wins, cloud only fills a local void. If the
// merged local state is richer than the cloud copy, push it back.
export function syncCampaignFromCloud() {
    cloudGet(KEY, (v) => {
        if (!v) {
            // Nothing in the cloud yet — seed it if we have any progress.
            if (data.selected || Object.keys(data.quests).length || Object.keys(data.cycles).length) {
                flushCampaign();
            }
            return;
        }
        let cloud = null;
        try { cloud = JSON.parse(v); } catch (e) { return; }
        if (!cloud || typeof cloud !== 'object') return;
        let changed = false;   // local got new info -> re-persist locally
        let localRicher = false; // local has info the cloud lacks -> push back
        ['quests', 'cycles'].forEach((k) => {
            const cloudMap = cloud[k] && typeof cloud[k] === 'object' ? cloud[k] : {};
            const localMap = data[k];
            Object.keys(cloudMap).forEach((id) => {
                const cv = parseInt(cloudMap[id], 10) || 0;
                if (cv > (localMap[id] || 0)) { localMap[id] = cv; changed = true; }
            });
            Object.keys(localMap).forEach((id) => {
                if ((localMap[id] || 0) > (parseInt(cloudMap[id], 10) || 0)) localRicher = true;
            });
        });
        if (!data.selected && typeof cloud.selected === 'string' && cloud.selected) {
            data.selected = cloud.selected;
            changed = true;
        } else if (data.selected && data.selected !== cloud.selected) {
            localRicher = true;
        }
        if (changed) persistLocal();
        if (localRicher) flushCampaign();
    });
}
