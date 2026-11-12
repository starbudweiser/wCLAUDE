// Import d'une session depuis un navigateur Chromium installé (Chrome, Brave, Edge, Vivaldi, Chromium).
// Google refuse la connexion dans un navigateur intégré à une appli (règle « navigateur non sécurisé ») :
// l'utilisateur se connecte dans son vrai navigateur, puis wCLAUDE recopie ses cookies Google et ceux du site
// ouvert. Action lancée à la main depuis le menu Fichier, jamais par l'agent. La clé de déchiffrement
// (« … Safe Storage ») est lue dans le Trousseau après l'accord de l'utilisateur dans la fenêtre de macOS.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SUPPORT = path.join(os.homedir(), 'Library', 'Application Support');
const BROWSERS = [
  { id: 'chrome', name: 'Google Chrome', dir: 'Google/Chrome', service: 'Chrome Safe Storage', account: 'Chrome' },
  { id: 'brave', name: 'Brave', dir: 'BraveSoftware/Brave-Browser', service: 'Brave Safe Storage', account: 'Brave' },
  { id: 'edge', name: 'Microsoft Edge', dir: 'Microsoft Edge', service: 'Microsoft Edge Safe Storage', account: 'Microsoft Edge' },
  { id: 'vivaldi', name: 'Vivaldi', dir: 'Vivaldi', service: 'Vivaldi Safe Storage', account: 'Vivaldi' },
  { id: 'chromium', name: 'Chromium', dir: 'Chromium', service: 'Chromium Safe Storage', account: 'Chromium' },
];

// Domaines de la session Google (compte, services, connexion « Se connecter avec Google »).
const GOOGLE = ['google.com', 'youtube.com', 'gstatic.com', 'googleusercontent.com'];

// Navigateurs installés qui ont un profil par défaut avec des cookies.
function available(root = SUPPORT) {
  return BROWSERS.filter((b) => {
    try { return fs.statSync(path.join(root, b.dir, 'Default', 'Cookies')).size > 0; } catch { return false; }
  });
}

// Le cookie (host_key) appartient-il à l'un des domaines (domaine lui-même ou sous-domaine) ?
function matchesDomain(hostKey, domains) {
  const h = String(hostKey || '').replace(/^\./, '').toLowerCase();
  return domains.some((d) => h === d || h.endsWith('.' + d));
}

function deriveKey(password) {
  return crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), 'saltysalt', 1003, 16, 'sha1');
}

// Valeur chiffrée « v10 » (AES-128-CBC, IV de 16 espaces). Base v24+ : 32 octets (SHA-256 du domaine) en tête.
function decrypt(encrypted, key, dbVersion) {
  const buf = Buffer.from(encrypted);
  if (!buf.length) return null;
  if (buf.subarray(0, 3).toString() !== 'v10') return null;
  const d = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  let out = Buffer.concat([d.update(buf.subarray(3)), d.final()]);
  if (dbVersion >= 24) out = out.subarray(32);
  return out.toString('utf8');
}

const SAME_SITE = { '-1': 'unspecified', 0: 'no_restriction', 1: 'lax', 2: 'strict' };

// Ligne de la base Chromium → détails pour session.cookies.set d'Electron (null si inutilisable).
function toElectronCookie(row, value, nowSec = Date.now() / 1000) {
  const host = String(row.host_key);
  const secure = !!Number(row.is_secure);
  const expires = Number(BigInt(row.expires_utc) / 1000000n) - 11644473600;
  if (Number(row.has_expires) && expires <= nowSec) return null;
  const sameSite = SAME_SITE[String(Number(row.samesite))] || 'unspecified';
  const cookie = {
    url: `${secure ? 'https' : 'http'}://${host.replace(/^\./, '')}${row.path || '/'}`,
    name: String(row.name),
    value,
    path: row.path || '/',
    secure: secure || sameSite === 'no_restriction',
    httpOnly: !!Number(row.is_httponly),
    sameSite,
  };
  if (host.startsWith('.') && !cookie.name.startsWith('__Host-')) cookie.domain = host;
  if (Number(row.has_expires)) cookie.expirationDate = expires;
  return cookie;
}

// Lit les cookies des domaines voulus (copie de la base : le navigateur la verrouille quand il est ouvert).
function readCookies(browser, password, domains, root = SUPPORT) {
  const { DatabaseSync } = require('node:sqlite');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wclaude-import-'));
  const copy = path.join(tmp, 'Cookies');
  try {
    fs.copyFileSync(path.join(root, browser.dir, 'Default', 'Cookies'), copy);
    const db = new DatabaseSync(copy, { readOnly: true });
    const meta = db.prepare("SELECT value FROM meta WHERE key = 'version'").get();
    const version = Number(meta && meta.value) || 0;
    const stmt = db.prepare('SELECT * FROM cookies');
    stmt.setReadBigInts(true);
    const key = deriveKey(password);
    const out = [];
    for (const row of stmt.all()) {
      if (!matchesDomain(row.host_key, domains)) continue;
      if (row.top_frame_site_key && String(row.top_frame_site_key)) continue; // cookies partitionnés : ignorés
      let value = String(row.value || '');
      if (!value && row.encrypted_value && row.encrypted_value.length) {
        try { value = decrypt(row.encrypted_value, key, version); } catch { value = null; }
        if (value === null) continue;
      }
      const c = toElectronCookie(row, value);
      if (c) out.push(c);
    }
    db.close();
    return out;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Import complet dans une session Electron. getSecret(service, account) → { found, value } (Trousseau).
async function importSession({ browser, siteDomain, ses, getSecret, root = SUPPORT }) {
  const secret = await getSecret(browser.service, browser.account);
  if (!secret || !secret.found || !secret.value) return { error: secret && secret.error ? 'denied' : 'nokey' };
  const domains = [...GOOGLE];
  if (siteDomain && !domains.includes(siteDomain)) domains.push(siteDomain);
  let cookies;
  try { cookies = readCookies(browser, secret.value, domains, root); } catch { return { error: 'read' }; }
  let imported = 0;
  for (const c of cookies) {
    try { await ses.cookies.set(c); imported++; } catch { /* cookie refusé par Chromium : ignoré */ }
  }
  if (ses.cookies.flushStore) await ses.cookies.flushStore();
  return { imported, total: cookies.length, domains };
}

module.exports = { BROWSERS, GOOGLE, available, matchesDomain, deriveKey, decrypt, toElectronCookie, readCookies, importSession };
