// Langue de l'appli : langue préférée du système si c'est fr, en, es ou it ; sinon anglais.
const path = require('path');
const fs = require('fs');

const SUPPORTED = ['fr', 'en', 'es', 'it'];
let lang = 'en';
let strings = {};
let fallback = {};

function read(code) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'locales', code + '.json'), 'utf8'));
}

function init(preferred) {
  const forced = process.env.WCLAUDE_LANG;
  const candidates = forced ? [forced] : preferred || [];
  lang = 'en';
  for (const tag of candidates) {
    const code = String(tag).toLowerCase().split(/[-_]/)[0];
    if (SUPPORTED.includes(code)) { lang = code; break; }
  }
  fallback = read('en');
  strings = lang === 'en' ? fallback : read(lang);
  return lang;
}

function t(key, vars) {
  let s = strings[key] ?? fallback[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split('{' + k + '}').join(String(v));
  return s;
}

module.exports = { init, t, get lang() { return lang; }, get strings() { return { ...fallback, ...strings }; }, SUPPORTED };
