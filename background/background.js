// Service worker — owns the long-running farms so they keep going after the
// popup closes:
//   - mine farm: sequential POST /mine/hit with human-like pauses
//   - comment farm: 13 daily comments into the user's alliance (or club)
//   - ads bonus: 3 daily claims of the rewarded-ad bonus
// Popup just sends start/stop messages and observes `chrome.storage.local`
// (`mineFarm`, `clubFarm`, `adsFarm`) for live state + a rolling log. State + the next
// scheduled step live in storage so the loops survive service-worker
// termination (Chrome wakes the SW for chrome.alarms).
//
// Day boundary uses Europe/Moscow because the site's quest counter resets
// on Moscow midnight.

const ORIGIN = 'https://mangabuff.ru';
const COMMENTS_URL = ORIGIN + '/comments';
const HOME_URL = ORIGIN + '/';
const BALANCE_URL = ORIGIN + '/balance';
const MINE_URL = ORIGIN + '/mine';
const MINE_HIT_URL = ORIGIN + '/mine/hit';
const ADS_URL = ORIGIN + '/balance/ads';
const ALARM_NAME = 'clubFarmTick';
const MINE_ALARM = 'mineFarmTick';
const MINE_WATCHDOG = 'mineFarmWatchdog';
const ADS_ALARM = 'adsFarmTick';

const DAILY_TARGET = 13;
const COOLDOWN_MIN_MS = 35_000;
const COOLDOWN_JITTER_MS = 10_000;
const RATE_LIMIT_BACKOFF_MS = 35_000;

// The site's own swing is 8 animation frames × 50ms + 200ms before the POST,
// then a human needs a moment to tap again. Firing hits in parallel gets most
// of them rejected, so we go one by one at roughly that pace.
const MINE_DELAY_MIN_MS = 650;
const MINE_DELAY_JITTER_MS = 650;
const MINE_BREAK_EVERY = [18, 32]; // occasional "hand rest" every N hits
const MINE_BREAK_MS = [2_500, 6_000];
const MINE_MAX_FAILS = 8; // consecutive failures before giving up
const LONG_WAIT_MS = 20_000; // longer waits go through chrome.alarms so the SW may sleep

// The rewarded ad on /balance is a Yandex `rewarded` block whose client-side
// `onRewarded` callback does a bare `POST /balance/ads` — no ad token is sent.
// We make that same POST without loading the ad, spaced like real views
// (a rewarded video runs ~15–30s; alarms can't fire sooner than 30s anyway).
const ADS_DAILY = 3;
const ADS_WATCH_MS = [32_000, 55_000];
const ADS_MAX_FAILS = 3;

const LOG_LIMIT = 40;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const fmt = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('ru-RU'));

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

// Append a line to a state's rolling log. Ids are monotonic so the popup can
// append only the lines it hasn't rendered yet.
const addLog = (s, msg, kind = 'info') => {
  const log = s.log || [];
  const id = (log.length ? log[log.length - 1].id : 0) + 1;
  return { ...s, log: [...log, { id, t: Date.now(), msg, kind }].slice(-LOG_LIMIT) };
};

// Every writer of a farm's state lives in this SW, so chaining each
// read-modify-write onto one promise makes them atomic: a stop message can't
// be overwritten by a loop iteration that read the state before it.
const createStore = (key, normalize) => {
  let chain = Promise.resolve();
  const read = async () => normalize((await chrome.storage.local.get(key))[key]);
  const update = (fn) => {
    const run = chain.then(async () => {
      const next = fn(await read());
      await chrome.storage.local.set({ [key]: next });
      return next;
    });
    chain = run.catch(() => {});
    return run;
  };
  return { read, update };
};

const clubStore = createStore('clubFarm', (s) => {
  const today = moscowDateStr();
  if (!s || s.day !== today) {
    return { day: today, count: 0, rootId: null, running: false, lastResult: null, lastError: null, log: s?.log || [] };
  }
  return s;
});

const adsStore = createStore('adsFarm', (s) => {
  const today = moscowDateStr();
  if (!s || s.day !== today) {
    return { day: today, count: 0, running: false, fails: 0, nextAt: null, log: s?.log || [] };
  }
  return s;
});

const mineStore = createStore('mineFarm', (s) => ({
  running: false, done: 0, target: 0, ore: null, hitsLeft: null, fails: 0, nextAt: null, log: [],
  ...s,
}));

const parseCsrf = (html) => html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/)?.[1] || null;

const postForm = async (url, csrf, params = {}) => {
  const r = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-CSRF-TOKEN': csrf,
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'application/json',
    },
    body: new URLSearchParams(params),
  });
  let data = null;
  try { data = await r.json(); } catch {}
  // A dead session can come back as a redirect to the HTML login page with
  // a 200 status — never count that as a success.
  const status = r.redirected && /\/login/i.test(r.url) ? 401 : r.status;
  return { status, data, retryAfter: parseInt(r.headers.get('retry-after'), 10) || null };
};

/* ---------- Mine farm ---------- */

// Ore, hits-left and CSRF from the /mine page. No DOMParser in service
// workers, so plain regexes against the known markup.
const fetchMinePage = async () => {
  const r = await fetch(MINE_URL, { credentials: 'include' });
  if (r.redirected && /\/login/i.test(r.url)) return { ok: false, code: 'auth' };
  if (r.status !== 200) return { ok: false, code: 'http', status: r.status };
  const html = await r.text();
  const csrf = parseCsrf(html);
  if (!csrf) return { ok: false, code: 'auth' };
  const num = (re) => {
    const n = parseInt((html.match(re)?.[1] || '').replace(/\D/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  };
  return {
    ok: true,
    csrf,
    ore: num(/class="main-mine"[^>]*\bdata-ore="(\d+)"/) ?? num(/\bjs-score">([\d\s]+)</),
    hitsLeft: num(/main-mine__game-hits-left">([\d\s]+)</),
  };
};

let mineCsrf = null; // in-memory; re-fetched after a SW restart or a 419
let mineLoopActive = false;

const clearMineAlarms = () => {
  chrome.alarms.clear(MINE_ALARM);
  chrome.alarms.clear(MINE_WATCHDOG);
};

const finishMine = async (msg, kind) => {
  await mineStore.update((c) => addLog({ ...c, running: false, nextAt: null }, msg, kind));
  clearMineAlarms();
};

const mineBackoff = (fails) => Math.min(30_000, 1_500 * 2 ** (fails - 1)) + rand(0, 500);

const runMineLoop = async () => {
  if (mineLoopActive) return;
  mineLoopActive = true;
  try {
    let sinceBreak = 0;
    let breakAt = rand(...MINE_BREAK_EVERY);
    for (;;) {
      let s = await mineStore.read();
      if (!s.running) { clearMineAlarms(); return; }
      // Woken early (watchdog / SW restart) during a long pause — keep waiting.
      if (s.nextAt && s.nextAt - Date.now() > 1_500) {
        chrome.alarms.create(MINE_ALARM, { when: s.nextAt });
        return;
      }
      if (s.fails >= MINE_MAX_FAILS) {
        await finishMine(`Слишком много ошибок подряд (${s.fails}) — остановлено`, 'err');
        return;
      }

      let wait;
      if (!mineCsrf) {
        // Also our resync point: after an odd error we re-read hits-left from
        // the page instead of guessing what the server's message meant.
        let page;
        try { page = await fetchMinePage(); } catch (e) { page = { ok: false, code: 'network', error: e.message }; }
        if (!page.ok && page.code === 'auth') { await finishMine('Сессия закончилась — войди на mangabuff.ru', 'err'); return; }
        if (!page.ok) {
          s = await mineStore.update((c) => addLog({ ...c, fails: c.fails + 1 },
            `Не открылась /mine: ${page.error || page.status || page.code}`, 'err'));
          wait = mineBackoff(s.fails);
        } else {
          mineCsrf = page.csrf;
          s = await mineStore.update((c) => ({ ...c, ore: page.ore ?? c.ore, hitsLeft: page.hitsLeft ?? c.hitsLeft }));
          if (page.hitsLeft === 0) { await finishMine(`Удары закончились · ударов: ${s.done}`, 'ok'); return; }
          continue;
        }
      } else {
        let res;
        try { res = await postForm(MINE_HIT_URL, mineCsrf); } catch (e) { res = { status: 0, error: e.message }; }

        if (res.status >= 200 && res.status < 300 && res.data) {
          const hitsLeft = Number.isFinite(parseInt(res.data.hits_left, 10)) ? parseInt(res.data.hits_left, 10) : null;
          const ore = Number.isFinite(parseInt(res.data.ore, 10)) ? parseInt(res.data.ore, 10) : null;
          s = await mineStore.update((c) => {
            const left = hitsLeft ?? (c.hitsLeft !== null ? c.hitsLeft - 1 : null);
            const n = { ...c, done: c.done + 1, fails: 0, nextAt: null, ore: ore ?? c.ore, hitsLeft: left };
            return n.done % 10 === 0 ? addLog(n, `удар ${n.done}/${n.target} · руда ${fmt(n.ore)}`, 'ok') : n;
          });
          if (s.hitsLeft !== null && s.hitsLeft <= 0) {
            await finishMine(`Готово — ударов: ${s.done} · руда ${fmt(s.ore)}`, 'ok');
            return;
          }
          if (++sinceBreak >= breakAt) {
            sinceBreak = 0;
            breakAt = rand(...MINE_BREAK_EVERY);
            wait = rand(...MINE_BREAK_MS);
          } else {
            wait = MINE_DELAY_MIN_MS + rand(0, MINE_DELAY_JITTER_MS);
          }
        } else if (res.status === 401 || res.status === 403) {
          await finishMine('Сессия закончилась — войди на mangabuff.ru', 'err');
          return;
        } else if (res.status === 419) {
          mineCsrf = null;
          s = await mineStore.update((c) => addLog({ ...c, fails: c.fails + 1 }, 'CSRF протух — обновляю', 'err'));
          wait = 1_000;
        } else if (res.status === 429) {
          wait = res.retryAfter ? res.retryAfter * 1_000 + rand(500, 2_000) : mineBackoff(s.fails + 1) + 5_000;
          s = await mineStore.update((c) => addLog({ ...c, fails: c.fails + 1 },
            `Сервер просит притормозить — пауза ${Math.round(wait / 1000)}с`, 'info'));
        } else {
          // 4xx with a message (e.g. hits are over) or 5xx / network.
          if (res.status >= 400 && res.status < 500) mineCsrf = null; // resync from the page
          const why = res.data?.message || res.error || `HTTP ${res.status}`;
          s = await mineStore.update((c) => addLog({ ...c, fails: c.fails + 1 }, `Удар не прошёл: ${why}`, 'err'));
          wait = mineBackoff(s.fails);
        }
      }

      if (wait > LONG_WAIT_MS) {
        const at = Date.now() + wait;
        await mineStore.update((c) => ({ ...c, nextAt: at }));
        chrome.alarms.create(MINE_ALARM, { when: at });
        return;
      }
      await sleep(wait);
    }
  } finally {
    mineLoopActive = false;
  }
};

const startMine = async () => {
  const page = await fetchMinePage();
  if (!page.ok) return { ok: false, error: page.code === 'auth' ? 'auth' : `HTTP ${page.status}` };
  mineCsrf = page.csrf;
  if (page.hitsLeft === 0) {
    await mineStore.update((c) => addLog({ ...c, running: false, ore: page.ore, hitsLeft: 0 }, 'Удары закончились', 'info'));
    return { ok: true, nothing: true };
  }
  await mineStore.update((c) => addLog(
    { ...c, running: true, done: 0, target: page.hitsLeft ?? 100, ore: page.ore, hitsLeft: page.hitsLeft, fails: 0, nextAt: null },
    `Фарм запущен — ${page.hitsLeft ?? '?'} ударов по одному`, 'info'));
  // Restarts the loop if Chrome kills the SW mid-run.
  chrome.alarms.create(MINE_WATCHDOG, { periodInMinutes: 0.5 });
  runMineLoop();
  return { ok: true };
};

/* ---------- Comment farm (alliance / club) ---------- */

// Today's quests from /balance — server-authoritative counts.
//   comments: `<span>Комментарии</span> <b>3/13</b>` (older "Комментариев N
//             из M" text kept as a fallback)
//   ads:      `<button class="… user-quest__watch-ads-btn" data-count="1">`
const fetchBalancePage = async () => {
  const r = await fetch(BALANCE_URL, { credentials: 'include' });
  if (r.redirected && /\/login/i.test(r.url)) return { ok: false, code: 'auth' };
  if (r.status !== 200) return { ok: false, code: 'http', status: r.status };
  const html = await r.text();
  const m = html.match(/Комментарии\s*<\/span>\s*<b>\s*(\d+)\s*\/\s*(\d+)/)
    || html.match(/Комментариев\s+(\d+)\s+из\s+(\d+)/);
  const adsBtn = html.match(/<button\b[^>]*\buser-quest__watch-ads-btn\b[^>]*>/)?.[0];
  const ads = parseInt(adsBtn?.match(/\bdata-count="(\d+)"/)?.[1], 10);
  return {
    ok: true,
    csrf: parseCsrf(html),
    comments: m ? { done: parseInt(m[1], 10), total: parseInt(m[2], 10) } : null,
    adsCount: Number.isFinite(ads) ? ads : null,
  };
};

const fetchBalanceCount = async () => {
  try {
    const page = await fetchBalancePage();
    return page.ok ? page.comments : null;
  } catch { return null; }
};

const decodeEntities = (s) => s
  .replace(/&laquo;/g, '«').replace(/&raquo;/g, '»').replace(/&quot;/g, '"')
  .replace(/&#0?39;/g, "'").replace(/&amp;/g, '&');

// «Мой альянс» / «Мой клуб» links from the site menu, alliance first.
const findMenuTargets = (html) => {
  const paths = [];
  for (const m of html.matchAll(/<a\b([^>]*)>/g)) {
    const attrs = m[1];
    if (!/\bclass="[^"]*\bmenu__item\b/.test(attrs)) continue;
    const path = attrs.match(/\bhref="(?:https:\/\/mangabuff\.ru)?(\/(?:alliances\/\d+|clubs\/[^"/]+))\/?"/)?.[1];
    if (path && !paths.includes(path)) paths.push(path);
  }
  return paths.sort((a, b) => b.startsWith('/alliances/') - a.startsWith('/alliances/'));
};

// `<div class="comments" data-type="ClubAlliance" data-id="327">` — take the
// type/id as rendered instead of hardcoding them, so a future rename on the
// site doesn't break posting.
const parseCommentable = (html) => {
  for (const m of html.matchAll(/<div\b([^>]*)>/g)) {
    const attrs = m[1];
    if (!/\bclass="(?:[^"]*\s)?comments(?:\s[^"]*)?"/.test(attrs)) continue;
    const type = attrs.match(/\bdata-type="([^"]+)"/)?.[1];
    const id = attrs.match(/\bdata-id="(\d+)"/)?.[1];
    if (type && id) return { type, id };
  }
  return null;
};

// The daily comment quest moved from the club page to the alliance page
// (`/alliances/{id}`), so discover the target from the menu on every start:
// alliance if the user is in one, otherwise their club.
const fetchCommentTarget = async () => {
  const r = await fetch(HOME_URL, { credentials: 'include' });
  if (r.redirected && /\/login/i.test(r.url)) return { ok: false, code: 'auth' };
  if (r.status !== 200) return { ok: false, code: 'http', status: r.status };
  const paths = findMenuTargets(await r.text());
  if (!paths.length) return { ok: false, code: 'no-club' };

  for (const path of paths) {
    const r2 = await fetch(ORIGIN + path, { credentials: 'include' });
    if (r2.status !== 200) continue;
    const html = await r2.text();
    const target = parseCommentable(html);
    const csrf = parseCsrf(html);
    if (!target || !csrf) continue;
    // <title> is "Альянс «OTV»" or "Клуб - Pepe squad".
    const title = decodeEntities(html.match(/<title>([^<]+)<\/title>/)?.[1] || '');
    const name = title.replace(/^(Альянс|Клуб)\s*[-–—:]?\s*/i, '').replace(/^«(.*)»$/, '$1').trim() || path;
    const kind = path.startsWith('/alliances/') ? 'Альянс' : 'Клуб';
    return { ok: true, path, csrf, type: target.type, id: target.id, name: `${kind} «${name}»` };
  }
  return { ok: false, code: 'parse' };
};

const postComment = ({ meta, text, parentId }) => postForm(COMMENTS_URL, meta.csrf, {
  text,
  commentable_id: String(meta.id),
  commentable_type: meta.type,
  parent_id: parentId ? String(parentId) : '',
  gif_image: '',
  is_trade: '0',
  is_raffle: '0',
});

const extractCommentId = (commentHtml) => {
  if (typeof commentHtml !== 'string') return null;
  const m = commentHtml.match(/id="comment_(\d+)"/);
  return m ? m[1] : null;
};

const TARGET_ERRORS = {
  auth: 'Не авторизован — войди на mangabuff.ru',
  'no-club': 'В меню нет «Мой альянс» / «Мой клуб»',
  parse: 'На странице альянса/клуба не найден блок комментариев',
};

const scheduleNext = (delayMs) => {
  // chrome.alarms `when` survives SW termination; minimum effective delay
  // for unpacked extensions is fine for our 35s cooldown.
  chrome.alarms.create(ALARM_NAME, { when: Date.now() + delayMs });
};

let clubTickActive = false;

// One iteration: post one comment, merge the result into the latest state,
// schedule next. Results are merged (not written from a stale snapshot), so a
// stop pressed while the POST is in flight sticks.
const tick = async () => {
  if (clubTickActive) return;
  clubTickActive = true;
  try {
    let state = await clubStore.read();
    if (!state.running) return;
    if (state.count >= DAILY_TARGET) {
      await clubStore.update((c) => addLog({ ...c, running: false, lastResult: 'done' }, 'Готово — норма дня выполнена', 'ok'));
      return;
    }

    let meta = state.clubMeta;
    if (!meta) {
      let m;
      try { m = await fetchCommentTarget(); } catch (e) { m = { ok: false, code: 'network', error: e.message }; }
      if (!m.ok && m.code === 'network') {
        state = await clubStore.update((c) => addLog({ ...c, lastResult: 'network', nextAt: Date.now() + 10_000 },
          `Сеть: ${m.error}`, 'err'));
        if (state.running) scheduleNext(10_000);
        return;
      }
      if (!m.ok) {
        const msg = TARGET_ERRORS[m.code] || `HTTP ${m.status || m.code}`;
        await clubStore.update((c) => addLog({ ...c, running: false, lastError: m.code, lastResult: 'error' }, `Ошибка: ${msg}`, 'err'));
        return;
      }
      meta = { path: m.path, type: m.type, id: m.id, csrf: m.csrf, name: m.name };
      const key = `${meta.type}:${meta.id}`;
      state = await clubStore.update((c) => {
        // A thread root from another commentable can't be replied to here.
        const n = c.rootFor === key ? c : { ...c, rootId: null, rootFor: key };
        return addLog({ ...n, clubMeta: meta, clubName: meta.name }, `Цель: ${meta.name}`, 'info');
      });
      if (!state.running) return;
    }

    let res;
    try {
      res = await postComment({ meta, text: randomComment(), parentId: state.rootId });
    } catch (e) {
      state = await clubStore.update((c) => addLog({ ...c, lastResult: 'network', lastError: e.message, nextAt: Date.now() + 10_000 },
        `Сеть: ${e.message}`, 'err'));
      if (state.running) scheduleNext(10_000);
      return;
    }

    let wait = RATE_LIMIT_BACKOFF_MS;
    state = await clubStore.update((c) => {
      let n = { ...c };
      if (res.status >= 200 && res.status < 300 && res.data) {
        const id = extractCommentId(res.data.comment);
        const isRoot = !n.rootId && !!id;
        n.count = n.count + 1;
        if (isRoot) n.rootId = id;
        n.lastResult = 'ok';
        n.lastError = null;
        n = addLog(n, `✓ ${n.count}/${DAILY_TARGET}${isRoot ? ' (root)' : ''}`, 'ok');
        wait = COOLDOWN_MIN_MS + Math.floor(Math.random() * COOLDOWN_JITTER_MS);
      } else if (res.status === 422) {
        const msg = res.data?.message || '';
        if (n.rootId && msg && !/часто|подожд|секунд|минут/i.test(msg)) {
          // Not the cooldown — most likely the root comment is gone. Start a new thread.
          n.rootId = null;
          n = addLog(n, `Ветка недоступна (${msg}) — начну новую`, 'err');
        } else {
          // Server cooldown ("Нельзя оставлять комментарии так часто") — back off.
          n = addLog(n, 'Кулдаун сервера — ждём', 'info');
        }
        n.lastResult = 'cooldown';
      } else if (res.status === 419) {
        n.lastResult = 'csrf-refresh';
        n.clubMeta = null; // force re-fetch next tick
        n = addLog(n, 'CSRF протух — обновляю', 'err');
      } else if (res.status === 401 || res.status === 403) {
        return addLog({ ...n, running: false, lastError: 'auth', lastResult: 'error' }, `Ошибка: ${TARGET_ERRORS.auth}`, 'err');
      } else {
        n.lastResult = 'http-' + res.status;
        n.lastError = res.data?.message || res.data?.error || null;
        n = addLog(n, `Ошибка: HTTP ${res.status}${n.lastError ? ' — ' + n.lastError : ''}`, 'err');
      }

      if (n.count >= DAILY_TARGET) {
        return addLog({ ...n, running: false, lastResult: 'done' }, 'Готово — норма дня выполнена', 'ok');
      }
      if (!n.running) return n;
      n.nextAt = Date.now() + wait;
      return n.lastResult === 'ok' ? addLog(n, `Жду ${Math.round(wait / 1000)}с до следующего`, 'info') : n;
    });
    if (state.running) scheduleNext(wait);
  } finally {
    clubTickActive = false;
  }
};

/* ---------- Ads bonus ---------- */

let adsTickActive = false;

const scheduleAds = (delayMs) => chrome.alarms.create(ADS_ALARM, { when: Date.now() + delayMs });

const finishAds = async (msg, kind) => {
  await adsStore.update((c) => addLog({ ...c, running: false, nextAt: null }, msg, kind));
  chrome.alarms.clear(ADS_ALARM);
};

// One claim per alarm. CSRF is re-read from /balance every time: claims are
// minutes apart and the page also carries the server's view counter.
const adsTick = async () => {
  if (adsTickActive) return;
  adsTickActive = true;
  try {
    let s = await adsStore.read();
    if (!s.running) return;

    let page;
    try { page = await fetchBalancePage(); } catch (e) { page = { ok: false, code: 'network', error: e.message }; }
    if (!page.ok && page.code === 'auth') { await finishAds('Сессия закончилась — войди на mangabuff.ru', 'err'); return; }
    if (!page.ok || !page.csrf) {
      s = await adsStore.update((c) => addLog({ ...c, fails: c.fails + 1 },
        `Не открылась /balance: ${page.error || page.status || page.code || 'нет CSRF'}`, 'err'));
      if (s.fails >= ADS_MAX_FAILS) await finishAds('Слишком много ошибок — остановлено', 'err');
      else if (s.running) scheduleAds(60_000);
      return;
    }
    if (page.adsCount !== null && page.adsCount >= ADS_DAILY) {
      await adsStore.update((c) => ({ ...c, count: page.adsCount }));
      await finishAds(`Реклама на сегодня всё: ${ADS_DAILY}/${ADS_DAILY}`, 'ok');
      return;
    }

    let res;
    try { res = await postForm(ADS_URL, page.csrf); } catch (e) { res = { status: 0, error: e.message }; }

    let wait = null;
    s = await adsStore.update((c) => {
      let n = { ...c };
      if (res.status >= 200 && res.status < 300) {
        n.count = Math.max(n.count, page.adsCount ?? 0) + 1;
        n.fails = 0;
        n = addLog(n, `📺 ✓ ${n.count}/${ADS_DAILY}${res.data?.message ? ' · ' + res.data.message : ''}`, 'ok');
        if (n.count >= ADS_DAILY) return addLog({ ...n, running: false, nextAt: null }, `Реклама на сегодня всё: ${ADS_DAILY}/${ADS_DAILY}`, 'ok');
        wait = rand(...ADS_WATCH_MS);
      } else if (res.status === 401 || res.status === 403) {
        return addLog({ ...n, running: false, nextAt: null }, 'Сессия закончилась — войди на mangabuff.ru', 'err');
      } else if (res.status >= 400 && res.status < 500 && res.status !== 419 && res.status !== 429) {
        // Limit reached / "досмотри рекламу" etc. — the server said no, don't hammer it.
        return addLog({ ...n, running: false, nextAt: null }, `📺 Сервер: ${res.data?.message || 'HTTP ' + res.status}`, 'err');
      } else {
        n.fails = n.fails + 1;
        n = addLog(n, `📺 Не прошло: ${res.data?.message || res.error || 'HTTP ' + res.status}`, 'err');
        if (n.fails >= ADS_MAX_FAILS) return addLog({ ...n, running: false, nextAt: null }, 'Слишком много ошибок — остановлено', 'err');
        wait = res.retryAfter ? res.retryAfter * 1_000 + 2_000 : 60_000;
      }
      if (!n.running) return n;
      n.nextAt = Date.now() + wait;
      return addLog(n, `📺 Следующий бонус через ~${Math.round(wait / 1000)}с`, 'info');
    });
    if (s.running && wait !== null) scheduleAds(wait);
    else chrome.alarms.clear(ADS_ALARM);
  } finally {
    adsTickActive = false;
  }
};

const startAds = async () => {
  const page = await fetchBalancePage();
  if (!page.ok) return { ok: false, error: page.code === 'auth' ? 'auth' : `HTTP ${page.status}` };
  const s = await adsStore.update((c) => {
    const count = Math.max(c.count, page.adsCount ?? 0);
    if (count >= ADS_DAILY) return addLog({ ...c, count, running: false }, `Реклама на сегодня всё: ${ADS_DAILY}/${ADS_DAILY}`, 'ok');
    const wait = rand(...ADS_WATCH_MS);
    return addLog({ ...c, count, running: true, fails: 0, nextAt: Date.now() + wait },
      `📺 Запущено · ${count}/${ADS_DAILY} · первый бонус через ~${Math.round(wait / 1000)}с`, 'info');
  });
  if (s.running) chrome.alarms.create(ADS_ALARM, { when: s.nextAt });
  return { ok: true, alreadyDone: !s.running };
};

/* ---------- Wiring ---------- */

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) tick();
  if (alarm.name === MINE_ALARM || alarm.name === MINE_WATCHDOG) runMineLoop();
  if (alarm.name === ADS_ALARM) adsTick();
});

// Survive SW restarts: if a farm is marked running but nothing will wake it,
// re-schedule based on `nextAt` (or fire immediately if overdue).
const ensureAlarm = async () => {
  const state = await clubStore.read();
  if (state.running && !(await chrome.alarms.get(ALARM_NAME))) {
    scheduleNext(Math.max(1000, (state.nextAt || 0) - Date.now()));
  }
  const ads = await adsStore.read();
  if (ads.running && !(await chrome.alarms.get(ADS_ALARM))) {
    scheduleAds(Math.max(1000, (ads.nextAt || 0) - Date.now()));
  }
  const mine = await mineStore.read();
  if (mine.running) {
    chrome.alarms.create(MINE_WATCHDOG, { periodInMinutes: 0.5 });
    runMineLoop();
  }
};
chrome.runtime.onStartup.addListener(ensureAlarm);
chrome.runtime.onInstalled.addListener(ensureAlarm);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.type === 'mine-start') {
      const s = await mineStore.read();
      if (s.running) { runMineLoop(); sendResponse({ ok: true }); return; }
      sendResponse(await startMine());
      return;
    }
    if (msg?.type === 'mine-stop') {
      await finishMine('Остановлено', 'info');
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === 'ads-start') {
      const s = await adsStore.read();
      sendResponse(s.running ? { ok: true } : await startAds());
      return;
    }
    if (msg?.type === 'ads-stop') {
      await finishAds('📺 Остановлено', 'info');
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === 'club-start') {
      // Sync with server's authoritative count before starting.
      const bal = await fetchBalanceCount();
      const state = await clubStore.update((c) => {
        const n = { ...c };
        if (bal && bal.done > n.count) n.count = bal.done;
        if (n.count >= DAILY_TARGET) {
          return addLog({ ...n, running: false, lastResult: 'done' }, `Сегодня уже ${DAILY_TARGET} — норма выполнена`, 'ok');
        }
        return addLog(
          { ...n, running: true, clubMeta: null, lastError: null, lastResult: null, nextAt: Date.now() },
          `Фарм запущен · ${n.count}/${DAILY_TARGET}`, 'info');
      });
      if (!state.running) {
        sendResponse({ ok: true, alreadyDone: true });
        return;
      }
      // Fire first tick immediately rather than waiting on alarm latency.
      tick();
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === 'club-stop') {
      await clubStore.update((c) => addLog({ ...c, running: false, lastResult: 'stopped' }, 'Остановлено', 'info'));
      chrome.alarms.clear(ALARM_NAME);
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === 'balance-sync') {
      let page = null;
      try { page = await fetchBalancePage(); } catch {}
      const bal = page?.ok ? page.comments : null;
      if (bal) {
        await clubStore.update((c) => (bal.done !== c.count ? { ...c, count: bal.done } : c));
      }
      if (page?.ok && page.adsCount !== null) {
        await adsStore.update((c) => (page.adsCount !== c.count ? { ...c, count: page.adsCount } : c));
      }
      sendResponse({ ok: true, balance: bal, ads: page?.ok ? page.adsCount : null });
      return;
    }
  })().catch((e) => sendResponse({ ok: false, error: e.message }));
  return true; // async
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    console.log('[MangaBuff] Installed. Open https://mangabuff.ru to use.');
  }
});
