// Réglages persistants de wCLAUDE : ~/Library/Application Support/wCLAUDE/config.json
const fs = require('fs');
const path = require('path');
const os = require('os');

// WCLAUDE_SUPPORT_DIR / WCLAUDE_DOWNLOADS_DIR : édition à part (essais, build de test) sans toucher aux données de l'utilisateur.
const SUPPORT_DIR = process.env.WCLAUDE_SUPPORT_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'wCLAUDE');
const CONFIG_FILE = path.join(SUPPORT_DIR, 'config.json');
const CONTROL_FILE = path.join(SUPPORT_DIR, 'control.json');
const DOWNLOADS_DIR = process.env.WCLAUDE_DOWNLOADS_DIR || path.join(os.homedir(), 'Downloads', 'wCLAUDE');

const DEFAULTS = {
  mobileSites: [],
  autoInstall: false,
  agentControl: true,
  cdpPort: 9333,
  lastAgent: '',
  lastUpdateCheck: 0,
  lastTabs: [],
  windowSize: null,
  iconMode: 'menubar', // dock | menubar | both
  watchNotify: true,
  mdownLink: false, // lien optionnel avec mDOWN (téléchargeur de médias), activé par l'utilisateur
};

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function save() {
  fs.mkdirSync(SUPPORT_DIR, { recursive: true });
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, CONFIG_FILE);
}

function get(key) {
  return load()[key];
}

function set(key, value) {
  load()[key] = value;
  save();
}

/** Domaine « enregistrable » d'un hôte (www.instagram.com → instagram.com, a.b.co.uk → b.co.uk). */
const SECOND_LEVEL = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'co.jp', 'co.nz', 'com.br', 'com.mx', 'co.za', 'com.tr', 'co.kr', 'com.cn', 'com.ar']);
function registrableDomain(host) {
  if (!host) return '';
  host = host.toLowerCase().replace(/\.$/, '');
  if (/^[\d.]+$/.test(host) || host.includes(':') || !host.includes('.')) return host;
  const parts = host.split('.');
  const lastTwo = parts.slice(-2).join('.');
  if (SECOND_LEVEL.has(lastTwo) && parts.length >= 3) return parts.slice(-3).join('.');
  return lastTwo;
}

function hostOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname : '';
  } catch {
    return '';
  }
}

function isMobileUrl(url) {
  const host = hostOf(url);
  if (!host) return false;
  return load().mobileSites.some((s) => host === s || host.endsWith('.' + s));
}

function setMobileSite(site, enabled) {
  const sites = new Set(load().mobileSites);
  if (enabled) sites.add(site);
  else sites.delete(site);
  set('mobileSites', [...sites].sort());
}

module.exports = {
  SUPPORT_DIR, CONFIG_FILE, CONTROL_FILE, DOWNLOADS_DIR,
  load, get, set, registrableDomain, hostOf, isMobileUrl, setMobileSite,
};
