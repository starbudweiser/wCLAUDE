import { t, $, esc, invoke, send, on, brand, fit, checkbox } from './panel.js';
import { icon } from './icons.js';

const fmtDate = (ms) => new Intl.DateTimeFormat(window.wclaude.lang, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms));

$('agentTitle').textContent = t('settings.agent');
$('agentHint').textContent = t('settings.agentHint');
$('agentAllow').querySelector('.sc-option__label').textContent = t('settings.agentAllow');
$('agentAllowHint').textContent = t('settings.agentAllowHint');
$('copyConfig').innerHTML = `${icon('copy')}<span>${esc(t('settings.copyConfig'))}</span>`;
$('iconTitle').textContent = t('settings.icon');
$('iconHint').textContent = t('settings.iconHint');
$('mobileTitle').textContent = t('settings.mobile');
$('mobileHint').textContent = t('settings.mobileHint');
$('dlTitle').textContent = t('settings.downloads');
$('dlHint').textContent = t('settings.downloadsHint');
$('dlOpen').innerHTML = `${icon('folder')}<span>${esc(t('settings.openFolder'))}</span>`;
$('updTitle').textContent = t('upd.section');
$('updHint').textContent = t('upd.autoHint');
$('updAuto').querySelector('.sc-option__label').textContent = t('upd.auto');
$('updCheck').textContent = t('upd.checkNow');

$('dlOpen').onclick = () => send('downloads:open');
$('copyConfig').onclick = async () => {
  await invoke('settings:copyConfig');
  $('copied').textContent = t('settings.copied');
  $('copied').hidden = false;
  fit();
};
$('updCheck').onclick = async () => {
  $('updStatus').textContent = t('upd.checking');
  renderUpdate(await invoke('update:check'));
};

function renderUpdate(u) {
  const s = $('updStatus');
  s.className = '';
  if (u.status === 'uptodate') s.textContent = t('upd.upToDate', { version: u.current });
  else if (u.status === 'available') s.textContent = t('upd.available', { version: u.latest, current: u.current });
  else if (u.status === 'ready') s.textContent = t('upd.ready', { version: u.latest });
  else if (u.status === 'checking') s.textContent = t('upd.checking');
  else if (u.status === 'downloading') s.textContent = t('upd.downloading', { version: u.latest });
  else if (u.status === 'verifying') s.textContent = t('upd.verifying');
  else if (u.status === 'error') { s.textContent = t('upd.error'); s.className = 'err'; }
  else s.textContent = '';
  s.hidden = !s.textContent;
  $('updLast').textContent = u.lastCheck ? t('upd.lastCheck', { date: fmtDate(u.lastCheck) }) : t('upd.never');
  fit();
}

function renderIconModes(current) {
  const box = $('iconModes');
  box.innerHTML = ['menubar', 'dock', 'both'].map((m) => `<div class="sc-option${m === current ? ' is-selected' : ''}" role="radio" tabindex="0" aria-checked="${m === current}" data-mode="${m}"><span class="sc-choice sc-choice--radio"></span><span class="sc-option__label">${esc(t('settings.icon.' + m))}</span></div>`).join('');
  const pick = async (el) => {
    if (!el || el.dataset.mode === current) return;
    await invoke('settings:set', { key: 'iconMode', value: el.dataset.mode });
    renderIconModes(el.dataset.mode);
  };
  box.onclick = (e) => pick(e.target.closest('[data-mode]'));
  box.onkeydown = (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); pick(e.target.closest('[data-mode]')); } };
}

async function load() {
  const s = await invoke('settings:get');
  checkbox($('agentAllow'), s.agentControl, (v) => invoke('settings:set', { key: 'agentControl', value: v }));
  checkbox($('updAuto'), s.autoInstall, (v) => invoke('settings:set', { key: 'autoInstall', value: v }));
  $('agentState').textContent = s.agentActive ? t('settings.agentState', { port: s.cdpPort }) : t('settings.agentOff');
  $('agentLast').textContent = s.lastAgent ? t('settings.agentConnected', { agent: s.lastAgent }) : '';
  $('agentLast').hidden = !s.lastAgent;
  $('dlPath').textContent = s.downloadsDir;
  const list = $('mobileList');
  list.innerHTML = s.mobileSites.length
    ? s.mobileSites.map((site) => `<div class="item"><span>${esc(site)}</span><button class="sc-btn sc-btn--secondary" type="button" data-site="${esc(site)}">${esc(t('settings.remove'))}</button></div>`).join('')
    : `<p class="muted">${esc(t('settings.mobileEmpty'))}</p>`;
  list.onclick = async (e) => {
    const b = e.target.closest('[data-site]');
    if (!b) return;
    await invoke('settings:removeMobile', b.dataset.site);
    load();
  };
  renderIconModes(s.iconMode);
  renderUpdate(s.update);
  brand();
  fit();
}

// YouTube
$('ytTitle').textContent = t('settings.youtube');
$('ytHint').textContent = t('settings.youtubeHint');
$('ytHow').textContent = t('settings.youtubeHow');
$('ytChoose').textContent = t('settings.youtubeChoose');
$('ytConnect').textContent = t('settings.youtubeConnect');
$('ytDisconnect').textContent = t('settings.youtubeDisconnect');
$('ytIdLabel').textContent = t('settings.youtubeClientId');
$('ytSecretLabel').textContent = t('settings.youtubeClientSecret');
$('ytSave').textContent = t('settings.youtubeSave');
$('ytForm').onsubmit = async (e) => {
  e.preventDefault();
  const r = await invoke('yt:saveClient', { clientId: $('ytId').value, clientSecret: $('ytSecret').value });
  $('ytSecret').value = '';
  if (r.error) return ytMessage('settings.youtubeBadValues', 'err');
  $('ytId').value = '';
  ytMessage('');
  renderYouTube(r);
};
function ytMessage(key, cls = '') {
  const m = $('ytMsg');
  m.textContent = key ? t(key) : '';
  m.className = cls;
  m.hidden = !key;
  fit();
}
function renderYouTube(s) {
  $('ytClient').textContent = t(s.clientConfigured ? 'settings.youtubeClient' : 'settings.youtubeNoClient');
  $('ytChannel').textContent = s.connected ? t('settings.youtubeChannel', { channel: (s.channel && s.channel.title) || '—' }) : t('settings.youtubeNotConnected');
  $('ytChannel').className = s.connected ? 'ok' : 'muted';
  $('ytConnect').hidden = !s.clientConfigured || (s.connected && !s.needsReconnect);
  $('ytConnect').textContent = t(s.connected && s.needsReconnect ? 'settings.youtubeReconnect' : 'settings.youtubeConnect');
  $('ytScope').textContent = t('settings.youtubeNeedsReconnect');
  $('ytScope').hidden = !(s.connected && s.needsReconnect);
  $('ytForm').hidden = s.clientConfigured;
  $('ytDisconnect').hidden = !s.connected;
  brand();
  fit();
}
$('ytChoose').onclick = async () => {
  const r = await invoke('yt:import');
  if (r.cancelled) return;
  if (r.error) return ytMessage('settings.youtubeBadFile', 'err');
  ytMessage('');
  renderYouTube(r);
};
$('ytConnect').onclick = async () => {
  ytMessage('settings.youtubeWaiting');
  const r = await invoke('yt:connect');
  if (r.error) return ytMessage('settings.youtubeError', 'err');
  ytMessage('');
  renderYouTube(r);
};
$('ytDisconnect').onclick = async () => renderYouTube(await invoke('yt:disconnect'));
invoke('yt:status').then(renderYouTube);

on('update:state', renderUpdate);
load();
