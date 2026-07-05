// === BIOMES & DAY CYCLE ===
// Pure data + pure functions, no DOM: maps a run's elapsed time to the
// current time-of-day segment. game.js applies the returned css class to
// <body> (the palette lives in css/styles.css); audio.js MOODS are keyed by
// the same class names, so id/cssClass here are the single source of truth.
import { DAY_SUNSET_MS, DAY_NIGHT_MS, DAY_STORM_MS } from './config.js';

// Every palette class the day cycle can put on <body> — game.js clears these
// before applying the next one.
export const DAY_PHASE_CLASSES = ['biome-day', 'biome-sunset', 'biome-night', 'biome-storm'];

// Run-elapsed (ms) -> current day segment. Storm is terminal for now; the
// wrapping full cycle (dawn, then noon again) lands in the next commit.
export function dayPhaseFor(elapsed) {
    if (elapsed >= DAY_STORM_MS) return { id: 'storm', cssClass: 'biome-storm' };
    if (elapsed >= DAY_NIGHT_MS) return { id: 'night', cssClass: 'biome-night' };
    if (elapsed >= DAY_SUNSET_MS) return { id: 'sunset', cssClass: 'biome-sunset' };
    return { id: 'noon', cssClass: 'biome-day' };
}
