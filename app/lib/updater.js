// Mise à jour automatique depuis les releases GitHub (modèle : _tools/shared/updater.py et Updater.swift).
// Recherche quotidienne, notes de chaque version plus récente, téléchargement, contrôles (SHA-256, identifiant,
// version, signature, Team ID Developer ID), remplacement puis relance. Jamais pendant qu'un agent agit.
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const config = require('./config');
const pkg = require('../../package.json');

const REPO = pkg.wclaude.updateRepo;          // « propriétaire/dépôt »
const TEAM_ID = pkg.wclaude.teamId;           // Team ID des versions officielles
const DAY = 24 * 3600 * 1000;
const assetName = (v) => `wCLAUDE-${v}-macOS-arm64.zip`;

let state = { status: 'idle', current: app.getVersion() };
let pending = null; // { app, version } prêt à installer
const listeners = new Set();

function setState(patch) {
  state = { ...state, ...patch, current: app.getVersion() };
  for (const fn of listeners) fn(state);
}

function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function cmp(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 1 << 22 }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, out: String(stdout) + String(stderr) }));
  });
}

async function ghToken() {
  for (const gh of ['/opt/homebrew/bin/gh', '/usr/local/bin/gh']) {
    if (!fs.existsSync(gh)) continue;
    const r = await run(gh, ['auth', 'token']);
    if (r.code === 0 && r.out.trim()) return r.out.trim().split('\n')[0];
  }
  return null;
}

async function api(url, token, accept = 'application/vnd.github+json') {
  const headers = { Accept: accept, 'User-Agent': 'wCLAUDE-updater', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = `Bearer ${token}`;
  // fetch retire l'en-tête Authorization quand GitHub redirige vers son stockage (autre origine).
  return fetch(url, { headers, redirect: 'follow' });
}

/** Releases publiées, avec repli sur le jeton gh si le dépôt est privé. */
async function releases() {
  const url = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
  let token = null;
  let res = await api(url, null);
  if (res.status === 404 || res.status === 401 || res.status === 403) {
    token = await ghToken();
    if (token) res = await api(url, token);
  }
  if (!res.ok) throw new Error('github ' + res.status);
  const list = (await res.json()).filter((r) => !r.draft && !r.prerelease);
  return { list, token };
}

function notesFor(body, lang) {
  body = body || '';
  const pick = (code) => {
    const m = body.match(new RegExp(`<!--\\s*notes:${code}\\s*-->([\\s\\S]*?)(?=<!--\\s*notes:|$)`));
    return m ? m[1].trim() : null;
  };
  return pick(lang) ?? pick('en') ?? body.trim();
}

async function check({ lang = 'en' } = {}) {
  setState({ status: 'checking', error: null });
  try {
    const { list, token } = await releases();
    config.set('lastUpdateCheck', Date.now());
    const newer = list
      .map((r) => ({ r, v: String(r.tag_name).replace(/^v/, '') }))
      .filter(({ v }) => cmp(v, app.getVersion()) > 0)
      .sort((a, b) => cmp(b.v, a.v));
    if (!newer.length) {
      setState({ status: 'uptodate', latest: app.getVersion(), notes: [], lastCheck: Date.now() });
      return state;
    }
    const latest = newer[0];
    setState({
      status: 'available',
      latest: latest.v,
      notes: newer.map(({ r, v }) => ({ version: v, text: notesFor(r.body, lang) })),
      lastCheck: Date.now(),
      _release: latest.r,
      _token: token,
    });
    return state;
  } catch (e) {
    setState({ status: 'error', error: String(e.message || e) });
    return state;
  }
}

async function downloadAsset(asset, token, dest) {
  const res = await api(asset.url, token, 'application/octet-stream');
  if (!res.ok) throw new Error('download ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return buf;
}

function currentAppPath() {
  // …/wCLAUDE.app/Contents/MacOS/wCLAUDE
  return path.resolve(path.dirname(process.execPath), '..', '..');
}

/** Télécharge et contrôle la version disponible ; renvoie le chemin de la nouvelle .app. */
async function prepare() {
  if (pending) return pending;
  if (state.status !== 'available') throw new Error('nothing');
  const release = state._release;
  const version = state.latest;
  const zip = release.assets.find((a) => a.name === assetName(version));
  const sum = release.assets.find((a) => a.name === assetName(version) + '.sha256');
  if (!zip || !sum) throw new Error('assets');
  setState({ status: 'downloading' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wclaude-update-'));
  const zipPath = path.join(dir, zip.name);
  const data = await downloadAsset(zip, state._token, zipPath);
  const expected = (await (await api(sum.url, state._token, 'application/octet-stream')).text()).trim().split(/\s+/)[0].toLowerCase();
  setState({ status: 'verifying' });
  const actual = crypto.createHash('sha256').update(data).digest('hex');
  if (!expected || expected !== actual) throw new Error('verify:sha256');
  const out = path.join(dir, 'x');
  fs.mkdirSync(out);
  if ((await run('/usr/bin/ditto', ['-x', '-k', zipPath, out])).code !== 0) throw new Error('verify:unzip');
  const newApp = path.join(out, 'wCLAUDE.app');
  if (!fs.existsSync(newApp)) throw new Error('verify:missing');
  const plist = path.join(newApp, 'Contents', 'Info.plist');
  const id = (await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist])).out.trim();
  const ver = (await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist])).out.trim();
  if (id !== pkg.wclaude.bundleId) throw new Error('verify:id');
  if (ver !== version) throw new Error('verify:version');
  if ((await run('/usr/bin/codesign', ['--verify', '--strict', '--deep', newApp])).code !== 0) throw new Error('verify:signature');
  const info = (await run('/usr/bin/codesign', ['-dv', newApp])).out;
  const team = (info.match(/^TeamIdentifier=(\S+)/m) || [])[1];
  if (team !== TEAM_ID) throw new Error('verify:team');
  pending = { app: newApp, version };
  setState({ status: 'ready', latest: version });
  return pending;
}

/** Remplace l'appli après sa fermeture ; relance si demandé. */
function installOnExit(relaunch) {
  if (!pending || !app.isPackaged) return false;
  const target = currentAppPath();
  const script = path.join(path.dirname(pending.app), 'install.sh');
  fs.writeFileSync(script, `#!/bin/bash
while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done
BACKUP="$(mktemp -d)/old.app"
if mv "$TARGET" "$BACKUP" && /usr/bin/ditto "$NEW" "$TARGET"; then rm -rf "$BACKUP"; else rm -rf "$TARGET"; mv "$BACKUP" "$TARGET"; fi
[ "$RELAUNCH" = 1 ] && /usr/bin/open "$TARGET"
`, { mode: 0o755 });
  spawn('/bin/bash', [script], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, TARGET: target, NEW: pending.app, RELAUNCH: relaunch ? '1' : '0' },
  }).unref();
  pending = null;
  return true;
}

/** Recherche automatique : au plus une fois par jour, après le démarrage. */
function schedule({ lang, onAvailable, isBusy }) {
  const tick = async () => {
    if (Date.now() - (config.get('lastUpdateCheck') || 0) < DAY) return;
    const s = await check({ lang });
    if (s.status !== 'available') return;
    if (config.get('autoInstall')) {
      try { await prepare(); } catch (e) { setState({ status: 'error', error: String(e.message || e) }); }
    } else {
      onAvailable(s);
    }
  };
  setTimeout(tick, 60 * 1000);
  setInterval(tick, 3600 * 1000);
  app.on('before-quit', () => {
    if (pending && config.get('autoInstall') && !isBusy()) installOnExit(false);
  });
}

function publicState() {
  const { _release, _token, ...rest } = state;
  return { ...rest, lastCheck: config.get('lastUpdateCheck') || 0, autoInstall: !!config.get('autoInstall') };
}

module.exports = { check, prepare, installOnExit, schedule, onChange, publicState, cmp, notesFor, get pending() { return pending; } };
