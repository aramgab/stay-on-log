// GET /api/top[?uid=<telegram user id>]
// Returns the global top-10 { top: [{ name, score, you }], me } — and, when
// a uid is passed, that player's own rank/score even outside the top. Also
// serves as the client's liveness probe: 503 { disabled } until the env is
// configured, so the game can hide the whole feature gracefully.

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

        const top = rows.map((r) => ({
            name: names[r.uid] || 'Игрок',
            score: r.score,
            you: Boolean(uid) && r.uid === uid,
        }));

        let me = null;
        if (uid && out[1] && typeof out[1].result === 'number') {
            me = {
                rank: out[1].result + 1,
                score: Number(out[2] && out[2].result) || 0,
            };
        }

        res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=30');
        res.status(200).json({ top, me });
    } catch (e) {
        res.status(502).json({ error: 'kv unavailable' });
    }
};
