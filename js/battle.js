// === CHAT BATTLES (client) ===
// Chat vs chat: one challenge link, teams auto-formed by chat_instance
// server-side, 24h window, team score = sum of every member's every run.
// Self-hiding like the leaderboard: the ⚔️ button appears only inside
// Telegram AND after the backend probe answered (whenBackendAlive).
//
// The player's active battle lives in localStorage as the UI's source of
// truth; the server keeps its own bt:u pointer purely as an anti-spam
// "one battle per user" guard. Shape:
//   stayOnLog_activeBattle = JSON { id, side, ends, nameA, nameB, scoreA,
//                                   scoreB, myTotal, canRename?, finished? }

import { state, lsGet, lsSet } from './state.js';
import { isInTelegram, tgInitData, tgUser, tgStartParam, shareScore } from './tg.js';
import { battleBtn, battleBadge, battleOverlay, battleCloseBtn } from './dom.js';
import { whenBackendAlive } from './leaderboard.js';
import { initAudio } from './audio.js';
import { SHARE_URL, BATTLE_POLL_MS, BATTLE_SHARE_FOE_TEXT, BATTLE_SHARE_OWN_TEXT } from './config.js';

const LS_KEY = 'stayOnLog_activeBattle';

// --- data core -------------------------------------------------------------

export function getActiveBattle() {
    try {
        const raw = lsGet(LS_KEY);
        if (!raw) return null;
        const b = JSON.parse(raw);
        return b && b.id ? b : null;
    } catch (e) {
        return null;
    }
}

export function setActiveBattle(b) {
    lsSet(LS_KEY, JSON.stringify(b));
}

export function clearActiveBattle() {
    lsSet(LS_KEY, '');
}

// Merge fresh server numbers into the stored battle (badge/overlay read it).
export function cacheBattleScores(patch) {
    const b = getActiveBattle();
    if (!b) return null;
    const merged = Object.assign(b, patch);
    setActiveBattle(merged);
    return merged;
}

// POST helper for api/battle.js ops. Resolves to the parsed JSON with the
// HTTP status attached (callers branch on flags, not exceptions).
export function battleApi(op, payload) {
    return fetch('/api/battle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ op, initData: tgInitData() }, payload)),
    }).then((r) => r.json().then((data) => {
        data.httpStatus = r.status;
        return data;
    }));
}

export function battleState(id, uid) {
    const q = '/api/battle?op=state&id=' + encodeURIComponent(id) +
        (uid ? '&uid=' + encodeURIComponent(uid) : '');
    return fetch(q).then((r) => r.json().then((data) => {
        data.httpStatus = r.status;
        return data;
    }));
}

// Fire-and-forget from gameOver (same contract as leaderboard submitScore):
// every game over of a run submits (runId, score); the server only counts
// the positive delta per runId, so the second game over after a revive adds
// the growth, never a double. Guards keep it a no-op without an active
// battle, outside Telegram, or past the battle window.
export function submitBattleScore(runId, score) {
    const b = getActiveBattle();
    if (!b || b.finished || !isInTelegram() || !(score > 0) || !runId) return;
    if (b.ends && Date.now() > b.ends) return;
    battleApi('submit', { id: b.id, runId, score })
        .then((resp) => {
            if (resp.finished || resp.httpStatus === 410) {
                cacheBattleScores({ finished: true });
            } else if (resp.ok) {
                cacheBattleScores({
                    scoreA: resp.scoreA,
                    scoreB: resp.scoreB,
                    myTotal: resp.myTotal != null ? resp.myTotal : b.myTotal,
                });
            }
            updateBadge();
        })
        .catch(() => { /* best-effort, like the leaderboard */ });
}

// --- UI --------------------------------------------------------------------
// Section elements are private to the feature, so they're resolved here
// rather than ballooning dom.js (modules are deferred — DOM is parsed).

const el = (id) => document.getElementById(id);
const secNone = el('bt-none');
const secJoin = el('bt-join');
const secSide = el('bt-side');
const secName = el('bt-name');
const secMain = el('bt-main');
const createNameInput = el('bt-create-name');
const createBtn = el('bt-create');
const joinTitle = el('bt-join-title');
const joinScore = el('bt-join-score');
const joinGoBtn = el('bt-join-go');
const sideABtn = el('bt-side-a');
const sideBBtn = el('bt-side-b');
const nameInput = el('bt-name-input');
const nameSaveBtn = el('bt-name-save');
const teamAEl = el('bt-team-a');
const teamBEl = el('bt-team-b');
const timerEl = el('bt-timer');
const verdictEl = el('bt-verdict');
const mineEl = el('bt-mine');
const renameLink = el('bt-rename');
const listA = el('bt-list-a');
const listB = el('bt-list-b');
const shareRow = el('bt-share-row');
const shareFoeBtn = el('bt-share-foe');
const shareOwnBtn = el('bt-share-own');
const newBtn = el('bt-new');
const msgEl = el('bt-msg');

let pollTimer = 0;
let tickTimer = 0;
let serverOffset = 0; // resp.now - Date.now(); trusts the server clock
let pendingJoinId = ''; // set by the boot deep-link routing before opening

function myUid() {
    const u = tgUser();
    return u && u.id ? String(u.id) : '';
}

function fmtShort(n) {
    n = Number(n) || 0;
    return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'к' : String(n);
}

function setMsg(text) {
    msgEl.textContent = text || '';
}

function showState(which) {
    [secNone, secJoin, secSide, secName, secMain].forEach((s) => s.classList.remove('on'));
    setMsg('');
    if (which === 'none') secNone.classList.add('on');
    else if (which === 'join') secJoin.classList.add('on');
    else if (which === 'side') secSide.classList.add('on');
    else if (which === 'name') secName.classList.add('on');
    else if (which === 'main') secMain.classList.add('on');
}

export function updateBadge() {
    const b = getActiveBattle();
    if (!b || b.finished || b.side !== 'A' && b.side !== 'B') {
        battleBadge.textContent = '';
        battleBadge.classList.remove('on');
        return;
    }
    const mine = b.side === 'A' ? b.scoreA : b.scoreB;
    const foe = b.side === 'A' ? b.scoreB : b.scoreA;
    battleBadge.textContent = fmtShort(mine) + ':' + fmtShort(foe);
    battleBadge.classList.add('on');
}

function stopTimers() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = 0; }
    if (tickTimer) { clearInterval(tickTimer); tickTimer = 0; }
}

function fmtRemaining(ms) {
    if (ms <= 0) return '0:00:00';
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
}

function startTicker(ends) {
    if (tickTimer) clearInterval(tickTimer);
    const tick = () => {
        const left = ends - (Date.now() + serverOffset);
        timerEl.textContent = left > 0 ? '⏳ ' + fmtRemaining(left) : '⏳ бой окончен';
        if (left <= 0 && tickTimer) {
            clearInterval(tickTimer);
            tickTimer = 0;
            refreshState(); // flips the view to the verdict
        }
    };
    tick();
    tickTimer = setInterval(tick, 1000);
}

function contribRow(entry) {
    const li = document.createElement('li');
    li.className = 'bt-row' + (entry.you ? ' you' : '');
    const name = document.createElement('span');
    name.className = 'bt-row-name';
    name.textContent = entry.name; // user input — textContent only
    const score = document.createElement('span');
    score.className = 'bt-row-score';
    score.textContent = entry.score;
    li.appendChild(name);
    li.appendChild(score);
    return li;
}

function renderMain(resp) {
    const b = getActiveBattle();
    const side = b && b.id === resp.id ? b.side : '';
    showState('main');

    teamAEl.querySelector('.bt-team-name').textContent = resp.nameA;
    teamBEl.querySelector('.bt-team-name').textContent = resp.nameB;
    teamAEl.querySelector('.bt-team-score').textContent = resp.scoreA;
    teamBEl.querySelector('.bt-team-score').textContent = resp.scoreB;
    teamAEl.classList.toggle('mine', side === 'A');
    teamBEl.classList.toggle('mine', side === 'B');

    listA.textContent = '';
    listB.textContent = '';
    (resp.topA || []).forEach((e) => listA.appendChild(contribRow(e)));
    (resp.topB || []).forEach((e) => listB.appendChild(contribRow(e)));

    mineEl.textContent = resp.me ? 'Твой вклад: ' + resp.me.score + ' 🪵' : '';

    const finished = Boolean(resp.finished);
    verdictEl.textContent = '';
    verdictEl.className = '';
    if (finished) {
        timerEl.textContent = '';
        if (!side || resp.winner === 'draw') {
            verdictEl.textContent = resp.winner === 'draw' ? '🤝 НИЧЬЯ' : '🏁 Битва завершена';
        } else {
            const won = resp.winner === side;
            verdictEl.textContent = won ? '🏆 ПОБЕДА!' : '💀 ПОРАЖЕНИЕ';
            verdictEl.className = won ? 'won' : 'lost';
        }
    } else {
        startTicker(resp.ends);
    }

    shareRow.style.display = finished || !side ? 'none' : '';
    newBtn.style.display = finished ? '' : 'none';

    const myTeamScore = side === 'A' ? resp.scoreA : side === 'B' ? resp.scoreB : 1;
    renameLink.style.display = b && b.canRename && myTeamScore === 0 && !finished ? '' : 'none';
}

function refreshState() {
    const b = getActiveBattle();
    if (!b) return;
    battleState(b.id, myUid())
        .then((resp) => {
            if (resp.httpStatus === 404) {
                // The battle expired out of the store — let go.
                clearActiveBattle();
                updateBadge();
                if (battleOverlay.classList.contains('active')) showState('none');
                return;
            }
            if (!resp.ends) return;
            serverOffset = resp.now ? resp.now - Date.now() : 0;
            cacheBattleScores({
                ends: resp.ends,
                nameA: resp.nameA,
                nameB: resp.nameB,
                scoreA: resp.scoreA,
                scoreB: resp.scoreB,
                myTotal: resp.me ? resp.me.score : (b.myTotal || 0),
                finished: Boolean(resp.finished),
            });
            updateBadge();
            if (battleOverlay.classList.contains('active')) renderMain(resp);
            if (resp.finished) stopTimers();
        })
        .catch(() => { /* poll again later */ });
}

function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
        const b = getActiveBattle();
        if (!b || b.finished || !battleOverlay.classList.contains('active')) {
            stopTimers();
            return;
        }
        refreshState();
    }, BATTLE_POLL_MS);
}

function adoptBattle(id, side, resp, canRename) {
    setActiveBattle({
        id,
        side,
        ends: resp.ends || 0,
        nameA: resp.nameA || 'Команда А',
        nameB: resp.nameB || 'Команда Б',
        scoreA: resp.scoreA || 0,
        scoreB: resp.scoreB || 0,
        myTotal: 0,
        canRename: Boolean(canRename),
    });
    updateBadge();
}

function createBattle() {
    setMsg('Создаю…');
    battleApi('create', { name: createNameInput.value })
        .then((resp) => {
            if (resp.httpStatus === 409 && resp.id) {
                // Already fighting somewhere — open that battle instead.
                setActiveBattle({ id: resp.id, side: '', myTotal: 0 });
                refreshState();
                showState('main');
                setMsg('У тебя уже есть активная битва — вот она.');
                return;
            }
            if (!resp.ok) {
                setMsg('Не получилось создать 😔 Попробуй ещё раз.');
                return;
            }
            adoptBattle(resp.id, 'A', resp, true);
            refreshState();
            showState('main');
            startPolling();
            setMsg(resp.ciBound
                ? 'Команда привязана к этому чату. Зови своих и вызывай врагов!'
                : 'Открой «Клич своим» из своего чата — команда привяжется к нему.');
        })
        .catch(() => setMsg('Сеть молчит 😔'));
}

function joinBattle(id, side) {
    setMsg('Вступаю…');
    battleApi('join', { id, side })
        .then((resp) => {
            if (resp.needSide) {
                sideABtn.textContent = resp.nameA || 'Команда А';
                sideBBtn.textContent = resp.nameB || 'Команда Б';
                sideABtn.dataset.id = id;
                sideBBtn.dataset.id = id;
                showState('side');
                return;
            }
            if (resp.httpStatus === 409 && resp.error === 'already_in_battle' && resp.id) {
                setActiveBattle({ id: resp.id, side: '', myTotal: 0 });
                refreshState();
                showState('main');
                setMsg('Ты уже в другой битве — сначала она.');
                return;
            }
            if (resp.httpStatus === 410 || resp.finished) {
                setMsg('Эта битва уже завершена: ' +
                    (resp.nameA || 'А') + ' ' + (resp.scoreA || 0) + ' : ' +
                    (resp.scoreB || 0) + ' ' + (resp.nameB || 'Б'));
                showState('none');
                return;
            }
            if (!resp.ok) {
                setMsg(resp.httpStatus === 404 ? 'Битва не найдена — ссылка устарела.' : 'Не получилось вступить 😔');
                showState('none');
                return;
            }
            adoptBattle(id, resp.side, resp, resp.youNameIt);
            if (resp.youNameIt) {
                nameInput.value = resp.side === 'A' ? (resp.nameA || 'Команда А') : (resp.nameB || 'Команда Б');
                showState('name');
            } else {
                refreshState();
                showState('main');
                startPolling();
            }
        })
        .catch(() => setMsg('Сеть молчит 😔'));
}

function renameTeam() {
    const b = getActiveBattle();
    if (!b) return;
    setMsg('Сохраняю…');
    battleApi('rename', { id: b.id, name: nameInput.value })
        .then((resp) => {
            if (resp.ok) {
                cacheBattleScores({ nameA: resp.nameA, nameB: resp.nameB });
                refreshState();
                showState('main');
                startPolling();
                setMsg('');
            } else {
                setMsg(resp.error === 'locked' ? 'Уже нельзя — команда в бою.' : 'Не вышло 😔');
                refreshState();
                showState('main');
                startPolling();
            }
        })
        .catch(() => setMsg('Сеть молчит 😔'));
}

function shareBattle(text) {
    const b = getActiveBattle();
    if (!b) return;
    const method = shareScore(text, SHARE_URL + '?startapp=b_' + b.id);
    if (method === 'copy') setMsg('Ссылка скопирована!');
}

// Deep-link routing hook: the boot code (initBattle) parses start_param and
// stores the challenge id here, so opening the overlay lands on the join
// confirmation instead of the default view.
export function setPendingJoin(id) {
    pendingJoinId = id;
}

function renderJoinConfirm(id) {
    showState('join');
    joinTitle.textContent = 'Загружаю вызов…';
    joinScore.textContent = '';
    joinGoBtn.dataset.id = id;
    battleState(id, myUid())
        .then((resp) => {
            if (!resp.ends) {
                setMsg('Битва не найдена — ссылка устарела.');
                showState('none');
                return;
            }
            joinTitle.textContent = '«' + resp.nameA + '» против «' + resp.nameB + '»';
            joinScore.textContent = resp.scoreA + ' : ' + resp.scoreB;
            if (resp.finished) {
                setMsg('Эта битва уже завершена.');
                joinGoBtn.style.display = 'none';
            } else {
                joinGoBtn.style.display = '';
            }
        })
        .catch(() => setMsg('Сеть молчит 😔'));
}

function openBattle() {
    if (state.isPlaying) return;
    initAudio();
    battleOverlay.classList.add('active');
    const b = getActiveBattle();
    if (pendingJoinId && (!b || b.id !== pendingJoinId)) {
        renderJoinConfirm(pendingJoinId);
        pendingJoinId = '';
        return;
    }
    pendingJoinId = '';
    if (b) {
        showState('main');
        refreshState();
        if (!b.finished) startPolling();
    } else {
        createNameInput.value = '';
        showState('none');
    }
}

function closeBattle() {
    battleOverlay.classList.remove('active');
    stopTimers();
}

export function isBattleOverlayOpen() {
    return battleOverlay.classList.contains('active');
}

export function openBattleOverlay() {
    openBattle();
}

export function initBattle() {
    battleBtn.addEventListener('click', openBattle);
    battleCloseBtn.addEventListener('click', closeBattle);
    createBtn.addEventListener('click', createBattle);
    joinGoBtn.addEventListener('click', () => joinBattle(joinGoBtn.dataset.id));
    sideABtn.addEventListener('click', () => joinBattle(sideABtn.dataset.id, 'A'));
    sideBBtn.addEventListener('click', () => joinBattle(sideBBtn.dataset.id, 'B'));
    nameSaveBtn.addEventListener('click', renameTeam);
    renameLink.addEventListener('click', () => {
        const b = getActiveBattle();
        if (!b) return;
        nameInput.value = b.side === 'A' ? b.nameA : b.nameB;
        showState('name');
    });
    shareFoeBtn.addEventListener('click', () => shareBattle(BATTLE_SHARE_FOE_TEXT));
    shareOwnBtn.addEventListener('click', () => shareBattle(BATTLE_SHARE_OWN_TEXT));
    newBtn.addEventListener('click', () => {
        clearActiveBattle();
        updateBadge();
        createNameInput.value = '';
        showState('none');
    });

    // Battles are Telegram-only AND need the backend: reveal the button via
    // the shared probe; refresh the badge from the last cached numbers now
    // and from the server once per boot if a battle is on.
    if (!isInTelegram()) return;

    // Deep-link routing: the app was opened via a challenge link
    // (t.me/<bot>/<app>?startapp=b_<id>) — land the player straight on the
    // join confirmation once the backend answered. A member of that very
    // battle just gets his battle view.
    const spMatch = /^b_([A-Za-z0-9_-]{6,32})$/.exec(tgStartParam());
    if (spMatch) setPendingJoin(spMatch[1]);

    whenBackendAlive(() => {
        battleBtn.style.display = '';
        updateBadge();
        const b = getActiveBattle();
        if (pendingJoinId && !state.isPlaying) {
            openBattle();
            return;
        }
        if (b && !b.finished) refreshState();
    });
}
