// === BOSS FIGHTS (campaign) ===
// One boss per biome, living in the storm segment of the day cycle: once the
// day cycle crosses into 'storm' (js/biomes.js dayPhaseFor), a beat later the
// boss surfaces with an intro banner, then runs a scripted series of
// telegraphed attacks. Surviving the whole script = victory; getting hit
// costs 1 hp via the same registerHit path as obstacles (game.js routes it).
//
// No imports from game.js/obstacles.js/coins.js — they import US, and a
// cycle back would break the module graph. Purely: state.js, config.js,
// biomes.js, campaign.js, dom.js, audio.js, haptics.js.

import { state } from './state.js';
import {
    BOSS_INTRO_DELAY_MS,
    BOSS_INTRO_MS,
    BOSS_TELEGRAPH_MS,
    BOSS_STRIKE_MS,
    BOSS_ATTACK_GAP_MS,
    BOSS_LUNGE_SAFE_DEG,
    BOSS_CHASE_MS,
    BOSS_CHASE_FACTOR_MAX,
    BOSS_SNAP_EVERY_MS,
    BOSS_SNAP_TELEGRAPH_MS,
    BOSS_SNAP_STRIKE_MS,
    DAY_STORM_MS,
    DAY_CYCLE_MS,
} from './config.js';
import { dayPhaseFor, cycleOf, bossFor, BOSSES } from './biomes.js';
import { getSelectedBiome } from './campaign.js';
import { bossLayer, bossHintEl } from './dom.js';
import { sfx } from './audio.js';
import { hapticTick } from './haptics.js';

// Module state machine: 'idle' -> 'intro' -> 'fight' -> 'idle' (victory) or
// stays 'fight' across a gameOver/revive (see bossHide/bossResume).
let mode = 'idle';
let lastCycleFought = -1; // cycleOf(elapsed) value the boss already ran for
let t = 0;                // ms elapsed in the current intro/attack phase
let attackIx = 0;
let script = [];
let sideResolved = 0;         // -1 | 0 | 1: the side a lunge actually rolled to
let struckThisAttack = false; // guards one hit per attack
let strikeShown = false;      // visuals for the strike phase applied once
let biteChecked = false;      // the single-instant bite check has run

// fightKind picks which engine drives the 'fight' mode: the scripted
// telegraph/strike pattern above (shark et al.) or the endurance chase below
// (orca). lastBossId/layerVariant persist past endFight on purpose — the
// victory handler (game.js) and the farewell line both read them after the
// fight has already moved back to 'idle'.
let fightKind = 'pattern'; // 'pattern' | 'chase'
let lastBossId = '';       // id of the boss that is fighting / just fought
let layerVariant = '';     // per-boss CSS class riding alongside the state class
let snapState = 0;         // 0 none / 1 telegraph / 2 strike (chase-only)
let snapT = 0;              // ms elapsed in the current snap phase
let nextSnapAt = 0;         // t (chase clock) at which the next snap begins
let snapChecked = false;    // the single-instant snap check has run

// The shark script: 7 scripted attacks, telegraphed then struck, with a
// breather between. Side 0 on a lunge = rolled randomly at telegraph time.
const SHARK_SCRIPT = [
    { kind: 'lunge', side: -1 },
    { kind: 'lunge', side: 1 },
    { kind: 'bite' },
    { kind: 'lunge', side: 0 },   // 0 = roll a random side at telegraph time
    { kind: 'bite' },
    { kind: 'lunge', side: 0, gapAfter: 900 }, // finale: lunge then a quick bite
    { kind: 'bite' },
];

function setLayer(cls) {
    bossLayer.className = layerVariant ? cls + ' ' + layerVariant : cls;
}

// beginTelegraph: set up the visuals/hint for one attack's warning phase.
function beginTelegraph(atk) {
    if (atk.kind === 'lunge') {
        sideResolved = atk.side !== 0 ? atk.side : (Math.random() < 0.5 ? -1 : 1);
        setLayer(sideResolved === -1 ? 'on tele-left' : 'on tele-right');
        bossHintEl.innerText = sideResolved === -1 ? '➡ УЙДИ ВПРАВО!' : '⬅ УЙДИ ВЛЕВО!';
    } else {
        setLayer('on tele-bite');
        bossHintEl.innerText = '⬆ ПРЫГАЙ!';
    }
    sfx.whoosh();
    hapticTick();
}

// Swap telegraph visuals for strike visuals (layer keeps 'on').
function beginStrike(atk) {
    if (atk.kind === 'lunge') {
        setLayer(sideResolved === -1 ? 'on strike-left' : 'on strike-right');
        sfx.splash();
    } else {
        setLayer('on strike-bite');
        sfx.whoosh();
    }
}

function endFight() {
    mode = 'idle'; // lastCycleFought already set at intro start
    setLayer('on victory');
    bossHintEl.innerText = (BOSSES[lastBossId] ? BOSSES[lastBossId].emoji + ' ' : '') + 'ПОБЕДА! Хищник отступил';
    document.body.classList.remove('boss-fight');
    // A stray timeout landing after showCountdown's bossReset is harmless —
    // reset already clears the same classList/text.
    setTimeout(() => {
        bossLayer.className = '';
        bossHintEl.innerText = '';
    }, 1800);
}

export function isBossActive() {
    return mode !== 'idle';
}

// Full reset — called from showCountdown (new run / restart).
export function bossReset() {
    mode = 'idle';
    lastCycleFought = -1;
    t = 0;
    attackIx = 0;
    script = [];
    sideResolved = 0;
    struckThisAttack = false;
    strikeShown = false;
    biteChecked = false;
    fightKind = 'pattern';
    lastBossId = '';
    layerVariant = '';
    snapState = 0;
    snapT = 0;
    nextSnapAt = 0;
    snapChecked = false;
    bossLayer.className = '';
    bossHintEl.innerText = '';
    document.body.classList.remove('boss-fight');
}

// Death screen: fade the layer out, but preserve all state (mode/attackIx/t)
// so a revive can pick the fight back up exactly where it left off.
export function bossHide() {
    bossLayer.classList.add('hidden');
}

// Revive: bring the layer back and restart the CURRENT beat from its top —
// mid-strike is never a fair resume point, so a fight always resumes at a
// fresh telegraph (or the intro replays from 0 if we died during it).
export function bossResume() {
    bossLayer.classList.remove('hidden');
    if (mode === 'fight' && fightKind === 'chase') {
        // Chase progress (t) is fair to preserve — it's an endurance clock,
        // not a mid-strike snapshot — but the CURRENT snap always restarts
        // clean, same fairness rule as the pattern path below.
        snapState = 0;
        snapT = 0;
        snapChecked = false;
        nextSnapAt = t + BOSS_SNAP_EVERY_MS;
        setLayer('on chase');
        bossHintEl.innerText = '🐋 ДЕРЖИСЬ!';
    } else if (mode === 'fight') {
        t = 0;
        struckThisAttack = false;
        strikeShown = false;
        biteChecked = false;
        beginTelegraph(script[attackIx]);
    } else if (mode === 'intro') {
        t = 0;
    }
}

// Advance the boss for this frame. Returns null | 'hit' | 'victory'.
export function stepBoss(dtMs, normPos) {
    if (mode === 'idle') {
        const dp = dayPhaseFor(state.elapsed);
        if (dp.id !== 'storm') return null;
        const cyc = cycleOf(state.elapsed);
        if (cyc === lastCycleFought) return null;
        const tInStorm = (state.elapsed % DAY_CYCLE_MS) - DAY_STORM_MS;
        if (tInStorm < BOSS_INTRO_DELAY_MS) return null;
        const boss = bossFor(getSelectedBiome());
        if (!boss) { lastCycleFought = cyc; return null; }

        mode = 'intro';
        lastCycleFought = cyc;
        lastBossId = boss.id;
        layerVariant = boss.id === 'orca' ? 'orca' : '';
        fightKind = boss.id === 'orca' ? 'chase' : 'pattern';
        t = 0;
        setLayer('on intro');
        bossHintEl.innerText = boss.emoji + ' ' + boss.title + '!';
        sfx.whoosh();
        hapticTick();
        document.body.classList.add('boss-fight'); // hides ambient fins via CSS
        return null;
    }

    if (mode === 'intro') {
        t += dtMs;
        if (t >= BOSS_INTRO_MS) {
            mode = 'fight';
            t = 0;
            if (fightKind === 'chase') {
                snapState = 0;
                snapT = 0;
                nextSnapAt = BOSS_SNAP_EVERY_MS;
                setLayer('on chase');
                bossHintEl.innerText = '🐋 ДЕРЖИСЬ! Косатка догоняет!';
            } else {
                attackIx = 0;
                script = SHARK_SCRIPT.slice();
                beginTelegraph(script[0]);
            }
        }
        return null;
    }

    if (mode === 'fight' && fightKind === 'chase') {
        return stepChase(dtMs);
    }

    // mode === 'fight' (fightKind === 'pattern')
    t += dtMs;
    const atk = script[attackIx];
    const gap = atk.gapAfter != null ? atk.gapAfter : BOSS_ATTACK_GAP_MS;
    const strikeStart = BOSS_TELEGRAPH_MS;
    const strikeEnd = strikeStart + BOSS_STRIKE_MS;
    const total = strikeEnd + gap;

    if (t >= strikeStart && !strikeShown) {
        strikeShown = true;
        beginStrike(atk);
    }

    if (t >= strikeStart && t < strikeEnd && !struckThisAttack && !state.invulnerable) {
        if (atk.kind === 'lunge') {
            // Jumping does NOT save from a lunge — it bites the whole side
            // arc; only standing clear of that side does.
            if ((sideResolved === -1 && normPos < -BOSS_LUNGE_SAFE_DEG) ||
                (sideResolved === 1 && normPos > BOSS_LUNGE_SAFE_DEG)) {
                struckThisAttack = true;
                return 'hit';
            }
        } else {
            // bite: single-instant check at the strike midpoint — one
            // well-timed jump beats it, standing gets chomped once.
            if (!biteChecked && t >= strikeStart + BOSS_STRIKE_MS / 2) {
                biteChecked = true;
                if (!state.isJumping) {
                    struckThisAttack = true;
                    return 'hit';
                }
            }
        }
    }

    if (t >= total) {
        attackIx += 1;
        t = 0;
        struckThisAttack = false;
        strikeShown = false;
        biteChecked = false;
        if (attackIx >= script.length) {
            endFight();
            return 'victory';
        }
        beginTelegraph(script[attackIx]);
    }

    return null;
}

// Chase fight step (orca): no attack script — the world just accelerates
// (see bossSpeedFactor below, consumed by game.js) while the orca snaps at
// the player on a fixed timer. Surviving the whole clock is the win.
function stepChase(dtMs) {
    t += dtMs;
    if (snapState === 0 && t >= nextSnapAt && t < BOSS_CHASE_MS - BOSS_SNAP_STRIKE_MS) {
        snapState = 1;
        snapT = 0;
        snapChecked = false;
        setLayer('on chase tele-snap');
        bossHintEl.innerText = '⬆ ПРЫГАЙ!';
        sfx.whoosh();
        hapticTick();
    }
    if (snapState === 1) {
        snapT += dtMs;
        if (snapT >= BOSS_SNAP_TELEGRAPH_MS) {
            snapState = 2;
            snapT = 0;
            setLayer('on chase strike-snap');
            sfx.splash();
        }
    } else if (snapState === 2) {
        snapT += dtMs;
        // Single-instant check at the strike midpoint — one timed jump beats
        // the snap, standing gets chomped once (same rule as the shark bite).
        if (!snapChecked && snapT >= BOSS_SNAP_STRIKE_MS / 2) {
            snapChecked = true;
            if (!state.isJumping && !state.invulnerable) {
                endSnap();
                return 'hit';
            }
        }
        if (snapT >= BOSS_SNAP_STRIKE_MS) endSnap();
    }
    if (t >= BOSS_CHASE_MS) {
        endFight();
        return 'victory';
    }
    return null;
}

function endSnap() {
    snapState = 0;
    nextSnapAt = t + BOSS_SNAP_EVERY_MS;
    // snap-recover: css plays the dive-back, then the pursuit bob resumes.
    setLayer('on chase snap-recover');
    bossHintEl.innerText = '🐋 ДЕРЖИСЬ!';
}

// World-speed multiplier while the orca chases (1.0 otherwise). Ramps up
// linearly over the chase so the endurance test tightens toward the end.
export function bossSpeedFactor() {
    if (mode !== 'fight' || fightKind !== 'chase') return 1;
    return 1 + (BOSS_CHASE_FACTOR_MAX - 1) * Math.min(1, t / BOSS_CHASE_MS);
}

// The boss that is fighting / just fought — lastBossId deliberately survives
// endFight so the victory handler (game.js) and the farewell line can still
// read it after the fight has already moved back to 'idle'.
export function activeBossId() {
    return lastBossId;
}
