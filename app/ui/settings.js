import { t, $, esc, invoke, send, on, brand, fit, checkbox } from './panel.js';
import { icon } from './icons.js';

const fmtDate = (ms) => new Intl.DateTimeFormat(window.wclaude.lang, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms));

$('agentTitle').textContent = t('settings.agent');
$('agentHint').textContent = t('settings.agentHint');
$('agentAllow').querySelector('.sc-option__label').textContent = t('settings.agentAllow');
$('agentAllowHint').textContent = t('settings.agentAllowHint');
$('copyConfig').innerHTML = `${icon('copy')}<span>${esc(t('settings.copyConfig'))}</span>`;
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
  renderUpdate(s.update);
  brand();
  fit();
}

on('update:state', renderUpdate);
load();
