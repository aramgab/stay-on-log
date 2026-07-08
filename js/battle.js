// === CHAT BATTLES (client) ===
// A player belongs to at most one persistent chat at a time (server-side
// chat:u:<uid>), independent of any battle. Two things hang off "having a
// chat": a permanent in-chat leaderboard among its members, and the 24h
// cross-chat battle (whole chat vs whole chat, team score = sum of every
// member's every run) — side A/B is derived from current chat membership,
// not a one-off per-battle claim. Without a chat, neither is reachable, so
// the single ⚔️ #battle-btn overlay now gates on chat membership first.
// Self-hiding like the leaderboard: the button appears only inside
// Telegram AND after the backend probe answered (whenBackendAlive).
//
// Two localStorage caches, same split as always — the UI's cheap source of
// truth, the server keeps the real pointer:
//   stayOnLog_myChat       = JSON { ci, name, founder, renameCount }
//   stayOnLog_activeBattle = JSON { id, side, ends, nameA, nameB, scoreA,
//                                   scoreB, myTotal, canRename?, finished? }

import { state, lsGet, lsSet } from './state.js';
import { isInTelegram, tgInitData, tgUser, tgStartParam, shareScore, isDevMode } from './tg.js';
import { battleBtn, battleBadge, battleOverlay, battleCloseBtn } from './dom.js';
import { whenBackendAlive } from './leaderboard.js';
import { initAudio } from './audio.js';
import {
    SHARE_URL, BATTLE_POLL_MS, BATTLE_SHARE_FOE_TEXT, BATTLE_SHARE_OWN_TEXT,
    CHAT_NO_CONTEXT_TEXT, CHAT_INVITE_SHARE_TEXT, CHAT_LEAVE_CONFIRM_TEXT, CHAT_LEAVE_BLOCKED_TEXT,
} from './config.js';

const LS_KEY = 'stayOnLog_activeBattle';
const CHAT_LS_KEY = 'stayOnLog_myChat';

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

// Same shape as getActiveBattle/setActiveBattle/clearActiveBattle, but for
// "my chat" — the entity a battle now hangs off instead of a raw chat_instance.
export function getMyChat() {
    try {
        const raw = lsGet(CHAT_LS_KEY);
        if (!raw) return null;
        const c = JSON.parse(raw);
        return c && c.ci ? c : null;
    } catch (e) {
        return null;
    }
}

export function setMyChat(c) {
    lsSet(CHAT_LS_KEY, JSON.stringify(c));
}

export function clearMyChat() {
    lsSet(CHAT_LS_KEY, '');
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

// GET analogue of battleState, but for the caller's own chat entity.
export function chatState(uid) {
    const q = '/api/battle?op=chatState&uid=' + encodeURIComponent(uid || '');
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

// Dev-only (?dev=1): fast-forward MY active battle to end in 5 minutes, so
// the win/lose/draw screens can be playtested without waiting out the real
// 24h window. Server enforces membership + only-shortens — see api/battle.js.
export function devExpireBattle(id) {
    return battleApi('devExpire', { id });
}

// --- UI --------------------------------------------------------------------
// Section elements are private to the feature, so they're resolved here
// rather than ballooning dom.js (modules are deferred — DOM is parsed).

const el = (id) => document.getElementById(id);
const secNone = el('bt-none');
const secJoin = el('bt-join');
const secName = el('bt-name');
const secChatHome = el('chat-home');
const chatJoinBtn = el('chat-join-btn');
const chatInviteBtn = el('chat-invite-btn');
const joinTitle = el('bt-join-title');
const joinScore = el('bt-join-score');
const joinGoBtn = el('bt-join-go');
const chatNameNote = el('chat-name-note');
const nameInput = el('bt-name-input');
const nameSaveBtn = el('bt-name-save');
const chatHomeName = el('chat-home-name');
const chatHomeCount = el('chat-home-count');
const chatList = el('chat-list');
const chatRenameLink = el('chat-rename-link');
const chatLeaveLink = el('chat-leave-link');
const chatBattlePanel = el('chat-battle-panel');
const chatChallengeBtn = el('chat-challenge-btn');
const teamAEl = el('bt-team-a');
const teamBEl = el('bt-team-b');
const timerEl = el('bt-timer');
const verdictEl = el('bt-verdict');
const mineEl = el('bt-mine');
const devExpireLink = el('bt-dev-expire');
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
    [secNone, secJoin, secName, secChatHome].forEach((s) => s.classList.remove('on'));
    setMsg('');
    // Only relevant to the 'none' screen; reset here so every OTHER
    // transition hides it too, same reasoning as clearing the message above.
    chatInviteBtn.style.display = 'none';
    if (which === 'none') secNone.classList.add('on');
    else if (which === 'join') secJoin.classList.add('on');
    else if (which === 'name') secName.classList.add('on');
    else if (which === 'chat-home') secChatHome.classList.add('on');
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

// Renders the versus/timer/tables sub-panel from a battle-state response.
// Invoked as a sub-render from within the chat-home render path — there's no
// standalone "main" state anymore, the battle panel lives inside chat-home.
function renderMain(resp) {
    const b = getActiveBattle();
    const side = b && b.id === resp.id ? b.side : '';

    chatBattlePanel.style.display = 'block';
    chatChallengeBtn.style.display = 'none';

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
}

// Polls the ONE battle hanging off my chat right now, feeding the render
// into the chat-home sub-panel (renderMain no longer flips a standalone
// state — the overlay may or may not even be showing chat-home).
function refreshState() {
    const b = getActiveBattle();
    if (!b) return;
    battleState(b.id, myUid())
        .then((resp) => {
            if (resp.httpStatus === 404) {
                // The battle expired out of the store — let go.
                clearActiveBattle();
                updateBadge();
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
            if (battleOverlay.classList.contains('active') && secChatHome.classList.contains('on')) {
                renderMain(resp);
            }
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

function adoptBattle(id, side, resp) {
    setActiveBattle({
        id,
        side,
        ends: resp.ends || 0,
        nameA: resp.nameA || 'Команда А',
        nameB: resp.nameB || 'Команда Б',
        scoreA: resp.scoreA || 0,
        scoreB: resp.scoreB || 0,
        myTotal: 0,
    });
    updateBadge();
}

// Renders the chat-home screen from a chatState() response: name, member
// count, permanent leaderboard, rename-left, and — if a battle is hanging
// off this chat — the versus/timer/tables sub-panel (fetched separately,
// see refreshChatState). Kept split from refreshChatState the same way the
// old file split refreshState (fetch+poll) from renderMain (paint).
function renderChatHome(resp) {
    showState('chat-home');
    chatHomeName.textContent = resp.name || 'Мой чат';
    chatHomeCount.textContent = (resp.memberCount || 1) + ' 👥';
    chatList.textContent = '';
    (resp.top || []).forEach((e) => chatList.appendChild(contribRow(e)));
    chatRenameLink.textContent = '✏️ переименовать чат' +
        (resp.renamesLeft != null ? ' (' + resp.renamesLeft + ')' : '');
    // Battle panel vs "Вызвать другой чат" is decided by refreshChatState,
    // not here — see the comment there for why it needs the local battle
    // cache too, not just this chat snapshot.
}

// Fetch+poll driver for the chat-home screen — analogue of the old
// refreshState, but for the chat entity rather than a single battle.
function refreshChatState() {
    const uid = myUid();
    chatState(uid)
        .then((resp) => {
            if (resp.httpStatus === 404 || resp.error === 'no_chat') {
                clearMyChat();
                if (battleOverlay.classList.contains('active')) showState('none');
                return;
            }
            if (!resp.ok) {
                // refreshChatState is only ever called right after an explicit
                // action (never a silent background poll) — going quiet here
                // left "Вступаю…"/etc. stuck on screen forever with zero
                // feedback. Status/error code included while we track down
                // why this branch is actually firing in practice.
                setMsg('Не получилось загрузить чат 😔 (' + (resp.httpStatus || '?') + (resp.error ? ' ' + resp.error : '') + ')');
                return;
            }
            setMyChat({
                ci: resp.ci,
                name: resp.name,
                founder: Boolean(resp.founder),
                renameCount: 0,
            });
            if (battleOverlay.classList.contains('active')) renderChatHome(resp);

            // Whether to show the battle panel is driven by the LOCAL battle
            // cache first, not chatState's battleActive: that flag flips to
            // false the instant a battle's `ends` passes, which would
            // otherwise silently swap the verdict screen for the challenge
            // button before the player ever saw who won (e.g. reopening the
            // overlay after the battle already finished). A locally-tracked
            // battle — active OR just-finished-but-not-yet-dismissed — keeps
            // rendering through the existing battle-specific path below,
            // which already shows the verdict correctly; clicking "Новая
            // битва" is what actually dismisses it (clearActiveBattle).
            // chatState's battleActive/battleId is only used to DISCOVER a
            // battle this client doesn't have cached yet (e.g. a fellow
            // member started one, or this is a fresh load).
            const existing = getActiveBattle();
            if (existing) {
                if (battleOverlay.classList.contains('active') && secChatHome.classList.contains('on')) {
                    chatBattlePanel.style.display = 'block';
                    chatChallengeBtn.style.display = 'none';
                }
                refreshState();
                if (!existing.finished) startPolling();
                return;
            }

            if (resp.battleActive && resp.battleId) {
                battleState(resp.battleId, uid).then((bResp) => {
                    if (!bResp.ends) return;
                    serverOffset = bResp.now ? bResp.now - Date.now() : 0;
                    adoptBattle(resp.battleId, bResp.me ? bResp.me.side : '', bResp);
                    if (battleOverlay.classList.contains('active') && secChatHome.classList.contains('on')) {
                        renderMain(bResp);
                    }
                    startPolling();
                }).catch(() => { /* poll again later */ });
            } else if (battleOverlay.classList.contains('active') && secChatHome.classList.contains('on')) {
                chatBattlePanel.style.display = 'none';
                chatChallengeBtn.style.display = '';
                stopTimers();
            }
        })
        .catch(() => setMsg('Сеть молчит 😔'));
}

function joinOrFoundChat(name) {
    setMsg('Вступаю…');
    battleApi('chatJoinOrFound', name ? { name } : {})
        .then((resp) => {
            if (resp.httpStatus === 400 && resp.error === 'no_chat_context') {
                // showState() clears the message as its own first step (it's
                // meant to reset stale text on a real transition) — setting
                // the message BEFORE calling it, as this used to, meant
                // showState immediately wiped it back to '' since we're
                // already on 'none' (no visible transition to hide behind).
                // Order matters: transition first, THEN set the message that
                // should actually stick.
                showState('none');
                setMsg(CHAT_NO_CONTEXT_TEXT);
                // Same reasoning as the message above: showState() just reset
                // this to hidden, so it has to be re-shown AFTER, not before.
                chatInviteBtn.style.display = '';
                return;
            }
            if (resp.httpStatus === 409 && resp.error === 'already_in_chat') {
                setMsg('Ты уже в чате — сначала выйди из него, если хочешь вступить в другой.');
                refreshChatState();
                return;
            }
            if (!resp.ok) {
                setMsg('Не получилось вступить 😔 (' + (resp.httpStatus || '?') + (resp.error ? ' ' + resp.error : '') + ')');
                return;
            }
            if (resp.founder && !name) {
                // Brand-new/empty chat, nobody named it yet — prompt for a name,
                // then re-call this SAME op with the typed name (the server only
                // honors `name` on the founding path).
                chatNameNote.textContent = 'Ты первый в этом чате — назови его!';
                nameInput.value = '';
                showState('name');
                return;
            }
            setMyChat({ ci: resp.ci, name: resp.name, founder: Boolean(resp.founder), renameCount: 0 });
            if (pendingJoinId) {
                const id = pendingJoinId;
                pendingJoinId = '';
                renderJoinConfirm(id);
                return;
            }
            refreshChatState();
        })
        .catch(() => setMsg('Сеть молчит 😔'));
}

function leaveChat() {
    if (!window.confirm(CHAT_LEAVE_CONFIRM_TEXT)) return;
    setMsg('Выхожу…');
    battleApi('chatLeave', {})
        .then((resp) => {
            if (resp.httpStatus === 409 && resp.error === 'battle_active') {
                setMsg(CHAT_LEAVE_BLOCKED_TEXT);
                return;
            }
            if (!resp.ok) {
                setMsg('Не получилось выйти 😔');
                return;
            }
            clearMyChat();
            clearActiveBattle();
            updateBadge();
            stopTimers();
            showState('none');
        })
        .catch(() => setMsg('Сеть молчит 😔'));
}

function renameChat(name) {
    setMsg('Сохраняю…');
    battleApi('chatRename', { name })
        .then((resp) => {
            if (resp.httpStatus === 403 && resp.error === 'limit_reached') {
                setMsg('Лимит переименований исчерпан.');
                refreshChatState();
                return;
            }
            if (!resp.ok) {
                setMsg('Не вышло 😔');
                refreshChatState();
                return;
            }
            const c = getMyChat();
            if (c) setMyChat(Object.assign(c, { name: resp.name }));
            setMsg('');
            refreshChatState();
        })
        .catch(() => setMsg('Сеть молчит 😔'));
}

function createBattle() {
    setMsg('Вызываю…');
    battleApi('create', {})
        .then((resp) => {
            if (resp.httpStatus === 403 && resp.error === 'no_chat') {
                clearMyChat();
                showState('none');
                return;
            }
            if (resp.httpStatus === 409 && resp.error === 'already_active' && resp.id) {
                // Your chat already has a live battle — just refresh onto it.
                refreshChatState();
                return;
            }
            if (!resp.ok) {
                setMsg('Не получилось создать 😔 Попробуй ещё раз.');
                return;
            }
            adoptBattle(resp.id, 'A', resp);
            refreshChatState();
            startPolling();
        })
        .catch(() => setMsg('Сеть молчит 😔'));
}

function joinBattle(id) {
    setMsg('Вступаю…');
    battleApi('join', { id })
        .then((resp) => {
            if (resp.httpStatus === 403 && resp.error === 'no_chat') {
                clearMyChat();
                // Same ordering fix as joinOrFoundChat: showState() clears
                // the message itself, so it must run BEFORE setMsg, not after.
                showState('none');
                setMsg(CHAT_NO_CONTEXT_TEXT);
                chatInviteBtn.style.display = '';
                return;
            }
            if (resp.httpStatus === 409 && resp.error === 'battle_full') {
                setMsg('Обе стороны уже заняты другими чатами.');
                refreshChatState();
                return;
            }
            if (resp.httpStatus === 410 || resp.finished) {
                setMsg('Эта битва уже завершена: ' +
                    (resp.nameA || 'А') + ' ' + (resp.scoreA || 0) + ' : ' +
                    (resp.scoreB || 0) + ' ' + (resp.nameB || 'Б'));
                refreshChatState();
                return;
            }
            if (!resp.ok) {
                setMsg(resp.httpStatus === 404 ? 'Битва не найдена — ссылка устарела.' : 'Не получилось вступить 😔');
                refreshChatState();
                return;
            }
            adoptBattle(id, resp.side, resp);
            refreshChatState();
            startPolling();
        })
        .catch(() => setMsg('Сеть молчит 😔'));
}

function shareBattle(text) {
    const b = getActiveBattle();
    if (!b) return;
    const method = shareScore(text, SHARE_URL + '?startapp=b_' + b.id);
    if (method === 'copy') setMsg('Ссылка скопирована!');
}

// For the no_chat_context wall: no battle id involved, chat identity comes
// entirely from WHICHEVER chat this link is eventually opened from — so
// unlike shareBattle above, this link carries no target-specific payload,
// startapp=joinchat only exists to auto-retry joinOrFoundChat() on boot
// (see initBattle) instead of requiring one more manual tap once there.
function shareChatInvite() {
    const method = shareScore(CHAT_INVITE_SHARE_TEXT, SHARE_URL + '?startapp=joinchat');
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
                refreshChatState();
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
    const c = getMyChat();
    if (!c) {
        // No chat yet: a pending challenge link waits behind the chat-cta
        // screen — joinOrFoundChat() forwards to it once membership lands.
        showState('none');
        return;
    }
    if (pendingJoinId) {
        const id = pendingJoinId;
        pendingJoinId = '';
        renderJoinConfirm(id);
        return;
    }
    refreshChatState();
    startPolling();
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
    chatJoinBtn.addEventListener('click', () => joinOrFoundChat());
    chatInviteBtn.addEventListener('click', shareChatInvite);
    joinGoBtn.addEventListener('click', () => joinBattle(joinGoBtn.dataset.id));
    nameSaveBtn.addEventListener('click', () => {
        const c = getMyChat();
        if (!c) joinOrFoundChat(nameInput.value);
        else renameChat(nameInput.value);
    });
    chatRenameLink.addEventListener('click', () => {
        const c = getMyChat();
        chatNameNote.textContent = 'Переименовать чат:';
        nameInput.value = c ? c.name : '';
        showState('name');
    });
    chatLeaveLink.addEventListener('click', leaveChat);
    chatChallengeBtn.addEventListener('click', createBattle);
    shareFoeBtn.addEventListener('click', () => shareBattle(BATTLE_SHARE_FOE_TEXT));
    shareOwnBtn.addEventListener('click', () => shareBattle(BATTLE_SHARE_OWN_TEXT));
    newBtn.addEventListener('click', () => {
        clearActiveBattle();
        updateBadge();
        refreshChatState();
    });

    // Dev-only fast-forward: the button starts display:none in the markup,
    // this is the ONLY place that ever reveals it.
    if (isDevMode()) {
        devExpireLink.style.display = '';
        devExpireLink.addEventListener('click', () => {
            const b = getActiveBattle();
            if (!b) return;
            devExpireLink.textContent = '⏳…';
            devExpireBattle(b.id)
                .then((resp) => {
                    devExpireLink.textContent = !resp.ok
                        ? '⚡ не вышло'
                        : resp.unchanged
                            ? '⚡ уже скоро закончится'
                            : '⚡ конец через 5 мин ✓';
                    if (resp.ok) refreshChatState();
                })
                .catch(() => { devExpireLink.textContent = '⚡ не вышло'; });
        });
    }

    // Battles are Telegram-only AND need the backend: reveal the button via
    // the shared probe; refresh the badge from the last cached numbers now
    // and from the server once per boot if a battle is on.
    if (!isInTelegram()) return;

    // Deep-link routing: the app was opened via a challenge link
    // (t.me/<bot>/<app>?startapp=b_<id>) — land the player straight on the
    // join confirmation once the backend answered (or, if they have no chat
    // yet, on chat-cta first — joinOrFoundChat() forwards to the pending
    // join once membership lands). A member of that very battle's chat just
    // gets his battle view.
    const spMatch = /^b_([A-Za-z0-9_-]{6,32})$/.exec(tgStartParam());
    if (spMatch) setPendingJoin(spMatch[1]);

    // The OTHER deep link (t.me/<bot>/<app>?startapp=joinchat, shared by
    // shareChatInvite from the no_chat_context wall): unlike the one above,
    // it carries no id — chat identity is whatever chat_instance this
    // specific open happens to have, so there's nothing to "confirm", just
    // attempt the join immediately. Harmless to retry on someone re-opening
    // an old invite link: joinOrFoundChat's own already_in_chat/idempotent
    // handling covers that.
    const isJoinChatLink = tgStartParam() === 'joinchat';

    whenBackendAlive(() => {
        battleBtn.style.display = '';
        updateBadge();
        if (pendingJoinId && !state.isPlaying) {
            openBattle();
            return;
        }
        if (isJoinChatLink && !state.isPlaying) {
            initAudio();
            battleOverlay.classList.add('active');
            showState('none');
            joinOrFoundChat();
            return;
        }
        // Not opening the overlay yet (no pending join) — just refresh the
        // ⚔️ badge from the server once per boot if a battle is on. The
        // full chat-state refresh happens lazily when the overlay opens.
        const b = getActiveBattle();
        if (b && !b.finished) refreshState();
    });
}
