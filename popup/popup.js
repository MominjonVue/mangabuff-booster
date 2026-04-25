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
const HIT_URL = `${ORIGIN}/mine/hit`;
const EXCHANGE_URL = `${ORIGIN}/mine/exchange`;

let csrf = null;

const fmt = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('ru-RU'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const log = (msg, kind = 'info') => {
  const line = document.createElement('div');
  line.className = `line ${kind}`;
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = new Date().toLocaleTimeString('ru-RU');
  line.appendChild(time);
  line.appendChild(document.createTextNode(msg));
  els.log.appendChild(line);
  els.log.scrollTop = els.log.scrollHeight;
  while (els.log.childElementCount > 60) els.log.removeChild(els.log.firstChild);
};

const setStatus = (text, kind = '') => {
  els.status.textContent = text;
  els.status.className = `status ${kind}`;
};

const updateStats = ({ ore, clicks } = {}) => {
  if (ore !== undefined && ore !== null) els.ore.textContent = fmt(ore);
  if (clicks !== undefined && clicks !== null) els.clicks.textContent = fmt(clicks);
};

const apiHeaders = () => ({
  'Content-Type': 'application/json',
  'X-CSRF-TOKEN': csrf,
  'X-Requested-With': 'XMLHttpRequest',
  'Accept': 'application/json',
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

const refresh = async () => {
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

const hitOnce = async () => {
  const r = await fetch(HIT_URL, {
    method: 'POST',
    credentials: 'include',
    headers: apiHeaders(),
  });
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
};

els.farmBtn.addEventListener('click', async () => {
  if (!csrf) { log('Нет CSRF — обнови состояние', 'err'); return; }
  els.farmBtn.disabled = true;
  els.exchangeBtn.disabled = true;
  log('Фарм запущен…', 'info');

  let success = 0, failed = 0, last = null;
  const max = 100;
  for (let i = 1; i <= max; i++) {
    let status, data;
    try {
      ({ status, data } = await hitOnce());
      last = data;

      if (status >= 200 && status < 300) {
        success++;
        updateStats({ ore: data?.ore, clicks: data?.hits_left });
      } else {
        failed++;
        if (status === 419) { log('CSRF просрочен — обновляю', 'err'); await refresh(); break; }
        if (status === 401 || status === 403) { log('Сессия закончилась', 'err'); break; }
        if (status === 429) await sleep(900);
      }
    } catch (e) {
      failed++;
      log(`Ошибка сети: ${e.message}`, 'err');
      await sleep(400);
    }

    const left = data?.hits_left;
    if (typeof left === 'number') {
      if (i % 10 === 0 || left <= 0) log(`удар ${i}/${max} · осталось ${left}`, 'ok');
      if (left <= 0) { log('Удары закончились', 'info'); break; }
    }
    const msg = (data?.message || data?.error || '').toString();
    if (msg && /закончил|нет.*удар|недостаточн/i.test(msg)) { log(msg, 'info'); break; }

    await sleep(110 + Math.floor(Math.random() * 80));
  }

  log(`Готово — ударов: ${success}, ошибок: ${failed}`, 'ok');
  if (last) updateStats({ ore: last.ore, clicks: last.hits_left });
  els.farmBtn.disabled = false;
  els.exchangeBtn.disabled = false;
});

els.exchangeBtn.addEventListener('click', async () => {
  if (!csrf) { log('Нет CSRF — обнови состояние', 'err'); return; }
  els.farmBtn.disabled = true;
  els.exchangeBtn.disabled = true;
  log('Обмен руды…', 'info');

  try {
    const r = await fetch(EXCHANGE_URL, {
      method: 'POST',
      credentials: 'include',
      headers: apiHeaders(),
    });
    let data = null;
    try { data = await r.json(); } catch {}

    if (r.status >= 200 && r.status < 300) {
      log('Обмен выполнен ✓', 'ok');
      if (data?.ore !== undefined) updateStats({ ore: data.ore });
      // Re-read state for the freshest numbers (server may not echo all fields).
      await refresh();
    } else {
      log(data?.message || `Ошибка ${r.status}`, 'err');
    }
  } catch (e) {
    log(e.message, 'err');
  }

  els.farmBtn.disabled = false;
  els.exchangeBtn.disabled = false;
});

refresh();
setInterval(refresh, 5000);

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

/* ---------- Club comments farm (popup side) ----------
 *
 * The actual loop lives in the background service worker (background.js) so
 * it keeps running while the popup is closed. This file is just a thin client:
 *   - Renders state from chrome.storage.local.clubFarm
 *   - Live-updates via storage.onChanged while the popup is open
 *   - Sends `club-start` / `club-stop` messages to background
 *   - Pulls the authoritative daily count from /balance via background
 *
 * Day boundary is Moscow (Europe/Moscow) because the site's quest counter
 * resets at MSK midnight — done in background.js.
 */
const DAILY_TARGET = 13;

const clubLogEl = $('clubLog');
const clubNameEl = $('clubName');
const clubProgressEl = $('clubProgress');
const clubFarmBtn = $('clubFarmBtn');
const clubStopBtn = $('clubStopBtn');

const renderClubProgress = (count) => {
  clubProgressEl.textContent = `${count} / ${DAILY_TARGET}`;
};

const clubLog = (msg, kind = 'info') => {
  const line = document.createElement('div');
  line.className = `line ${kind}`;
  const t = document.createElement('span');
  t.className = 'time';
  t.textContent = new Date().toLocaleTimeString('ru-RU');
  line.appendChild(t);
  line.appendChild(document.createTextNode(msg));
  clubLogEl.appendChild(line);
  clubLogEl.scrollTop = clubLogEl.scrollHeight;
  while (clubLogEl.childElementCount > 60) clubLogEl.removeChild(clubLogEl.firstChild);
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
};

// Translate background lastResult codes into a human log line.
let lastSeenResult = null;
const reportResult = (s) => {
  if (!s || !s.lastResult || s.lastResult === lastSeenResult) return;
  lastSeenResult = s.lastResult;
  if (s.lastResult === 'ok') {
    clubLog(`✓ ${s.count}/${DAILY_TARGET}${s.rootId && s.count === 1 ? ' (root)' : ''}`, 'ok');
    if (s.running && s.nextAt) {
      const wait = Math.max(0, s.nextAt - Date.now());
      if (wait > 0) clubLog(`Жду ${Math.round(wait / 1000)}с до следующего`, 'info');
    }
  } else if (s.lastResult === 'cooldown') {
    clubLog('Кулдаун сервера — ждём', 'info');
  } else if (s.lastResult === 'csrf-refresh') {
    clubLog('CSRF протух — обновляю', 'err');
  } else if (s.lastResult === 'network') {
    clubLog(`Сеть: ${s.lastError || 'ошибка'}`, 'err');
  } else if (s.lastResult === 'done') {
    clubLog('Готово — норма дня выполнена', 'ok');
  } else if (s.lastResult === 'stopped') {
    clubLog('Остановлено', 'info');
  } else if (s.lastResult === 'error') {
    const msg = s.lastError === 'auth' ? 'Не авторизован'
              : s.lastError === 'no-club' ? 'У тебя нет клуба'
              : s.lastError || 'неизвестная ошибка';
    clubLog(`Ошибка: ${msg}`, 'err');
  } else if (s.lastResult.startsWith('http-')) {
    clubLog(`Ошибка: ${s.lastResult}${s.lastError ? ' — ' + s.lastError : ''}`, 'err');
  }
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

clubFarmBtn.addEventListener('click', async () => {
  clubFarmBtn.disabled = true;
  clubLog('Запускаю фоновый фарм…', 'info');
  const resp = await sendBg('club-start');
  if (!resp || resp.ok === false) {
    clubLog(`Не вышло связаться с фоном${resp?.error ? ': ' + resp.error : ''}`, 'err');
    clubFarmBtn.disabled = false;
    return;
  }
  if (resp.alreadyDone) {
    clubLog('Сегодня уже 13 — норма выполнена', 'ok');
    clubFarmBtn.disabled = false;
  }
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
  if (area !== 'local' || !changes.clubFarm) return;
  const s = changes.clubFarm.newValue;
  renderClubState(s);
  reportResult(s);
});

// Init: read state, sync count from /balance via background, auto-switch
// to the Club tab if a farm is in progress.
const switchToTab = (name) => {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== name));
};

(async () => {
  const { clubFarm } = await chrome.storage.local.get('clubFarm');
  if (clubFarm) {
    renderClubState(clubFarm);
    if (clubFarm.running) {
      switchToTab('club');
      const left = clubFarm.nextAt ? Math.max(0, clubFarm.nextAt - Date.now()) : 0;
      clubLog(`Фарм идёт фоном · ${clubFarm.count}/${DAILY_TARGET}${left ? ` · след. через ~${Math.round(left/1000)}с` : ''}`, 'info');
    }
  } else {
    renderClubState({ count: 0, running: false });
  }
  // Pull authoritative count from /balance (background does the fetch + store update).
  sendBg('club-sync-count').then((r) => {
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
