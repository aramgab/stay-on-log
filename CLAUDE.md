# CLAUDE.md — гайд для ИИ-агента

Контекст для любой новой сессии. **Источник истины по механике — код в `js/`** (особенно
`config.js`, `game.js`, `obstacles.js`, `input.js`). Этот файл и `README.md` могут отставать —
при расхождении верь коду и поправь доку.

## Что это
«Stay on Log» — мобильная мини-игра на **чистом HTML/CSS/ES-модулях, без сборки и зависимостей**.
Вид с торца на крутящееся бревно (круг), человечек балансирует сверху. **Выложена как Telegram
Mini App: `t.me/StayOnLog_bot/game`** (бот `@StayOnLog_bot`; токен — секрет, хранится у
владельца, в репо/коде его нет и не должно быть). TG-интеграция: `ready()/expand()`, haptics,
ник из TG-профиля, рекорд/ник в `CloudStorage`, «Похвастаться» шарит deep-link Mini App.
Нет лидерборда — ждёт бэкенда (этап 3; токен тогда пойдёт в env Vercel для валидации initData).

Деплой: **Vercel из ветки `main`**, без конфигурации → https://stay-on-log.vercel.app

## Управление и платформа
- Управление — **наклон/вращение телефона** (`devicemotion` → `accelerationIncludingGravity`).
  Две схемы (диспетчер в `input.js`): **A «штурвал»** (дефолт) — игрок «подкручивает» телефон,
  компенсируя вращение бревна; **B «наклон-руль»** (`stayOnLog_controlScheme='tilt'`) —
  удержание наклона → скорость докрутки (`TILT_*` в config.js), интеграция в `gameLoop` через
  `dtF`, калибровка нуля в конце отсчёта. Переключатель схемы и слайдеры B — пока в `?dev=1`.
- Первый старт ведёт в **интерактивный туториал** (баланс 4с в ±45° → прыжок через сучок;
  `?tut=1` — принудительный повтор; флаг `stayOnLog_seenTutorial_v1` пишется на финише/скипе).
  Коуч-баннеры первых забегов: «ТАПНИ — ПРЫЖОК!» и подсказка руления при сносе (`HINT_*`,
  счётчик `stayOnLog_runCount`). Автопоказ howto-оверлея ретайрнут (остался за кнопкой `?`).
- Уход дальше **±`FALL_THRESHOLD` (110°)** от верха → падение в воду.
- **Десктоп**: заглушка «играй на телефоне», но в ней кнопка «🎹 Играть с клавиатурой»
  (←/→ — баланс, Space/↑ — прыжок) — честный запасной режим, чтобы расшаренные ссылки в
  Desktop Telegram/браузере не упирались в тупик. **`?dev=1`** скипает заглушку и добавляет
  живую панель тюнинга инпута. iOS требует HTTPS и `DeviceMotionEvent.requestPermission()`
  (вызывается в жесте Start).

## Рабочий процесс (важно!)
Геймплей **нельзя проверить локально/в песочнице**: нужен реальный сенсор телефона, а превью-сервер
в агентских песочницах падает на `getcwd` (`Operation not permitted`). Поэтому цикл такой:
1. Правка → `git push` в `main`.
2. **Ручной тест на реальном телефоне** по задеплоенному URL.
3. Если сломалось — откат: `git revert --no-edit <sha> && git push`.
- Делай изменения **маленькими отдельными коммитами** — так откат точечный.
- На маке пользователя нет node; синтакс-чек модулей перед пушем:
  `/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc -m js/game.js`
  (`ReferenceError: document` = парсинг всего графа прошёл; страшен только `SyntaxError`).
- Фил инпута/прыжка субъективен и зависит от устройства: где можно, выноси в **тюнинг-константы**
  (`config.js`) и в живые слайдеры `?dev=1`, чтобы пользователь сам подобрал, а не гонять передеплои.
- Сообщения коммитов заканчивай строкой `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Архитектура (модули `js/`)
| Файл | Ответственность |
|------|------------------|
| `config.js` | **Все тюнинг-константы**: скорости, тайминги сложности, геометрия, инпут, препятствия, scoring. |
| `state.js` | Единый мутабельный объект `state` + обёртки `lsGet/lsSet` (localStorage, гард от исключений в webview). |
| `dom.js` | Кэш ссылок на DOM (резолвятся один раз; модули deferred). |
| `input.js` | Акселерометр → угол, диспетчер двух схем. A: EMA по **скорости** (`velEMA`) → накопление в `contAngle` → low-pass позиции в `userAngle`. B: только глитч-гардный EMA наклона в `tiltEMA` (посев первым сэмплом!), интеграция rate — в `gameLoop` через `dtF`. Дедзона, чувствительность, `getScheme/setScheme`. |
| `game.js` | Точка входа: главный цикл (`gameLoop`), поток игры, сложность, биомы (`applyBiome`), комбо, UI, ник, **туториал** (`tutorialMode`: elapsed заморожен, `tutorialTick` 3 шага, мягкий ресет `userAngle=-logAngle`), коуч-баннеры, dev-режим, привязка событий. |
| `obstacles.js` | Одно препятствие со стейт-машиной `submerged ⇄ active`, **3 типа** (`knot`/`branch`/`double` из `OBSTACLE_TYPES`), многоточечные коллизии (`parts`). Возвращает `'hit' | 'cleared' | null`. Пробы для честности: `isObstacleActive/activeObstacleType/isObstacleApproaching`. |
| `render.js` | Анимация падения в воду + брызги. |
| `audio.js` | Синтез-SFX (Web Audio): `jump/hit/splash/point/combo/whoosh` + **процедурная музыка** (бас/арпеджио/пад, lookahead-планировщик; `music.setMood(biome)` меняет BPM/лад/плотность по биому, ассетов нет). Mute в localStorage, unmute возвращает музыку сразу. `AudioContext` ленивый, резюм по жесту. |
| `haptics.js` | Вибрация: сначала Telegram `HapticFeedback`, иначе `navigator.vibrate`. События: jump/hit/fall/clear(combo)/tick/record. На десктопе/iOS Safari — no-op. |
| `tg.js` | Мост к Telegram WebApp SDK (весь доступ к `window.Telegram` — только отсюда): `initTelegram`, `isInTelegram` (по непустой `initData`!), `tgUser`, `cloudGet/cloudSet` (CloudStorage, гард версии ≥6.9), `shareScore` (TG share → Web Share → clipboard). Вне TG всё деградирует в no-op. |
| `fx.js` | «Сочность»: `screenShake`, `burst` (частицы, Web Animations API), `floatText` (попап «+50 ×2»), `countUp`. DOM-based, без canvas. |

Визуал: палитра сцены — CSS-переменные, зарегистрированные через `@property` (`styles.css`);
биом = класс `biome-*` на `<body>` (день→закат 40с→ночь 80с→шторм 140с), градиенты кроссфейдятся
сами. Небо/вода/бревно/лицо персонажа — чистый SVG/CSS, анимации только transform/opacity.

## Текущие механики и константы (сверяй с `config.js`!)
- **Scoring событийный**: `score = floor(elapsed / SURVIVAL_MS_PER_POINT=500) + eventScore`
  (≈2 очка/сек выживания + `OBSTACLE_CLEAR_POINTS=25` × комбо-множитель за перепрыгнутое).
  **Комбо**: серия `cleared` без удара, множитель `min(combo, COMBO_MAX_MULT=5)`, сброс на hit.
  Рекорд под ключом `stayOnLog_highScore_v2` (старый таймерный рекорд ретайрнут).
- **Сложность по времени** (не по очкам): фаза 1 < `PHASE1_MS=40s` (скорость ≤50%),
  фаза 2 < `PHASE2_MS=80s` (блок «разворот + высокая скорость с обеих сторон»), дальше без ограничений.
  Биомы привязаны к тем же вехам (+шторм на 140с).
- **Препятствия**: грейс `OBSTACLE_START_MS=12s`, затем одно за раз; окно `COLLIDE_WINDOW=16°`;
  кулдаун `1–3` оборота × `OBSTACLE_COOLDOWN_PHASE_SCALE=[1,0.7,0.5]` по фазам.
  Типы: `knot` (с фазы 1), `branch` (с фазы 2, `cleared` только в средней части прыжка,
  маржа `midAirMarginMs=80`), `double` (с фазы 3, только при `|speed|≤1.2`, гэп от скорости).
  **Честность**: при активном препятствии реверс → смена только скорости; при активном double
  заморожено всё; стрелка `#ob-side-hint` показывает сторону подхода.
- **Прыжок**: `JUMP_DURATION=620ms` (параболическая дуга, синхронизирован с CSS `playerJump`);
  в воздухе столкновение засчитывается как `cleared` (кроме `branch` — см. выше);
  `doJump()` пишет `state.jumpStartTime`.
- **Жизни**: `START_HP=2`, после не-смертельного удара неуязвимость `INVULN_DURATION=900ms`.
- **Инпут**: `INPUT_SMOOTH=0.18` (поз. low-pass), `INPUT_VEL_SMOOTH=0.2` (EMA скорости),
  `INPUT_DEADZONE=0.25°`, `INPUT_MAX_STEP=80°` (глитч-гард), `DEFAULT_SENSITIVITY=1.0`.
  localStorage: `stayOnLog_sensitivity`, `stayOnLog_inputSmooth`.
- **Steering assist**: игра компенсирует долю вращения бревна за игрока —
  `ASSIST_PHASE_FACTOR=[0.30,0.18,0.10]` по фазам × слайдер «assist» в `?dev=1`
  (`stayOnLog_assistMult`). В `gameLoop` правится **оба** угла (`contAngle`+`userAngle`),
  иначе low-pass инпута съедает поправку.
- **Danger-виньетка**: `#danger-vignette` — красный градиент со стороны сноса, прозрачность
  0→1 от `DANGER_WARN_FROM=55°` до `FALL_THRESHOLD`; сбрасывается в `gameOver`/`showCountdown`.
- **Delta-time**: скорости (`logSpeed`, `DEV_KEY_SPEED`) = «градусы за кадр 60 Гц»; `gameLoop`
  масштабирует весь шаг мира на `dtF` (клэмп дельты 50мс) — темп одинаков на 60/90/120 Гц.
  `state.elapsed` копится по живым кадрам: фон/свёртывание не фармит очки и не двигает фазы.
  Таймер смены направления — в elapsed-домене.
- **TG-нативность**: ник по умолчанию из TG-профиля (приоритет: введённый вручную >
  CloudStorage > профиль; см. `nameSource` в game.js); рекорд/ник синхронятся с CloudStorage
  (merge: больший рекорд побеждает). Шаринг: `SHARE_URL` в config.js — заменить на
  `t.me/<bot>/<app>?startapp=…`, когда появится бот.

## Грабли
- **Репозиторий публичный** — не клади сюда секреты/приватное.
- Звук стартует только после жеста пользователя (политика автоплея) — `initAudio()` в `handleStartClick`.
- `localStorage` может бросать в приватных webview — всегда через `lsGet/lsSet`.
- Не предлагать переписать на фреймворк: проект **намеренно** статическая ваниль.

## Дальше
Беклог, приоритеты (P0–P3) и дизайн-заметки — в [`docs/ROADMAP.md`](docs/ROADMAP.md).
