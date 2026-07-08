// === SHOP ===
// The coin sink: a howto-style overlay with two items for now —
//   - "Твоё бревно": the player's Telegram avatar clipped onto the log face
//     (premium skin; needs to be inside Telegram with a visible photo);
//   - "Запасное сердце": a consumable that starts the NEXT run with +1 hp.
// Purchases/equip state live in localStorage and sync to CloudStorage the
// same way the high score does (skins never "spend", so a max/union merge
// is safe — unlike the wallet, which stays local-only for now).

import { state, lsGet, lsSet } from './state.js';
import { AVATAR_SKIN_PRICE, SPARE_HEART_PRICE, SKINS, SKIN_RARITY } from './config.js';
import { track } from './analytics.js';
import {
    logSvg,
    playerEl,
    fallingPlayerEl,
    shopBtn,
    shopOverlay,
    shopBalanceEl,
    shopMannequin,
    shopTabs,
    shopSubtabs,
    shopGrid,
    shopCloseBtn,
} from './dom.js';
import { isInTelegram, tgUser, cloudGet, cloudSet } from './tg.js';
import { sfx, initAudio } from './audio.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

// Owned = a set of skin ids (avatar_log + character-skin ids like head_cap,
// body_cape, suit_ninja). Equipped is per slot: `log` dresses the log face,
// head/body/legs/suit dress the character. A suit is a full costume that
// overrides the individual slots (see applyCharSkin).
let ownedSkins = (lsGet('stayOnLog_ownedSkins') || '').split(',').filter(Boolean);

const EQUIP_KEYS = {
    log: 'stayOnLog_equipLog',
    head: 'stayOnLog_equipHead',
    body: 'stayOnLog_equipBody',
    legs: 'stayOnLog_equipLegs',
    suit: 'stayOnLog_equipSuit',
};
const equip = { log: '', head: '', body: '', legs: '', suit: '' };

function loadEquip() {
    for (const slot in EQUIP_KEYS) equip[slot] = lsGet(EQUIP_KEYS[slot]) || '';
    // Migrate the legacy single-slot key (held 'avatar_log' or '') into the
    // new per-slot log key, once, so old installs keep their log avatar.
    const legacy = lsGet('stayOnLog_equippedSkin');
    if (legacy && !equip.log) {
        equip.log = legacy;
        lsSet(EQUIP_KEYS.log, legacy);
    }
    if (legacy !== null && legacy !== '') lsSet('stayOnLog_equippedSkin', '');
}
loadEquip();

// game.js hands us its HUD refresher via initShop() — shop.js can't import
// game.js back without a cycle.
let onWalletChange = null;

// Wallet write-through used by every purchase (and by revive in game.js).
export function spendCoins(amount) {
    if (state.coins < amount) return false;
    state.coins -= amount;
    lsSet('stayOnLog_coins', String(state.coins));
    if (onWalletChange) onWalletChange();
    return true;
}

// --- Spare heart (consumable) ---
export function hasPendingHeart() {
    return lsGet('stayOnLog_pendingHeart') === '1';
}

export function consumePendingHeart() {
    lsSet('stayOnLog_pendingHeart', '');
}

// --- Avatar-on-the-log skin ---
function avatarUrl() {
    const u = tgUser();
    return (u && u.photo_url) || '';
}

function ownsAvatar() {
    return ownedSkins.indexOf('avatar_log') !== -1;
}

function persistOwned() {
    lsSet('stayOnLog_ownedSkins', ownedSkins.join(','));
    cloudSet('stayOnLog_ownedSkins', ownedSkins.join(','));
}

function persistSlot(slot) {
    lsSet(EQUIP_KEYS[slot], equip[slot]);
    cloudSet(EQUIP_KEYS[slot], equip[slot]);
}

// Insert (or update) the avatar <image> inside the log-face SVG. It sits
// right under the ambient-shading circle, so the log keeps its depth; the
// bark ring stays visible around the clipped photo. Rotates with the log
// for free — it lives inside #log-svg.
function applyLogSkin() {
    const url = equip.log === 'avatar_log' ? avatarUrl() : '';
    let img = logSvg.querySelector('#avatar-skin-img');
    if (!url) {
        if (img) img.remove();
        return;
    }
    if (!logSvg.querySelector('#avatarClip')) {
        const clip = document.createElementNS(SVG_NS, 'clipPath');
        clip.setAttribute('id', 'avatarClip');
        const c = document.createElementNS(SVG_NS, 'circle');
        c.setAttribute('cx', '140');
        c.setAttribute('cy', '140');
        c.setAttribute('r', '112');
        clip.appendChild(c);
        logSvg.querySelector('defs').appendChild(clip);
    }
    if (!img) {
        img = document.createElementNS(SVG_NS, 'image');
        img.setAttribute('id', 'avatar-skin-img');
        img.setAttribute('x', '28');
        img.setAttribute('y', '28');
        img.setAttribute('width', '224');
        img.setAttribute('height', '224');
        img.setAttribute('preserveAspectRatio', 'xMidYMid slice');
        img.setAttribute('clip-path', 'url(#avatarClip)');
        // Photo URL can expire/be blocked — drop the image quietly, the
        // plain wood face is always underneath.
        img.addEventListener('error', () => img.remove());
        const shade = logSvg.querySelector('circle[fill="url(#logShadow)"]');
        logSvg.insertBefore(img, shade);
    }
    img.setAttribute('href', url);
    img.setAttributeNS(XLINK_NS, 'xlink:href', url); // older webviews
}

// --- Character skins ---
// The equipped slots map to toggle classes on the figure root; a suit
// (costume) wins and suppresses the individual slots. Ids are prefixed by
// slot ('head_cap', 'suit_ninja'), so the class strips the prefix.
function charClasses() {
    const cls = [];
    if (equip.suit) {
        cls.push('char-costume-' + equip.suit.replace('suit_', ''));
    } else {
        if (equip.head) cls.push('char-head-' + equip.head.replace('head_', ''));
        if (equip.body) cls.push('char-body-' + equip.body.replace('body_', ''));
        if (equip.legs) cls.push('char-legs-' + equip.legs.replace('legs_', ''));
    }
    return cls;
}

// #player is an SVG element — its `.className` is an SVGAnimatedString, so
// classes MUST go through classList, never `el.className = ...`.
function applyClasses(el) {
    if (!el) return;
    Array.prototype.slice.call(el.classList).forEach((c) => {
        if (c.indexOf('char-head-') === 0 || c.indexOf('char-body-') === 0 ||
            c.indexOf('char-legs-') === 0 || c.indexOf('char-costume-') === 0) {
            el.classList.remove(c);
        }
    });
    charClasses().forEach((c) => el.classList.add(c));
}

// The shop mannequin is a static, animation-frozen clone of #player (css
// freezes it) that always shows the equipped look.
let mannequinFig = null;

function buildMannequin() {
    if (!shopMannequin || mannequinFig) return;
    const clone = playerEl.cloneNode(true);
    clone.removeAttribute('id');
    clone.removeAttribute('style');
    clone.setAttribute('class', 'char-fig'); // drop #player state classes
    shopMannequin.appendChild(clone);
    mannequinFig = clone;
}

function applyCharSkin() {
    applyClasses(playerEl);
    applyClasses(fallingPlayerEl); // keep the fall clone dressed too
    if (mannequinFig) applyClasses(mannequinFig);
}

// --- Overlay UI ---
// Two-level tabs: activeGroup picks Скины/Сундуки/Прочее; activeSlot only
// matters while activeGroup is 'skins' (it picks the sub-tab within it).
let activeGroup = 'skins';
let activeSlot = 'head';

function isOwned(id) {
    return ownedSkins.indexOf(id) !== -1;
}

function refreshBalance() {
    shopBalanceEl.innerText = '🪙 ' + state.coins;
}

// A character-skin card. Registry data (name/icon) is static, so building it
// as an HTML string is safe — no user input goes in here.
function skinCardHtml(skin) {
    const owned = isOwned(skin.id);
    const equipped = equip[skin.slot] === skin.id;
    let btn;
    if (equipped) btn = 'Снять ✓';
    else if (owned) btn = 'Надеть';
    else btn = skin.price + ' 🪙';
    const disabled = !owned && state.coins < skin.price;
    const rar = SKIN_RARITY[skin.rarity] ? SKIN_RARITY[skin.rarity].label : '';
    return '<div class="skin-card rar-' + skin.rarity + (equipped ? ' equipped' : '') + '" data-id="' + skin.id + '">'
        + '<div class="skin-card-icon">' + skin.icon + '</div>'
        + '<div class="skin-card-name">' + skin.name + '</div>'
        + '<div class="skin-card-rar">' + rar + '</div>'
        + '<button class="skin-card-btn"' + (disabled ? ' disabled' : '') + '>' + btn + '</button>'
        + '</div>';
}

// The Сундуки tab has no gacha mechanic yet — a placeholder until it does.
function chestsHtml() {
    return '<div class="empty-state">Сундуки скоро откроются!</div>';
}

// The Прочее tab keeps the log avatar and the spare heart.
function miscCardsHtml() {
    const url = avatarUrl();
    let avatarBtn;
    let avatarDisabled = '';
    if (!isInTelegram() || !url) {
        avatarBtn = '🔒 В Telegram';
        avatarDisabled = ' disabled';
    } else if (!ownsAvatar()) {
        avatarBtn = AVATAR_SKIN_PRICE + ' 🪙';
        if (state.coins < AVATAR_SKIN_PRICE) avatarDisabled = ' disabled';
    } else {
        avatarBtn = equip.log === 'avatar_log' ? 'Снять ✓' : 'Надеть';
    }
    const avatarCard = '<div class="skin-card' + (equip.log === 'avatar_log' ? ' equipped' : '') + '" data-id="avatar_log">'
        + '<div class="skin-card-icon">🪵</div>'
        + '<div class="skin-card-name">Твоё бревно</div>'
        + '<div class="skin-card-rar">аватар из TG</div>'
        + '<button class="skin-card-btn"' + avatarDisabled + '>' + avatarBtn + '</button>'
        + '</div>';

    const has = hasPendingHeart();
    const heartBtn = has ? 'В запасе ✓' : (SPARE_HEART_PRICE + ' 🪙');
    const heartDisabled = has || state.coins < SPARE_HEART_PRICE ? ' disabled' : '';
    const heartCard = '<div class="skin-card" data-id="heart">'
        + '<div class="skin-card-icon">❤️</div>'
        + '<div class="skin-card-name">Сердце</div>'
        + '<div class="skin-card-rar">+1 жизнь</div>'
        + '<button class="skin-card-btn"' + heartDisabled + '>' + heartBtn + '</button>'
        + '</div>';

    return avatarCard + heartCard;
}

function renderGrid() {
    if (activeGroup === 'misc') {
        shopGrid.innerHTML = miscCardsHtml();
    } else if (activeGroup === 'chests') {
        shopGrid.innerHTML = chestsHtml();
    } else {
        shopGrid.innerHTML = SKINS.filter((s) => s.slot === activeSlot).map(skinCardHtml).join('');
    }
}

function selectGroup(group) {
    activeGroup = group;
    Array.prototype.slice.call(shopTabs.children).forEach((b) => {
        b.classList.toggle('active', b.dataset.tab === group);
    });
    shopSubtabs.style.display = group === 'skins' ? '' : 'none';
    renderGrid();
}

function selectSlot(slot) {
    activeSlot = slot;
    Array.prototype.slice.call(shopSubtabs.children).forEach((b) => {
        b.classList.toggle('active', b.dataset.slot === slot);
    });
    renderGrid();
}

// Buy (if not owned) or toggle equip/unequip a character skin.
function buyOrToggleSkin(id) {
    const skin = SKINS.find((s) => s.id === id);
    if (!skin) return;
    if (!isOwned(id)) {
        if (!spendCoins(skin.price)) return;
        ownedSkins.push(id);
        equip[skin.slot] = id;
        persistOwned();
        sfx.combo(3); // a purchase is a small celebration
    } else {
        equip[skin.slot] = equip[skin.slot] === id ? '' : id;
        sfx.point();
    }
    persistSlot(skin.slot);
    applyCharSkin();
    refreshBalance();
    renderGrid();
}

function onAvatar() {
    if (!ownsAvatar()) {
        if (!spendCoins(AVATAR_SKIN_PRICE)) return;
        ownedSkins.push('avatar_log');
        equip.log = 'avatar_log';
        persistOwned();
        sfx.combo(3);
    } else {
        equip.log = equip.log === 'avatar_log' ? '' : 'avatar_log';
        sfx.point();
    }
    persistSlot('log');
    applyLogSkin();
    refreshBalance();
    renderGrid();
}

function onHeart() {
    if (hasPendingHeart()) return;
    if (!spendCoins(SPARE_HEART_PRICE)) return;
    lsSet('stayOnLog_pendingHeart', '1');
    sfx.point();
    refreshBalance();
    renderGrid();
}

// One delegated handler for the whole grid — cards are re-rendered on every
// change, so per-card listeners would go stale.
function onGridClick(e) {
    const card = e.target.closest && e.target.closest('.skin-card');
    if (!card || (e.target.closest('button') && e.target.closest('button').disabled)) return;
    const id = card.dataset.id;
    if (id === 'avatar_log') onAvatar();
    else if (id === 'heart') onHeart();
    else buyOrToggleSkin(id);
}

function openShop() {
    if (state.isPlaying) return;
    initAudio();
    track('feature_opened', { feature: 'shop' });
    buildMannequin();
    if (mannequinFig) applyClasses(mannequinFig);
    refreshBalance();
    renderGrid();
    shopOverlay.classList.add('active');
}

function closeShop() {
    shopOverlay.classList.remove('active');
}

// CloudStorage merge: purchases are a set — union both sides; an equipped
// choice from the cloud only fills a local void (an explicit local choice,
// including "unequipped", wins on this device).
function syncFromCloud() {
    cloudGet('stayOnLog_ownedSkins', (v) => {
        if (!v) return;
        let changed = false;
        v.split(',').filter(Boolean).forEach((skin) => {
            if (ownedSkins.indexOf(skin) === -1) {
                ownedSkins.push(skin);
                changed = true;
            }
        });
        if (changed) {
            lsSet('stayOnLog_ownedSkins', ownedSkins.join(','));
            applyLogSkin();
            applyCharSkin();
        }
    });
    // Each equipped slot: the cloud value only fills a local void (an
    // explicit local choice, including "unequipped", wins on this device).
    for (const slot in EQUIP_KEYS) {
        (function (s) {
            cloudGet(EQUIP_KEYS[s], (v) => {
                if (v && !lsGet(EQUIP_KEYS[s]) && ownedSkins.indexOf(v) !== -1) {
                    equip[s] = v;
                    lsSet(EQUIP_KEYS[s], v);
                    if (s === 'log') applyLogSkin();
                    else applyCharSkin();
                }
            });
        })(slot);
    }
}

// Wire the UI and apply the equipped skin. Called once from game.js;
// walletChangedCb keeps the HUD wallet in sync after purchases.
export function initShop(walletChangedCb) {
    onWalletChange = walletChangedCb || null;
    shopBtn.addEventListener('click', openShop);
    shopCloseBtn.addEventListener('click', closeShop);
    shopGrid.addEventListener('click', onGridClick);
    shopTabs.addEventListener('click', (e) => {
        const tab = e.target.closest('.shop-tab');
        if (tab) selectGroup(tab.dataset.tab);
    });
    shopSubtabs.addEventListener('click', (e) => {
        const tab = e.target.closest('.shop-tab');
        if (tab) selectSlot(tab.dataset.slot);
    });
    applyLogSkin();
    applyCharSkin();
    syncFromCloud();
}
