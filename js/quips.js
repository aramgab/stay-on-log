// === DEATH QUIPS ===
// The funny one-liner under «УПАЛ! Очки: N» explaining WHY the run ended.
// Two jobs at once: close the newcomer's "wait, what just happened?" gap
// (playtest insight) and keep the tone light. Cause-specific pools plus
// context pools (recent direction change / storm / high speed) that get
// mixed in when they apply; never repeats the same line twice in a row.

const BY_CAUSE = {
    fall: [
        'Бревно решило, что вы больше не друзья',
        'Гравитация: 1 — ты: 0',
        'Плавание — тоже спорт',
        'Вода мокрая. Проверено.',
        'Ушёл красиво, по дуге',
        'Балансировать легко. Пока бревно не крутится',
    ],
    'hit-knot': [
        'Сучок оказался принципиальным',
        'Этот сучок здесь вообще-то стоял',
        'Сучок засчитал себе победу',
    ],
    'hit-branch': [
        'Ветка передаёт привет',
        'Прыгать надо было выше. И чуть позже',
        'Ветка была против',
    ],
    'hit-double': [
        'Два сучка — двойное уважение',
        'Первый перепрыгнул. Второй обиделся',
        'Ритм — это пока не твоё',
    ],
};

// Context pools take priority: when one applies, the quip is drawn from it
// more often than from the cause pool (they explain the run better).
const BY_CONTEXT = {
    recentChange: [
        'Смена направления застала врасплох. Как понедельник',
        'Стрелка ведь предупреждала…',
        'Развернулось бревно — развернулись планы',
    ],
    storm: [
        'Шторм: 1 — ты: 0',
        'В шторм даже брёвна злее',
    ],
    fast: [
        'На такой скорости даже мысли не держатся',
        'Быстро крутилось. Быстро кончилось',
    ],
};

let lastQuip = '';

function pick(pool) {
    if (pool.length > 1 && pool.indexOf(lastQuip) !== -1) {
        pool = pool.filter((q) => q !== lastQuip);
    }
    return pool[Math.floor(Math.random() * pool.length)];
}

// cause: 'fall' | 'hit-knot' | 'hit-branch' | 'hit-double'
// ctx: { recentChange, storm, fast } (all booleans, all optional)
export function deathQuip(cause, ctx) {
    const contextPool = [];
    if (ctx && ctx.recentChange) contextPool.push(...BY_CONTEXT.recentChange);
    if (ctx && ctx.storm) contextPool.push(...BY_CONTEXT.storm);
    if (ctx && ctx.fast) contextPool.push(...BY_CONTEXT.fast);

    const causePool = BY_CAUSE[cause] || BY_CAUSE.fall;
    // 65%: the context line (it references what actually killed the run).
    const pool = contextPool.length && Math.random() < 0.65 ? contextPool : causePool;
    lastQuip = pick(pool);
    return lastQuip;
}
