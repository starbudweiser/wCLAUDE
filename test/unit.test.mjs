// Tests unitaires : traductions (mêmes clés dans les 4 langues, aucun « Brave »), domaines, mise à jour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.join(import.meta.dirname, '..');
const LANGS = ['fr', 'en', 'es', 'it'];
const load = (l) => JSON.parse(fs.readFileSync(path.join(root, 'app', 'locales', l + '.json'), 'utf8'));

test('les 4 langues ont exactement les mêmes clés, toutes remplies', () => {
  const fr = load('fr');
  for (const l of LANGS) {
    const d = load(l);
    assert.deepEqual(Object.keys(d).sort(), Object.keys(fr).sort(), `clés de ${l}`);
    for (const [k, v] of Object.entries(d)) assert.ok(typeof v === 'string' && v.trim(), `${l}:${k} vide`);
  }
});

test('les variables {…} sont les mêmes dans chaque langue', () => {
  const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  const fr = load('fr');
  for (const l of LANGS) {
    const d = load(l);
    for (const k of Object.keys(fr)) assert.equal(vars(d[k]), vars(fr[k]), `${l}:${k}`);
  }
});

test('les clés de la fenêtre À propos existent', () => {
  for (const l of LANGS) for (const k of ['about.title', 'about.version', 'about.license', 'about.disclaimer', 'about.origin']) assert.ok(load(l)[k], `${l}:${k}`);
});

test('aucune mention du navigateur d’origine ni de Claude seul dans les textes', () => {
  for (const l of LANGS) {
    for (const [k, v] of Object.entries(load(l))) {
      assert.ok(!/brave/i.test(v), `${l}:${k} mentionne Brave`);
      assert.ok(!/Claude(?! Code| Desktop)/.test(v.replace(/wCLAUDE/g, '')), `${l}:${k} réserve l’appli à Claude`);
    }
  }
});

test('aucun texte visible écrit en dur dans les pages (textes posés par les scripts)', () => {
  const ui = path.join(root, 'app', 'ui');
  for (const f of fs.readdirSync(ui).filter((f) => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(ui, f), 'utf8').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, '\n');
    const words = html.split('\n').map((s) => s.trim()).filter((s) => s && !['wCLAUDE', 'CLAUDE', 'w', 'Starbudweiser &amp; Claude Code (Anthropic)'].includes(s));
    assert.deepEqual(words, [], `${f} : ${words.join(' | ')}`);
  }
});

test('domaine enregistrable et sites en version iPhone', () => {
  process.env.WCLAUDE_SUPPORT_DIR = fs.mkdtempSync(path.join(fs.realpathSync(require('os').tmpdir()), 'wclaude-test-'));
  const config = require('../app/lib/config.js');
  assert.equal(config.registrableDomain('www.instagram.com'), 'instagram.com');
  assert.equal(config.registrableDomain('studio.youtube.com'), 'youtube.com');
  assert.equal(config.registrableDomain('a.b.example.co.uk'), 'example.co.uk');
  assert.equal(config.registrableDomain('127.0.0.1'), '127.0.0.1');
  assert.equal(config.hostOf('file:///tmp/x.html'), '');
  config.setMobileSite('instagram.com', true);
  assert.ok(config.isMobileUrl('https://www.instagram.com/accounts/edit/'));
  assert.ok(!config.isMobileUrl('https://notinstagram.com/'));
  config.setMobileSite('instagram.com', false);
  assert.ok(!config.isMobileUrl('https://www.instagram.com/'));
});

test('service de session : agent de lancement valide, caché, relancé seulement après un échec', async () => {
  const { execFileSync } = await import('node:child_process');
  const autostart = require('../app/lib/autostart.js');
  const xml = autostart.plist('/Applications/A & B/wCLAUDE.app/Contents/MacOS/wCLAUDE');
  assert.match(xml, /<string>--background<\/string>/);
  assert.match(xml, /<key>SuccessfulExit<\/key><false\/>/);
  assert.match(xml, /A &amp; B/);
  const f = path.join(fs.mkdtempSync(path.join(fs.realpathSync(require('os').tmpdir()), 'wclaude-plist-')), 'a.plist');
  fs.writeFileSync(f, xml);
  execFileSync('/usr/bin/plutil', ['-lint', f]);
});

test('veille : texte, lignes ajoutées, bruit, mots-clés', () => {
  const core = require('../app/lib/watch-core.js');
  assert.equal(core.normalize('  a   b \n\n a   b\n\tc d '), 'a b\nc d');
  assert.deepEqual(core.addedLines('Menu\nCrossOver 26 is out\nUpdated 5 min ago', 'Menu\nCrossOver 27 is out\nCrossOver 26 is out\n6 min ago\n2026-11-10'), ['CrossOver 27 is out']);
  assert.ok(core.matchesKeywords(['Build ARM64 pour macOS'], ['arm64']));
  assert.ok(!core.matchesKeywords(['Nouveau thème'], ['DXMT', 'arm64']));
  assert.ok(core.matchesKeywords(['Élévation'], ['elevation']));
  assert.deepEqual(core.parseKeywords('DXMT, ARM64;  ,Wine'), ['DXMT', 'ARM64', 'Wine']);
});

test('veille : numéros de version', () => {
  const core = require('../app/lib/watch-core.js');
  assert.equal(core.highestVersion('Latest: v1.4.3. Older v1.4.2, v1.3.9'), 'v1.4.3');
  assert.equal(core.highestVersion('Le 10.11.2026, prix 10.50 €'), null);
  assert.equal(core.highestVersion('CrossOver 26.1.0 et 27.0.1'), '27.0.1');
  assert.equal(core.highestVersion(' 6.9 '), '6.9');
  assert.equal(core.highestVersion('1.0.27'), '1.0.27');
  assert.deepEqual(core.addedLines('1.0.27', '1.0.28', { keepNoise: true }), ['1.0.28']);
  assert.ok(core.versionGreater('v1.4.3', 'v1.4.2'));
  assert.ok(core.versionGreater('2.0', '2.0 rc1'));
  assert.ok(!core.versionGreater('2.0 beta 3', '2.0'));
});

test('veille : flux RSS et Atom, lien de flux, GitHub, barrières', () => {
  const core = require('../app/lib/watch-core.js');
  const rss = '<?xml version="1.0"?><rss><channel><item><title>A &amp; B</title><link>https://x/a</link><guid>1</guid><description><![CDATA[<p>Hi <b>there</b></p>]]></description></item></channel></rss>';
  assert.ok(core.looksLikeFeed(rss));
  assert.deepEqual(core.parseFeed(rss).map((e) => [e.id, e.title, e.url, e.summary]), [['1', 'A & B', 'https://x/a', 'Hi there']]);
  const atom = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>t1</id><title>T</title><link rel="alternate" href="https://y/1"/></entry></feed>';
  assert.equal(core.parseFeed(atom)[0].url, 'https://y/1');
  assert.equal(core.feedLink('<link rel="alternate" type="application/rss+xml" href="/feed/">', 'https://blog.example/a/'), 'https://blog.example/feed/');
  assert.deepEqual(core.githubRepo('https://github.com/doodlum/skyrim-community-shaders/releases'), { owner: 'doodlum', repo: 'skyrim-community-shaders' });
  assert.equal(core.githubRepo('https://example.com/a/b'), null);
  assert.equal(core.needsUser({ title: 'Just a moment...' }), 'challenge');
  assert.equal(core.needsUser({ text: 'Sign in', hasPassword: true }), 'signin');
  assert.equal(core.needsUser({ text: 'A long normal article' }), null);
});

test('identité Chrome : user agent réduit et Client Hints identiques au vrai Chrome', () => {
  const { desktopIdentity } = require('../app/lib/identity.js');
  // Valeurs relevées sur Chrome 120 et 131 pour Mac.
  assert.equal(desktopIdentity({ chromeVersion: '120.0.6099.71' }).headers['sec-ch-ua'],
    '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"');
  assert.equal(desktopIdentity({ chromeVersion: '131.0.6778.86' }).headers['sec-ch-ua'],
    '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"');
  const id = desktopIdentity({ chromeVersion: '156.0.8078.80', macVersion: '27.2', arch: 'arm64' });
  assert.match(id.userAgent, /Chrome\/156\.0\.0\.0 Safari\/537\.36$/);
  assert.equal(id.metadata.platform, 'macOS');
  assert.equal(id.metadata.platformVersion, '27.2.0');
  assert.equal(id.metadata.architecture, 'arm');
  assert.equal(id.metadata.fullVersionList.find((b) => b.brand === 'Google Chrome').version, '156.0.8078.80');
});
