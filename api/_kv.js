// Shared helpers for the leaderboard endpoints (files starting with "_" are
// not deployed as functions by Vercel). Zero npm dependencies: Upstash Redis
// is reached over its REST API with the global fetch of the Node runtime,
// initData is validated with node:crypto.
//
// Env (set in Vercel project settings; endpoints answer 503 until then):
//   TG_BOT_TOKEN                              — bot token (initData HMAC)
//   UPSTASH_REDIS_REST_URL  | KV_REST_API_URL — Upstash REST endpoint
//   UPSTASH_REDIS_REST_TOKEN| KV_REST_API_TOKEN

const crypto = require('crypto');

const BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const KV_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '';
const KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';

// Score submissions older than this (by initData auth_date) are rejected.
const MAX_AUTH_AGE_S = 24 * 60 * 60;

function kvConfigured() {
    return Boolean(KV_URL && KV_TOKEN);
}

function botConfigured() {
    return Boolean(BOT_TOKEN);
}

// Run an array of Redis commands through the Upstash REST pipeline.
// Returns the array of { result } objects (or throws on network failure).
async function kvPipeline(commands) {
    const r = await fetch(KV_URL + '/pipeline', {
        method: 'POST',
        headers: {
            Authorization: 'Bearer ' + KV_TOKEN,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(commands),
    });
    if (!r.ok) throw new Error('kv http ' + r.status);
    return r.json();
}

// Telegram Mini App initData validation (per Telegram docs):
//   secret = HMAC_SHA256(key="WebAppData", msg=bot_token)
//   hash   = hex(HMAC_SHA256(key=secret, msg=data_check_string))
// where data_check_string = sorted "key=value" lines of every field except
// hash, with URL-decoded values. Returns the verified user object or null.
function validateInitData(initData) {
    let params;
    try {
        params = new URLSearchParams(initData);
    } catch (e) {
        return null;
    }
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    const pairs = [];
    for (const [k, v] of params.entries()) pairs.push(k + '=' + v);
    pairs.sort();

    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const expected = crypto
        .createHmac('sha256', secret)
        .update(pairs.join('\n'))
        .digest('hex');

    const a = Buffer.from(expected);
    const b = Buffer.from(String(hash));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    const authDate = parseInt(params.get('auth_date'), 10) || 0;
    if (Math.abs(Date.now() / 1000 - authDate) > MAX_AUTH_AGE_S) return null;

    try {
        return JSON.parse(params.get('user') || 'null');
    } catch (e) {
        return null;
    }
}

module.exports = { kvConfigured, botConfigured, kvPipeline, validateInitData };
