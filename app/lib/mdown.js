// Lien avec mDOWN (téléchargeur de médias du DESKTOP MAC TOOLKIT) : envoie l'adresse de l'onglet, avec les cookies de ce site
// pour les vidéos réservées à un compte, par la prise locale de mDOWN (réservée à l'utilisateur, droits 600).
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const SUPPORT = path.join(os.homedir(), 'Library', 'Application Support', process.env.WCLAUDE_MDOWN_DEV ? 'mDOWN Dev' : 'mDOWN');
const SOCKET = path.join(SUPPORT, 'mdown.sock');
const BUNDLE_ID = 'fr.stephan.mdown';
const CANDIDATES = ['/Applications/mDOWN.app', path.join(os.homedir(), 'Applications', 'mDOWN.app'), path.join(os.homedir(), 'Applications', 'Applications Personnelles', 'mDOWN.app')];

/** mDOWN est-elle installée ? Dossiers usuels, puis Spotlight (n'importe quel dossier ou disque). */
async function isInstalled() {
  if (CANDIDATES.some((p) => fs.existsSync(p))) return true;
  return new Promise((resolve) => {
    execFile('/usr/bin/mdfind', [`kMDItemCFBundleIdentifier == '${BUNDLE_ID}'`], { timeout: 5000 }, (err, out) => resolve(!err && out.trim().length > 0));
  });
}

function once(req, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const s = net.createConnection(SOCKET);
    let buf = '';
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeoutMs, () => done(null));
    s.on('error', () => done(null));
    s.on('connect', () => s.write(JSON.stringify(req) + '\n'));
    s.on('data', (d) => { buf += d; if (buf.endsWith('\n')) { try { done(JSON.parse(buf)); } catch { done(null); } } });
    s.on('end', () => { try { done(JSON.parse(buf)); } catch { done(null); } });
  });
}

/** Parle à mDOWN ; la lance en arrière-plan (sans prendre le focus) si elle ne tourne pas. */
async function call(req) {
  for (let i = 0; i < 24; i++) {
    const r = await once(req);
    if (r) return r;
    if (i === 0) {
      if (!(await isInstalled())) return { ok: false, error: 'not_installed' };
      spawn('/usr/bin/open', ['-g', '-b', BUNDLE_ID, '--args', '--background'], { stdio: 'ignore', detached: true }).unref();     // sans prendre le focus
    }
    await new Promise((r2) => setTimeout(r2, 500));
  }
  return { ok: false, error: 'unreachable' };
}

/** Cookies du site (et de son domaine) au format Netscape, seul format lu par yt-dlp. */
function netscape(cookies, host, baseDomain) {
  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of cookies) {
    const d = String(c.domain || '').replace(/^\./, '').toLowerCase();
    if (!d || !(host === d || host.endsWith('.' + d) || d.endsWith(baseDomain))) continue;
    const dom = (c.httpOnly ? '#HttpOnly_' : '') + (c.domain.startsWith('.') ? c.domain : (c.hostOnly === false ? '.' + c.domain : c.domain));
    lines.push([dom, c.domain.startsWith('.') || c.hostOnly === false ? 'TRUE' : 'FALSE', c.path || '/', c.secure ? 'TRUE' : 'FALSE', Math.floor(c.expirationDate || 0), c.name, c.value].join('\t'));
  }
  return lines.join('\n') + '\n';
}

/** Cookies du site de cette adresse au format Netscape (chaîne vide s'il n'y en a pas). */
async function cookiesFor(url, ses) {
  const host = new URL(url).hostname.toLowerCase();
  const text = netscape(await ses.cookies.get({}), host, host.split('.').slice(-2).join('.'));
  return text.split('\n').length > 2 ? text : '';
}

/** Envoie une adresse à mDOWN. `ses` : session Electron dont on prend les cookies du site (omis : sans compte). */
async function send({ url, mode = 'video', quality, format, ses, baseDomain, useSession = true }) {
  const req = { op: 'add', url, mode };
  if (quality) req.quality = String(quality);
  if (format) req.format = format;
  if (ses && useSession) {
    const host = new URL(url).hostname.toLowerCase();
    const cookies = await ses.cookies.get({});
    const text = netscape(cookies, host, baseDomain || host.split('.').slice(-2).join('.'));
    if (text.split('\n').length > 2) req.cookies = text;
  }
  return call(req);
}

const status = (id) => call({ op: 'status', id });

module.exports = { send, status, call, netscape, isInstalled, cookiesFor };
