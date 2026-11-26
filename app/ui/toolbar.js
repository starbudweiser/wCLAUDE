import { icon } from './icons.js';

const { t, send, on } = window.wclaude;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

let state = null;
let editing = false;
let agentTimer = null;

// Boutons fixes
$('newtab').innerHTML = icon('plus');
$('newtab').title = t('tab.new');
$('newtab').setAttribute('aria-label', t('tab.new'));
$('back').innerHTML = icon('back');
$('back').setAttribute('aria-label', t('nav.back'));
$('back').title = t('nav.back');
$('forward').innerHTML = icon('forward');
$('forward').setAttribute('aria-label', t('nav.forward'));
$('forward').title = t('nav.forward');
$('mobile').innerHTML = `${icon('phone')}<span>${esc(t('mobile.button'))}</span>`;
$('keychain').innerHTML = `${icon('key')}<span>${esc(t('keychain.button'))}</span>`;
$('keychain').title = t('keychain.tooltip');
$('mdown').innerHTML = `${icon('download')}<span>${esc(t('mdown.button'))}</span>`;
$('mdown').title = t('mdown.tooltip');
$('address').placeholder = t('address.placeholder');
$('gutter').querySelector('.label').textContent = t('mobile.caption');
$('handoff').querySelector('.hi').innerHTML = icon('sparkles');
$('handoffCancel').textContent = t('handoff.cancel');
$('handoffDone').textContent = t('handoff.done');
$('handoffCancel').onclick = () => state && state.handoff && send('handoff:answer', { id: state.handoff.id, done: false });
$('handoffDone').onclick = () => state && state.handoff && send('handoff:answer', { id: state.handoff.id, done: true });

// Hauteur réelle de la barre (onglets + navigation + relais) : la page web se place juste en dessous.
const chromeHeight = () => ['tabsbar', 'navbar', 'handoff'].reduce((h, id) => h + ($(id).hidden ? 0 : $(id).getBoundingClientRect().height), 0);
const reportHeight = () => send('toolbar:height', chromeHeight());
new ResizeObserver(reportHeight).observe(document.body);
for (const id of ['tabsbar', 'navbar', 'handoff']) new ResizeObserver(reportHeight).observe($(id));

$('newtab').onclick = () => send('tab:new');
$('back').onclick = () => send('nav', { action: 'back' });
$('forward').onclick = () => send('nav', { action: 'forward' });
$('reload').onclick = () => send('nav', { action: active()?.loading ? 'stop' : 'reload' });
$('mobile').onclick = () => send('mobile:toggle');
$('keychain').onclick = () => send('keychain:fill');
$('mdown').onclick = () => send('mdown:send');
$('downloads').onclick = () => send('downloads:menu');
$('watch').onclick = () => send('watch:open');
$('watch').title = t('watch.tooltip');

const address = $('address');
address.addEventListener('focus', () => { editing = true; setTimeout(() => address.select(), 0); });
address.addEventListener('blur', () => { editing = false; render(); });
address.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    send('nav', { action: 'go', url: address.value });
    editing = false;
    address.blur();
  } else if (e.key === 'Escape') {
    editing = false;
    render();
    address.select();
  }
});

on('focus-address', () => { address.focus(); address.select(); });
on('state', (s) => { state = s; render(); });

function active() {
  return state ? state.tabs.find((x) => x.id === state.activeId) : null;
}

function tabTitle(tab) {
  if (tab.internal === 'watch') return t('watch.title');
  if (tab.title && tab.title !== tab.url) return tab.title;
  if (!tab.url) return t('tab.new');
  try { return new URL(tab.url).hostname || tab.url; } catch { return tab.url; }
}

function renderTabs() {
  const box = $('tabs');
  const agentTab = state.agent && Date.now() - state.agent.at < 5000 ? state.agent.tabId : null;
  box.innerHTML = state.tabs.map((tab) => `
    <div class="tab${tab.active ? ' is-active' : ''}${tab.internal ? ' is-pinned' : ''}${tab.id === agentTab ? ' is-agent' : ''}" role="tab" aria-selected="${tab.active}" data-id="${tab.id}" title="${esc(tabTitle(tab))}">
      <span class="fav">${tab.id === agentTab ? icon('sparkles') : tab.internal === 'watch' ? icon('eye') : tab.favicon ? `<img src="${esc(tab.favicon)}" alt="">` : icon('globe')}</span>
      <span class="title">${esc(tab.loading && !tab.title ? t('tab.loading') : tabTitle(tab))}</span>
      ${tab.internal === 'watch' ? '' : `<button class="close" type="button" data-close="${tab.id}" aria-label="${esc(t('tab.close'))}" title="${esc(t('tab.close'))}">${icon('x')}</button>`}
    </div>`).join('');
  for (const img of box.querySelectorAll('.fav img')) img.onerror = () => { img.replaceWith(document.createRange().createContextualFragment(icon('globe'))); };
  box.onclick = (e) => {
    const close = e.target.closest('[data-close]');
    if (close) return send('tab:close', Number(close.dataset.close));
    const tab = e.target.closest('.tab');
    if (tab) send('tab:select', Number(tab.dataset.id));
  };
  box.onauxclick = (e) => {
    const tab = e.target.closest('.tab');
    if (tab && e.button === 1 && !tab.classList.contains('is-pinned')) send('tab:close', Number(tab.dataset.id));
  };
}

function renderNotice() {
  const box = $('notice');
  const n = state.notice;
  if (!n) { box.hidden = true; return; }
  const iconName = { tip: 'tip', warning: 'warning', danger: 'x', ai: 'sparkles' }[n.kind] || 'info';
  box.className = `bubble bubble--${n.kind || 'help'}`;
  box.innerHTML = `<span class="bi">${icon(iconName)}</span><span class="text">${esc(n.text)}</span>${n.action ? `<button class="act" type="button">${esc(n.action.label)}</button>` : ''}`;
  box.title = n.text;
  const act = box.querySelector('.act');
  if (act) act.onclick = () => send('notice:action', n.action.id);
  box.hidden = false;
}

function renderAgent() {
  const box = $('agent');
  clearTimeout(agentTimer);
  const a = state.agent;
  const left = a && a.at ? 5000 - (Date.now() - a.at) : 0;
  if (left <= 0) { box.hidden = true; return; }
  box.className = 'bubble bubble--ai';
  box.innerHTML = `<span class="bi">${icon('sparkles')}</span><span class="text">${esc(t('agent.acting', { agent: a.name, action: a.label }))}</span>`;
  box.hidden = false;
  agentTimer = setTimeout(() => { renderAgent(); renderTabs(); }, left + 50);
}

function render() {
  if (!state) return;
  const tab = active();
  renderTabs();
  renderNotice();
  renderAgent();
  $('back').disabled = !tab || !tab.canBack;
  $('forward').disabled = !tab || !tab.canForward;
  const loading = tab && tab.loading;
  $('reload').innerHTML = icon(loading ? 'x' : 'reload');
  $('reload').title = t(loading ? 'nav.stop' : 'nav.reload');
  $('reload').setAttribute('aria-label', $('reload').title);
  if (!editing) address.value = tab ? tab.url : '';
  const mobile = $('mobile');
  mobile.classList.toggle('is-on', !!state.mobile);
  mobile.setAttribute('aria-pressed', String(!!state.mobile));
  mobile.title = state.site ? t(state.mobile ? 'mobile.turnOff' : 'mobile.turnOn', { site: state.site }) : t('mobile.noSite');
  const dl = $('downloads');
  dl.classList.toggle('is-active', state.downloads.active > 0);
  dl.innerHTML = `${icon('download')}<span>${esc(t('downloads.button'))}</span>${state.downloads.count ? `<span class="count">${state.downloads.active || state.downloads.count}</span>` : ''}`;
  const wn = state.watch ? state.watch.unread : 0;
  $('watch').innerHTML = `${icon('eye')}<span>${esc(t('watch.button'))}</span>${wn ? `<span class="count">${wn}</span>` : ''}`;
  $('watch').classList.toggle('is-current', !!(tab && tab.internal === 'watch'));
  const ho = $('handoff');
  const h = state.handoff;
  if (h) {
    ho.querySelector('.title').textContent = t('handoff.title', { agent: h.agent });
    ho.querySelector('.reason').textContent = h.reason || t('handoff.kind.' + h.kind);
  }
  if (ho.hidden !== !h) { ho.hidden = !h; reportHeight(); }
  const gutter = $('gutter');
  gutter.style.top = chromeHeight() + 'px';
  gutter.hidden = !state.mobile || state.fullscreen || (window.innerWidth - 390) / 2 < 200;
  gutter.style.width = Math.max(0, (window.innerWidth - 390) / 2) + 'px';
  gutter.querySelector('.site').textContent = state.site || '';
  document.body.style.visibility = state.fullscreen ? 'hidden' : 'visible';
}

window.addEventListener('resize', render);
send('state:request');
