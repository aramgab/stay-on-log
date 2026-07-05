// POST /api/score  { initData, score }
// Validates the Telegram initData signature server-side (only real Telegram
// users can submit, and only as themselves), sanity-caps the score, and
// writes it to the leaderboard sorted set with ZADD GT — a submission can
// only ever RAISE a player's stored best. The display name comes from the
// VERIFIED initData user, never from a client-supplied field.

const { kvConfigured, botConfigured, kvPipeline, validateInitData } = require('./_kv.js');

// Hard sanity cap: ~2 pts/sec survival + clears means a legit hour-long god
// run stays way below this; anything above is a forged request.
const MAX_SCORE = 50000;

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'POST only' });
        return;
    }
    if (!kvConfigured() || !botConfigured()) {
        res.status(503).json({ disabled: true });
        return;
    }

    let body = req.body;
    if (typeof body === 'string') {
        try {
            body = JSON.parse(body);
        } catch (e) {
            body = null;
        }
    }
    const initData = body && body.initData;
    const score = body ? Math.floor(Number(body.score)) : NaN;
    if (!initData || !Number.isFinite(score) || score <= 0 || score > MAX_SCORE) {
        res.status(400).json({ error: 'bad request' });
        return;
    }

    const user = validateInitData(String(initData));
    if (!user || !user.id) {
        res.status(403).json({ error: 'invalid initData' });
        return;
    }

    const uid = String(user.id);
    const name = String(user.first_name || user.username || 'Игрок').slice(0, 16);

    try {
        const out = await kvPipeline([
            ['ZADD', 'lb', 'GT', String(score), uid],
            ['HSET', 'lb:names', uid, name],
            ['ZREVRANK', 'lb', uid],
        ]);
        const rank = out && out[2] && typeof out[2].result === 'number'
            ? out[2].result + 1
            : null;
        res.status(200).json({ ok: true, rank });
    } catch (e) {
        res.status(502).json({ error: 'kv unavailable' });
    }
};
