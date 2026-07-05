// === BIOMES & DAY CYCLE ===
// Pure data + pure functions, no DOM: maps a run's elapsed time to the
// current time-of-day segment. game.js applies the returned css class to
// <body> (the palette lives in css/styles.css); audio.js MOODS are keyed by
// the same class names, so id/cssClass here are the single source of truth.
import { DAY_SUNSET_MS, DAY_NIGHT_MS, DAY_STORM_MS, DAY_DAWN_MS, DAY_CYCLE_MS } from './config.js';

// Every palette class the day cycle can put on <body> — game.js clears these
// before applying the next one.
export const DAY_PHASE_CLASSES = ['biome-day', 'biome-sunset', 'biome-night', 'biome-storm', 'biome-dawn'];

// Run-elapsed (ms) -> current day segment. The cycle wraps every DAY_CYCLE_MS:
// storm is the boss-window segment (hardest palette read), dawn is the
// victory lap right after it, then the palette loops back to noon — while
// elapsed itself keeps growing (difficulty reads it raw, unaffected).
export function dayPhaseFor(elapsed) {
    const t = elapsed % DAY_CYCLE_MS;
    if (t >= DAY_DAWN_MS) return { id: 'dawn', cssClass: 'biome-dawn' };
    if (t >= DAY_STORM_MS) return { id: 'storm', cssClass: 'biome-storm' };
    if (t >= DAY_NIGHT_MS) return { id: 'night', cssClass: 'biome-night' };
    if (t >= DAY_SUNSET_MS) return { id: 'sunset', cssClass: 'biome-sunset' };
    return { id: 'noon', cssClass: 'biome-day' };
}

// How many full days this run has survived (0 during the first cycle).
export function cycleOf(elapsed) {
    return Math.floor(elapsed / DAY_CYCLE_MS);
}
