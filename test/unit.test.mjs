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
