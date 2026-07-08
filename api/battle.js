// /api/battle — chat-vs-chat battles, one function with op routing to stay
// well inside the Vercel Hobby function limit:
//   GET  ?op=state&id=..&uid=..              — live scoreboard (uid only marks "you")
//   GET  ?op=chatState&uid=..                — caller's own chat entity + its leaderboard
//   POST {op:'create', initData}             — start a battle, creator's chat joins side A
//   POST {op:'join',   initData, id}
//   POST {op:'submit', initData, id, runId, score}
//   POST {op:'chatJoinOrFound', initData, name?}
//   POST {op:'chatLeave', initData}
//   POST {op:'chatRename', initData, name}
//
// Teams are formed by a PERSISTENT chat entity (chat:<ci>, keyed by the
// SIGNED chat_instance from initData — the anonymous per-chat fingerprint
// Telegram attaches when the app is opened from a chat), not by an ad-hoc
// per-battle claim: a player's chat membership (chat:u:<uid> -> ci) is set
// once via chatJoinOrFound/chatLeave, independently of any battle, and a
// battle's side A/B is just "whichever chat entity is bound to that side" —
// side is derived live from CURRENT chat membership, so anyone who is a
// member of a chat is automatically "in" any battle that chat is fighting,
// with no separate per-user join-the-battle step.
//
// Scoring: team score = SUM of every run of every member inside the 24h
// window. Dedup across revive: the client submits (runId, score) on every
// game over of one run; the server stores the last submitted score per
// uid:runId and increments the team only by the positive delta. The same
// verified delta ALSO feeds the chat's own all-time (never reset) total.
//
// Keys (prefix bt:, TTL = 24h window + 7d grace to view the result):
//   bt:<id>          HASH  created ends creator chatA? chatB? nameA nameB
//                          scoreA scoreB
//                          (chat*/ are CLAIMED via HSETNX, so they are
//                           omitted at create when unknown — never
//                           pre-written as '')
//   bt:<id>:contrib  HASH  uid -> total contributed (this battle only)
//   bt:<id>:names    HASH  uid -> display name from VERIFIED initData
//   bt:<id>:runs     HASH  "<uid>:<runId>" -> last submitted score of the run
//
// Keys (prefix chat:, persistent — see CHAT_TTL_S below for why the TTL on
// these is long and NOT something a player should ever hit in practice):
//   chat:<ci>          HASH  name founder created renameCount
//   chat:<ci>:members  SET   uid, uid, ...
//   chat:<ci>:contrib  HASH  uid -> all-time cumulative score (never reset,
//                            unlike bt:<id>:contrib which is per-battle)
//   chat:<ci>:names    HASH  uid -> display name from VERIFIED initData
//   chat:<ci>:battle   STR   the bt:<id> this chat currently has active
//                            (mirrors bt:u:<uid>, just re-scoped from user
//                            to chat — "one active battle per chat")
//   chat:u:<uid>       STR   ci of caller's current chat — THE pointer
//                            answering "does this player have a chat, and
//                            which"

const crypto = require('crypto');
const { kvConfigured, botConfigured, kvPipeline, validateInitData } = require('./_kv.js');

const BATTLE_WINDOW_MS = 24 * 60 * 60 * 1000;
const TTL_S = 8 * 24 * 60 * 60;          // window + grace, applied to every bt:<id>* key
// chat:* keys are meant to feel PERMANENT to a player — this long TTL exists
// purely as Upstash storage hygiene against chats that got abandoned outright
// (nobody ever opens the app from that group again), not a real expiry any
// active player should ever notice. It is refreshed on every write to a
// chat:* key, so a chat with any ongoing activity never approaches it.
// Do NOT "fix" this into something shorter — that would turn into a real,
// player-visible expiry for chats that just go quiet for a few weeks.
const CHAT_TTL_S = 180 * 24 * 60 * 60;
const MAX_SCORE = 50000;                 // same sanity cap as api/score.js
const NAME_MAX = 24;
const TOP_N = 10;
const CHAT_RENAME_LIMIT = 3;
const ID_RE = /^[A-Za-z0-9_-]{6,32}$/;
const RUN_RE = /^[a-z0-9.-]{6,40}$/i;
const GROUP_TYPES = { group: 1, supergroup: 1, channel: 1 };

function json(res, code, obj) {
    res.status(code).json(obj);
}

function readBody(req) {
    let body = req.body;
    if (typeof body === 'string') {
        try {
            body = JSON.parse(body);
        } catch (e) {
            body = null;
        }
    }
    return body || null;
}

// HGETALL comes back as a flat [field, value, field, value, ...] array.
function hashToObj(flat) {
    const o = {};
    if (Array.isArray(flat)) {
        for (let i = 0; i + 1 < flat.length; i += 2) o[flat[i]] = flat[i + 1];
    }
    return o;
}

function sanitizeName(raw, fallback) {
    const s = String(raw == null ? '' : raw)
        .replace(/[\x00-\x1f\x7f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, NAME_MAX);
    return s || fallback;
}

function displayName(user) {
    return String(user.first_name || user.username || 'Игрок').slice(0, 16);
}

// The chat fingerprint only counts when the app was opened from a group-like
// chat; a private-chat launch must not weld a "team" to one person's DMs.
function groupCi(v) {
    return GROUP_TYPES[v.chatType] ? v.chatInstance : '';
}

function battleView(meta) {
    return {
        ends: Number(meta.ends) || 0,
        nameA: meta.nameA || 'Команда А',
        nameB: meta.nameB || 'Команда Б',
        scoreA: Number(meta.scoreA) || 0,
        scoreB: Number(meta.scoreB) || 0,
    };
}

function winnerOf(meta) {
    const a = Number(meta.scoreA) || 0;
    const b = Number(meta.scoreB) || 0;
    return a > b ? 'A' : b > a ? 'B' : 'draw';
}

// ---------------------------------------------------------------------
// Part 1 — chat entity ops (pure additions; nothing existing calls these).
// ---------------------------------------------------------------------

async function opChatJoinOrFound(res, body) {
    const v = validateInitData(String(body.initData || ''));
    if (!v) return json(res, 403, { error: 'invalid initData' });
    const uid = String(v.user.id);
    const now = Date.now();

    const ci = groupCi(v);
    if (!ci) return json(res, 400, { error: 'no_chat_context' });

    const ptr = await kvPipeline([['GET', 'chat:u:' + uid]]);
    const curCi = ptr && ptr[0] && ptr[0].result;
    if (curCi && curCi !== ci) {
        return json(res, 409, { error: 'already_in_chat', ci: curCi });
    }

    const chatKey = 'chat:' + ci;
    const membersKey = chatKey + ':members';

    // curCi === ci means we're already a member of THIS chat — idempotent
    // success, skip straight to returning the current view (no founder logic).
    if (curCi === ci) {
        const state = await kvPipeline([
            ['HGETALL', chatKey],
            ['SCARD', membersKey],
        ]);
        const meta = hashToObj(state[0] && state[0].result);
        const memberCount = Number(state[1] && state[1].result) || 0;
        const renameCount = Number(meta.renameCount) || 0;
        return json(res, 200, {
            ok: true,
            ci,
            name: meta.name || 'Наш чат',
            founder: false,
            renameCount,
            renamesLeft: Math.max(0, CHAT_RENAME_LIMIT - renameCount),
            memberCount,
        });
    }

    const existing = await kvPipeline([
        ['HGETALL', chatKey],
        ['SCARD', membersKey],
    ]);
    const existingMeta = hashToObj(existing[0] && existing[0].result);
    const exists = Object.keys(existingMeta).length > 0;
    const memberCountBefore = Number(existing[1] && existing[1].result) || 0;

    const name = sanitizeName(body.name, 'Наш чат');
    let founder = false;
    let finalMeta = existingMeta;

    if (!exists) {
        // Brand new chat: nobody has ever seen this ci before. Race-safe
        // founder claim via HSETNX (mirrors the ciA/ciB claim idiom already
        // used elsewhere in this file).
        const claim = await kvPipeline([['HSETNX', chatKey, 'founder', uid]]);
        founder = Boolean(claim && claim[0] && claim[0].result === 1);
        if (founder) {
            await kvPipeline([
                ['HSET', chatKey, 'name', name, 'created', String(now), 'renameCount', '0'],
            ]);
            finalMeta = { founder: uid, name, created: String(now), renameCount: '0' };
        } else {
            // Lost the race to a concurrent founder — re-read what they wrote.
            const reread = await kvPipeline([['HGETALL', chatKey]]);
            finalMeta = hashToObj(reread[0] && reread[0].result);
        }
    } else if (memberCountBefore === 0) {
        // The chat entity exists but has been emptied out (everyone left) —
        // it is re-foundable. Accept the tiny race risk of two people
        // re-founding the exact same emptied chat at the same instant; this
        // is a rare edge case not worth over-engineering.
        founder = true;
        await kvPipeline([
            ['HSET', chatKey, 'founder', uid, 'name', name, 'created', String(now), 'renameCount', '0'],
        ]);
        finalMeta = { founder: uid, name, created: String(now), renameCount: '0' };
    }
    // else: memberCountBefore > 0 — definite join, no founder attempt at all,
    // founder stays false and finalMeta stays the existing chat's meta.

    await kvPipeline([
        ['SADD', membersKey, uid],
        ['SET', 'chat:u:' + uid, ci],
        ['EXPIRE', chatKey, String(CHAT_TTL_S)],
        ['EXPIRE', membersKey, String(CHAT_TTL_S)],
        ['EXPIRE', 'chat:u:' + uid, String(CHAT_TTL_S)],
    ]);

    const memberCount = await kvPipeline([['SCARD', membersKey]]);
    const renameCount = Number(finalMeta.renameCount) || 0;

    return json(res, 200, {
        ok: true,
        ci,
        name: finalMeta.name || 'Наш чат',
        founder,
        renameCount,
        renamesLeft: Math.max(0, CHAT_RENAME_LIMIT - renameCount),
        memberCount: Number(memberCount && memberCount[0] && memberCount[0].result) || 0,
    });
}

async function opChatLeave(res, body) {
    const v = validateInitData(String(body.initData || ''));
    if (!v) return json(res, 403, { error: 'invalid initData' });
    const uid = String(v.user.id);

    const ptr = await kvPipeline([['GET', 'chat:u:' + uid]]);
    const ci = ptr && ptr[0] && ptr[0].result;
    if (!ci) return json(res, 404, { error: 'no_chat' });

    const chatKey = 'chat:' + ci;

    // Anti-abuse: don't let a chat bail out of a battle it's currently
    // losing by having everyone leave. Double-check the pointed-to record
    // (don't just trust the pointer's presence) — same idiom as opCreate's
    // bt:u:<uid> check and api/top.js's equivalent pattern.
    const battlePtr = await kvPipeline([['GET', chatKey + ':battle']]);
    const battleId = battlePtr && battlePtr[0] && battlePtr[0].result;
    if (battleId) {
        const bt = await kvPipeline([['HGET', 'bt:' + battleId, 'ends']]);
        const ends = bt && bt[0] && Number(bt[0].result);
        if (ends && Date.now() < ends) {
            return json(res, 409, { error: 'battle_active' });
        }
    }

    // Deliberately do NOT touch chat:<ci>:contrib for this uid — leaving
    // forfeits future visibility, not the historical number. The row simply
    // stops rendering once the uid drops out of :members, same as how
    // battle contrib rows are filtered by current membership.
    await kvPipeline([
        ['SREM', chatKey + ':members', uid],
        ['DEL', 'chat:u:' + uid],
    ]);

    return json(res, 200, { ok: true });
}

async function opChatRename(res, body) {
    const v = validateInitData(String(body.initData || ''));
    if (!v) return json(res, 403, { error: 'invalid initData' });
    const uid = String(v.user.id);

    const ptr = await kvPipeline([['GET', 'chat:u:' + uid]]);
    const ci = ptr && ptr[0] && ptr[0].result;
    if (!ci) return json(res, 404, { error: 'no_chat' });

    const chatKey = 'chat:' + ci;
    const cur = await kvPipeline([['HGETALL', chatKey]]);
    const meta = hashToObj(cur[0] && cur[0].result);
    const renameCount = Number(meta.renameCount) || 0;
    if (renameCount >= CHAT_RENAME_LIMIT) return json(res, 403, { error: 'limit_reached' });

    const name = sanitizeName(body.name, meta.name || 'Наш чат');
    await kvPipeline([
        ['HSET', chatKey, 'name', name],
        ['HINCRBY', chatKey, 'renameCount', '1'],
        ['EXPIRE', chatKey, String(CHAT_TTL_S)],
    ]);

    return json(res, 200, {
        ok: true,
        name,
        renamesLeft: Math.max(0, CHAT_RENAME_LIMIT - (renameCount + 1)),
    });
}

async function opChatState(res, query) {
    const uid = query.uid ? String(query.uid) : '';
    if (!uid) return json(res, 400, { error: 'uid required' });

    const ptr = await kvPipeline([['GET', 'chat:u:' + uid]]);
    const ci = ptr && ptr[0] && ptr[0].result;
    if (!ci) return json(res, 404, { error: 'no_chat' });

    const chatKey = 'chat:' + ci;
    const out = await kvPipeline([
        ['HGETALL', chatKey],
        ['HGETALL', chatKey + ':contrib'],
        ['HGETALL', chatKey + ':names'],
        ['SCARD', chatKey + ':members'],
        ['GET', chatKey + ':battle'],
    ]);
    const meta = hashToObj(out[0] && out[0].result);
    const contrib = hashToObj(out[1] && out[1].result);
    const names = hashToObj(out[2] && out[2].result);
    const memberCount = Number(out[3] && out[3].result) || 0;
    const battleId = out[4] && out[4].result;

    // Same shape as opState's top() helper: build rows from contrib, sort
    // descending, slice to TOP_N, always include "me" even if outside the
    // top-N slice.
    const rows = [];
    for (const u in contrib) {
        rows.push({ name: names[u] || 'Игрок', score: Number(contrib[u]) || 0, you: u === uid });
    }
    rows.sort((a, b) => b.score - a.score);
    const top = rows.slice(0, TOP_N);
    const mine = rows.find((r) => r.you);
    if (mine && top.indexOf(mine) === -1) top.push(mine);

    let battleActive = false;
    let battleIdOut = null;
    if (battleId) {
        const bt = await kvPipeline([['HGET', 'bt:' + battleId, 'ends']]);
        const ends = bt && bt[0] && Number(bt[0].result);
        if (ends && Date.now() < ends) {
            battleActive = true;
            battleIdOut = battleId;
        }
    }

    const renameCount = Number(meta.renameCount) || 0;
    return json(res, 200, {
        ok: true,
        ci,
        name: meta.name || 'Наш чат',
        memberCount,
        top,
        me: { score: Number(contrib[uid]) || 0 },
        renamesLeft: Math.max(0, CHAT_RENAME_LIMIT - renameCount),
        battleId: battleIdOut,
        battleActive,
    });
}

// ---------------------------------------------------------------------
// Part 2 — battle ops, rewired to derive side from persistent chat
// membership instead of an ad-hoc per-battle claim.
// ---------------------------------------------------------------------

async function opCreate(res, body) {
    const v = validateInitData(String(body.initData || ''));
    if (!v) return json(res, 403, { error: 'invalid initData' });
    const uid = String(v.user.id);
    const now = Date.now();

    const chatPtr = await kvPipeline([['GET', 'chat:u:' + uid]]);
    const ci = chatPtr && chatPtr[0] && chatPtr[0].result;
    if (!ci) return json(res, 403, { error: 'no_chat' });
    const chatKey = 'chat:' + ci;

    // One battle per CHAT: if the chat's pointed-to battle is still running,
    // send the client there instead of creating a parallel one.
    const ptr = await kvPipeline([['GET', chatKey + ':battle']]);
    const oldId = ptr && ptr[0] && ptr[0].result;
    if (oldId) {
        const old = await kvPipeline([['HGET', 'bt:' + oldId, 'ends']]);
        const oldEnds = old && old[0] && Number(old[0].result);
        if (oldEnds && now < oldEnds) {
            return json(res, 409, { error: 'already_active', id: oldId });
        }
    }

    // Snapshot the chat's own name at creation time — this deliberately does
    // NOT live-follow later chat renames.
    const chatMeta = await kvPipeline([['HGET', chatKey, 'name']]);
    const nameA = (chatMeta && chatMeta[0] && chatMeta[0].result) || 'Команда А';
    const ends = now + BATTLE_WINDOW_MS;

    // Claim a fresh id (HSETNX on 'created' detects the astronomically
    // unlikely collision); everything else is written only after the claim
    // so a collision can never scribble over an existing battle.
    let id = '';
    for (let attempt = 0; attempt < 3 && !id; attempt++) {
        const cand = crypto.randomBytes(6).toString('base64url');
        const claim = await kvPipeline([['HSETNX', 'bt:' + cand, 'created', String(now)]]);
        if (claim && claim[0] && claim[0].result === 1) id = cand;
    }
    if (!id) return json(res, 500, { error: 'id collision' });

    const bt = 'bt:' + id;
    await kvPipeline([
        ['HSET', bt,
            'ends', String(ends),
            'creator', uid,
            'chatA', ci,
            'nameA', nameA,
            'nameB', 'Команда Б',
            'scoreA', '0',
            'scoreB', '0',
        ],
        ['HSET', bt + ':names', uid, displayName(v.user)],
        ['EXPIRE', bt, String(TTL_S)],
        ['EXPIRE', bt + ':names', String(TTL_S)],
        ['SET', chatKey + ':battle', id],
        ['EXPIRE', chatKey, String(CHAT_TTL_S)],
        ['EXPIRE', chatKey + ':battle', String(CHAT_TTL_S)],
    ]);

    return json(res, 200, { ok: true, id, side: 'A', ends, nameA, nameB: 'Команда Б' });
}

async function opJoin(res, body) {
    const v = validateInitData(String(body.initData || ''));
    if (!v) return json(res, 403, { error: 'invalid initData' });
    const id = String(body.id || '');
    if (!ID_RE.test(id)) return json(res, 400, { error: 'bad id' });
    const uid = String(v.user.id);
    const bt = 'bt:' + id;
    const now = Date.now();

    const chatPtr = await kvPipeline([['GET', 'chat:u:' + uid]]);
    const ci = chatPtr && chatPtr[0] && chatPtr[0].result;
    if (!ci) return json(res, 403, { error: 'no_chat' });
    const chatKey = 'chat:' + ci;

    const out = await kvPipeline([['HGETALL', bt]]);
    const meta = hashToObj(out[0] && out[0].result);
    if (!meta.ends) return json(res, 404, { error: 'not found' });
    const view = battleView(meta);
    if (now > view.ends) {
        return json(res, 410, Object.assign({ finished: true, winner: winnerOf(meta) }, view));
    }

    // Own chat's own challenge link — not really a "join," just "show me my
    // own battle". Treat as idempotent, no chatB binding attempt.
    if (ci === meta.chatA) {
        return json(res, 200, Object.assign({ ok: true, side: 'A' }, view));
    }

    if (ci === meta.chatB) {
        // Already bound to this side — idempotent success.
        return json(res, 200, Object.assign({ ok: true, side: 'B' }, view));
    }

    if (meta.chatB) {
        // chatB is already bound to a THIRD, different chat — sides are full.
        return json(res, 409, { error: 'battle_full' });
    }

    // chatB unset: claim it (race-safe idiom mirrors the old ciA/ciB claim).
    const claim = await kvPipeline([
        ['HSETNX', bt, 'chatB', ci],
        ['HGET', bt, 'chatB'],
    ]);
    const actual = claim && claim[1] && claim[1].result;
    if (actual !== ci) {
        // Lost the race to a concurrent joiner from a different chat.
        return json(res, 409, { error: 'battle_full' });
    }

    const chatMeta = await kvPipeline([['HGET', chatKey, 'name']]);
    const nameB = sanitizeName(chatMeta && chatMeta[0] && chatMeta[0].result, 'Команда Б');

    await kvPipeline([
        ['HSET', bt, 'nameB', nameB],
        ['HSET', bt + ':names', uid, displayName(v.user)],
        ['EXPIRE', bt, String(TTL_S)],
        ['EXPIRE', bt + ':names', String(TTL_S)],
        ['SET', chatKey + ':battle', id],
        ['EXPIRE', chatKey, String(CHAT_TTL_S)],
        ['EXPIRE', chatKey + ':battle', String(CHAT_TTL_S)],
    ]);

    return json(res, 200, Object.assign({ ok: true, side: 'B' }, view, { nameB }));
}

async function opState(res, query) {
    const id = String(query.id || '');
    if (!ID_RE.test(id)) return json(res, 400, { error: 'bad id' });
    const uid = query.uid ? String(query.uid) : '';
    const bt = 'bt:' + id;
    const now = Date.now();

    const out = await kvPipeline([
        ['HGETALL', bt],
        ['HGETALL', bt + ':contrib'],
        ['HGETALL', bt + ':names'],
    ]);
    const meta = hashToObj(out[0] && out[0].result);
    if (!meta.ends) return json(res, 404, { error: 'not found' });
    const contrib = hashToObj(out[1] && out[1].result);
    const names = hashToObj(out[2] && out[2].result);

    const membersOut = await kvPipeline([
        meta.chatA ? ['SMEMBERS', 'chat:' + meta.chatA + ':members'] : ['SMEMBERS', 'chat:__none__:members'],
        meta.chatB ? ['SMEMBERS', 'chat:' + meta.chatB + ':members'] : ['SMEMBERS', 'chat:__none__:members'],
    ]);
    const membersA = {};
    (membersOut[0] && membersOut[0].result || []).forEach((u) => { membersA[u] = 1; });
    const membersB = {};
    (membersOut[1] && membersOut[1].result || []).forEach((u) => { membersB[u] = 1; });

    const view = battleView(meta);
    const finished = now > view.ends;

    const rows = { A: [], B: [] };
    for (const u in contrib) {
        const s = membersA[u] ? 'A' : membersB[u] ? 'B' : null;
        if (!s) continue;
        rows[s].push({ name: names[u] || 'Игрок', score: Number(contrib[u]) || 0, you: u === uid });
    }
    const top = (s) => {
        rows[s].sort((a, b) => b.score - a.score);
        const t = rows[s].slice(0, TOP_N);
        const mine = rows[s].find((r) => r.you);
        if (mine && t.indexOf(mine) === -1) t.push(mine);
        return t;
    };

    const myScore = uid && contrib[uid] ? Number(contrib[uid]) || 0 : 0;
    const mySide = uid && membersA[uid] ? 'A' : uid && membersB[uid] ? 'B' : null;

    // Short shared cache: the poll while the overlay is open rides this.
    res.setHeader('Cache-Control', 's-maxage=5, stale-while-revalidate=15');
    return json(res, 200, Object.assign({
        id,
        now,
        finished,
        winner: finished ? winnerOf(meta) : null,
        topA: top('A'),
        topB: top('B'),
        me: mySide ? { side: mySide, score: myScore } : null,
    }, view));
}

async function opSubmit(res, body) {
    const v = validateInitData(String(body.initData || ''));
    if (!v) return json(res, 403, { error: 'invalid initData' });
    const id = String(body.id || '');
    if (!ID_RE.test(id)) return json(res, 400, { error: 'bad id' });
    const runId = String(body.runId || '');
    const score = Math.floor(Number(body.score));
    if (!RUN_RE.test(runId) || !Number.isFinite(score) || score <= 0 || score > MAX_SCORE) {
        return json(res, 400, { error: 'bad request' });
    }
    const uid = String(v.user.id);
    const bt = 'bt:' + id;
    const runKey = uid + ':' + runId; // uid prefixed SERVER-side — no forging other players' runs
    const now = Date.now();

    const chatPtr = await kvPipeline([['GET', 'chat:u:' + uid]]);
    const ci = chatPtr && chatPtr[0] && chatPtr[0].result;

    const out = await kvPipeline([
        ['HGETALL', bt],
        ['HGET', bt + ':runs', runKey],
        ['HGET', bt + ':contrib', uid],
    ]);
    const meta = hashToObj(out[0] && out[0].result);
    if (!meta.ends) return json(res, 404, { error: 'not found' });
    const side = ci && ci === meta.chatA ? 'A' : ci && ci === meta.chatB ? 'B' : null;
    if (!side) return json(res, 403, { error: 'not a member' });
    const view = battleView(meta);
    if (now > view.ends) return json(res, 410, Object.assign({ finished: true, winner: winnerOf(meta) }, view));

    const old = Number(out[1] && out[1].result) || 0;
    const myTotal = Number(out[2] && out[2].result) || 0;
    const delta = score - old;
    if (delta <= 0) {
        // Same run resubmitted with no growth (or a replayed request) — a no-op.
        return json(res, 200, Object.assign({ ok: true, unchanged: true, myTotal }, view));
    }

    const chatKey = 'chat:' + ci;
    const inc = await kvPipeline([
        ['HSET', bt + ':runs', runKey, String(score)],
        ['HINCRBY', bt, 'score' + side, String(delta)],
        ['HINCRBY', bt + ':contrib', uid, String(delta)],
        ['EXPIRE', bt + ':runs', String(TTL_S)],
        ['EXPIRE', bt + ':contrib', String(TTL_S)],
        ['HINCRBY', chatKey + ':contrib', uid, String(delta)],
        ['EXPIRE', chatKey, String(CHAT_TTL_S)],
        ['EXPIRE', chatKey + ':contrib', String(CHAT_TTL_S)],
    ]);
    const newTeam = Number(inc && inc[1] && inc[1].result) || 0;
    const newMine = Number(inc && inc[2] && inc[2].result) || myTotal + delta;

    return json(res, 200, {
        ok: true,
        scoreA: side === 'A' ? newTeam : view.scoreA,
        scoreB: side === 'B' ? newTeam : view.scoreB,
        myTotal: newMine,
        ends: view.ends,
    });
}

// Dev-only (?dev=1 client gate): fast-forward the caller's OWN battle to end
// in 5 minutes, so the win/lose/draw screens can be playtested without
// waiting out the real 24h window. Chat membership (derived the same way as
// opSubmit) is the entire authorization surface. Only ever shortens `ends` —
// never extends it — which as a side effect also refuses to resurrect an
// already-finished battle (its `ends` is in the past, so `newEnds >= curEnds`
// is always true there).
async function opDevExpire(res, body) {
    const v = validateInitData(String(body.initData || ''));
    if (!v) return json(res, 403, { error: 'invalid initData' });
    const id = String(body.id || '');
    if (!ID_RE.test(id)) return json(res, 400, { error: 'bad id' });
    const uid = String(v.user.id);
    const bt = 'bt:' + id;

    const chatPtr = await kvPipeline([['GET', 'chat:u:' + uid]]);
    const ci = chatPtr && chatPtr[0] && chatPtr[0].result;

    const out = await kvPipeline([['HGETALL', bt]]);
    const meta = hashToObj(out[0] && out[0].result);
    if (!meta.ends) return json(res, 404, { error: 'not found' });
    const side = ci && ci === meta.chatA ? 'A' : ci && ci === meta.chatB ? 'B' : null;
    if (!side) return json(res, 403, { error: 'not a member' });

    const newEnds = Date.now() + 5 * 60 * 1000;
    const curEnds = Number(meta.ends) || 0;
    if (newEnds >= curEnds) return json(res, 200, { ok: true, ends: curEnds, unchanged: true });

    await kvPipeline([['HSET', bt, 'ends', String(newEnds)]]);
    return json(res, 200, { ok: true, ends: newEnds });
}

module.exports = async (req, res) => {
    if (!kvConfigured() || !botConfigured()) {
        return json(res, 503, { disabled: true });
    }

    try {
        if (req.method === 'GET') {
            const query = req.query || {};
            if (query.op === 'state') return await opState(res, query);
            if (query.op === 'chatState') return await opChatState(res, query);
            return json(res, query.op ? 405 : 400, { error: query.op ? 'GET is for op=state/chatState only' : 'no op' });
        }
        if (req.method === 'POST') {
            const body = readBody(req);
            if (!body || !body.op) return json(res, 400, { error: 'no op' });
            if (body.op === 'create') return await opCreate(res, body);
            if (body.op === 'join') return await opJoin(res, body);
            if (body.op === 'submit') return await opSubmit(res, body);
            if (body.op === 'devExpire') return await opDevExpire(res, body);
            if (body.op === 'chatJoinOrFound') return await opChatJoinOrFound(res, body);
            if (body.op === 'chatLeave') return await opChatLeave(res, body);
            if (body.op === 'chatRename') return await opChatRename(res, body);
            if (body.op === 'state' || body.op === 'chatState') return json(res, 405, { error: body.op + ' is GET' });
            return json(res, 400, { error: 'unknown op' });
        }
        return json(res, 405, { error: 'GET or POST' });
    } catch (e) {
        return json(res, 502, { error: 'kv unavailable' });
    }
};
