// /api/battle — chat-vs-chat battles, one function with op routing to stay
// well inside the Vercel Hobby function limit:
//   GET  ?op=state&id=..&uid=..          — live scoreboard (uid only marks "you")
//   POST {op:'create', initData, name?}  — start a battle, creator joins side A
//   POST {op:'join',   initData, id, side?}
//   POST {op:'submit', initData, id, runId, score}
//   POST {op:'rename', initData, id, name}
//
// Teams are formed by the SIGNED chat_instance from initData (the anonymous
// per-chat fingerprint Telegram attaches when the app is opened from a chat):
// the creator's chat is side A, the first foreign chat claims side B, users
// keep their side forever. No chat_instance (private chat / a third chat) —
// the client asks the player to pick a side (fallback).
//
// Scoring: team score = SUM of every run of every member inside the 24h
// window. Dedup across revive: the client submits (runId, score) on every
// game over of one run; the server stores the last submitted score per
// uid:runId and increments the team only by the positive delta.
//
// Keys (prefix bt:, TTL = 24h window + 7d grace to view the result):
//   bt:<id>          HASH  created ends creator ciA? ciB? nameA nameB
//                          nameSetByA? nameSetByB? scoreA scoreB
//                          (ci*/nameSetBy* are CLAIMED via HSETNX, so they
//                           are omitted at create when unknown — never
//                           pre-written as '')
//   bt:<id>:members  HASH  uid -> 'A' | 'B'   (HSETNX only — side is forever)
//   bt:<id>:contrib  HASH  uid -> total contributed
//   bt:<id>:names    HASH  uid -> display name from VERIFIED initData
//   bt:<id>:runs     HASH  "<uid>:<runId>" -> last submitted score of the run
//   bt:u:<uid>       STR   active battle id (anti-spam: one battle per user)

const crypto = require('crypto');
const { kvConfigured, botConfigured, kvPipeline, validateInitData } = require('./_kv.js');

const BATTLE_WINDOW_MS = 24 * 60 * 60 * 1000;
const TTL_S = 8 * 24 * 60 * 60;          // window + grace, applied to every bt:<id>* key
const PTR_TTL_S = 24 * 60 * 60;          // bt:u pointer lives only for the window
const MAX_SCORE = 50000;                 // same sanity cap as api/score.js
const NAME_MAX = 24;
const TOP_N = 10;
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
        .replace(/[\u0000-\u001F\u007F]/g, '')
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

async function opCreate(res, body) {
    const v = validateInitData(String(body.initData || ''));
    if (!v) return json(res, 403, { error: 'invalid initData' });
    const uid = String(v.user.id);
    const now = Date.now();

    // One battle per user: if the pointed-to battle is still running, send
    // the client there instead of creating a parallel one.
    const ptr = await kvPipeline([['GET', 'bt:u:' + uid]]);
    const oldId = ptr && ptr[0] && ptr[0].result;
    if (oldId) {
        const old = await kvPipeline([['HGET', 'bt:' + oldId, 'ends']]);
        const oldEnds = old && old[0] && Number(old[0].result);
        if (oldEnds && now < oldEnds) {
            return json(res, 409, { error: 'already_active', id: oldId });
        }
    }

    const ci = groupCi(v);
    const nameA = sanitizeName(body.name, 'Команда А');
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
    const meta = ['HSET', bt,
        'ends', String(ends),
        'creator', uid,
        'nameA', nameA,
        'nameB', 'Команда Б',
        'nameSetByA', uid,
        'scoreA', '0',
        'scoreB', '0',
    ];
    if (ci) meta.push('ciA', ci);

    await kvPipeline([
        meta,
        ['HSETNX', bt + ':members', uid, 'A'],
        ['HSET', bt + ':names', uid, displayName(v.user)],
        ['EXPIRE', bt, String(TTL_S)],
        ['EXPIRE', bt + ':members', String(TTL_S)],
        ['EXPIRE', bt + ':names', String(TTL_S)],
        ['SET', 'bt:u:' + uid, id, 'EX', String(PTR_TTL_S)],
    ]);

    return json(res, 200, { ok: true, id, side: 'A', ends, nameA, nameB: 'Команда Б', ciBound: Boolean(ci) });
}

async function opJoin(res, body) {
    const v = validateInitData(String(body.initData || ''));
    if (!v) return json(res, 403, { error: 'invalid initData' });
    const id = String(body.id || '');
    if (!ID_RE.test(id)) return json(res, 400, { error: 'bad id' });
    const uid = String(v.user.id);
    const bt = 'bt:' + id;
    const now = Date.now();

    const out = await kvPipeline([
        ['HGETALL', bt],
        ['HGET', bt + ':members', uid],
        ['GET', 'bt:u:' + uid],
    ]);
    const meta = hashToObj(out[0] && out[0].result);
    if (!meta.ends) return json(res, 404, { error: 'not found' });
    const view = battleView(meta);
    if (now > view.ends) {
        return json(res, 410, Object.assign({ finished: true, winner: winnerOf(meta) }, view));
    }

    const memberSide = out[1] && out[1].result;
    const ci = groupCi(v);

    if (memberSide) {
        // Side is forever. Opportunistic ci bind: a member arriving from a
        // group chat that nobody owns yet welds it to HIS side — this is how
        // a creator who started from a private chat attaches his real chat
        // (he opens his own rally link from inside it).
        let bound = false;
        if (ci && ci !== meta.ciA && ci !== meta.ciB && !meta['ci' + memberSide]) {
            const claim = await kvPipeline([
                ['HSETNX', bt, 'ci' + memberSide, ci],
                ['HGET', bt, 'ci' + memberSide],
            ]);
            bound = Boolean(claim && claim[1] && claim[1].result === ci);
        }
        return json(res, 200, Object.assign({
            ok: true, side: memberSide, youNameIt: false, ciBound: bound,
        }, view));
    }

    // Not a member yet: refuse if he already fights elsewhere (alive).
    const otherId = out[2] && out[2].result;
    if (otherId && otherId !== id) {
        const other = await kvPipeline([['HGET', 'bt:' + otherId, 'ends']]);
        const otherEnds = other && other[0] && Number(other[0].result);
        if (otherEnds && now < otherEnds) {
            return json(res, 409, { error: 'already_in_battle', id: otherId });
        }
    }

    // Resolve the side.
    let side = '';
    if (ci && ci === meta.ciA) side = 'A';
    else if (ci && ci === meta.ciB) side = 'B';
    else if (ci) {
        // Unknown group chat: claim the free side — B first (the canonical
        // flow creates the battle from the home chat, so the first foreign
        // chat IS the enemy), then A (creator-from-DMs case).
        for (const s of ['B', 'A']) {
            if (side) break;
            if (meta['ci' + s]) continue;
            const claim = await kvPipeline([
                ['HSETNX', bt, 'ci' + s, ci],
                ['HGET', bt, 'ci' + s],
            ]);
            const actual = claim && claim[1] && claim[1].result;
            if (actual === ci) side = s;
            else meta['ci' + s] = actual || meta['ci' + s]; // lost the race — remember and move on
        }
        if (!side) return json(res, 409, { needSide: true, nameA: view.nameA, nameB: view.nameB });
    } else {
        // No chat fingerprint (DMs / desktop): manual pick from the client.
        if (body.side === 'A' || body.side === 'B') side = body.side;
        else return json(res, 409, { needSide: true, nameA: view.nameA, nameB: view.nameB });
    }

    // Fix membership (first write wins; on a race we return the actual side)
    // and detect "you are the first here — name your team".
    const fix = await kvPipeline([
        ['HSETNX', bt + ':members', uid, side],
        ['HGET', bt + ':members', uid],
    ]);
    const actualSide = (fix && fix[1] && fix[1].result) || side;

    const nameClaim = await kvPipeline([
        ['HSETNX', bt, 'nameSetBy' + actualSide, uid],
        ['HGET', bt, 'nameSetBy' + actualSide],
        ['HSET', bt + ':names', uid, displayName(v.user)],
        ['SET', 'bt:u:' + uid, id, 'EX', String(PTR_TTL_S)],
        ['EXPIRE', bt, String(TTL_S)],
        ['EXPIRE', bt + ':members', String(TTL_S)],
        ['EXPIRE', bt + ':names', String(TTL_S)],
    ]);
    const youNameIt = Boolean(nameClaim && nameClaim[1] && nameClaim[1].result === uid);

    return json(res, 200, Object.assign({ ok: true, side: actualSide, youNameIt }, view));
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
        ['HGETALL', bt + ':members'],
        ['HGETALL', bt + ':names'],
    ]);
    const meta = hashToObj(out[0] && out[0].result);
    if (!meta.ends) return json(res, 404, { error: 'not found' });
    const contrib = hashToObj(out[1] && out[1].result);
    const members = hashToObj(out[2] && out[2].result);
    const names = hashToObj(out[3] && out[3].result);

    const view = battleView(meta);
    const finished = now > view.ends;

    const rows = { A: [], B: [] };
    for (const u in contrib) {
        const s = members[u];
        if (!rows[s]) continue;
        rows[s].push({ name: names[u] || 'Игрок', score: Number(contrib[u]) || 0, you: u === uid });
    }
    const top = (s) => {
        rows[s].sort((a, b) => b.score - a.score);
        const t = rows[s].slice(0, TOP_N);
        const mine = rows[s].find((r) => r.you);
        if (mine && t.indexOf(mine) === -1) t.push(mine);
        return t;
    };

    // Short shared cache: the poll while the overlay is open rides this.
    res.setHeader('Cache-Control', 's-maxage=5, stale-while-revalidate=15');
    return json(res, 200, Object.assign({
        id,
        now,
        finished,
        winner: finished ? winnerOf(meta) : null,
        topA: top('A'),
        topB: top('B'),
        me: uid && members[uid]
            ? { side: members[uid], score: Number(contrib[uid]) || 0 }
            : null,
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

    const out = await kvPipeline([
        ['HGETALL', bt],
        ['HGET', bt + ':members', uid],
        ['HGET', bt + ':runs', runKey],
        ['HGET', bt + ':contrib', uid],
    ]);
    const meta = hashToObj(out[0] && out[0].result);
    if (!meta.ends) return json(res, 404, { error: 'not found' });
    const side = out[1] && out[1].result;
    if (side !== 'A' && side !== 'B') return json(res, 403, { error: 'not a member' });
    const view = battleView(meta);
    if (now > view.ends) return json(res, 410, Object.assign({ finished: true, winner: winnerOf(meta) }, view));

    const old = Number(out[2] && out[2].result) || 0;
    const myTotal = Number(out[3] && out[3].result) || 0;
    const delta = score - old;
    if (delta <= 0) {
        // Same run resubmitted with no growth (or a replayed request) — a no-op.
        return json(res, 200, Object.assign({ ok: true, unchanged: true, myTotal }, view));
    }

    const inc = await kvPipeline([
        ['HSET', bt + ':runs', runKey, String(score)],
        ['HINCRBY', bt, 'score' + side, String(delta)],
        ['HINCRBY', bt + ':contrib', uid, String(delta)],
        ['EXPIRE', bt + ':runs', String(TTL_S)],
        ['EXPIRE', bt + ':contrib', String(TTL_S)],
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

async function opRename(res, body) {
    const v = validateInitData(String(body.initData || ''));
    if (!v) return json(res, 403, { error: 'invalid initData' });
    const id = String(body.id || '');
    if (!ID_RE.test(id)) return json(res, 400, { error: 'bad id' });
    const uid = String(v.user.id);
    const bt = 'bt:' + id;
    const now = Date.now();

    const out = await kvPipeline([
        ['HGETALL', bt],
        ['HGET', bt + ':members', uid],
    ]);
    const meta = hashToObj(out[0] && out[0].result);
    if (!meta.ends) return json(res, 404, { error: 'not found' });
    const side = out[1] && out[1].result;
    const view = battleView(meta);

    // Naming right: only the member who claimed the team name slot, only
    // while his team has not scored yet, only while the battle runs.
    const allowed = (side === 'A' || side === 'B')
        && meta['nameSetBy' + side] === uid
        && (Number(meta['score' + side]) || 0) === 0
        && now <= view.ends;
    if (!allowed) return json(res, 403, { error: 'locked' });

    const name = sanitizeName(body.name, side === 'A' ? 'Команда А' : 'Команда Б');
    await kvPipeline([['HSET', bt, 'name' + side, name]]);

    return json(res, 200, {
        ok: true,
        nameA: side === 'A' ? name : view.nameA,
        nameB: side === 'B' ? name : view.nameB,
    });
}

// Dev-only (?dev=1 client gate): fast-forward the caller's OWN battle to end
// in 5 minutes, so the win/lose/draw screens can be playtested without
// waiting out the real 24h window. Membership is the entire authorization
// surface (mirrors opRename). Only ever shortens `ends` — never extends it —
// which as a side effect also refuses to resurrect an already-finished battle
// (its `ends` is in the past, so `newEnds >= curEnds` is always true there).
async function opDevExpire(res, body) {
    const v = validateInitData(String(body.initData || ''));
    if (!v) return json(res, 403, { error: 'invalid initData' });
    const id = String(body.id || '');
    if (!ID_RE.test(id)) return json(res, 400, { error: 'bad id' });
    const uid = String(v.user.id);
    const bt = 'bt:' + id;

    const out = await kvPipeline([
        ['HGETALL', bt],
        ['HGET', bt + ':members', uid],
    ]);
    const meta = hashToObj(out[0] && out[0].result);
    if (!meta.ends) return json(res, 404, { error: 'not found' });
    const side = out[1] && out[1].result;
    if (side !== 'A' && side !== 'B') return json(res, 403, { error: 'not a member' });

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
            return json(res, query.op ? 405 : 400, { error: query.op ? 'GET is for op=state only' : 'no op' });
        }
        if (req.method === 'POST') {
            const body = readBody(req);
            if (!body || !body.op) return json(res, 400, { error: 'no op' });
            if (body.op === 'create') return await opCreate(res, body);
            if (body.op === 'join') return await opJoin(res, body);
            if (body.op === 'submit') return await opSubmit(res, body);
            if (body.op === 'rename') return await opRename(res, body);
            if (body.op === 'devExpire') return await opDevExpire(res, body);
            if (body.op === 'state') return json(res, 405, { error: 'state is GET' });
            return json(res, 400, { error: 'unknown op' });
        }
        return json(res, 405, { error: 'GET or POST' });
    } catch (e) {
        return json(res, 502, { error: 'kv unavailable' });
    }
};
