const $ = (id) => document.getElementById(id);
const els = {
  ore: $('ore'),
  clicks: $('clicks'),
  user: $('user'),
  status: $('status'),
  log: $('log'),
  farmBtn: $('farmBtn'),
  exchangeBtn: $('exchangeBtn'),
};

const ORIGIN = 'https://mangabuff.ru';
const MINE_URL = `${ORIGIN}/mine`;
const EXCHANGE_URL = `${ORIGIN}/mine/exchange`;
const ORE_PER_DIAMOND = 100; // `rate` in the site's mineModule.js

let csrf = null;

const fmt = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('ru-RU'));

// A log panel fed from lines the popup writes itself plus background rolling
// logs in storage (`sync({ source: entries })`). Entries are appended by id
// per source, so reopening the popup shows what happened while it was closed.
const makeFeed = (el) => {
  const lastIds = {};
  const line = (msg, kind = 'info', t = Date.now()) => {
    const row = document.createElement('div');
    row.className = `line ${kind}`;
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = new Date(t).toLocaleTimeString('ru-RU');
    row.appendChild(time);
    row.appendChild(document.createTextNode(msg));
    el.appendChild(row);
    el.scrollTop = el.scrollHeight;
    while (el.childElementCount > 60) el.removeChild(el.firstChild);
  };
  const sync = (sources) => {
    const fresh = [];
    for (const [src, entries = []] of Object.entries(sources)) {
      let last = lastIds[src] || 0;
      // Storage was reset — ids restarted.
      if (entries.length && entries[entries.length - 1].id < last) last = 0;
      for (const e of entries) {
        if (e.id <= last) continue;
        fresh.push(e);
        last = e.id;
      }
      lastIds[src] = last;
    }
    fresh.sort((a, b) => a.t - b.t).forEach((e) => line(e.msg, e.kind, e.t));
  };
  return { line, sync };
};

const mineFeed = makeFeed(els.log);
const log = mineFeed.line;

const setStatus = (text, kind = '') => {
  els.status.textContent = text;
  els.status.className = `status ${kind}`;
};

const updateStats = ({ ore, clicks } = {}) => {
  if (ore !== undefined && ore !== null) els.ore.textContent = fmt(ore);
  if (clicks !== undefined && clicks !== null) els.clicks.textContent = fmt(clicks);
};

// Send a message to background. Wakes the SW if asleep. We always check
// chrome.runtime.lastError so the "Could not establish connection" warning
// doesn't pollute the console, and we retry once after 250ms because a
// just-woken SW occasionally drops the very first message.
const sendBg = (type, attempt = 0) => new Promise((resolve) => {
  try {
    chrome.runtime.sendMessage({ type }, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) {
        if (attempt === 0) {
          setTimeout(() => sendBg(type, 1).then(resolve), 250);
        } else {
          resolve({ ok: false, error: err.message || 'no-bg' });
        }
        return;
      }
      resolve(resp || { ok: false });
    });
  } catch (e) {
    resolve({ ok: false, error: e.message });
  }
});

// Pull state by fetching the /mine page and parsing it. The page is the only
// place that returns ore + hits-left without modifying state.
const fetchState = async () => {
  const r = await fetch(MINE_URL, { credentials: 'include' });
  if (r.redirected && /\/login/i.test(r.url)) {
    return { ok: false, code: 'auth' };
  }
  if (r.status !== 200) return { ok: false, code: 'http', status: r.status };

  const html = await r.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');

  const token = doc.querySelector('meta[name="csrf-token"]')?.content;
  if (!token) return { ok: false, code: 'auth' };
  csrf = token;

  const oreText = doc.querySelector('.main-mine__header_score-count.js-score')?.textContent?.trim();
  const oreData = doc.querySelector('.main-mine')?.dataset?.ore;
  const ore = parseInt((oreText ?? oreData ?? '').replace(/\D/g, ''), 10);
  const hitsTxt = doc.querySelector('.main-mine__game-hits-left')?.textContent?.trim();
  const clicks = parseInt((hitsTxt ?? '').replace(/\D/g, ''), 10);
  const user = doc.querySelector('#userName')?.textContent?.trim() || '';

  return {
    ok: true,
    ore: Number.isFinite(ore) ? ore : null,
    clicks: Number.isFinite(clicks) ? clicks : null,
    user,
  };
};

/* ---------- Mine farm (popup side) ----------
 *
 * The hit loop lives in background.js (sequential hits with human-like
 * pauses) so it keeps going with the popup closed. Here: start/stop, live
 * stats + log from chrome.storage.local.mineFarm, and the ore exchange.
 */
let mineRunning = false;

const refresh = async () => {
  // While farming, background pushes fresh ore/hits on every hit.
  if (mineRunning) return;
  try {
    const s = await fetchState();
    if (!s.ok) {
      if (s.code === 'auth') setStatus('Войди на mangabuff.ru', 'error');
      else setStatus(`Ошибка ${s.status || ''}`.trim(), 'error');
      return;
    }
    updateStats(s);
    if (s.user) els.user.textContent = `👤 ${s.user}`;
    setStatus('Подключено', 'ok');
  } catch (e) {
    setStatus(e.message || 'Нет связи', 'error');
  }
};

const setMineRunningUI = (running) => {
  mineRunning = !!running;
  els.farmBtn.querySelector('.btn-icon').textContent = running ? '⏹' : '⛏️';
  els.farmBtn.querySelector('.btn-label').textContent = running ? 'Стоп' : 'Фарм';
};

const renderMineState = (s, { stats = true } = {}) => {
  if (!s) return;
  setMineRunningUI(s.running);
  if (stats) updateStats({ ore: s.ore, clicks: s.hitsLeft });
  mineFeed.sync({ mine: s.log });
};

els.farmBtn.addEventListener('click', async () => {
  els.farmBtn.disabled = true;
  const resp = await sendBg(mineRunning ? 'mine-stop' : 'mine-start');
  if (!resp || resp.ok === false) {
    log(resp?.error === 'auth' ? 'Войди на mangabuff.ru'
      : `Не вышло связаться с фоном${resp?.error ? ': ' + resp.error : ''}`, 'err');
  }
  // Running state / stats / log then arrive via storage.onChanged.
  els.farmBtn.disabled = false;
});

els.exchangeBtn.addEventListener('click', async () => {
  els.exchangeBtn.disabled = true;
  try {
    // Fresh ore + CSRF: the farm may be changing ore in the background.
    const s = await fetchState();
    if (!s.ok) {
      log(s.code === 'auth' ? 'Войди на mangabuff.ru' : `Ошибка ${s.status || ''}`.trim(), 'err');
      return;
    }
    updateStats(s);
    // The site exchanges a chosen number of diamonds (slider), not "all ore",
    // so ask for the maximum the current ore covers.
    const diamonds = Math.floor((s.ore ?? 0) / ORE_PER_DIAMOND);
    if (diamonds < 1) {
      log(`Мало руды: ${fmt(s.ore)} — нужно от ${ORE_PER_DIAMOND}`, 'err');
      return;
    }
    log(`Обмен ${fmt(diamonds * ORE_PER_DIAMOND)} руды → ${fmt(diamonds)} 💎…`, 'info');

    const r = await fetch(EXCHANGE_URL, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-CSRF-TOKEN': csrf,
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json',
      },
      body: new URLSearchParams({ diamonds: String(diamonds) }),
    });
    let data = null;
    try { data = await r.json(); } catch {}

    if (r.status >= 200 && r.status < 300 && data) {
      log(data.message || 'Обмен выполнен ✓', 'ok');
      if (data.ore !== undefined) updateStats({ ore: data.ore });
    } else {
      log(data?.message || `Ошибка ${r.status}`, 'err');
    }
  } catch (e) {
    log(e.message, 'err');
  } finally {
    els.exchangeBtn.disabled = false;
  }
});

refresh();
setInterval(refresh, 5000);

/* ---------- Ads bonus (popup side) ----------
 *
 * background.js claims the rewarded-ad bonus 3× a day without loading the
 * ad; its log shares the mine panel's log.
 */
const ADS_DAILY = 3;

const adsBtn = $('adsBtn');
const adsProgressEl = $('adsProgress');
let adsRunning = false;

const renderAdsState = (s) => {
  if (!s) return;
  adsRunning = !!s.running;
  adsProgressEl.textContent = `${s.count || 0} / ${ADS_DAILY}`;
  adsBtn.querySelector('.btn-icon').textContent = s.running ? '⏹' : '▶';
  adsBtn.querySelector('.btn-label').textContent = s.running ? 'Стоп' : 'Забрать';
  adsBtn.disabled = !s.running && (s.count || 0) >= ADS_DAILY;
  mineFeed.sync({ ads: s.log });
};

adsBtn.addEventListener('click', async () => {
  adsBtn.disabled = true;
  const resp = await sendBg(adsRunning ? 'ads-stop' : 'ads-start');
  if (!resp || resp.ok === false) {
    log(resp?.error === 'auth' ? 'Войди на mangabuff.ru'
      : `Не вышло связаться с фоном${resp?.error ? ': ' + resp.error : ''}`, 'err');
  }
  const { adsFarm } = await chrome.storage.local.get('adsFarm');
  if (adsFarm) renderAdsState(adsFarm);
  else adsBtn.disabled = false;
});

/* ---------- Tabs ---------- */
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.panel').forEach((p) => {
      p.classList.toggle('hidden', p.dataset.panel !== target);
    });
  });
});

/* ---------- Skins ---------- */
const skinGrid = $('skinGrid');
const skinCurrentEl = $('skinCurrent');
const skinResetBtn = $('skinReset');

const renderSkins = (selectedId) => {
  skinGrid.innerHTML = '';
  for (const skin of window.SKINS) {
    const tile = document.createElement('div');
    tile.className = 'skin-tile' + (skin.id === selectedId ? ' active' : '');
    tile.style.background = skin.bg;
    tile.title = `Скин #${skin.id}`;
    const label = document.createElement('span');
    label.textContent = `#${skin.id}`;
    tile.appendChild(label);
    tile.addEventListener('click', () => selectSkin(skin.id));
    skinGrid.appendChild(tile);
  }
  skinCurrentEl.textContent = selectedId ? `#${selectedId}` : '—';
};

const applySkinToProfileTabs = async (skinId) => {
  // Skin is OWN-profile only. Push live to /users/* tabs but the inline
  // function double-checks the page is the user's own profile before mutating.
  try {
    const tabs = await chrome.tabs.query({ url: 'https://mangabuff.ru/users/*' });
    for (const t of tabs) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: t.id },
          func: (id) => {
            const isOwn =
              !!document.querySelector('.profile-customization-form__save-button')
              || document.body.classList.contains('profile-skin');
            if (!isOwn) return;
            const body = document.body;
            [...body.classList].forEach((c) => {
              if (/^profile-skin(--\d+)?$/.test(c)) body.classList.remove(c);
            });
            if (id) body.classList.add('profile-skin', 'profile-skin--' + id);
          },
          args: [skinId],
        });
      } catch {}
    }
  } catch {}
};

const selectSkin = async (id) => {
  await chrome.storage.local.set({ selectedSkin: id });
  renderSkins(id);
  await applySkinToProfileTabs(id);
};

skinResetBtn.addEventListener('click', async () => {
  await chrome.storage.local.remove('selectedSkin');
  renderSkins(null);
  await applySkinToProfileTabs(null);
});

(async () => {
  const { selectedSkin } = await chrome.storage.local.get('selectedSkin');
  renderSkins(selectedSkin || null);
})();

/* ---------- Avatars ---------- */
const avatarGrid = $('avatarGrid');
const avatarPreview = $('avatarPreview');
const avatarLabel = $('avatarLabel');
const avatarReset = $('avatarReset');
const avatarUpload = $('avatarUpload');
const avatarSearch = $('avatarSearch');

let avatarItems = []; // [{id, ext, src}]
let currentAvatar = null;

const buildAvatarItems = () => {
  const items = [];
  for (const id of window.AVATARS.gifs) items.push({ id, ext: 'gif', src: window.AVATAR_URL(id, 'gif') });
  for (const id of window.AVATARS.jpgs) items.push({ id, ext: 'jpg', src: window.AVATAR_URL(id, 'jpg') });
  items.sort((a, b) => a.id - b.id);
  return items;
};

// IntersectionObserver — only set img.src when the tile scrolls near the viewport.
// Without this, even with `loading="lazy"`, the popup would queue up
// hundreds of GIFs at once on first open.
let lazyObserver = null;
const ensureLazyObserver = () => {
  if (lazyObserver) return lazyObserver;
  lazyObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const tile = e.target;
      const img = tile.querySelector('img');
      const src = tile.dataset.src;
      if (img && src && !img.src) {
        img.addEventListener('load', () => tile.classList.add('loaded'), { once: true });
        img.addEventListener('error', () => tile.classList.add('loaded'), { once: true });
        img.src = src;
      }
      lazyObserver.unobserve(tile);
    }
  }, { root: avatarGrid, rootMargin: '200px 0px', threshold: 0.01 });
  return lazyObserver;
};

const renderAvatars = (filter = '') => {
  if (lazyObserver) lazyObserver.disconnect();
  lazyObserver = null;
  avatarGrid.innerHTML = '';
  const obs = ensureLazyObserver();

  const f = filter.trim().toLowerCase();
  const items = f ? avatarItems.filter((it) => String(it.id).includes(f)) : avatarItems;
  const frag = document.createDocumentFragment();
  for (const it of items) {
    const tile = document.createElement('div');
    tile.className = 'avatar-tile' + (currentAvatar === it.src ? ' active' : '');
    tile.title = `Аватар #${it.id}`;
    tile.dataset.src = it.src;
    const img = document.createElement('img');
    img.alt = '';
    const tag = document.createElement('span');
    tag.className = 'id-tag';
    tag.textContent = `#${it.id}`;
    tile.appendChild(img);
    tile.appendChild(tag);
    tile.addEventListener('click', () => selectAvatar(it.src, `#${it.id}`));
    frag.appendChild(tile);
  }
  avatarGrid.appendChild(frag);

  // Observe after they're in the DOM.
  avatarGrid.querySelectorAll('.avatar-tile').forEach((t) => obs.observe(t));
};

const updateAvatarHeader = (src, label) => {
  if (src) avatarPreview.src = src;
  else avatarPreview.removeAttribute('src');
  avatarLabel.textContent = label || '—';
};

const applyAvatarToTabs = async (src) => {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://mangabuff.ru/*' });
    for (const t of tabs) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: t.id },
          func: (stored) => {
            if (!stored) return;
            const SLOTS = [
              ['img.my-avatar', 'x150'],
              ['.header__item.header-profile.dropdown__trigger img', 'x35'],
              ['.menu__avatar img', 'x35'],
            ];
            const srcForSlot = (s, size) =>
              s.startsWith('data:') ? s : s.replace(/\/x\d+\//, `/${size}/`);
            for (const [sel, size] of SLOTS) {
              const want = srcForSlot(stored, size);
              document.querySelectorAll(sel).forEach((im) => im.setAttribute('src', want));
            }
          },
          args: [src],
        });
      } catch {}
    }
  } catch {}
};

const selectAvatar = async (src, label) => {
  currentAvatar = src;
  await chrome.storage.local.set({ selectedAvatar: src, selectedAvatarLabel: label });
  updateAvatarHeader(src, label);
  // Re-render only updates active border — cheap enough.
  renderAvatars(avatarSearch.value);
  await applyAvatarToTabs(src);
};

avatarReset.addEventListener('click', async () => {
  currentAvatar = null;
  await chrome.storage.local.remove(['selectedAvatar', 'selectedAvatarLabel']);
  updateAvatarHeader(null, '—');
  renderAvatars(avatarSearch.value);
  // Note: can't reliably restore the original src per-tab without reload.
  // Telling the user to refresh is simpler than tracking originals.
});

avatarUpload.addEventListener('change', async (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;
  // 4MB cap — chrome.storage.local has a 10MB ceiling; data URLs ~33% bigger than the file.
  if (file.size > 4 * 1024 * 1024) {
    alert('Файл слишком большой (макс. 4 МБ)');
    return;
  }
  const reader = new FileReader();
  reader.onload = async () => {
    const dataUrl = reader.result;
    await selectAvatar(dataUrl, '📷 Своя');
  };
  reader.readAsDataURL(file);
  avatarUpload.value = '';
});

avatarSearch.addEventListener('input', () => renderAvatars(avatarSearch.value));

(async () => {
  avatarItems = buildAvatarItems();
  const { selectedAvatar, selectedAvatarLabel } = await chrome.storage.local.get(['selectedAvatar', 'selectedAvatarLabel']);
  currentAvatar = selectedAvatar || null;
  updateAvatarHeader(currentAvatar, selectedAvatarLabel || (currentAvatar ? '—' : '—'));
  renderAvatars();
})();

/* ---------- Comment farm (popup side) ----------
 *
 * The actual loop lives in the background service worker (background.js) so
 * it keeps running while the popup is closed. This file is just a thin client:
 *   - Renders state + log from chrome.storage.local.clubFarm
 *   - Live-updates via storage.onChanged while the popup is open
 *   - Sends `club-start` / `club-stop` messages to background
 *   - Pulls the authoritative daily count from /balance via background
 *
 * The target (alliance, or club as a fallback) is discovered by background
 * from the site menu. Day boundary is Moscow (Europe/Moscow) because the
 * site's quest counter resets at MSK midnight — done in background.js.
 */
const DAILY_TARGET = 13;

const clubNameEl = $('clubName');
const clubProgressEl = $('clubProgress');
const clubFarmBtn = $('clubFarmBtn');
const clubStopBtn = $('clubStopBtn');

const clubFeed = makeFeed($('clubLog'));
const clubLog = clubFeed.line;

const renderClubProgress = (count) => {
  clubProgressEl.textContent = `${count} / ${DAILY_TARGET}`;
};

const setRunningUI = (running) => {
  clubFarmBtn.disabled = !!running;
  clubStopBtn.disabled = !running;
};

const renderClubState = (s) => {
  if (!s) return;
  renderClubProgress(s.count || 0);
  if (s.clubName) clubNameEl.textContent = s.clubName;
  setRunningUI(s.running);
  clubFeed.sync({ club: s.log });
};

clubFarmBtn.addEventListener('click', async () => {
  clubFarmBtn.disabled = true;
  const resp = await sendBg('club-start');
  if (!resp || resp.ok === false) {
    clubLog(`Не вышло связаться с фоном${resp?.error ? ': ' + resp.error : ''}`, 'err');
    clubFarmBtn.disabled = false;
    return;
  }
  if (resp.alreadyDone) clubFarmBtn.disabled = false;
  // setRunningUI is then driven by storage.onChanged from the SW.
});

clubStopBtn.addEventListener('click', async () => {
  clubStopBtn.disabled = true;
  const resp = await sendBg('club-stop');
  if (!resp || resp.ok === false) {
    clubLog('Стоп не дошёл до фона — попробуй ещё раз', 'err');
    clubStopBtn.disabled = false;
  }
});

// Live-update from background while popup is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.clubFarm) renderClubState(changes.clubFarm.newValue);
  if (changes.mineFarm) renderMineState(changes.mineFarm.newValue);
  if (changes.adsFarm) renderAdsState(changes.adsFarm.newValue);
});

// Init: read both farms, sync count from /balance via background, auto-switch
// to the comments tab if only that farm is in progress.
const switchToTab = (name) => {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== name));
};

(async () => {
  const { clubFarm, mineFarm, adsFarm } = await chrome.storage.local.get(['clubFarm', 'mineFarm', 'adsFarm']);
  // Mine + ads share one log panel: render their history interleaved by time.
  mineFeed.sync({ mine: mineFarm?.log, ads: adsFarm?.log });
  // Stored ore/hits are only fresh while the farm runs; otherwise refresh() owns them.
  if (mineFarm) renderMineState(mineFarm, { stats: !!mineFarm.running });
  if (adsFarm) renderAdsState(adsFarm);
  if (clubFarm) {
    renderClubState(clubFarm);
    if (clubFarm.running && !mineFarm?.running) switchToTab('club');
  } else {
    renderClubState({ count: 0, running: false });
  }
  // Pull authoritative comment + ad counts from /balance (background does the
  // fetch + store update; renders follow via storage.onChanged).
  sendBg('balance-sync').then((r) => {
    if (r && r.balance) clubLog(`Сервер: ${r.balance.done}/${r.balance.total}`, 'info');
  });
})();

/* ---------- Adblock panel ----------
 *
 * Uses chrome.declarativeNetRequest with one static ruleset ("trackers")
 * defined in rules/trackers.json. The toggle calls updateEnabledRulesets
 * to enable/disable it; persisted state lives in chrome.storage.local.
 *
 * The list shown is the human-readable domain names parsed from the
 * ruleset's `urlFilter` patterns (||domain^).
 */
const TRACKER_RULESET_ID = 'trackers';

const adblockToggle = $('adblockToggle');
const adblockStatus = $('adblockStatus');
const blockList = $('blockList');

// Mirrors the urlFilter list from rules/trackers.json. Kept here just for
// display — the actual blocking is driven by the manifest-loaded ruleset.
const TRACKER_DOMAINS = [
  'googletagmanager.com',
  'google-analytics.com',
  'yandex.ru',
  'yastatic.net',
  'doubleclick.net',
  'googleadservices.com',
  'googlesyndication.com',
  'adfox.ru',
  'yandexmetrica.com',
  'top-fwz1.mail.ru',
  'counter.yadro.ru',
];

const renderBlockList = (enabled) => {
  blockList.innerHTML = '';
  blockList.classList.toggle('disabled', !enabled);
  for (const d of TRACKER_DOMAINS) {
    const li = document.createElement('li');
    li.textContent = d;
    blockList.appendChild(li);
  }
};

const renderAdblockStatus = (enabled) => {
  adblockStatus.textContent = enabled ? 'включено' : 'отключено';
  adblockStatus.className = 'adblock-sub ' + (enabled ? 'on' : 'off');
  adblockToggle.checked = !!enabled;
  renderBlockList(enabled);
};

const setAdblockEnabled = async (enabled) => {
  try {
    await chrome.declarativeNetRequest.updateEnabledRulesets(
      enabled
        ? { enableRulesetIds: [TRACKER_RULESET_ID] }
        : { disableRulesetIds: [TRACKER_RULESET_ID] }
    );
    await chrome.storage.local.set({ adblockEnabled: !!enabled });
    renderAdblockStatus(!!enabled);
  } catch (e) {
    // Revert checkbox on failure
    adblockToggle.checked = !enabled;
    console.error('adblock toggle failed', e);
  }
};

adblockToggle.addEventListener('change', (e) => setAdblockEnabled(e.target.checked));

(async () => {
  // Read actual SW state, not just storage — they should match but truth is the runtime.
  let enabled = true;
  try {
    const ids = await chrome.declarativeNetRequest.getEnabledRulesets();
    enabled = ids.includes(TRACKER_RULESET_ID);
  } catch {
    const { adblockEnabled } = await chrome.storage.local.get('adblockEnabled');
    enabled = adblockEnabled !== false;
  }
  renderAdblockStatus(enabled);
})();
