import { chromium } from 'playwright-core';
import fs from 'fs';
const [svgPath, outDir] = process.argv.slice(2);
const exe = process.env.HOME + '/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const b = await chromium.launch({ executablePath: exe });
const svg = fs.readFileSync(svgPath, 'utf8');
for (const s of [16, 32, 64, 128, 256, 512, 1024]) {
  const p = await b.newPage({ viewport: { width: s, height: s }, deviceScaleFactor: 1 });
  await p.setContent(`<style>html,body{margin:0;background:transparent}</style>${svg.replace('width="1024" height="1024"', `width="${s}" height="${s}"`)}`);
  await p.screenshot({ path: `${outDir}/${s}.png`, omitBackground: true });
  await p.close();
}
await b.close();
