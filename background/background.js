// Service worker — owns the long-running club-comment farm so it keeps going
// after the popup closes. Popup just sends start/stop messages and observes
// `chrome.storage.local.clubFarm` for live state. State + the next scheduled
// post live in storage so the loop survives service-worker termination
// (Chrome wakes the SW for chrome.alarms).
//
// Day boundary uses Europe/Moscow because the site's quest counter resets
// on Moscow midnight.

const ORIGIN = 'https://mangabuff.ru';
const COMMENTS_URL = ORIGIN + '/comments';
const HOME_URL = ORIGIN + '/';
const BALANCE_URL = ORIGIN + '/balance';
const ALARM_NAME = 'clubFarmTick';

const DAILY_TARGET = 13;
const COOLDOWN_MIN_MS = 35_000;
const COOLDOWN_JITTER_MS = 10_000;
const RATE_LIMIT_BACKOFF_MS = 35_000;

const COMMENT_POOL = ['+', '++', '+rep', 'gg', 'круто', 'класс', 'лайк', 'плюс', 'ok', 'ну', '👍', 'top', 'fire'];
const randomComment = () => {
  const base = COMMENT_POOL[Math.floor(Math.random() * COMMENT_POOL.length)];
  const uuid = (self.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/-/g, '');
  return `${base} ${uuid.slice(0, 5)}`;
};

const moscowDateStr = () => {
  // en-CA gives us YYYY-MM-DD format directly.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
};

const getState = async () => {
  const { clubFarm } = await chrome.storage.local.get('clubFarm');
  const today = moscowDateStr();
  if (!clubFarm || clubFarm.day !== today) {
    return { day: today, count: 0, rootId: null, running: false, lastResult: null, lastError: null };
  }
  return clubFarm;
};
const setState = async (s) => chrome.storage.local.set({ clubFarm: s });
const patchState = async (patch) => {
  const cur = await getState();
  await setState({ ...cur, ...patch });
};

// Parse "Комментариев N из M" from /balance — server-authoritative count.
const fetchBalanceCount = async () => {
  try {
    const r = await fetch(BALANCE_URL, { credentials: 'include' });
    if (!r.ok) return null;
    const html = await r.text();
    const m = html.match(/Комментариев\s+(\d+)\s+из\s+(\d+)/);
    if (!m) return null;
    return { done: parseInt(m[1], 10), total: parseInt(m[2], 10) };
  } catch { return null; }
};

// Discover club slug → numeric id + CSRF + display name.
const fetchClubMeta = async () => {
  const r = await fetch(HOME_URL, { credentials: 'include' });
  if (r.redirected && /\/login/i.test(r.url)) return { ok: false, code: 'auth' };
  if (r.status !== 200) return { ok: false, code: 'http', status: r.status };
  const html = await r.text();
  // Manual parsing — no DOMParser in service workers. Find all <a href="/clubs/...">
  // and pick the one whose class contains "menu__item" (works regardless of attr order).
  let slug = null;
  for (const m of html.matchAll(/<a\b([^>]*)\bhref="(\/clubs\/[^"]+)"([^>]*)>/g)) {
    const attrs = (m[1] || '') + ' ' + (m[3] || '');
    if (/\bclass="[^"]*\bmenu__item\b/.test(attrs)) {
      slug = m[2].replace(/^\/clubs\//, '').replace(/\/$/, '');
      break;
    }
  }
  if (!slug) return { ok: false, code: 'no-club' };

  const r2 = await fetch(`${ORIGIN}/clubs/${slug}`, { credentials: 'include' });
  if (r2.status !== 200) return { ok: false, code: 'http', status: r2.status };
  const html2 = await r2.text();
  const csrfMatch = html2.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/);
  const idMatch = html2.match(/<div[^>]+class="[^"]*\bcomments\b[^"]*"[^>]+data-type="Club"[^>]+data-id="(\d+)"/)
    || html2.match(/<div[^>]+data-type="Club"[^>]+data-id="(\d+)"/);
  // Page <title> is "Клуб - Pepe squad" — strip the prefix.
  const titleMatch = html2.match(/<title>([^<]+)<\/title>/);
  const csrf = csrfMatch?.[1];
  const clubId = idMatch?.[1];
  const name = titleMatch?.[1]?.replace(/^Клуб\s*[-–—]\s*/i, '').trim() || slug;
  if (!csrf || !clubId) return { ok: false, code: 'parse' };
  return { ok: true, slug, clubId, csrf, name };
};

const postClubComment = async ({ clubId, csrf, text, parentId = '' }) => {
  const body = new URLSearchParams({
    text,
    commentable_id: String(clubId),
    commentable_type: 'Club',
    parent_id: parentId ? String(parentId) : '',
    gif_image: '',
    is_trade: '0',
    is_raffle: '0',
  });
  const r = await fetch(COMMENTS_URL, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-CSRF-TOKEN': csrf,
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'application/json',
    },
    body,
  });
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
};

const extractCommentId = (commentHtml) => {
  if (typeof commentHtml !== 'string') return null;
  const m = commentHtml.match(/id="comment_(\d+)"/);
  return m ? m[1] : null;
};

const scheduleNext = (delayMs) => {
  // chrome.alarms `when` survives SW termination; minimum effective delay
  // for unpacked extensions is fine for our 35s cooldown.
  chrome.alarms.create(ALARM_NAME, { when: Date.now() + delayMs });
};

// One iteration: post one comment, update state, schedule next.
const tick = async () => {
  let state = await getState();
  if (!state.running) return;
  if (state.count >= DAILY_TARGET) {
    await setState({ ...state, running: false, lastResult: 'done' });
    return;
  }

  // Refresh meta if missing or after a CSRF refresh signal.
  let meta = state.clubMeta;
  if (!meta) {
    const m = await fetchClubMeta();
    if (!m.ok) {
      await setState({ ...state, running: false, lastError: m.code, lastResult: 'error' });
      return;
    }
    meta = { clubId: m.clubId, csrf: m.csrf, name: m.name };
    state = { ...state, clubMeta: meta, clubName: m.name };
  }

  let res;
  try {
    res = await postClubComment({
      clubId: meta.clubId, csrf: meta.csrf,
      text: randomComment(), parentId: state.rootId || '',
    });
  } catch (e) {
    state.lastResult = 'network';
    state.lastError = e.message;
    state.nextAt = Date.now() + 10_000;
    await setState(state);
    scheduleNext(10_000);
    return;
  }

  if (res.status >= 200 && res.status < 300) {
    const id = extractCommentId(res.data?.comment);
    state.count = state.count + 1;
    if (!state.rootId && id) state.rootId = id;
    state.lastResult = 'ok';
    state.lastError = null;
  } else if (res.status === 422) {
    // Server cooldown ("Нельзя оставлять комментарии так часто") — back off.
    state.lastResult = 'cooldown';
  } else if (res.status === 419) {
    state.lastResult = 'csrf-refresh';
    state.clubMeta = null; // force re-fetch next tick
  } else if (res.status === 401 || res.status === 403) {
    await setState({ ...state, running: false, lastError: 'auth', lastResult: 'error' });
    return;
  } else {
    state.lastResult = 'http-' + res.status;
    state.lastError = res.data?.message || res.data?.error || null;
  }

  // Schedule next or finish
  if (state.count >= DAILY_TARGET) {
    state.running = false;
    state.lastResult = 'done';
    await setState(state);
    return;
  }
  const wait = state.lastResult === 'ok'
    ? COOLDOWN_MIN_MS + Math.floor(Math.random() * COOLDOWN_JITTER_MS)
    : RATE_LIMIT_BACKOFF_MS;
  state.nextAt = Date.now() + wait;
  await setState(state);
  scheduleNext(wait);
};

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) tick();
});

// Survive SW restarts: if state.running is true but no alarm scheduled,
// re-schedule one based on `nextAt` (or fire immediately if overdue).
const ensureAlarm = async () => {
  const state = await getState();
  if (!state.running) return;
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (existing) return;
  const delay = Math.max(1000, (state.nextAt || 0) - Date.now());
  scheduleNext(delay);
};
chrome.runtime.onStartup.addListener(ensureAlarm);
chrome.runtime.onInstalled.addListener(ensureAlarm);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.type === 'club-start') {
      let state = await getState();
      // Sync with server's authoritative count before starting.
      const bal = await fetchBalanceCount();
      if (bal && bal.done > state.count) state.count = bal.done;
      if (state.count >= DAILY_TARGET) {
        await setState({ ...state, running: false, lastResult: 'done' });
        sendResponse({ ok: true, alreadyDone: true });
        return;
      }
      state.running = true;
      state.clubMeta = null; // re-fetch with fresh CSRF
      state.lastError = null;
      state.lastResult = null;
      state.nextAt = Date.now();
      await setState(state);
      // Fire first tick immediately rather than waiting on alarm latency.
      tick();
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === 'club-stop') {
      const state = await getState();
      await setState({ ...state, running: false, lastResult: 'stopped' });
      chrome.alarms.clear(ALARM_NAME);
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === 'club-sync-count') {
      const bal = await fetchBalanceCount();
      if (bal) {
        const state = await getState();
        if (bal.done !== state.count) {
          await setState({ ...state, count: bal.done });
        }
      }
      sendResponse({ ok: true, balance: bal });
      return;
    }
  })();
  return true; // async
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    console.log('[MangaBuff] Installed. Open https://mangabuff.ru to use.');
  }
});
