import { t, $, esc, invoke, send, on, brand, fit } from './panel.js';
$('title').textContent = t('upd.title');
$('later').textContent = t('upd.later');
$('install').textContent = t('upd.install');
$('close').textContent = t('common.close');
$('later').onclick = $('close').onclick = () => send('panel:close');

const md = (text) => {
  const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean);
  let html = '', list = false;
  for (const l of lines) {
    const item = l.match(/^[-*•]\s+(.*)$/);
    if (item) { if (!list) { html += '<ul>'; list = true; } html += `<li>${esc(item[1])}</li>`; continue; }
    if (list) { html += '</ul>'; list = false; }
    if (!/^#+\s*$/.test(l)) html += `<p>${esc(l.replace(/^#+\s*/, ''))}</p>`;
  }
  return html + (list ? '</ul>' : '');
};

function render(u) {
  const s = $('status');
  $('actions').hidden = true; $('closeRow').hidden = true; $('notes').hidden = true; $('error').hidden = true;
  if (u.status === 'checking') s.textContent = t('upd.checking');
  else if (u.status === 'uptodate') { s.textContent = t('upd.upToDate', { version: u.current }); $('closeRow').hidden = false; }
  else if (u.status === 'error') { s.textContent = t('upd.error'); s.className = 'err'; $('closeRow').hidden = false; }
  else if (u.status === 'downloading') s.textContent = t('upd.downloading', { version: u.latest });
  else if (u.status === 'verifying') s.textContent = t('upd.verifying');
  else if (u.status === 'available' || u.status === 'ready') {
    s.textContent = t('upd.available', { version: u.latest, current: u.current });
    $('notes').innerHTML = (u.notes || []).map((n) => `<div><h3>${esc(n.version)}</h3>${n.text ? md(n.text) : `<p class="muted">${esc(t('upd.noNotes'))}</p>`}</div>`).join('');
    $('notes').hidden = !(u.notes || []).length;
    $('actions').hidden = false;
  }
  brand();
  fit();
}

$('install').onclick = async () => {
  $('install').disabled = true;
  const r = await invoke('update:install');
  if (r && r.error) {
    $('install').disabled = false;
    $('error').textContent = t(r.error === 'busy' ? 'upd.busy' : r.error === 'verify' ? 'upd.verifyFailed' : 'upd.error');
    $('error').className = 'center err';
    $('error').hidden = false;
    fit();
  }
};

on('update:state', render);
const manual = new URLSearchParams(location.search).get('manual') === '1';
const current = await invoke('update:state');
if (manual || !['available', 'ready'].includes(current.status)) { render({ ...current, status: 'checking' }); render(await invoke('update:check')); }
else render(current);
