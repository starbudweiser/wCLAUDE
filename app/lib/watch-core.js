// wCLAUDE — Veille : fonctions pures (sans Electron), testées par test/unit.test.mjs.
// Détection déterministe, aucune IA : normalisation du texte, lignes ajoutées, numéros de version, flux RSS/Atom.

const MAX_TEXT = 200 * 1024; // texte de référence gardé par source
const MAX_LINE = 400;

/** Texte visible → lignes nettoyées (espaces réduits, lignes vides et doublons consécutifs retirés), borné. */
function normalize(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/[\s ​]+/g, ' ').trim().slice(0, MAX_LINE);
    if (line && line !== out[out.length - 1]) out.push(line);
  }
  let s = out.join('\n');
  if (s.length > MAX_TEXT) s = s.slice(0, MAX_TEXT).replace(/\n[^\n]*$/, '');
  return s;
}

const wordCount = (text) => (String(text).match(/[\p{L}\p{N}]+/gu) || []).length;

// Lignes qui changent à chaque visite sans rien dire (heures, compteurs, « il y a 5 minutes ») : jamais une alerte.
const NOISE = [
  /^[\d\s.,:;/+\-–—%()|·•]*$/,
  /^(il y a|hace|fa|\d+\s*(s|sec|min|h|j|d|days?|hours?|minutes?|seconds?|jours?|heures?|giorni|ore|días|horas)\b.*\b(ago|fa)?)\b/i,
  /^\d+\s*(s|sec|min|mins|h|hrs?|d|days?|hours?|minutes?|jours?|heures?)\s*(ago)?$/i,
  /^(\d+(\.\d+)?[kKmM]?\s*)?(views?|vues|likes?|comments?|commentaires|visualizaciones|visualizzazioni|downloads?|téléchargements)$/i,
  // compteur suivi d'un ou deux mots : « 6 507 625 membres », « 1.2k upvotes », « 85 872 members online »
  /^[+\-]?\d[\d\s.,\u00a0\u202f]*[kKmM]?\s+\p{L}+(\s(online|en ligne|connectés|en línea|in linea|mensuels|monthly|mensuales|mensili))?$/iu,
  // publicités
  /^(sponsoris[ée]e?|sponsored|promoted|publicité|publicidad|pubblicità|annonce|advertisement|ad|promu)$/i,
];
const isNoise = (line) => line.length < 3 || !/\p{L}/u.test(line) || NOISE.some((r) => r.test(line));

/** Lignes présentes dans le nouveau texte et absentes (ou moins nombreuses) dans l'ancien, dans l'ordre. */
function addedLines(oldText, newText, { keepNoise = false } = {}) {
  const count = new Map();
  for (const l of String(oldText || '').split('\n')) count.set(l, (count.get(l) || 0) + 1);
  const added = [];
  for (const l of String(newText || '').split('\n')) {
    const n = count.get(l) || 0;
    if (n > 0) count.set(l, n - 1);
    else if (l && (keepNoise || !isNoise(l))) added.push(l);
  }
  return added;
}

/** Mots-clés : alerte seulement si l'un d'eux apparaît dans le texte ajouté (sans accents ni casse). */
const fold = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function matchesKeywords(lines, keywords) {
  const kw = (keywords || []).map(fold).filter(Boolean);
  if (!kw.length) return true;
  const hay = fold(lines.join('\n'));
  return kw.some((k) => hay.includes(k));
}

function parseKeywords(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean).slice(0, 30);
  return String(v || '').split(/[,;\n]/).map((s) => s.trim()).filter(Boolean).slice(0, 30);
}

// ---------- numéros de version ----------
const VERSION_RE = /(?<![\w.])v?(\d{1,4})\.(\d{1,4})(?:\.(\d{1,5}))?(?:\.(\d{1,5}))?(?:[-\s]?(alpha|beta|preview|rc|pre)[-.\s]?(\d{1,3})?)?(?![\w.]*\d)/gi;
const STAGE = { alpha: 1, pre: 2, preview: 2, beta: 3, rc: 4 };

function parseVersion(m) {
  const nums = [m[1], m[2], m[3], m[4]].map((x) => (x === undefined ? 0 : Number(x)));
  const stage = m[5] ? STAGE[m[5].toLowerCase()] : 9; // version finale après alpha, beta, rc
  return { text: m[0].trim(), nums, stage, stageNum: m[6] ? Number(m[6]) : 0 };
}

function compareVersions(a, b) {
  for (let i = 0; i < 4; i++) if (a.nums[i] !== b.nums[i]) return a.nums[i] - b.nums[i];
  if (a.stage !== b.stage) return a.stage - b.stage;
  return a.stageNum - b.stageNum;
}

/** Plus haut numéro de version du texte (« v1.4.3 », « 27.0.1 », « 2.0 beta 3 ») ; les dates sont ignorées. */
function highestVersion(text) {
  // Zone qui ne contient qu'un numéro (« 6.9 » d'une page Nexus lue par sélecteur) : c'est la version.
  const bare = String(text || '').trim().match(/^v?\d{1,4}(\.\d{1,5}){1,3}([-.]?[a-z]+\.?\d*)?$/i);
  if (bare) return bare[0];
  let best = null;
  for (const m of String(text || '').matchAll(VERSION_RE)) {
    const v = parseVersion(m);
    if (v.nums[0] > 999) continue; // 2026.11 : une date
    if (v.nums[2] >= 1900 && v.nums[2] <= 2100 && v.nums[0] <= 31 && v.nums[1] <= 31) continue; // 10.11.2026 : une date
    if (!m[3] && !/^v/i.test(v.text) && !m[5]) {
      // « 10.11 » seul : date ou nombre décimal plutôt qu'une version
      continue;
    }
    if (!best || compareVersions(v, best) > 0) best = v;
  }
  return best ? best.text.replace(/\s+/g, ' ') : null;
}

function versionGreater(a, b) {
  const pa = [...String(a).matchAll(VERSION_RE)][0];
  const pb = [...String(b).matchAll(VERSION_RE)][0];
  if (!pa || !pb) return a !== b;
  return compareVersions(parseVersion(pa), parseVersion(pb)) > 0;
}

// ---------- flux RSS / Atom ----------
const decode = (s) => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();

const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : '';
};

const looksLikeFeed = (body) => /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<(rss|feed|rdf:RDF)\b/i.test(String(body || '').slice(0, 2000));

/** Éléments d'un flux : { id, title, url, at, summary }, du plus récent au plus ancien (ordre du flux). */
function parseFeed(xml) {
  xml = String(xml || '');
  const entries = [];
  const atom = /<feed\b/i.test(xml.slice(0, 2000));
  const re = atom ? /<entry\b[\s\S]*?<\/entry>/gi : /<item\b[\s\S]*?<\/item>/gi;
  for (const [block] of xml.matchAll(re)) {
    let url = '';
    if (atom) {
      const alt = block.match(/<link\b[^>]*rel=["']alternate["'][^>]*>/i) || block.match(/<link\b[^>]*>/i);
      url = alt ? (alt[0].match(/href=["']([^"']+)["']/i) || [])[1] || '' : '';
    } else url = decode(tag(block, 'link'));
    const title = decode(tag(block, 'title'));
    const id = decode(tag(block, atom ? 'id' : 'guid')) || url || title;
    const summary = decode(tag(block, atom ? 'summary' : 'description') || tag(block, 'content') || tag(block, 'content:encoded')).slice(0, 600);
    const at = Date.parse(decode(tag(block, atom ? 'updated' : 'pubDate') || tag(block, 'published') || tag(block, 'dc:date'))) || 0;
    if (id) entries.push({ id: id.slice(0, 500), title: title.slice(0, 300), url: url.replace(/&amp;/g, '&'), at, summary });
  }
  return entries;
}

/** <link rel="alternate" type="application/rss+xml|atom+xml" href="…"> d'une page HTML, en adresse absolue. */
function feedLink(html, base) {
  for (const [linkTag] of String(html || '').matchAll(/<link\b[^>]*>/gi)) {
    if (!/rel=["']?alternate/i.test(linkTag) || !/type=["']?application\/(rss|atom)\+xml/i.test(linkTag)) continue;
    const href = (linkTag.match(/href=["']([^"']+)["']/i) || [])[1];
    if (!href || /comments/i.test(href)) continue;
    try { return new URL(href.replace(/&amp;/g, '&'), base).href; } catch { /* adresse invalide */ }
  }
  return null;
}

/** github.com/owner/repo(/releases…) → { owner, repo } */
function githubRepo(url) {
  try {
    const u = new URL(url);
    if (!/^(www\.)?github\.com$/i.test(u.hostname)) return null;
    const [owner, repo] = u.pathname.split('/').filter(Boolean);
    if (!owner || !repo || ['orgs', 'topics', 'settings', 'marketplace', 'sponsors'].includes(owner)) return null;
    return { owner, repo: repo.replace(/\.git$/, '') };
  } catch {
    return null;
  }
}

// ---------- barrières : connexion, CAPTCHA, anti-robots (jamais contournées) ----------
const WALL = /captcha|verify (that )?you are (a )?human|are you a robot|unusual traffic|just a moment|checking your browser|attention required|access denied|vérifiez que vous (êtes|n'êtes pas)|confirmez que vous êtes humain|cloudflare ray id|enable javascript and cookies/i;

/** { title, text, hasPassword, status } → raison « main demandée » ou null. */
function needsUser({ title = '', text = '', hasPassword = false, status = 200 }) {
  if (WALL.test(title) || WALL.test(String(text).slice(0, 3000))) return 'challenge';
  if (hasPassword && wordCount(text) < 400) return 'signin';
  if ((status === 401 || status === 407)) return 'signin';
  return null;
}

module.exports = {
  MAX_TEXT, normalize, wordCount, addedLines, isNoise, matchesKeywords, parseKeywords,
  highestVersion, versionGreater, parseFeed, looksLikeFeed, feedLink, githubRepo, needsUser, decode,
};
