// === SHOP ===
// The coin sink: a howto-style overlay with two items for now —
//   - "Твоё бревно": the player's Telegram avatar clipped onto the log face
//     (premium skin; needs to be inside Telegram with a visible photo);
//   - "Запасное сердце": a consumable that starts the NEXT run with +1 hp.
// Purchases/equip state live in localStorage and sync to CloudStorage the
// same way the high score does (skins never "spend", so a max/union merge
// is safe — unlike the wallet, which stays local-only for now).

import { state, lsGet, lsSet } from './state.js';
import { AVATAR_SKIN_PRICE, SPARE_HEART_PRICE } from './config.js';
import {
    logSvg,
    shopBtn,
    shopOverlay,
    shopBalanceEl,
    shopAvatarBtn,
    shopAvatarPreview,
    shopHeartBtn,
    shopCloseBtn,
} from './dom.js';
import { isInTelegram, tgUser, cloudGet, cloudSet } from './tg.js';
import { sfx, initAudio } from './audio.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

let ownedSkins = (lsGet('stayOnLog_ownedSkins') || '').split(',').filter(Boolean);
let equippedSkin = lsGet('stayOnLog_equippedSkin') || '';

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

function persistSkins() {
    lsSet('stayOnLog_ownedSkins', ownedSkins.join(','));
    lsSet('stayOnLog_equippedSkin', equippedSkin);
    cloudSet('stayOnLog_ownedSkins', ownedSkins.join(','));
    cloudSet('stayOnLog_equippedSkin', equippedSkin);
}

// Insert (or update) the avatar <image> inside the log-face SVG. It sits
// right under the ambient-shading circle, so the log keeps its depth; the
// bark ring stays visible around the clipped photo. Rotates with the log
// for free — it lives inside #log-svg.
function applyLogSkin() {
    const url = equippedSkin === 'avatar_log' ? avatarUrl() : '';
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

// --- Overlay UI ---
function refreshShopUI() {
    shopBalanceEl.innerText = '🪙 ' + state.coins;

    // Avatar item: preview shows the actual photo when we have one.
    const url = avatarUrl();
    if (url) {
        shopAvatarPreview.style.backgroundImage = `url("${url}")`;
        shopAvatarPreview.innerText = '';
    } else {
        shopAvatarPreview.style.backgroundImage = '';
        shopAvatarPreview.innerText = '🪵';
    }
    if (!isInTelegram() || !url) {
        shopAvatarBtn.innerText = '🔒 В Telegram';
        shopAvatarBtn.disabled = true;
    } else if (!ownsAvatar()) {
        shopAvatarBtn.innerText = AVATAR_SKIN_PRICE + ' 🪙';
        shopAvatarBtn.disabled = state.coins < AVATAR_SKIN_PRICE;
    } else if (equippedSkin === 'avatar_log') {
        shopAvatarBtn.innerText = 'Снять ✓';
        shopAvatarBtn.disabled = false;
    } else {
        shopAvatarBtn.innerText = 'Надеть';
        shopAvatarBtn.disabled = false;
    }

    // Spare heart item.
    if (hasPendingHeart()) {
        shopHeartBtn.innerText = 'В запасе ✓';
        shopHeartBtn.disabled = true;
    } else {
        shopHeartBtn.innerText = SPARE_HEART_PRICE + ' 🪙';
        shopHeartBtn.disabled = state.coins < SPARE_HEART_PRICE;
    }
}

function openShop() {
    if (state.isPlaying) return;
    initAudio();
    refreshShopUI();
    shopOverlay.classList.add('active');
}

function closeShop() {
    shopOverlay.classList.remove('active');
}

function onAvatarBtn() {
    if (!ownsAvatar()) {
        if (!spendCoins(AVATAR_SKIN_PRICE)) return;
        ownedSkins.push('avatar_log');
        equippedSkin = 'avatar_log';
        sfx.combo(3); // a purchase is a small celebration
    } else {
        equippedSkin = equippedSkin === 'avatar_log' ? '' : 'avatar_log';
        sfx.point();
    }
    persistSkins();
    applyLogSkin();
    refreshShopUI();
}

function onHeartBtn() {
    if (hasPendingHeart()) return;
    if (!spendCoins(SPARE_HEART_PRICE)) return;
    lsSet('stayOnLog_pendingHeart', '1');
    sfx.point();
    refreshShopUI();
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
        }
    });
    cloudGet('stayOnLog_equippedSkin', (v) => {
        if (v && !lsGet('stayOnLog_equippedSkin') && ownedSkins.indexOf(v) !== -1) {
            equippedSkin = v;
            lsSet('stayOnLog_equippedSkin', equippedSkin);
            applyLogSkin();
        }
    });
}

// Wire the UI and apply the equipped skin. Called once from game.js;
// walletChangedCb keeps the HUD wallet in sync after purchases.
export function initShop(walletChangedCb) {
    onWalletChange = walletChangedCb || null;
    shopBtn.addEventListener('click', openShop);
    shopCloseBtn.addEventListener('click', closeShop);
    shopAvatarBtn.addEventListener('click', onAvatarBtn);
    shopHeartBtn.addEventListener('click', onHeartBtn);
    applyLogSkin();
    syncFromCloud();
}
