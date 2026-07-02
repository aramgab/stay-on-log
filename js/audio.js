// === AUDIO ===
// Synthesized sound effects via the Web Audio API (no asset files needed), plus
// an optional background music track loaded from audio/music.mp3 if present.
// Everything respects a persisted mute flag. The AudioContext is created lazily
// and resumed on the first user gesture (mobile browsers require this).

import { lsGet, lsSet } from './state.js';

let ctx = null;
let masterGain = null;
let noiseBuffer = null;
let musicEl = null;
let musicUnavailable = false; // set once the file is found missing, to stop retrying
let iosUnlocked = false; // set once the zero-gain unlock buffer has been played

export let isMuted = lsGet('stayOnLog_muted') === '1';

// Play a near-silent zero-length buffer once, inside a user gesture. This is
// the classic iOS Safari/WebKit trick to fully unlock audio output — resuming
// the context alone doesn't always get real sound flowing on iOS.
function unlockIOSAudio() {
    if (iosUnlocked || !ctx) return;
    iosUnlocked = true;
    try {
        const buffer = ctx.createBuffer(1, 1, 22050);
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        if (src.start) src.start(0);
        else if (src.noteOn) src.noteOn(0);
    } catch (e) { /* ignore */ }
}

// Lazily create the context (call from a user gesture, e.g. the Start tap).
// Safe to call from EVERY user gesture (tap-to-jump, how-to "Go", nickname
// save, mute toggle, Start): iOS can suspend/interrupt the context at any
// time (app switch, notification, phone call, silent-switch flip), so a
// single resume() at Start isn't enough — we need to re-resume on demand.
export function initAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!ctx) {
        if (!AC) return;
        ctx = new AC();
        masterGain = ctx.createGain();
        masterGain.gain.value = isMuted ? 0 : 1;
        masterGain.connect(ctx.destination);

        // Pre-build a short white-noise buffer for splash / hit textures.
        const len = Math.floor(ctx.sampleRate * 0.5);
        noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
        const data = noiseBuffer.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }

    // 'suspended' happens before first resume or after some backgrounding;
    // 'interrupted' is WebKit-specific (phone call, Siri, control center...).
    if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
        try {
            const p = ctx.resume();
            if (p && p.catch) p.catch(() => { /* ignore — will retry on next gesture */ });
        } catch (e) { /* ignore */ }
    }

    unlockIOSAudio();
}

// One-shot tone with an attack/decay envelope.
function tone(type, fromHz, toHz, dur, gain = 0.25) {
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(fromHz, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, toHz), now + dur);
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(gain, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(g);
    g.connect(masterGain);
    osc.start(now);
    osc.stop(now + dur + 0.02);
}

// Filtered noise burst (splash / impact texture).
function noise(dur, filterFrom, filterTo, gain = 0.3) {
    if (!ctx || !noiseBuffer) return;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(filterFrom, now);
    filter.frequency.exponentialRampToValueAtTime(Math.max(1, filterTo), now + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(filter);
    filter.connect(g);
    g.connect(masterGain);
    src.start(now);
    src.stop(now + dur + 0.02);
}

export const sfx = {
    jump() { tone('square', 320, 720, 0.18, 0.18); },
    hit() { tone('sawtooth', 280, 90, 0.25, 0.25); noise(0.18, 1800, 400, 0.18); },
    splash() { noise(0.5, 2400, 200, 0.35); },
    point() { tone('sine', 880, 1320, 0.12, 0.2); },
    // Combo reward: two quick rising notes; pitch climbs with the multiplier.
    combo(mult) {
        if (!ctx) return;
        const base = 880 * (1 + 0.12 * Math.min(mult, 8));
        tone('sine', base, base * 1.5, 0.1, 0.2);
        setTimeout(() => tone('sine', base * 1.25, base * 1.9, 0.12, 0.2), 90);
    },
    // Soft filtered-noise up-sweep for biome/scene transitions.
    whoosh() { noise(0.6, 300, 2800, 0.12); },
};

export const music = {
    start() {
        if (isMuted || musicUnavailable) return;
        if (!musicEl) {
            musicEl = new Audio('audio/music.mp3');
            musicEl.loop = true;
            musicEl.volume = 0.5;
            // No file yet → mark unavailable so we don't keep re-requesting it.
            musicEl.addEventListener('error', () => { musicUnavailable = true; }, { once: true });
        }
        const p = musicEl.play();
        if (p && p.catch) p.catch(() => { /* missing file / autoplay block */ });
    },
    stop() {
        if (musicEl) {
            musicEl.pause();
            musicEl.currentTime = 0;
        }
    },
};

export function toggleMute() {
    isMuted = !isMuted;
    lsSet('stayOnLog_muted', isMuted ? '1' : '0');
    if (masterGain) masterGain.gain.value = isMuted ? 0 : 1;
    if (isMuted) music.stop();
    return isMuted;
}
