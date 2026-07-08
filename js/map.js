// === CAMPAIGN MAP ===
// The journey line: chapters of four biome cards each, all visible from day
// one. Cards tease what's ahead («?» mystery / named teaser / "скоро"
// announced world); tapping a locked-but-playable world shows a transient
// hint bubble pointing at the biome whose quests unlock it.
// Same overlay idiom as js/shop.js — open/close, rebuild-on-open, no diffing.

import { state } from './state.js';
import { BIOMES, CHAPTERS } from './biomes.js';
import { getSelectedBiome, setSelectedBiome, isBiomeUnlocked, cyclesOf } from './campaign.js';
import { initAudio, sfx } from './audio.js';
import { mapBtn, mapOverlay, mapListEl, mapCloseBtn } from './dom.js';
import { track } from './analytics.js';

let mapHintTimer = 0;

// Transient bubble at the top of the map card («выполни задания в …»).
function showMapHint(text) {
    let el = document.getElementById('map-hint');
    if (!el) {
        el = document.createElement('div');
        el.id = 'map-hint';
        document.getElementById('map-card').appendChild(el);
    }
    el.textContent = text;
    el.classList.add('visible');
    clearTimeout(mapHintTimer);
    mapHintTimer = setTimeout(() => el.classList.remove('visible'), 2000);
}

function openMap() {
    if (state.isPlaying) return;
    initAudio();
    track('feature_opened', { feature: 'map' });
    renderMap();
    mapOverlay.classList.add('active');
}

function closeMap() {
    mapOverlay.classList.remove('active');
}

// Locked-but-playable card: clicking it can't select the world, so give a
// small "no" shake instead of doing nothing.
function shakeCard(card) {
    card.classList.remove('shake');
    void card.offsetWidth; // restart the animation if it's already mid-shake
    card.classList.add('shake');
    card.addEventListener('animationend', function onEnd() {
        card.classList.remove('shake');
        card.removeEventListener('animationend', onEnd);
    });
}

function onSelectCard(biomeId) {
    setSelectedBiome(biomeId);
    sfx.point();
    updateMapBtnLabel();
    renderMap(); // refresh the selection ring
    closeMap();
}

function buildBiomeCard(biomeId) {
    const b = BIOMES[biomeId];
    const card = document.createElement('div');
    card.className = 'map-card-item';

    if (!b.playable) {
        // Announced: named card on the map, locked "скоро".
        card.classList.add('announced');
        const emoji = document.createElement('div');
        emoji.textContent = b.emoji;
        const title = document.createElement('div');
        title.textContent = b.title;
        const badge = document.createElement('div');
        badge.className = 'map-done';
        badge.textContent = 'скоро';
        card.appendChild(emoji);
        card.appendChild(title);
        card.appendChild(badge);
        return card;
    }

    const unlocked = isBiomeUnlocked(biomeId);
    const emoji = document.createElement('div');
    emoji.textContent = b.emoji;
    const title = document.createElement('div');
    title.textContent = b.title;
    card.appendChild(emoji);
    card.appendChild(title);

    if (unlocked) {
        if (getSelectedBiome() === biomeId) card.classList.add('selected');
        const cycles = cyclesOf(biomeId);
        if (cycles > 0) {
            const done = document.createElement('div');
            done.className = 'map-done';
            done.textContent = '✓ пройден ×' + cycles;
            card.appendChild(done);
        }
        card.addEventListener('click', () => onSelectCard(biomeId));
    } else {
        card.classList.add('locked');
        const lock = document.createElement('div');
        lock.className = 'map-done';
        lock.textContent = '🔒';
        card.appendChild(lock);
        card.addEventListener('click', () => {
            shakeCard(card);
            if (b.unlock && b.unlock.questsOf) {
                showMapHint('Выполни задания в биоме «' + BIOMES[b.unlock.questsOf].title + '»');
            } else {
                showMapHint('Скоро!');
            }
        });
    }
    return card;
}

function buildTeaserCard(name) {
    const card = document.createElement('div');
    card.className = 'map-card-item mystery';
    const q = document.createElement('div');
    q.textContent = '?';
    const title = document.createElement('div');
    title.textContent = name;
    card.appendChild(q);
    card.appendChild(title);
    return card;
}

function buildMysteryCard() {
    const card = document.createElement('div');
    card.className = 'map-card-item mystery';
    const q = document.createElement('div');
    q.textContent = '?';
    card.appendChild(q);
    return card;
}

function buildCard(cardValue) {
    if (cardValue === null) return buildMysteryCard();
    if (typeof cardValue === 'string' && BIOMES[cardValue]) return buildBiomeCard(cardValue);
    return buildTeaserCard(cardValue);
}

function renderMap() {
    mapListEl.innerHTML = '';

    // Events section first: slot only, data arrives with the first event.
    const eventsChapter = document.createElement('div');
    eventsChapter.className = 'map-chapter';
    const eventsTitle = document.createElement('div');
    eventsTitle.className = 'map-chapter-title';
    eventsTitle.textContent = '⚽ События';
    const eventsRow = document.createElement('div');
    eventsRow.className = 'map-cards';
    const eventCard = document.createElement('div');
    eventCard.className = 'map-card-item map-event announced';
    eventCard.textContent = 'Скоро: событийные миры';
    eventsRow.appendChild(eventCard);
    eventsChapter.appendChild(eventsTitle);
    eventsChapter.appendChild(eventsRow);
    mapListEl.appendChild(eventsChapter);

    CHAPTERS.forEach((chapter) => {
        const chapterEl = document.createElement('div');
        chapterEl.className = 'map-chapter';
        const titleEl = document.createElement('div');
        titleEl.className = 'map-chapter-title';
        titleEl.textContent = chapter.title;
        const rowEl = document.createElement('div');
        rowEl.className = 'map-cards';
        chapter.cards.forEach((cardValue) => rowEl.appendChild(buildCard(cardValue)));
        chapterEl.appendChild(titleEl);
        chapterEl.appendChild(rowEl);
        mapListEl.appendChild(chapterEl);
    });
}

export function updateMapBtnLabel() {
    const b = BIOMES[getSelectedBiome()];
    mapBtn.innerText = '🗺 ' + b.emoji + ' ' + b.title;
}

export function initMap() {
    mapBtn.addEventListener('click', openMap);
    mapCloseBtn.addEventListener('click', closeMap);
    updateMapBtnLabel();
}
