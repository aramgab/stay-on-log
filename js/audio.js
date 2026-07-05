// === AUDIO ===
// Synthesized sound effects AND a fully procedural background soundtrack, both
// via the Web Audio API — no asset files anywhere in this project. The music
// mood (tempo, scale, root note, texture density) follows the current biome.
// Everything respects a persisted mute flag. The AudioContext is created lazily
// and resumed on the first user gesture (mobile browsers require this).

import { lsGet, lsSet, state } from './state.js';

let ctx = null;
let masterGain = null;
let musicGain = null; // separate bus so the soundtrack stays under the SFX
let noiseBuffer = null;
let iosUnlocked = false; // set once the zero-gain unlock buffer has been played
let sessionPromoted = false; // set once the audio session is 'playback' (see below)
let silentEl = null; // kept referenced so the looping promoter element isn't GC'd

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

// iOS (Safari and Telegram's WKWebView alike) routes Web Audio through the
// "ambient" audio session, which the ringer/silent switch mutes — haptics keep
// working while every sound silently dies (the July-2026 playtest symptom:
// "на телефоне звука нет, вибрации есть"). Games are expected to keep playing
// (we ship our own mute button), so promote the session to "playback", which
// the switch does not affect. Two mechanisms, tried in order:
//  1. the modern AudioSession API (WebKit 17+): navigator.audioSession.type;
//  2. a looping <audio> element whose CONTENT is silence — merely having an
//     active media element flips the session category as a side effect.
function promotePlaybackSession() {
    if (sessionPromoted) return;
    try {
        if (navigator.audioSession && 'type' in navigator.audioSession) {
            navigator.audioSession.type = 'playback';
            sessionPromoted = true;
            return;
        }
    } catch (e) { /* fall through to the element trick */ }
    try {
        if (!silentEl) {
            silentEl = document.createElement('audio');
            silentEl.setAttribute('playsinline', '');
            silentEl.loop = true;
            // Minimal valid WAV, 16 zero samples — pure silence.
            silentEl.src = 'data:audio/wav;base64,UklGRkQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
        }
        const p = silentEl.play();
        if (p && p.then) p.then(() => { sessionPromoted = true; }).catch(() => { /* retry next gesture */ });
        else sessionPromoted = true;
    } catch (e) { /* ignore — retry on the next gesture */ }
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

        // Music bus: scales the whole soundtrack down relative to SFX, sits
        // in front of masterGain so mute silences both in one place.
        musicGain = ctx.createGain();
        musicGain.gain.value = 1;
        musicGain.connect(masterGain);

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
    promotePlaybackSession();
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
    // Coin pickup: a short bright double-blip, higher than point() so a
    // clear+coin in the same second still read as two different rewards.
    coin() {
        tone('sine', 1320, 1760, 0.07, 0.16);
        setTimeout(() => tone('sine', 1760, 2093, 0.09, 0.14), 60);
    },
};

// === PROCEDURAL MUSIC ===
// A tiny generative backing track: a 4-bar chord loop (scale-degree
// progression) with a bass note, an arpeggio "pluck" and a soft pad layer,
// all synthesized live. Mood (tempo/scale/root/density) swaps per biome
// without ever restarting the scheduler — each scheduled step just reads
// whatever the current mood is at that instant.
const MOODS = {
    'biome-day':    { bpm: 96,  root: 262, scale: [0, 2, 4, 7, 9],  arpDensity: 0.5,  bassSteps: [0, 4] },
    'biome-sunset': { bpm: 88,  root: 233, scale: [0, 2, 4, 7, 9],  arpDensity: 0.4,  bassSteps: [0, 4] },
    'biome-night':  { bpm: 76,  root: 220, scale: [0, 3, 5, 7, 10], arpDensity: 0.25, bassSteps: [0] },
    'biome-storm':  { bpm: 116, root: 196, scale: [0, 3, 5, 6, 10], arpDensity: 0.6,  bassSteps: [0, 2, 4, 6] },
};
const DEFAULT_MOOD = 'biome-day';

// Chord progression expressed as scale-degree indices (into the current
// mood's `scale`), one chord per bar, looping every 4 bars.
const PROGRESSION = [0, 5 % 5, 3 % 5, 4 % 5]; // -> [0, 0, 3, 4] within a 5-note scale

const SCHEDULE_AHEAD = 0.3;   // schedule notes up to this far into the future (s)
const SCHEDULER_INTERVAL = 125; // lookahead tick (ms)

function noteFreq(root, scale, degree, octaveShift = 0) {
    const scaleLen = scale.length;
    const octave = Math.floor(degree / scaleLen) + octaveShift;
    const semitone = scale[((degree % scaleLen) + scaleLen) % scaleLen];
    return root * Math.pow(2, octave) * Math.pow(2, semitone / 12);
}

// Short plucked/percussive voice (bass, arpeggio).
function playVoice(type, freq, startAt, dur, peakGain) {
    if (!ctx || !musicGain) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, startAt);
    g.gain.setValueAtTime(0, startAt);
    g.gain.linearRampToValueAtTime(peakGain, startAt + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, startAt + dur);
    osc.connect(g);
    g.connect(musicGain);
    osc.start(startAt);
    osc.stop(startAt + dur + 0.02);
}

// Long soft pad: two sines (root + fifth), slow attack/release, sustained
// for a whole bar.
function playPad(root, fifthFreq, startAt, dur, peakGain) {
    if (!ctx || !musicGain) return;
    [root, fifthFreq].forEach((freq) => {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, startAt);
        g.gain.setValueAtTime(0, startAt);
        g.gain.linearRampToValueAtTime(peakGain, startAt + dur * 0.3);
        g.gain.linearRampToValueAtTime(0.0001, startAt + dur);
        osc.connect(g);
        g.connect(musicGain);
        osc.start(startAt);
        osc.stop(startAt + dur + 0.02);
    });
}

export const music = (function () {
    let schedulerId = null;
    let currentMood = DEFAULT_MOOD;
    let nextStepTime = 0; // ctx.currentTime target for the next eighth-note
    let stepIndex = 0;    // 0..7 within the current bar (8 eighth-notes/bar)
    let barIndex = 0;     // 0..3 within the 4-bar progression loop

    function scheduleStep(mood, time) {
        const chordDegree = PROGRESSION[barIndex % PROGRESSION.length];

        // Bass: root of the current chord, low octave, on this mood's bass steps.
        if (mood.bassSteps.includes(stepIndex)) {
            const freq = noteFreq(mood.root, mood.scale, chordDegree, -1);
            playVoice('triangle', freq, time, 0.22, 0.07);
        }

        // Arpeggio: random chance per step, random scale note 1-2 octaves up.
        if (Math.random() < mood.arpDensity) {
            const degree = chordDegree + Math.floor(Math.random() * 3) * 2; // spread across the chord/scale
            const octaveShift = Math.random() < 0.5 ? 1 : 2;
            const freq = noteFreq(mood.root, mood.scale, degree, octaveShift - 1);
            playVoice('sine', freq, time, 0.15, 0.035);
        }

        // Pad: once per bar (on step 0), root + fifth, sustained the whole bar.
        if (stepIndex === 0) {
            const barDur = (60 / mood.bpm) * 4; // 4 beats/bar in seconds
            const rootFreq = noteFreq(mood.root, mood.scale, chordDegree, 0);
            const fifthFreq = noteFreq(mood.root, mood.scale, chordDegree + 2, 0);
            playPad(rootFreq, fifthFreq, time, barDur, 0.02);
        }
    }

    function advance(mood) {
        const eighthDur = (60 / mood.bpm) / 2; // one eighth-note, seconds
        nextStepTime += eighthDur;
        stepIndex++;
        if (stepIndex >= 8) {
            stepIndex = 0;
            barIndex = (barIndex + 1) % PROGRESSION.length;
        }
    }

    function tick() {
        if (!ctx) return;
        while (nextStepTime < ctx.currentTime + SCHEDULE_AHEAD) {
            const mood = MOODS[currentMood] || MOODS[DEFAULT_MOOD];
            scheduleStep(mood, nextStepTime);
            advance(mood);
        }
    }

    return {
        start() {
            if (isMuted || !ctx || schedulerId) return;
            stepIndex = 0;
            barIndex = 0;
            nextStepTime = ctx.currentTime + 0.05;
            tick();
            schedulerId = setInterval(tick, SCHEDULER_INTERVAL);
        },
        stop() {
            if (schedulerId) {
                clearInterval(schedulerId);
                schedulerId = null;
            }
            // Long pad notes are left to ring out / are already ramping to
            // silence on their own envelopes — no hard cutoff needed.
        },
        setMood(biomeClass) {
            currentMood = MOODS[biomeClass] ? biomeClass : DEFAULT_MOOD;
        },
    };
})();

export function toggleMute() {
    isMuted = !isMuted;
    lsSet('stayOnLog_muted', isMuted ? '1' : '0');
    if (masterGain) masterGain.gain.value = isMuted ? 0 : 1;
    if (isMuted) {
        music.stop();
    } else if (state.isPlaying) {
        music.start();
    }
    return isMuted;
}
