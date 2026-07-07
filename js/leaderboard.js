// === LEADERBOARD (client) ===
// Talks to /api/top and /api/score (Vercel serverless, see api/). The whole
// feature is self-hiding: the 🏆 button appears only after a successful
// probe of /api/top, so a deploy without the backend env (or any backend
// trouble) degrades to exactly the game we had before. Submissions go only
// from inside Telegram — initData is what the server validates.

import { state } from './state.js';
import { isInTelegram, tgInitData, tgUser } from './tg.js';
import { lbBtn, lbOverlay, lbListEl, lbMeEl, lbHintEl, lbCloseBtn } from './dom.js';
import { initAudio } from './audio.js';

const MEDALS = ['🥇', '🥈', '🥉'];

let backendAlive = false;
let aliveCbs = [];

function myUid() {
    const u = tgUser();
    return u && u.id ? String(u.id) : '';
}

// Other self-hiding features (battles) piggyback on the same single probe
// instead of firing their own: the callback runs once the backend answered,
// or immediately if it already did.
export function whenBackendAlive(cb) {
    if (backendAlive) {
        cb();
        return;
    }
    aliveCbs.push(cb);
}

// One probe at boot: backend alive -> show the 🏆 button.
export function probeLeaderboard() {
    fetch('/api/top')
        .then((r) => {
            if (!r.ok) return;
            backendAlive = true;
            lbBtn.style.display = '';
            aliveCbs.splice(0).forEach((cb) => cb());
        })
        .catch(() => { /* offline/сold backend — feature stays hidden */ });
}

// Fire-and-forget score submission from gameOver. The server only ever
// raises the stored best (ZADD GT), so submitting every run is fine.
export function submitScore(score) {
    if (!backendAlive || !isInTelegram() || !(score > 0)) return;
    try {
        fetch('/api/score', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ initData: tgInitData(), score }),
        }).catch(() => { /* best-effort */ });
    } catch (e) { /* ignore */ }
}

function rowHtml(entry, index) {
    const medal = MEDALS[index] || (index + 1) + '.';
    return '<li class="lb-row' + (entry.you ? ' you' : '') + '">'
        + '<span class="lb-rank">' + medal + '</span>'
        + '<span class="lb-name"></span>'
        + '<span class="lb-score">' + entry.score + '</span>'
        + '</li>';
}

function renderList(data) {
    const top = (data && data.top) || [];
    if (!top.length) {
        lbListEl.innerHTML = '';
        lbMeEl.innerText = 'Пока пусто — стань первым!';
        return;
    }
    lbListEl.innerHTML = top.map(rowHtml).join('');
    // Names go in via textContent — never innerHTML — they're user input.
    lbListEl.querySelectorAll('.lb-name').forEach((el, i) => {
        el.textContent = top[i].name;
    });
    const me = data.me;
    const inTop = top.some((e) => e.you);
    if (me && !inTop) {
        lbMeEl.innerText = 'Ты: #' + me.rank + ' · ' + me.score;
    } else if (!isInTelegram()) {
        lbMeEl.innerText = '';
    } else {
        lbMeEl.innerText = inTop ? 'Ты в топе! 🎉' : '';
    }
}

function openLeaderboard() {
    if (state.isPlaying) return;
    initAudio();
    lbListEl.innerHTML = '';
    lbMeEl.innerText = 'Загружаю…';
    lbHintEl.innerText = isInTelegram()
        ? ''
        : 'Играй в Telegram, чтобы попасть в топ';
    lbOverlay.classList.add('active');
    const uid = myUid();
    fetch('/api/top' + (uid ? '?uid=' + encodeURIComponent(uid) : ''))
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
            if (!data) {
                lbMeEl.innerText = 'Не получилось загрузить топ 😔';
                return;
            }
            renderList(data);
        })
        .catch(() => {
            lbMeEl.innerText = 'Не получилось загрузить топ 😔';
        });
}

export function initLeaderboard() {
    lbBtn.addEventListener('click', openLeaderboard);
    lbCloseBtn.addEventListener('click', () => lbOverlay.classList.remove('active'));
    probeLeaderboard();
}
