// === BIOMES & DAY CYCLE ===
// Pure data + pure functions, no DOM: maps a run's elapsed time to the
// current time-of-day segment. game.js applies the returned css class to
// <body> (the palette lives in css/styles.css); audio.js MOODS are keyed by
// the same class names, so id/cssClass here are the single source of truth.
import { DAY_SUNSET_MS, DAY_NIGHT_MS, DAY_STORM_MS, DAY_DAWN_MS, DAY_CYCLE_MS } from './config.js';

// Palette classes per day segment. Worlds override this in BIOMES[..].dayPalette;
// audio.js MOODS are keyed by the same class names.
const DAY_PALETTE_DEFAULT = {
    noon: 'biome-day', sunset: 'biome-sunset', night: 'biome-night',
    storm: 'biome-storm', dawn: 'biome-dawn',
};

// Run-elapsed (ms) -> current day segment. The cycle wraps every DAY_CYCLE_MS:
// storm is the boss-window segment (hardest palette read), dawn is the
// victory lap right after it, then the palette loops back to noon — while
// elapsed itself keeps growing (difficulty reads it raw, unaffected).
export function dayPhaseFor(elapsed, biomeId) {
    const t = elapsed % DAY_CYCLE_MS;
    const seg = t >= DAY_DAWN_MS ? 'dawn'
        : t >= DAY_STORM_MS ? 'storm'
        : t >= DAY_NIGHT_MS ? 'night'
        : t >= DAY_SUNSET_MS ? 'sunset'
        : 'noon';
    const pal = (biomeId && BIOMES[biomeId] && BIOMES[biomeId].dayPalette) || DAY_PALETTE_DEFAULT;
    return { id: seg, cssClass: pal[seg] };
}

// How many full days this run has survived (0 during the first cycle).
export function cycleOf(elapsed) {
    return Math.floor(elapsed / DAY_CYCLE_MS);
}

// === CAMPAIGN QUESTS ===
// 3 per biome, ALL required to unlock the next world (the map UI reads this
// table; campaign.js counts progress — counters are cumulative across runs
// and freeze at target). type/payload contract: see campaign.js questEvent().
export const QUESTS = [
    { id: 'earth_coins_night', biome: 'earth', title: 'Собери 3 монетки ночью', type: 'coin', dayPhase: 'night', target: 3 },
    { id: 'earth_knots', biome: 'earth', title: 'Перепрыгни 5 сучков', type: 'clear', obTypes: ['knot', 'double'], target: 5 },
    { id: 'earth_boss', biome: 'earth', title: 'Одолей белую акулу', type: 'boss', target: 1 },
    { id: 'winter_coins', biome: 'winter', title: 'Собери 10 монеток в Зимнем', type: 'coin', target: 10 },
    { id: 'winter_branches', biome: 'winter', title: 'Перепрыгни 3 ледяных шипа', type: 'clear', obTypes: ['branch'], target: 3 },
    { id: 'winter_boss', biome: 'winter', title: 'Одолей косатку', type: 'boss', target: 1 },
];

export function questsFor(biomeId) {
    return QUESTS.filter((q) => q.biome === biomeId);
}

// === BOSSES ===
// One per biome; the engine (js/boss.js) picks by the selected biome. Titles
// feed the intro banner and the map UI.
export const BOSSES = {
    shark: { id: 'shark', biome: 'earth', title: 'БЕЛАЯ АКУЛА', emoji: '🦈' },
    orca: { id: 'orca', biome: 'winter', title: 'КОСАТКА', emoji: '🐋' },
};

export function bossFor(biomeId) {
    for (const k in BOSSES) if (BOSSES[k].biome === biomeId) return BOSSES[k];
    return null;
}

// === WORLD REGISTRY (campaign) ===
// playable: has real content today. announced: named card on the map, locked
// «скоро». worldClass goes on <body> for per-world reskins (bark/wood vars,
// obstacle art). unlock: {questsOf: biomeId} = all quests of that biome done.
export const BIOMES = {
    earth: { id: 'earth', title: 'Земля', emoji: '🌍', worldClass: 'world-earth', playable: true, unlock: null },
    winter: {
        id: 'winter', title: 'Зимний', emoji: '❄️', worldClass: 'world-winter', playable: true, unlock: { questsOf: 'earth' },
        dayPalette: { noon: 'biome-w-day', sunset: 'biome-w-sunset', night: 'biome-w-night', storm: 'biome-w-storm', dawn: 'biome-w-dawn' },
    },
    lava: { id: 'lava', title: 'Лавовый', emoji: '🌋', playable: false, announced: true },
    space: { id: 'space', title: 'Космос', emoji: '🚀', playable: false, announced: true },
};

// Every palette class the day cycle can put on <body> — game.js clears these
// before applying the next one. Computed from the default palette plus every
// world's dayPalette override, so a new world only needs to list its classes
// once (here, implicitly, via BIOMES[..].dayPalette).
export const DAY_PHASE_CLASSES = (() => {
    const set = {};
    Object.keys(DAY_PALETTE_DEFAULT).forEach((k) => { set[DAY_PALETTE_DEFAULT[k]] = 1; });
    Object.keys(BIOMES).forEach((id) => {
        const pal = BIOMES[id].dayPalette;
        if (pal) Object.keys(pal).forEach((k) => { set[pal[k]] = 1; });
    });
    return Object.keys(set);
})();

// The campaign line: chapters of 4 cards each, all visible from day one.
// A card is: a biome id from BIOMES (playable or announced), OR a plain
// string (named teaser, no content yet), OR null (a pure «?» mystery).
export const CHAPTERS = [
    { id: 'stihii', title: 'I. Стихии', cards: ['earth', 'winter', 'lava', 'space'] },
    { id: 'civ', title: 'II. Цивилизации', cards: [null, null, null, null] },
    { id: 'smysly', title: 'III. Смыслы', cards: [null, null, null, null] },
    { id: 'ritm', title: 'Ритм', cards: ['Диско', 'Рок', 'Рэп', 'Классика'] },
    { id: 'detstvo', title: 'Детство', cards: ['Игрушки', 'Цирк', 'Кубический', 'Мультяшный'] },
    { id: 'iskusstvo', title: 'Искусство', cards: [null, null, null, null] },
    { id: 'sport', title: 'Спорт', cards: [null, null, null, null] },
    { id: 'strany', title: '🌏 Страны мира', arc: true, cards: [null, null, null, null] },
];
