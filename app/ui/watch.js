// wCLAUDE — onglet Veille : sources à gauche, nouveautés à droite, dialogue « Ajouter une source ».
import { icon } from './icons.js';

const { t, lang, invoke, onChange } = window.wclaude;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const brand = (s) => esc(s).replace(/wCLAUDE/g, '<span class="w">w</span>CLAUDE');

let snap = null;
let selected = 'all'; // 'all' ou id de source
let expanded = null; // id de l'élément déplié
let editing = null; // source en cours de modification
let testToken = null;

const fmtTime = (ms) => new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
const fmtDay = (ms) => new Intl.DateTimeFormat(lang, { day: '2-digit', month: '2-digit' }).format(new Date(ms));
const when = (ms) => {
  if (!ms) return '–';
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString() ? fmtTime(ms) : `${fmtDay(ms)} · ${fmtTime(ms)}`;
};
const KIND = { page: 'watch.kind.page', feed: 'watch.kind.feed', github: 'watch.kind.github', version: 'watch.kind.version' };

document.title = t('watch.title');

// ---------- rendu ----------
function render() {
  if (!snap) return;
  renderSide();
  renderMain();
}

function renderSide() {
  $('addBtn').innerHTML = `${icon('plus')}<span>${esc(t('watch.add'))}</span>`;
  const groups = new Map();
  for (const s of snap.sources) {
    const g = s.group || '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b, lang)));
  let html = `<button class="row${selected === 'all' ? ' on' : ''}" data-id="all" type="button"><b>${esc(t('watch.all'))}</b>${snap.unread ? `<span class="n">${snap.unread}</span>` : ''}</button>`;
  for (const g of keys) {
    if (keys.length > 1 || g) html += `<div class="gh">${esc(g || t('watch.noGroup'))}</div>`;
    for (const s of groups.get(g)) {
      const st = s.status === 'needs_user' ? `<span class="st" title="${esc(t('watch.status.needs_user'))}">${icon('hand')}</span>`
        : s.status === 'error' ? `<span class="st er" title="${esc(s.error)}">${icon('warning')}</span>`
        : s.status === 'paused' ? `<span class="st" title="${esc(t('watch.status.paused'))}">${icon('pause')}</span>` : '';
      html += `<button class="row${selected === s.id ? ' on' : ''}${s.enabled ? '' : ' off'}" data-id="${esc(s.id)}" type="button" title="${esc(s.url)}"><span class="dot ${s.status}"></span><b>${esc(s.name)}</b>${s.unread ? `<span class="n">${s.unread}</span>` : st}</button>`;
    }
  }
  $('sources').innerHTML = html;
  $('lastPass').textContent = snap.running ? t('watch.checking') : snap.lastPass ? t('watch.lastPass', { time: fmtTime(snap.lastPass) }) : '';
}

function renderMain() {
  const src = selected === 'all' ? null : snap.sources.find((s) => s.id === selected);
  if (selected !== 'all' && !src) selected = 'all';
  const actions = $('headActions');
  if (!snap.sources.length) {
    $('headTitle').textContent = '';
    actions.innerHTML = '';
    $('sourceInfo').hidden = true;
    $('list').innerHTML = `<div class="empty"><h2>${esc(t('watch.emptyTitle'))}</h2><p>${brand(t('watch.emptyText'))}</p><button class="sc-btn sc-btn--secondary" type="button" data-act="add">${icon('plus')}<span>${esc(t('watch.add'))}</span></button></div>`;
    return;
  }
  const items = snap.items.filter((it) => !src || it.sourceId === src.id);
  const unread = items.filter((it) => !it.read);
  $('headTitle').textContent = `${src ? src.name : t('watch.all')} · ${t(unread.length <= 1 ? 'watch.unreadOne' : 'watch.unreadCount', { count: unread.length })}`;
  const checkLabel = snap.running ? t('watch.checking') : t('watch.checkNow');
  actions.innerHTML = `<button class="sc-btn sc-btn--secondary" type="button" data-act="check" ${snap.running ? 'disabled' : ''}>${icon('reload')}<span>${esc(checkLabel)}</span></button>`
    + (unread.length ? `<button class="sc-btn sc-btn--secondary" type="button" data-act="readAll">${icon('check')}<span>${esc(t('watch.markAllRead'))}</span></button>` : '');

  const info = $('sourceInfo');
  if (src) {
    const state = src.status === 'error' ? `<span class="badge" style="color:var(--danger-soft);background:var(--danger-bg)">${esc(t('watch.status.error', { error: src.error }))}</span>`
      : src.status === 'needs_user' ? `<span class="badge" style="color:var(--warning-soft);background:var(--warning-bg)">${esc(t('watch.status.needs_user'))}</span>`
      : src.status === 'paused' ? `<span class="badge">${esc(t('watch.status.paused'))}</span>`
      : src.status === 'pending' ? `<span class="badge">${esc(t('watch.status.pending'))}</span>` : '';
    const meta = [
      `<span class="badge${src.kind === 'version' || src.kind === 'github' ? ' ac' : ''}">${esc(t(KIND[src.kind]))}</span>`,
      `<span>${esc(t('watch.every.' + src.everyHours))}</span>`,
      src.version ? `<span class="mono">${esc(src.version)}</span>` : '',
      src.lastCheck ? `<span class="mono">${esc(t('watch.checkedAt', { time: when(src.lastCheck) }))}</span>` : '',
      state,
    ].filter(Boolean).join('');
    info.innerHTML = `<div class="url">${esc(src.url)}</div><div class="meta">${meta}</div>`
      + (src.note ? noteHtml(src.note) : '')
      + (src.status === 'needs_user' ? `<p style="margin:0">${brand(t('watch.needsUserHelp'))}</p>` : '')
      + `<div class="acts">
          <button class="sc-btn sc-btn--secondary" type="button" data-act="openSrc">${icon('external')}<span>${esc(t('watch.openPage'))}</span></button>
          <button class="sc-btn sc-btn--secondary" type="button" data-act="edit">${icon('edit')}<span>${esc(t('watch.edit'))}</span></button>
          <button class="sc-btn sc-btn--secondary" type="button" data-act="toggle">${icon(src.enabled ? 'pause' : 'play')}<span>${esc(t(src.enabled ? 'watch.pause' : 'watch.resume'))}</span></button>
          <button class="sc-btn sc-btn--secondary" type="button" data-act="remove">${icon('trash')}<span>${esc(t('watch.remove'))}</span></button>
        </div>`;
    info.hidden = false;
  } else info.hidden = true;

  const read = items.filter((it) => it.read).slice(0, 20);
  if (expanded == null || !items.some((it) => it.id === expanded)) expanded = unread.length ? unread[0].id : null;
  let html = unread.map((it) => (it.id === expanded ? cardHtml(it, !src) : rowHtml(it, !src))).join('');
  if (!unread.length) html += `<p class="muted" style="margin:0">${esc(t(src ? 'watch.nothingSource' : 'watch.nothing'))}</p>`;
  if (read.length) {
    html += `<div class="sep">${esc(t('watch.alreadyRead'))}</div>`;
    html += read.map((it) => (it.id === expanded ? cardHtml(it, !src) : rowHtml(it, !src))).join('');
  }
  $('list').innerHTML = html;
}

const noteHtml = (note) => `<div class="note"><span class="ni">${icon('sparkles', 14)}</span><span>${esc(t('watch.noteFor', { note }))}</span></div>`;
const srcOf = (it) => snap.sources.find((s) => s.id === it.sourceId) || { name: '?', kind: 'page', note: '' };

function itemTitle(it) {
  if (it.kind === 'version') return it.from ? `${it.from} → ${it.to}` : it.to || it.title;
  if (it.kind === 'entry') return it.title || t('watch.item.entry');
  const n = it.count || it.lines.length;
  return t(n === 1 ? 'watch.changedOne' : 'watch.changedLines', { count: n });
}
function itemBadge(it) {
  if (it.kind === 'version') return `<span class="badge ac">${esc(t('watch.kind.version'))}</span>`;
  return `<span class="badge">${esc(t(KIND[srcOf(it).kind] || KIND.page))}</span>`;
}

function rowHtml(it, showSource) {
  return `<button class="it${it.read ? ' read' : ''}" type="button" data-item="${it.id}"><span class="dot ${it.read ? 'ok' : 'new'}"></span>${showSource ? `<span class="src">${esc(srcOf(it).name)}</span>` : ''}<span class="ct">${esc(itemTitle(it))}</span>${itemBadge(it)}<span class="when">${esc(when(it.at))}</span></button>`;
}

function cardHtml(it, showSource) {
  const s = srcOf(it);
  const lines = it.kind === 'changed' ? it.lines : it.kind === 'entry' ? it.lines : it.lines;
  const title = it.kind === 'changed' ? it.title : itemTitle(it);
  const extra = it.kind === 'changed' && (it.count || 0) > it.lines.length ? `<span class="more">${esc(t('watch.moreLines', { count: it.count - it.lines.length }))}</span>` : '';
  const diff = lines.length ? `<div class="diff">${lines.map((l) => `<span>+ ${esc(l)}</span>`).join('')}${extra}</div>` : '';
  return `<div class="card" data-card="${it.id}">
    <div class="ch"><span class="dot ${it.read ? 'ok' : 'new'}"></span><span class="src">${esc(showSource ? s.name : t(it.kind === 'changed' ? 'watch.item.changed' : it.kind === 'entry' ? 'watch.item.entry' : 'watch.kind.version'))}</span>${itemBadge(it)}<span class="when">${esc(when(it.at))}</span></div>
    <div class="ct">${esc(title)}</div>
    ${diff}
    ${s.note ? noteHtml(s.note) : ''}
    <div class="acts">
      <button class="sc-btn sc-btn--secondary" type="button" data-open="${esc(it.url || s.url)}">${icon('external')}<span>${esc(t('watch.openPage'))}</span></button>
      ${it.read ? '' : `<button class="sc-btn sc-btn--secondary" type="button" data-read="${it.id}">${icon('check')}<span>${esc(t('watch.markRead'))}</span></button>`}
    </div>
  </div>`;
}

// ---------- actions ----------
async function refresh() {
  snap = await invoke('watch:get');
  render();
}

$('sources').onclick = (e) => {
  const row = e.target.closest('[data-id]');
  if (!row) return;
  selected = row.dataset.id;
  expanded = null;
  render();
};

document.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b || b.closest('#dlg')) return;
  if (b.dataset.item) { expanded = Number(b.dataset.item); renderMain(); return; }
  if (b.dataset.open) { invoke('watch:open', { url: b.dataset.open }); return; }
  if (b.dataset.read) { await invoke('watch:read', { ids: [Number(b.dataset.read)] }); return; }
  const src = snap && snap.sources.find((s) => s.id === selected);
  switch (b.dataset.act || b.id) {
    case 'addBtn': case 'add': openDialog(); break;
    case 'check': await invoke('watch:check', { id: src ? src.id : undefined }); break;
    case 'readAll': await (src ? invoke('watch:readSource', { id: src.id }) : invoke('watch:read', { ids: 'all' })); break;
    case 'openSrc': if (src) invoke('watch:open', { url: src.url }); break;
    case 'edit': if (src) openDialog(src); break;
    case 'toggle': if (src) await invoke('watch:enable', { id: src.id, enabled: !src.enabled }); break;
    case 'remove':
      if (src && confirm(t('watch.removeConfirm', { name: src.name }))) { await invoke('watch:remove', { id: src.id }); selected = 'all'; }
      break;
    default:
  }
});

onChange(() => refresh());

// ---------- dialogue ----------
const EVERY = [1, 6, 24, 168];
let every = 24;

function setText() {
  $('lUrl').textContent = t('watch.f.url');
  $('lName').textContent = t('watch.f.name');
  $('lGroup').textContent = t('watch.f.group');
  $('lEvery').textContent = t('watch.f.every');
  $('lZone').textContent = t('watch.f.zone');
  $('lKeywords').textContent = t('watch.f.keywords');
  $('lZoneOpt').textContent = $('lKeywordsOpt').textContent = t('watch.f.optional');
  $('lNote').textContent = t('watch.f.note');
  $('fUrl').placeholder = 'https://';
  $('fSelector').placeholder = t('watch.f.zonePh');
  $('fKeywords').placeholder = t('watch.f.keywordsPh');
  $('fNote').placeholder = t('watch.f.notePh');
  $('fGroup').placeholder = t('watch.f.groupPh');
  $('hint').innerHTML = brand(t('watch.f.hint'));
  $('bCancel').textContent = t('watch.cancel');
  $('bTest').textContent = t('watch.test');
}

function renderEvery() {
  $('fEvery').innerHTML = EVERY.map((h) => `<button type="button" class="chip${h === every ? ' on' : ''}" role="radio" aria-checked="${h === every}" data-h="${h}">${esc(t('watch.chip.' + h))}</button>`).join('');
}
$('fEvery').onclick = (e) => { const c = e.target.closest('[data-h]'); if (c) { every = Number(c.dataset.h); renderEvery(); } };

function openDialog(src = null) {
  editing = src;
  testToken = null;
  setText();
  $('dlgTitle').textContent = t(src ? 'watch.editTitle' : 'watch.addTitle');
  $('bAdd').textContent = t(src ? 'watch.save' : 'watch.addBtn');
  $('fUrl').value = src ? src.url : '';
  $('fName').value = src ? src.name : '';
  $('fGroup').value = src ? src.group : '';
  $('fSelector').value = src ? src.selector : '';
  $('fKeywords').value = src ? src.keywords.join(', ') : '';
  $('fNote').value = src ? src.note : '';
  every = src ? src.everyHours : 24;
  renderEvery();
  $('groupList').innerHTML = [...new Set(snap.sources.map((s) => s.group).filter(Boolean))].map((g) => `<option value="${esc(g)}">`).join('');
  $('result').hidden = true;
  $('fUrl').classList.remove('bad');
  $('scrim').hidden = false;
  setTimeout(() => $(src ? 'fName' : 'fUrl').focus(), 0);
}
const closeDialog = () => { $('scrim').hidden = true; editing = null; };
$('bCancel').onclick = closeDialog;
$('scrim').addEventListener('mousedown', (e) => { if (e.target === $('scrim')) closeDialog(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('scrim').hidden) closeDialog(); });

const formValues = () => ({
  url: $('fUrl').value.trim().replace(/^(?!https?:\/\/)/i, 'https://'),
  name: $('fName').value.trim(),
  group: $('fGroup').value.trim(),
  everyHours: every,
  selector: $('fSelector').value.trim(),
  keywords: $('fKeywords').value,
  note: $('fNote').value.trim(),
});

function showResult(kind, text) {
  const r = $('result');
  r.className = kind;
  const ic = { ok: 'check', warn: 'hand', err: 'warning', busy: 'reload' }[kind];
  r.innerHTML = `${icon(ic)}<span>${esc(text)}</span>`;
  r.hidden = false;
}

function validUrl() {
  const v = formValues().url;
  let ok = false;
  try { ok = /^https?:$/.test(new URL(v).protocol) && $('fUrl').value.trim() !== ''; } catch { ok = false; }
  $('fUrl').classList.toggle('bad', !ok);
  if (!ok) showResult('err', t('watch.badUrl'));
  return ok;
}

$('bTest').onclick = async () => {
  if (!validUrl()) return;
  $('bTest').disabled = true;
  showResult('busy', t('watch.testing'));
  const r = await invoke('watch:test', formValues());
  $('bTest').disabled = false;
  if (r.error && !r.kind) return showResult('err', r.error === 'bad_url' ? t('watch.badUrl') : r.error);
  testToken = r.token;
  if (r.needsUser) return showResult('warn', t('watch.testNeedsUser'));
  if (r.error) return showResult('err', r.error === 'selector' ? t('watch.testNoZone') : t('watch.testError', { error: r.error }));
  const base = r.kind === 'feed' ? t('watch.testFeed', { seconds: r.seconds, count: r.entries })
    : r.kind === 'github' ? t('watch.testGithub', { seconds: r.seconds, count: r.entries, version: r.version || '–' })
    : r.kind === 'version' ? t('watch.testVersion', { seconds: r.seconds, version: r.version || '–' })
    : t('watch.testPage', { seconds: r.seconds, words: r.words.toLocaleString(lang) });
  showResult('ok', `${base} ${t('watch.testReference')}`);
};

$('dlg').onsubmit = async (e) => {
  e.preventDefault();
  if (!validUrl()) return;
  $('bAdd').disabled = true;
  const r = await invoke('watch:add', { ...formValues(), id: editing ? editing.id : undefined, token: testToken });
  $('bAdd').disabled = false;
  if (r.error) return showResult('err', r.error === 'bad_url' ? t('watch.badUrl') : r.error);
  selected = r.id;
  closeDialog();
  refresh();
};

refresh();
