// === CAMPAIGN MAP ===
// The journey line: chapters of four biome cards each, all visible from day
// one. Cards tease what's ahead («?» mystery / named teaser / "скоро"
// announced world) and show quest checklists on locked-but-playable worlds.
// Same overlay idiom as js/shop.js — open/close, rebuild-on-open, no diffing.

import { state } from './state.js';
import { BIOMES, CHAPTERS, questsFor } from './biomes.js';
import { getSelectedBiome, setSelectedBiome, isBiomeUnlocked, questCount, cyclesOf } from './campaign.js';
import { initAudio, sfx } from './audio.js';
import { mapBtn, mapOverlay, mapListEl, mapCloseBtn } from './dom.js';

function openMap() {
    if (state.isPlaying) return;
    initAudio();
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

// One quest-checklist line for a locked world's unlocking biome, e.g.
// "Перепрыгни 5 сучков — 3/5" with a done class once n >= target.
function buildQuestsList(unlockBiomeId) {
    const wrap = document.createElement('div');
    wrap.className = 'map-quests';
    questsFor(unlockBiomeId).forEach((q) => {
        const n = Math.min(questCount(q.id), q.target);
        const line = document.createElement('div');
        const done = n >= q.target;
        if (done) line.classList.add('done');
        line.textContent = (done ? '✓ ' : '') + q.title + ' — ' + n + '/' + q.target;
        wrap.appendChild(line);
    });
    return wrap;
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
        if (b.unlock && b.unlock.questsOf) {
            card.appendChild(buildQuestsList(b.unlock.questsOf));
        }
        card.addEventListener('click', () => shakeCard(card));
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

    // Events section: slot only, data arrives with the first event.
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
