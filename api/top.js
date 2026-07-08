// GET /api/top[?uid=<telegram user id>]
// Returns the global top-10 { top: [{ name, score, you, inBattle }], me } —
// and, when a uid is passed, that player's own rank/score even outside the
// top. Also serves as the client's liveness probe: 503 { disabled } until
// the env is configured, so the game can hide the whole feature gracefully.

const { kvConfigured, kvPipeline } = require('./_kv.js');

module.exports = async (req, res) => {
    if (!kvConfigured()) {
        res.status(503).json({ disabled: true });
        return;
    }

    const uid = req.query && req.query.uid ? String(req.query.uid) : '';
    const cmds = [['ZREVRANGE', 'lb', '0', '9', 'WITHSCORES']];
    if (uid) {
        cmds.push(['ZREVRANK', 'lb', uid]);
        cmds.push(['ZSCORE', 'lb', uid]);
    }

    try {
        const out = await kvPipeline(cmds);
        const flat = (out[0] && out[0].result) || [];
        const uids = [];
        const rows = [];
        for (let i = 0; i < flat.length; i += 2) {
            uids.push(String(flat[i]));
            rows.push({ uid: String(flat[i]), score: Number(flat[i + 1]) || 0 });
        }

        const names = {};
        if (uids.length) {
            const nm = await kvPipeline([['HMGET', 'lb:names', ...uids]]);
            ((nm[0] && nm[0].result) || []).forEach((n, i) => {
                names[uids[i]] = n || 'Игрок';
            });
        }

        // "In battle" status: chat:u:<uid> points at the player's current
        // persistent chat (ci), and chat:<ci>:battle points at that chat's
        // active battle id. A uid is "in battle" iff the battle its CURRENT
        // chat is fighting hasn't ended yet — never trust either pointer
        // alone; always confirm the pointed-to battle's own `ends` is still
        // in the future.
        const allUids = uid && !uids.includes(uid) ? uids.concat(uid) : uids;
        const inBattle = {};
        if (allUids.length) {
            const chatPtrs = await kvPipeline(allUids.map((u) => ['GET', 'chat:u:' + u]));
            const cis = new Set();
            const uidToCi = {};
            chatPtrs.forEach((r, i) => {
                const ci = r && r.result;
                if (ci) { cis.add(ci); uidToCi[allUids[i]] = ci; }
            });
            if (cis.size) {
                const ciList = [...cis];
                const battlePtrs = await kvPipeline(ciList.map((ci) => ['GET', 'chat:' + ci + ':battle']));
                const battleIds = new Set();
                const ciToBid = {};
                battlePtrs.forEach((r, i) => {
                    const bid = r && r.result;
                    if (bid) { battleIds.add(bid); ciToBid[ciList[i]] = bid; }
                });
                if (battleIds.size) {
                    const idList = [...battleIds];
                    const endsOut = await kvPipeline(idList.map((bid) => ['HGET', 'bt:' + bid, 'ends']));
                    const now = Date.now();
                    const bidEnds = {};
                    endsOut.forEach((r, i) => { bidEnds[idList[i]] = Number(r && r.result) || 0; });
                    for (const u in uidToCi) {
                        const bid = ciToBid[uidToCi[u]];
                        if (bid) inBattle[u] = bidEnds[bid] > now;
                    }
                }
            }
        }

        const top = rows.map((r) => ({
            name: names[r.uid] || 'Игрок',
            score: r.score,
            you: Boolean(uid) && r.uid === uid,
            inBattle: Boolean(inBattle[r.uid]),
        }));

        let me = null;
        if (uid && out[1] && typeof out[1].result === 'number') {
            me = {
                rank: out[1].result + 1,
                score: Number(out[2] && out[2].result) || 0,
                inBattle: Boolean(inBattle[uid]),
            };
        }

        res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=30');
        res.status(200).json({ top, me });
    } catch (e) {
        res.status(502).json({ error: 'kv unavailable' });
    }
};
