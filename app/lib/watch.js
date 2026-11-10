// wCLAUDE — Veille (niveau 1) : relève de sources pendant que l'agent n'est pas là, sans aucune IA.
// Pages : vue cachée du navigateur (session par défaut, donc les connexions de l'utilisateur) ; flux RSS/Atom et
// releases GitHub : requête réseau du navigateur. Première lecture = référence, aucune alerte.
// Barrière (CAPTCHA, connexion, anti-robots) : la source passe en « main demandée », rien n'est contourné.
const { BrowserWindow, session, powerMonitor } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('./watch-core');
const { SUPPORT_DIR } = require('./config');

const FILE = path.join(SUPPORT_DIR, 'watch.json');
const EVERY = [1, 6, 24, 168];
const MAX_ITEMS_PER_SOURCE = 50;
const MAX_AGE = 90 * 24 * 3600 * 1000;
const PAGE_TIMEOUT = 30000;
const SETTLE = 2500;
const H = 3600 * 1000;

let data = null;
let listeners = [];
let running = false; // une source à la fois
let timer = null;
let pending = []; // nouveautés du passage en cours, pour une seule notification
let notifier = null;
let ua = '';

// ---------- stockage ----------
function load() {
  if (data) return data;
  try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { data = null; }
  if (!data || !Array.isArray(data.sources)) data = { version: 1, nextItemId: 1, lastPass: 0, groups: [], sources: [], items: [] };
  data.groups = data.groups || [];
  data.items = data.items || [];
  return data;
}

function save() {
  fs.mkdirSync(SUPPORT_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, FILE);
}

function changed() {
  save();
  for (const fn of listeners) { try { fn(); } catch { /* écouteur fermé */ } }
}

const sourceById = (id) => load().sources.find((s) => s.id === String(id));
const unreadOf = (id) => load().items.filter((i) => !i.read && (id == null || i.sourceId === id));

function prune() {
  const now = Date.now();
  const bySource = new Map();
  data.items = data.items.filter((it) => {
    if (!sourceById(it.sourceId)) return false;
    if (it.read && now - it.at > MAX_AGE) return false;
    const n = (bySource.get(it.sourceId) || 0) + 1;
    bySource.set(it.sourceId, n);
    return true;
  });
  for (const [sid, n] of bySource) {
    if (n <= MAX_ITEMS_PER_SOURCE) continue;
    let drop = n - MAX_ITEMS_PER_SOURCE; // les plus anciens d'abord (les éléments sont rangés par id croissant)
    data.items = data.items.filter((it) => !(it.sourceId === sid && drop-- > 0));
  }
}

// ---------- état public ----------
function status(s) {
  if (!s.enabled) return 'paused';
  if (unreadOf(s.id).length) return 'new';
  return s.state.status || 'pending';
}

function publicSource(s) {
  const st = s.state || {};
  return {
    id: s.id, name: s.name, url: s.url, group: s.group || '', kind: s.kind, everyHours: s.everyHours,
    selector: s.selector || '', keywords: s.keywords || [], note: s.note || '', enabled: s.enabled !== false,
    status: status(s), unread: unreadOf(s.id).length, lastCheck: st.lastCheck || 0, nextCheck: st.nextCheck || 0,
    error: st.error || '', reason: st.reason || '', version: st.version || '', words: st.words || 0,
  };
}

function snapshot() {
  const d = load();
  return {
    sources: d.sources.map(publicSource),
    groups: d.groups,
    items: d.items.slice().reverse(),
    unread: unreadOf().length,
    lastPass: d.lastPass || 0,
    running,
    file: FILE,
  };
}

// ---------- lecture d'une adresse ----------
async function fetchText(url, { accept } = {}) {
  const res = await session.defaultSession.fetch(url, {
    headers: { 'User-Agent': ua, Accept: accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    redirect: 'follow',
    signal: AbortSignal.timeout(PAGE_TIMEOUT),
  });
  const body = await res.text();
  return { status: res.status, body: body.slice(0, 5 * 1024 * 1024), type: res.headers.get('content-type') || '', url: res.url || url };
}

/** Page dans une fenêtre cachée (jamais affichée, aucun focus) : texte visible, ou celui de la zone choisie. */
function readPage(url, selector) {
  return new Promise((resolve) => {
    const w = new BrowserWindow({
      show: false, width: 1280, height: 900, skipTaskbar: true, focusable: false, paintWhenInitiallyHidden: true,
      webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, images: false, autoplayPolicy: 'user-gesture-required' },
    });
    const wc = w.webContents;
    wc.setAudioMuted(true);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    let httpStatus = 200;
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(limit);
      if (!w.isDestroyed()) w.destroy();
      resolve(result);
    };
    const limit = setTimeout(() => extract(true), PAGE_TIMEOUT);
    wc.on('did-navigate', (_e, _url, code) => { if (code) httpStatus = code; });
    wc.on('did-fail-load', (_e, code, desc, _u, isMain) => {
      if (isMain && code !== -3) finish({ error: desc || `load ${code}` });
    });
    const js = `(() => {
      const sel = ${JSON.stringify(selector || '')};
      const root = sel ? document.querySelector(sel) : document.body;
      const pw = [...document.querySelectorAll('input[type=password]')].some((e) => e.offsetParent !== null);
      return { title: document.title, text: root ? root.innerText : '', found: !!root, hasPassword: pw };
    })()`;
    let tries = 0;
    async function extract(timedOut = false) {
      if (done) return;
      try {
        const r = await wc.executeJavaScript(js, true);
        const reason = core.needsUser({ ...r, status: httpStatus });
        // Défi anti-robot qui se résout seul (quelques secondes) : on patiente une fois, sans rien cliquer.
        if (reason === 'challenge' && !timedOut && tries++ < 1) { setTimeout(() => extract(), 8000); return; }
        if (reason) return finish({ needsUser: reason, status: httpStatus });
        if (httpStatus >= 400) return finish({ error: `HTTP ${httpStatus}`, status: httpStatus });
        if (selector && !r.found) return finish({ error: 'selector', status: httpStatus });
        finish({ text: core.normalize(r.text), title: r.title, status: httpStatus });
      } catch (e) {
        finish({ error: timedOut ? 'timeout' : String(e.message || e) });
      }
    }
    wc.once('did-finish-load', () => setTimeout(() => extract(), SETTLE));
    wc.loadURL(url, { userAgent: ua }).catch(() => { /* did-fail-load s'en charge */ });
  });
}

/** Type d'une adresse : releases GitHub, flux RSS/Atom (direct ou annoncé par la page), sinon page. */
async function detect(url) {
  const gh = core.githubRepo(url);
  if (gh) return { kind: 'github', fetchUrl: `https://api.github.com/repos/${gh.owner}/${gh.repo}/releases?per_page=10` };
  try {
    const r = await fetchText(url);
    if (core.looksLikeFeed(r.body) || /(rss|atom)\+xml/i.test(r.type)) return { kind: 'feed', fetchUrl: url };
    const feed = core.feedLink(r.body, r.url);
    if (feed) return { kind: 'feed', fetchUrl: feed };
  } catch { /* la page refuse peut-être les clients simples : la vue du navigateur la lira */ }
  return { kind: 'page', fetchUrl: url };
}

/**
 * Lit une source et rend son état actuel, sans rien enregistrer :
 * { text?, version?, entries?, needsUser?, error?, words, seconds }
 */
async function read(src) {
  const t0 = Date.now();
  const out = (o) => ({ ...o, seconds: Math.max(1, Math.round((Date.now() - t0) / 1000)) });
  try {
    if (src.kind === 'github') {
      const r = await fetchText(src.fetchUrl, { accept: 'application/vnd.github+json' });
      if (r.status === 404) return out({ error: 'HTTP 404' });
      if (r.status === 403 || r.status === 429) return out({ error: `HTTP ${r.status} (GitHub rate limit)`, retryable: true });
      if (r.status >= 400) return out({ error: `HTTP ${r.status}` });
      const list = JSON.parse(r.body).filter((x) => !x.draft);
      const entries = list.map((x) => ({
        id: String(x.id), title: x.name || x.tag_name, tag: x.tag_name, url: x.html_url, at: Date.parse(x.published_at) || 0,
        summary: core.normalize(String(x.body || '').replace(/[#*`>]/g, '')).split('\n').slice(0, 8).join('\n'),
      }));
      return out({ entries, version: entries[0] ? entries[0].tag : '' });
    }
    if (src.kind === 'feed') {
      const r = await fetchText(src.fetchUrl, { accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5' });
      if (r.status >= 400) return out({ error: `HTTP ${r.status}` });
      if (!core.looksLikeFeed(r.body)) return out({ error: 'not_a_feed' });
      return out({ entries: core.parseFeed(r.body) });
    }
    const p = await readPage(src.fetchUrl || src.url, src.selector);
    if (p.needsUser) return out({ needsUser: p.needsUser });
    if (p.error) return out({ error: p.error });
    if (src.kind === 'version') return out({ text: p.text, version: core.highestVersion(p.text) || '', words: core.wordCount(p.text) });
    return out({ text: p.text, words: core.wordCount(p.text) });
  } catch (e) {
    return out({ error: String(e && e.name === 'TimeoutError' ? 'timeout' : (e.message || e)).slice(0, 200) });
  }
}

// ---------- comparaison avec la référence ----------
function addItem(src, it) {
  const item = { id: data.nextItemId++, sourceId: src.id, at: Date.now(), read: false, lines: [], from: '', to: '', url: src.url, title: '', ...it };
  item.lines = item.lines.slice(0, 12).map((l) => l.slice(0, 300));
  data.items.push(item);
  pending.push(item);
  return item;
}

/** Applique une lecture : première fois = référence ; ensuite nouveautés. */
function apply(src, r) {
  const st = src.state || (src.state = {});
  const now = Date.now();
  const first = !st.lastOk;
  st.lastCheck = now;
  if (r.needsUser) {
    st.status = 'needs_user';
    st.reason = r.needsUser;
    st.error = '';
    st.nextCheck = now + src.everyHours * H;
    return;
  }
  if (r.error) {
    st.failures = (st.failures || 0) + 1;
    st.status = 'error';
    st.error = r.error;
    st.reason = '';
    st.nextCheck = now + Math.min(src.everyHours * H, 0.5 * H * Math.min(st.failures, 6));
    return;
  }
  st.status = 'ok';
  st.error = '';
  st.reason = '';
  st.failures = 0;
  st.lastOk = now;
  st.nextCheck = now + src.everyHours * H;
  if (r.words) st.words = r.words;

  if (r.entries) {
    const seen = new Set(st.seen || []);
    const fresh = first ? [] : r.entries.filter((e) => !seen.has(e.id));
    for (const e of fresh.slice(0, 10).reverse()) {
      const lines = [e.title, ...String(e.summary || '').split('\n')].filter(Boolean);
      if (!core.matchesKeywords(lines, src.keywords)) continue;
      if (src.kind === 'github') addItem(src, { kind: 'version', title: e.title, from: st.version || '', to: e.tag, url: e.url, lines: String(e.summary || '').split('\n').filter(Boolean) });
      else addItem(src, { kind: 'entry', title: e.title, url: e.url || src.url, lines: e.summary ? [e.summary] : [] });
    }
    st.seen = [...new Set([...r.entries.map((e) => e.id), ...(st.seen || [])])].slice(0, 300);
    if (r.version) st.version = r.version;
    return;
  }

  if (src.kind === 'version') {
    if (!first && r.version && st.version && r.version !== st.version && core.versionGreater(r.version, st.version)) {
      const lines = core.addedLines(st.text || '', r.text).filter((l) => l.includes(r.version.replace(/^v/i, ''))).slice(0, 4);
      if (core.matchesKeywords([r.version, ...lines], src.keywords)) addItem(src, { kind: 'version', title: r.version, from: st.version, to: r.version, lines });
    }
    if (r.version && (!st.version || core.versionGreater(r.version, st.version))) st.version = r.version;
    st.text = r.text;
    return;
  }

  if (!first) {
    const added = core.addedLines(st.text || '', r.text);
    if (added.length && core.matchesKeywords(added, src.keywords)) {
      addItem(src, { kind: 'changed', title: added[0], lines: added.slice(0, 12), count: added.length });
    }
  }
  st.text = r.text;
}

async function checkSource(src) {
  const r = await read(src);
  if (!sourceById(src.id)) return r; // retirée pendant la lecture
  apply(src, r);
  return r;
}

// ---------- horloge ----------
async function runDue() {
  if (running) return;
  running = true;
  changed();
  try {
    for (;;) {
      const now = Date.now();
      const src = load().sources.find((s) => s.enabled !== false && (s.state?.nextCheck || 0) <= now);
      if (!src) break;
      await checkSource(src);
      data.lastPass = Date.now();
      prune();
      changed();
    }
  } finally {
    running = false;
    const fresh = pending.filter((it) => !it.read && sourceById(it.sourceId));
    pending = [];
    changed();
    if (fresh.length && notifier) notifier(fresh);
  }
}

function start({ userAgent, notify }) {
  ua = userAgent;
  notifier = notify;
  load();
  clearInterval(timer);
  timer = setInterval(() => runDue(), 60 * 1000);
  setTimeout(() => runDue(), 20 * 1000);
  powerMonitor.on('resume', () => setTimeout(() => runDue(), 15 * 1000)); // rattrapage au réveil du Mac
}

// ---------- actions ----------
function cleanSource(input, base = {}) {
  const url = String(input.url ?? base.url ?? '').trim();
  let u;
  try { u = new URL(url); } catch { throw new Error('bad_url'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('bad_url');
  const every = Number(input.everyHours ?? base.everyHours ?? 24);
  return {
    name: String(input.name ?? base.name ?? '').trim().slice(0, 80) || u.hostname.replace(/^www\./, ''),
    url: u.href,
    group: String(input.group ?? base.group ?? '').trim().slice(0, 60),
    everyHours: EVERY.includes(every) ? every : 24,
    selector: String(input.selector ?? base.selector ?? '').trim().slice(0, 200),
    keywords: core.parseKeywords(input.keywords ?? base.keywords ?? []),
    note: String(input.note ?? base.note ?? '').trim().slice(0, 1000),
    enabled: input.enabled ?? base.enabled ?? true,
  };
}

/** Lecture d'essai (bouton TESTER) : rien n'est enregistré, mais le résultat peut servir de référence à l'ajout. */
const tests = new Map();
async function test(input) {
  const s = cleanSource(input);
  const kind = input.kind && ['page', 'feed', 'github', 'version'].includes(input.kind) ? input.kind : null;
  const det = kind && kind !== 'feed' && kind !== 'github' ? { kind, fetchUrl: s.url } : await detect(s.url);
  if (kind === 'version' || kind === 'page') det.kind = kind;
  if (s.selector && det.kind === 'feed' && !kind) { det.kind = 'page'; det.fetchUrl = s.url; } // zone choisie : on lit la page
  const src = { ...s, kind: det.kind, fetchUrl: det.fetchUrl };
  const r = await read(src);
  const token = crypto.randomBytes(8).toString('hex');
  tests.set(token, { at: Date.now(), url: s.url, selector: s.selector, kind: det.kind, fetchUrl: det.fetchUrl, result: r });
  for (const [k, v] of tests) if (Date.now() - v.at > 10 * 60 * 1000) tests.delete(k);
  return {
    token, kind: det.kind, fetchUrl: det.fetchUrl, seconds: r.seconds, words: r.words || 0,
    entries: r.entries ? r.entries.length : 0, version: r.version || '', needsUser: r.needsUser || '', error: r.error || '',
    sample: r.entries ? r.entries.slice(0, 3).map((e) => e.title) : [],
  };
}

function ensureGroup(name, brief) {
  if (!name) return;
  let g = data.groups.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!g) { g = { name, brief: '' }; data.groups.push(g); }
  if (brief !== undefined && brief !== null) g.brief = String(brief).trim().slice(0, 600);
}

/** Ajoute une source (ou met à jour celle qui a la même adresse). */
async function add(input) {
  load();
  const existing = input.id ? sourceById(input.id) : data.sources.find((s) => s.url === String(input.url || '').trim());
  const s = cleanSource(input, existing || {});
  const t = input.token && tests.get(input.token);
  let kind; let fetchUrl;
  if (t && t.url === s.url && t.selector === s.selector) ({ kind, fetchUrl } = t);
  else if (existing && existing.url === s.url && existing.selector === s.selector && !input.kind) ({ kind, fetchUrl } = existing);
  else {
    const det = input.kind && ['page', 'version'].includes(input.kind) ? { kind: input.kind, fetchUrl: s.url } : await detect(s.url);
    if (s.selector && det.kind === 'feed' && !input.kind) { det.kind = 'page'; det.fetchUrl = s.url; }
    ({ kind, fetchUrl } = det);
  }
  ensureGroup(s.group, input.groupBrief);
  let src;
  if (existing) {
    const reset = existing.url !== s.url || existing.selector !== s.selector || existing.kind !== kind;
    Object.assign(existing, s, { kind, fetchUrl });
    if (reset) existing.state = { nextCheck: 0 };
    src = existing;
  } else {
    src = { id: crypto.randomBytes(4).toString('hex'), ...s, kind, fetchUrl, createdAt: Date.now(), state: { nextCheck: 0 } };
    data.sources.push(src);
  }
  if (t && t.result && !t.result.error && !t.result.needsUser && (src.state.nextCheck || 0) === 0 && !src.state.lastOk) {
    apply(src, t.result); // la lecture d'essai sert de référence : aucune alerte
    tests.delete(input.token);
  }
  changed();
  if (!src.state.lastOk) setImmediate(() => runDue());
  return publicSource(src);
}

function remove(id) {
  load();
  const i = data.sources.findIndex((s) => s.id === String(id));
  if (i < 0) return false;
  data.sources.splice(i, 1);
  data.items = data.items.filter((it) => it.sourceId !== String(id));
  const used = new Set(data.sources.map((s) => s.group).filter(Boolean));
  data.groups = data.groups.filter((g) => used.has(g.name) || g.brief);
  changed();
  return true;
}

function setEnabled(id, on) {
  const s = sourceById(id);
  if (!s) return false;
  s.enabled = !!on;
  if (on) s.state.nextCheck = Math.min(s.state.nextCheck || 0, Date.now());
  changed();
  return true;
}

function setGroupBrief(name, brief) {
  load();
  ensureGroup(String(name || '').trim(), brief);
  changed();
}

/** Vérifie maintenant une source (id) ou toutes ; attend la fin si wait. */
async function checkNow(id, { wait = false } = {}) {
  load();
  const list = id ? [sourceById(id)].filter(Boolean) : data.sources.filter((s) => s.enabled !== false);
  if (id && !list.length) throw new Error('no_source');
  for (const s of list) s.state.nextCheck = 0;
  changed();
  const p = (async () => {
    while (running) await new Promise((r) => setTimeout(r, 300));
    await runDue();
  })();
  if (wait) await p;
  return list.map(publicSource);
}

function markRead(ids) {
  load();
  let n = 0;
  const all = ids === 'all';
  const set = new Set((Array.isArray(ids) ? ids : [ids]).map(Number));
  for (const it of data.items) if (!it.read && (all || set.has(it.id))) { it.read = true; n++; }
  if (n) changed();
  return n;
}

function markSourceRead(sourceId) {
  const ids = unreadOf(String(sourceId)).map((i) => i.id);
  return markRead(ids);
}

function history(id, limit = 20) {
  const s = sourceById(id);
  if (!s) throw new Error('no_source');
  return { source: publicSource(s), items: load().items.filter((i) => i.sourceId === s.id).slice(-limit).reverse() };
}

function onChange(fn) { listeners.push(fn); }

module.exports = {
  FILE, EVERY, start, snapshot, test, add, remove, setEnabled, setGroupBrief, checkNow, markRead, markSourceRead, history,
  onChange, unreadCount: () => unreadOf().length, publicSource, sourceById, unreadItems: () => unreadOf(),
};
