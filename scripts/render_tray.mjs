// Icône de la barre de menus : assets/tray.svg → app/ui/tray(.png|@2x.png) et tray-new(.png|@2x.png) (avec pastille).
import { chromium } from 'playwright-core';
import fs from 'fs';
const exe = process.env.HOME + '/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const svg = fs.readFileSync(new URL('../assets/tray.svg', import.meta.url), 'utf8');
const b = await chromium.launch({ executablePath: exe });
for (const badge of [false, true]) {
  const src = badge ? svg : svg.replace(/<g id="badge">[\s\S]*?<\/g>/, '');
  for (const [s, suffix] of [[18, ''], [36, '@2x']]) {
    const p = await b.newPage({ viewport: { width: s, height: s } });
    await p.setContent(`<style>html,body{margin:0;background:transparent}</style>${src.replace('width="36" height="36"', `width="${s}" height="${s}"`)}`);
    await p.screenshot({ path: `app/ui/tray${badge ? '-new' : ''}${suffix}.png`, omitBackground: true });
    await p.close();
  }
}
await b.close();
