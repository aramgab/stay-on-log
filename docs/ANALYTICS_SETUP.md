# Включение аналитики (PostHog, 5 минут, один раз)

Код уже задеплоен: `js/analytics.js` сам подхватит ключ, как только он появится в
`js/config.js`. Пока `POSTHOG_KEY` пустой, модуль не грузит скрипт вообще — ноль
сетевых запросов, игра работает точно как до этого файла. Как и с лидербордом
(`docs/BACKEND_SETUP.md`), включение — на стороне владельца, агент аккаунт завести
не может.

## 1. Завести аккаунт и проект

1. [posthog.com](https://posthog.com) → **Get started free** (без карты).
2. При создании проекта выбери регион (US или EU — это data residency, не принципиально
   для хобби-проекта с друзьями). Запомни, какой выбрал — понадобится в шаге 2.
3. В настройках проекта (**Project settings → General**) найди **Project API key**
   (начинается с `phc_`) — это НЕ секрет, публичный write-only ключ, как GA id
   (в отличие от `TG_BOT_TOKEN`, его можно спокойно коммитить).

## 2. Вписать ключ

1. Открой [`js/config.js`](../js/config.js), найди `POSTHOG_KEY`/`POSTHOG_HOST` в самом низу
   (секция `=== ANALYTICS (PostHog) ===`).
2. Вставь свой ключ в `POSTHOG_KEY`.
3. Если при регистрации выбрал EU — поменяй `POSTHOG_HOST` на `https://eu.i.posthog.com`
   (по умолчанию стоит `https://us.i.posthog.com`).
4. `git push` — начиная со следующего открытия игры (в Telegram и вне его) события пойдут.

## 3. Проверка

- Открой игру (после деплоя), сыграй один забег до конца.
- В PostHog: **Activity → Live events** — за несколько секунд должны появиться
  `run_start`, `run_end`, автозахваченные клики (`$autocapture`).

## Что уже трекается

| Событие | Когда | Свойства |
|---|---|---|
| `run_start` | старт обычного забега (`startGame()`) | `biome`, `hp`, `control_scheme`, `run_id` |
| `run_end` | смерть/конец забега (`gameOver()`) | `cause` (`fall`/`hit-knot`/`hit-branch`/`hit-double`/`boss-shark`/`boss-orca`), `biome`, `score`, `elapsed_ms`, `coins`, `revived`, `quests_completed`, `control_scheme`, `run_id` |
| `tutorial_start` / `tutorial_complete` / `tutorial_skip` | воронка первого запуска | — |
| `motion_permission_granted` / `motion_permission_denied` | iOS-пермишен на датчики (см. открытый вопрос в `ROADMAP.md`) | — |
| `feature_opened` | открытие магазина/карты/лидерборда/битв | `feature` (`shop`/`map`/`leaderboard`/`battle`) |
| `js_error` | необработанная JS-ошибка или promise rejection | `message`, `source`/`stack` (обрезаны) |
| `$autocapture` | клик по чему угодно ещё (SDK, без нашего кода) | селектор/текст элемента |

Игрок внутри Telegram идентифицируется по TG uid (`posthog.identify`, см. `js/analytics.js`) —
это то, что вообще делает retention/когорты осмысленными (иначе каждая сессия выглядит
новым анонимным визитом). Вне Telegram (десктоп-заглушка/клавиатура) — анонимный
device-id, который PostHog выставляет сам.

Сознательно НЕ включено: video-реплей сессий (`session_recording`) — просили длину сессии,
а не запись экрана; он и так автоматически считается PostHog по таймстемпам событий
одной сессии, без записи видео.

## Как посмотреть retention по квартилям (то, что просил владелец)

PostHog не делит на квартили одной кнопкой — но развилка ниже занимает пару минут:

1. **Insights → New → Trends** → событие `run_end`, group by person, посмотри
   распределение (Distribution) количества забегов на игрока — оттуда прикинь границы
   4 групп (например «1 забег», «2–5», «6–15», «16+» — подставь свои числа по факту
   распределения, не бери мои с потолка).
2. **Cohorts → New cohort** → четыре штуки с условием **Performed event** →
   `run_end` → **Total count** → **between/at least/at most** с границами из шага 1.
   Назови их явно (`Q1 casual`, `Q2`, `Q3`, `Q4 hardcore` и т.п.).
3. **Insights → New → Retention** → **Returning event** `run_end` (или любое) →
   **Breakdown by** → выбери одну из созданных когорт как фильтр (или сравни несколько
   через **Add graph series**, по одной когорте на серию) — получаешь кривую retention
   именно для этого квартиля.

Тот же приём подойдёт и для «прогрессии по очкам» — **Trends** → событие `run_end`,
свойство `score`, агрегация **Average**, по дням/неделям — готовый график, без кода.
