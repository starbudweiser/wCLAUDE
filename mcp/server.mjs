#!/usr/bin/env node
// wCLAUDE MCP server — lets any MCP-compatible AI agent drive the wCLAUDE browser.
// Transport: stdio. Talks to the running app through its local control API (127.0.0.1, token in control.json)
// and drives pages over the Chrome DevTools Protocol with Playwright.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');
const SUPPORT_DIR = process.env.WCLAUDE_SUPPORT_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'wCLAUDE');
const CONTROL_FILE = path.join(SUPPORT_DIR, 'control.json');
const ACTION_TIMEOUT = 15000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- app bridge
let control = null;
let browser = null;
const targetIds = new WeakMap();
const prepared = new WeakSet();
const consoleLogs = new WeakMap();
const dialogs = new WeakMap();

function readControl() {
  try {
    const info = JSON.parse(fs.readFileSync(CONTROL_FILE, 'utf8'));
    process.kill(info.pid, 0);
    return info;
  } catch {
    return null;
  }
}

async function api(method, route, body) {
  if (!control) throw new Error('wCLAUDE is not running.');
  const res = await fetch(`http://127.0.0.1:${control.controlPort}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-wCLAUDE-Token': control.token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `control API ${res.status}`);
  return data;
}

function appPath() {
  if (process.env.WCLAUDE_APP) return process.env.WCLAUDE_APP;
  // Run by the app's bundled engine: …/wCLAUDE.app/Contents/MacOS/wCLAUDE
  const m = process.execPath.match(/^(.*?\.app)\/Contents\/MacOS\//);
  return m ? m[1] : null;
}

function launchApp() {
  const target = appPath();
  const args = target ? ['-g', '-a', target, '--args', '--background'] : ['-g', '-b', pkg.wclaude.bundleId, '--args', '--background'];
  // The server may run on the app's own engine (ELECTRON_RUN_AS_NODE): never pass that to the app itself.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve) => execFile('/usr/bin/open', args, { env }, () => resolve()));
}

async function ensureApp() {
  control = readControl();
  if (control) {
    try { await api('GET', '/state'); return; } catch { control = null; }
  }
  await launchApp();
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    control = readControl();
    if (!control) continue;
    try { await api('GET', '/state'); return; } catch { /* starting */ }
  }
  throw new Error('Could not start wCLAUDE. Open it once, and check that "Allow control by an AI agent" is on in its Settings.');
}

async function ensure() {
  await ensureApp();
  await api('POST', '/tabs/ensure');
  if (browser && browser.isConnected()) return;
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${control.cdpPort}`, { timeout: 15000 });
  browser.on('disconnected', () => { browser = null; });
  // Playwright redirects downloads to its own temporary folder (random names, deleted on disconnect):
  // hand them back to wCLAUDE, which saves them under their real name in its downloads folder.
  const cdp = await browser.newBrowserCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' }).catch(() => {});
  // Playwright emulates a light color scheme on every page it attaches to, while wCLAUDE is always dark:
  // sites that follow prefers-color-scheme (Reddit…) then keep flipping between light and dark. Keep them dark.
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) keepDark(p);
    ctx.on('page', keepDark);
  }
}

function keepDark(page) {
  page.emulateMedia({ colorScheme: 'dark' }).catch(() => {});
}

async function targetIdOf(page) {
  if (targetIds.has(page)) return targetIds.get(page);
  try {
    const s = await page.context().newCDPSession(page);
    const { targetInfo } = await s.send('Target.getTargetInfo');
    await s.detach().catch(() => {});
    targetIds.set(page, targetInfo.targetId);
    return targetInfo.targetId;
  } catch {
    return null;
  }
}

function prepare(page) {
  if (prepared.has(page)) return;
  prepared.add(page);
  const logs = [];
  consoleLogs.set(page, logs);
  page.on('console', (m) => { logs.push(`[${m.type()}] ${m.text()}`); if (logs.length > 300) logs.shift(); });
  page.on('pageerror', (e) => { logs.push(`[pageerror] ${e.message}`); if (logs.length > 300) logs.shift(); });
  page.on('dialog', (d) => dialogs.set(page, d));
  page.setDefaultTimeout(ACTION_TIMEOUT);
}

async function pageByTab(tab) {
  for (let i = 0; i < 60; i++) {
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        const id = await targetIdOf(p);
        if ((tab.targetId && id === tab.targetId) || (!tab.targetId && p.url() === tab.url)) {
          prepare(p);
          return p;
        }
      }
    }
    await sleep(100);
  }
  throw new Error(`Tab #${tab.id} is not reachable. Try browser_tabs with action "list".`);
}

let agentName = '';
async function activity(action, tabId) {
  api('POST', '/activity', { action, agent: agentName, tabId }).catch(() => {});
}

/** Resolves the tab to act on (active tab by default), brings it to the front in wCLAUDE, returns its page. */
async function resolve(tabArg, action) {
  await ensure();
  const st = await api('GET', '/state');
  const tab = tabArg != null ? st.tabs.find((x) => x.id === Number(tabArg)) : st.tabs.find((x) => x.active) || st.tabs[0];
  if (!tab) throw new Error(`There is no tab #${tabArg}. Use browser_tabs with action "list".`);
  await activity(action, tab.id);
  const page = await pageByTab(tab);
  return { tab, page };
}

function locate(page, { ref, selector, text }) {
  if (ref) return page.locator(`aria-ref=${ref}`);
  if (selector) return page.locator(selector).first();
  if (text) return page.getByText(text).first();
  return null;
}

async function pageLine(page, tab) {
  let title = '';
  try { title = await page.title(); } catch { /* navigating */ }
  let mobile = tab.mobile;
  try { mobile = ((await api('GET', '/state')).tabs.find((x) => x.id === tab.id) || tab).mobile; } catch { /* état précédent */ }
  return `Tab #${tab.id}${mobile ? ' (iPhone mode)' : ''}: ${title || '(no title)'} — ${page.url()}`;
}

/**
 * Pages that need the user: sign-in, human checks (CAPTCHA), sites refusing access. wCLAUDE never tries to get past
 * them; it tells the agent to hand over to the user with browser_request_user.
 */
async function blockerNote(page) {
  const url = page.url();
  if (/^https:\/\/accounts\.google\.com\/.*\/rejected/.test(url)) {
    return '\nThe site refused this browser for sign-in. Do not retry: tell the user, and prefer an official API if one exists.';
  }
  const info = await page.evaluate(() => {
    const frames = [...document.querySelectorAll('iframe')].map((f) => f.src || '').join(' ');
    const text = (document.body ? document.body.innerText : '').slice(0, 6000).toLowerCase();
    const check = /recaptcha|hcaptcha|challenges\.cloudflare\.com|turnstile|arkoselabs|funcaptcha|captcha-delivery/.test(frames)
      || /captcha|verify you are human|vérifiez que vous êtes humain|unusual traffic|trafic inhabituel|are you a robot|êtes-vous un robot/.test(text);
    const password = [...document.querySelectorAll('input[type=password]')].some((i) => i.offsetParent !== null);
    return { check, password };
  }).catch(() => ({}));
  if (info.check) return '\nThis page asks for a human check (CAPTCHA). Never try to solve it: call browser_request_user with kind "captcha".';
  if (info.password) return '\nThis page asks for a sign-in. Use browser_keychain_fill if a sign-in is saved; otherwise call browser_request_user with kind "signin".';
  return '';
}

function dialogNote(page) {
  const d = dialogs.get(page);
  return d ? `\nA ${d.type()} dialog is open: "${d.message()}". Answer it with browser_handle_dialog.` : '';
}

async function settle(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
  await sleep(300);
}

/** Password and payment-card fields are off limits to agents: wCLAUDE fills sign-ins from the Keychain itself. */
async function guardField(loc) {
  const kind = await loc.evaluate((el) => {
    if (!(el instanceof HTMLInputElement)) return '';
    if (el.type === 'password') return 'password';
    if (/^cc-/.test(el.autocomplete || '')) return 'card';
    return '';
  }).catch(() => '');
  if (kind === 'password') throw new Error('Typing into password fields is blocked. Use browser_keychain_fill: wCLAUDE fills the password from the macOS Keychain after the user approves, and the agent never sees it.');
  if (kind === 'card') throw new Error('Typing into payment card fields is blocked. Ask the user to enter payment details themselves.');
}

async function focusedFieldKind(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!(el instanceof HTMLInputElement)) return '';
    if (el.type === 'password') return 'password';
    if (/^cc-/.test(el.autocomplete || '')) return 'card';
    return '';
  }).catch(() => '');
}

/**
 * Hands local file paths straight to the browser engine (DOM.setFileInputFiles): no size limit and no copy.
 * Playwright refuses files over 50 MB on a browser it connected to, which is the very limit wCLAUDE removes.
 */
async function setFiles(page, target, files) {
  const mark = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2);
  await target.evaluate((el, m) => el.setAttribute('data-wclaude-upload', m), mark);
  const s = await page.context().newCDPSession(page);
  try {
    const selector = `[data-wclaude-upload="${mark}"]`;
    const { result } = await s.send('Runtime.evaluate', { expression: `document.querySelector('${selector}')` });
    if (result && result.objectId) {
      await s.send('DOM.setFileInputFiles', { files, objectId: result.objectId });
    } else {
      // Element inside a frame: search the whole document tree.
      await s.send('DOM.getDocument', { depth: -1, pierce: true });
      const { searchId, resultCount } = await s.send('DOM.performSearch', { query: selector });
      if (!resultCount) throw new Error('The file input could not be reached.');
      const { nodeIds } = await s.send('DOM.getSearchResults', { searchId, fromIndex: 0, toIndex: 1 });
      await s.send('DOM.setFileInputFiles', { files, nodeId: nodeIds[0] });
      await s.send('DOM.discardSearchResults', { searchId }).catch(() => {});
    }
  } finally {
    await s.detach().catch(() => {});
    await target.evaluate((el) => el.removeAttribute('data-wclaude-upload')).catch(() => {});
  }
}

function expandPath(p) {
  if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}

const fmtSize = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.ceil(n / 1e3)} KB`);

// ---------------------------------------------------------------- MCP server
const server = new McpServer(
  { name: 'wclaude', version: pkg.version, title: 'wCLAUDE browser' },
  {
    instructions: [
      'wCLAUDE is a real, visible browser on the user\'s Mac with the user\'s own signed-in sessions.',
      'Workflow: browser_tabs (list) → browser_navigate → browser_snapshot to get element refs (e.g. ref=e12) → act with browser_click / browser_type / browser_upload_files using those refs → browser_snapshot again to check the result. Refs expire when the page changes.',
      'Uploads: browser_upload_files sends local files of any size. Downloads are saved in the folder reported by browser_downloads.',
      'Mobile-only features (e.g. Instagram profile links): browser_mobile_mode switches a site to the iPhone version (user agent, screen and touch).',
      'Sign-in: never ask for or type passwords. Use browser_keychain_fill; the user approves in a macOS dialog and the password is never shared with you. Typing into password or payment-card fields is blocked.',
      'When a page needs the user (sign-in without a saved Keychain entry, CAPTCHA, two-factor code, "unusual activity" block), call browser_request_user: wCLAUDE asks the user to act in its window and returns when they are done. Never try to get past those checks yourself.',
      'Watch: wCLAUDE checks the user\'s watched pages, feeds and GitHub releases while you are away. Call watch_digest when you start a task that may relate to them (or when the user asks what is new), then watch_read the items you have handled.',
      'YouTube: prefer the youtube_* tools (official API) over driving YouTube Studio pages; they upload videos of any size and read statistics reliably.',
      'Ask the user before publishing, posting, sending a message, buying, accepting terms or deleting anything.',
    ].join('\n'),
  },
);

const AGENTS = { 'claude-code': 'Claude Code', 'claude-ai': 'Claude', cursor: 'Cursor', 'codex-mcp-client': 'Codex', codex: 'Codex', 'gemini-cli-mcp-client': 'Gemini CLI', 'gemini-cli': 'Gemini CLI', 'Visual Studio Code': 'VS Code', windsurf: 'Windsurf', zed: 'Zed' };
server.server.oninitialized = () => {
  const name = server.server.getClientVersion()?.name || '';
  agentName = AGENTS[name] || name;
};

const tabArg = z.number().int().optional().describe('Tab number from browser_tabs (default: the active tab).');
const target = {
  ref: z.string().optional().describe('Element ref from browser_snapshot, e.g. "e12".'),
  selector: z.string().optional().describe('CSS or Playwright selector, used when no ref is given.'),
  text: z.string().optional().describe('Visible text of the element, used when no ref or selector is given.'),
};

function tool(name, description, schema, handler, annotations = {}) {
  server.registerTool(name, { description, inputSchema: schema, annotations: { openWorldHint: true, ...annotations } }, async (args) => {
    try {
      const out = await handler(args);
      return typeof out === 'string' ? { content: [{ type: 'text', text: out }] } : out;
    } catch (e) {
      const msg = String(e && e.message ? e.message : e).split('\n').slice(0, 6).join('\n').slice(0, 800);
      return { isError: true, content: [{ type: 'text', text: msg }] };
    }
  });
}

tool('browser_tabs', 'List, open, select or close wCLAUDE tabs.', {
  action: z.enum(['list', 'new', 'select', 'close']).default('list'),
  tab: z.number().int().optional().describe('Tab number for select/close.'),
  url: z.string().optional().describe('Address to open with action "new".'),
}, async ({ action, tab, url }) => {
  await ensure();
  await activity('tabs');
  if (action === 'new') {
    const { tab: t } = await api('POST', '/tabs/new', { url: url || '' });
    const page = await pageByTab(t);
    if (url) await settle(page);
    return `Opened tab #${t.id}.\n${await pageLine(page, t)}`;
  }
  if (action === 'select') { await api('POST', '/tabs/select', { id: tab }); }
  if (action === 'close') { await api('POST', '/tabs/close', { id: tab }); }
  const st = await api('GET', '/state');
  const lines = st.tabs.map((t) => `#${t.id}${t.active ? ' [active]' : ''}${t.mobile ? ' [iPhone]' : ''} ${t.title || '(new tab)'} — ${t.url || 'about:blank'}`);
  return `${lines.join('\n')}\nDownloads folder: ${st.downloadsDir}\nSites in iPhone mode: ${st.mobileSites.join(', ') || 'none'}`;
}, { readOnlyHint: false });

tool('browser_navigate', 'Open an address in a tab, or go "back", "forward" or "reload".', {
  url: z.string().describe('Address (https://…, a domain, or "back" / "forward" / "reload").'),
  tab: tabArg,
}, async ({ url, tab }) => {
  const { tab: t, page } = await resolve(tab, 'navigate');
  const opts = { waitUntil: 'domcontentloaded', timeout: 45000 };
  if (url === 'back') await page.goBack(opts);
  else if (url === 'forward') await page.goForward(opts);
  else if (url === 'reload') await page.reload(opts);
  else {
    let target = url.trim();
    if (!/^[a-z][a-z0-9+.-]*:/i.test(target)) target = (/^(localhost|127\.0\.0\.1)/.test(target) ? 'http://' : 'https://') + target;
    await page.goto(target, opts);
  }
  await sleep(500);
  return (await pageLine(page, t)) + dialogNote(page) + (await blockerNote(page));
});

tool('browser_snapshot', 'Accessibility snapshot of the page with element refs to use in other tools. Call it before acting and after the page changes.', {
  tab: tabArg,
  ref: z.string().optional().describe('Only snapshot this element and its content.'),
  max_chars: z.number().int().min(2000).max(200000).default(40000),
}, async ({ tab, ref, max_chars }) => {
  const { tab: t, page } = await resolve(tab, 'read');
  const snap = ref ? await page.locator(`aria-ref=${ref}`).ariaSnapshot({ mode: 'ai' }) : await page.ariaSnapshot({ mode: 'ai' });
  const cut = snap.length > max_chars;
  return `${await pageLine(page, t)}${dialogNote(page)}${await blockerNote(page)}\n\n${cut ? snap.slice(0, max_chars) + `\n… (truncated at ${max_chars} of ${snap.length} characters: pass ref= to read one part, or raise max_chars)` : snap}`;
}, { readOnlyHint: true });

tool('browser_page_text', 'Visible text of the page (or of one element), without refs. Handy for reading articles, tables and results.', {
  tab: tabArg,
  ...target,
  max_chars: z.number().int().min(1000).max(300000).default(30000),
}, async ({ tab, ref, selector, text, max_chars }) => {
  const { tab: t, page } = await resolve(tab, 'read');
  const loc = locate(page, { ref, selector, text });
  const body = loc ? await loc.innerText() : await page.evaluate(() => document.body ? document.body.innerText : '');
  return `${await pageLine(page, t)}\n\n${body.length > max_chars ? body.slice(0, max_chars) + `\n… (truncated, ${body.length} characters)` : body}`;
}, { readOnlyHint: true });

tool('browser_screenshot', 'Screenshot of the visible page, the full page, or one element.', {
  tab: tabArg,
  ref: z.string().optional(),
  full_page: z.boolean().default(false),
  save_to: z.string().optional().describe('Also save the JPEG to this absolute path.'),
}, async ({ tab, ref, full_page, save_to }) => {
  const { tab: t, page } = await resolve(tab, 'screenshot');
  const opts = { type: 'jpeg', quality: 70, scale: 'css', timeout: 20000 };
  const buf = ref ? await page.locator(`aria-ref=${ref}`).screenshot(opts) : await page.screenshot({ ...opts, fullPage: full_page });
  if (save_to) fs.writeFileSync(expandPath(save_to), buf);
  return { content: [{ type: 'image', data: buf.toString('base64'), mimeType: 'image/jpeg' }, { type: 'text', text: await pageLine(page, t) + (save_to ? `\nSaved to ${expandPath(save_to)}` : '') }] };
}, { readOnlyHint: true });

tool('browser_click', 'Click an element (by ref, selector or text) or a point (x, y in CSS pixels).', {
  tab: tabArg,
  ...target,
  x: z.number().optional(),
  y: z.number().optional(),
  double: z.boolean().default(false),
  button: z.enum(['left', 'right', 'middle']).default('left'),
  modifiers: z.array(z.enum(['Alt', 'Control', 'Meta', 'Shift'])).optional(),
}, async ({ tab, ref, selector, text, x, y, double, button, modifiers }) => {
  const { tab: t, page } = await resolve(tab, 'click');
  const loc = locate(page, { ref, selector, text });
  if (loc) {
    // noWaitAfter: a click that starts a download must not wait for a navigation that never comes.
    if (double) await loc.dblclick({ button, modifiers, noWaitAfter: true });
    else await loc.click({ button, modifiers, noWaitAfter: true });
  } else if (x != null && y != null) {
    await page.mouse.click(x, y, { button, clickCount: double ? 2 : 1 });
  } else throw new Error('Give a ref, a selector, a text or x and y.');
  await settle(page);
  return `Clicked.\n${await pageLine(page, t)}${dialogNote(page)}${await blockerNote(page)}`;
});

tool('browser_tap', 'Touch tap on an element or point — for sites in iPhone mode that need real touch events.', {
  tab: tabArg,
  ...target,
  x: z.number().optional(),
  y: z.number().optional(),
}, async ({ tab, ref, selector, text, x, y }) => {
  const { tab: t, page } = await resolve(tab, 'tap');
  const loc = locate(page, { ref, selector, text });
  if (loc) {
    await loc.scrollIntoViewIfNeeded();
    const box = await loc.boundingBox();
    if (!box) throw new Error('The element is not visible.');
    x = box.x + box.width / 2;
    y = box.y + box.height / 2;
  }
  if (x == null || y == null) throw new Error('Give a ref, a selector, a text or x and y.');
  const s = await page.context().newCDPSession(page);
  const point = [{ x, y, radiusX: 4, radiusY: 4, force: 1, id: 1 }];
  await s.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point });
  await s.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await s.detach().catch(() => {});
  await settle(page);
  return `Tapped at ${Math.round(x)}, ${Math.round(y)}.\n${await pageLine(page, t)}`;
});

tool('browser_type', 'Type text into a field (input, textarea, rich editor). Password and payment-card fields are blocked.', {
  tab: tabArg,
  ...target,
  value: z.string().describe('Text to type.'),
  clear: z.boolean().default(true).describe('Replace the current content (default) instead of appending.'),
  slowly: z.boolean().default(false).describe('Type key by key, for fields that react to each keystroke (search suggestions…).'),
  submit: z.boolean().default(false).describe('Press Enter afterwards.'),
}, async ({ tab, ref, selector, text, value, clear, slowly, submit }) => {
  const { tab: t, page } = await resolve(tab, 'type');
  const loc = locate(page, { ref, selector, text });
  if (!loc) throw new Error('Give the field\'s ref, selector or text.');
  await guardField(loc);
  if (slowly || !clear) {
    await loc.click();
    if (clear) await page.keyboard.press('ControlOrMeta+A');
    await loc.pressSequentially(value, { delay: 25 });
  } else {
    await loc.fill(value);
  }
  if (submit) { await loc.press('Enter'); await settle(page); }
  return `Typed ${value.length} characters.${submit ? ' Submitted.' : ''}\n${await pageLine(page, t)}`;
});

tool('browser_press_key', 'Press a key or shortcut in the page (e.g. "Enter", "Escape", "ArrowDown", "Meta+A").', {
  tab: tabArg,
  key: z.string(),
}, async ({ tab, key }) => {
  const { tab: t, page } = await resolve(tab, 'key');
  if (key.length === 1 && (await focusedFieldKind(page))) throw new Error('Typing into password or payment-card fields is blocked. Use browser_keychain_fill for sign-in.');
  await page.keyboard.press(key);
  await settle(page);
  return `Pressed ${key}.\n${await pageLine(page, t)}`;
});

tool('browser_hover', 'Move the mouse over an element (menus, tooltips).', { tab: tabArg, ...target }, async ({ tab, ref, selector, text }) => {
  const { tab: t, page } = await resolve(tab, 'hover');
  const loc = locate(page, { ref, selector, text });
  if (!loc) throw new Error('Give a ref, a selector or a text.');
  await loc.hover();
  return `Hovered.\n${await pageLine(page, t)}`;
});

tool('browser_select_option', 'Choose option(s) in a <select> list.', {
  tab: tabArg,
  ...target,
  values: z.array(z.string()).describe('Option values or labels.'),
}, async ({ tab, ref, selector, text, values }) => {
  const { tab: t, page } = await resolve(tab, 'select');
  const loc = locate(page, { ref, selector, text });
  if (!loc) throw new Error('Give the list\'s ref or selector.');
  const chosen = await loc.selectOption(values);
  return `Selected ${chosen.join(', ')}.\n${await pageLine(page, t)}`;
});

tool('browser_scroll', 'Scroll the page, or scroll an element into view.', {
  tab: tabArg,
  ...target,
  dy: z.number().default(700).describe('Vertical distance in pixels (negative = up).'),
  dx: z.number().default(0),
}, async ({ tab, ref, selector, text, dy, dx }) => {
  const { tab: t, page } = await resolve(tab, 'scroll');
  const loc = locate(page, { ref, selector, text });
  if (loc) await loc.scrollIntoViewIfNeeded();
  else await page.mouse.wheel(dx, dy);
  await sleep(300);
  return `Scrolled.\n${await pageLine(page, t)}`;
});

tool('browser_upload_files', 'Upload local files of any size to the page: into a file input, through the button that opens the file picker, or by dropping them on a drop zone.', {
  tab: tabArg,
  paths: z.array(z.string()).min(1).describe('Absolute paths of local files (~/ allowed).'),
  ...target,
  mode: z.enum(['auto', 'drop']).default('auto').describe('"drop" simulates dropping the files on the element (drag-and-drop zones).'),
}, async ({ tab, paths, ref, selector, text, mode }) => {
  const files = paths.map(expandPath);
  let total = 0;
  for (const f of files) {
    const st = fs.statSync(f, { throwIfNoEntry: false });
    if (!st || !st.isFile()) throw new Error(`File not found: ${f}`);
    total += st.size;
  }
  const { tab: t, page } = await resolve(tab, 'upload');
  const loc = locate(page, { ref, selector, text });
  let how;
  if (loc && mode === 'drop') {
    const input = await page.evaluateHandle(() => {
      const i = document.createElement('input');
      i.type = 'file'; i.multiple = true; i.style.display = 'none'; i.id = '__wclaude_drop';
      document.body.appendChild(i);
      return i;
    });
    await setFiles(page, input.asElement(), files);
    await loc.evaluate((el) => {
      const i = document.getElementById('__wclaude_drop');
      const dt = new DataTransfer();
      for (const f of i.files) dt.items.add(f);
      for (const type of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      i.remove();
    });
    how = 'dropped on the element';
  } else if (loc) {
    const isInput = await loc.evaluate((el) => el instanceof HTMLInputElement && el.type === 'file');
    if (isInput) {
      await setFiles(page, loc, files);
      how = 'set on the file input';
    } else {
      const chooser = page.waitForEvent('filechooser', { timeout: 6000 }).catch(() => null);
      await loc.click();
      const fc = await chooser;
      if (fc) {
        await setFiles(page, fc.element(), files);
        how = 'given to the file picker opened by the element';
      } else {
        const inputs = page.locator('input[type=file]');
        if (!(await inputs.count())) throw new Error('No file picker opened and the page has no file input. Try mode "drop" on the drop zone.');
        await setFiles(page, inputs.last(), files);
        how = 'set on the page\'s file input';
      }
    }
  } else {
    const inputs = page.locator('input[type=file]');
    const n = await inputs.count();
    if (!n) throw new Error('The page has no file input. Give the ref of the upload button or drop zone.');
    await setFiles(page, inputs.first(), files);
    how = n > 1 ? `set on the first of ${n} file inputs` : 'set on the page\'s file input';
  }
  await sleep(800);
  return `${files.length} file(s), ${fmtSize(total)}, ${how}. The site is now handling them: follow the progress with browser_snapshot.\n${await pageLine(page, t)}`;
});

tool('browser_wait_for', 'Wait until a text appears or disappears, an element appears, or a number of seconds passes.', {
  tab: tabArg,
  text: z.string().optional(),
  text_gone: z.string().optional(),
  selector: z.string().optional(),
  seconds: z.number().min(0).max(600).optional().describe('Plain wait, or the time limit for the other conditions (default 30).'),
}, async ({ tab, text, text_gone, selector, seconds }) => {
  const { tab: t, page } = await resolve(tab, 'wait');
  const timeout = (seconds ?? 30) * 1000;
  if (text) await page.getByText(text).first().waitFor({ state: 'visible', timeout });
  else if (text_gone) await page.getByText(text_gone).first().waitFor({ state: 'hidden', timeout });
  else if (selector) await page.locator(selector).first().waitFor({ state: 'visible', timeout });
  else await sleep(timeout);
  return `Done waiting.\n${await pageLine(page, t)}${dialogNote(page)}`;
}, { readOnlyHint: true });

tool('browser_evaluate', 'Run JavaScript in the page and return the result as JSON. An expression, or statements ending with return.', {
  tab: tabArg,
  script: z.string(),
}, async ({ tab, script }) => {
  const { page } = await resolve(tab, 'evaluate');
  // A filled password field must never be read back by the agent: no scripts until the form is gone.
  for (const frame of page.frames()) {
    const filled = await frame.evaluate(() => [...document.querySelectorAll('input[type=password]')].some((i) => i.value)).catch(() => false);
    if (filled) throw new Error('A password field is filled on this page, so scripts are disabled until the form is submitted or left.');
  }
  const body = /\breturn\b/.test(script) ? script : `return (${script});`;
  const result = await page.evaluate(`(async () => { ${body} })()`);
  const json = JSON.stringify(result, null, 2) ?? 'undefined';
  return json.length > 30000 ? json.slice(0, 30000) + '\n… (truncated)' : json;
});

tool('browser_downloads', 'List downloads (saved in wCLAUDE\'s downloads folder), optionally waiting for one to finish.', {
  wait_seconds: z.number().min(0).max(1800).default(0).describe('Wait up to this long for a download to complete.'),
}, async ({ wait_seconds }) => {
  await ensure();
  await activity('downloads');
  const start = Date.now();
  let data = await api('GET', '/downloads');
  if (wait_seconds > 0) {
    // Done when nothing is downloading any more and a download ended recently (or one starts and ends while waiting).
    const recent = (d) => d.endedAt && d.endedAt > start - 60000;
    while (Date.now() - start < wait_seconds * 1000) {
      if (!data.downloads.some((d) => d.state === 'progressing') && data.downloads.some(recent)) break;
      await sleep(1000);
      data = await api('GET', '/downloads');
    }
  }
  const lines = data.downloads.map((d) => `${d.state.padEnd(11)} ${d.path} (${fmtSize(d.received)}${d.total ? ' / ' + fmtSize(d.total) : ''}) from ${d.url}`);
  return `Downloads folder: ${data.dir}\n${lines.join('\n') || 'No downloads yet.'}`;
}, { readOnlyHint: true });

tool('browser_mobile_mode', 'Switch a site to its iPhone version (iPhone user agent, screen size and touch) or back to desktop. The choice is remembered for the site.', {
  enabled: z.boolean(),
  site: z.string().optional().describe('Domain, e.g. instagram.com (default: the site of the tab).'),
  tab: tabArg,
}, async ({ enabled, site, tab }) => {
  const { tab: t, page } = await resolve(tab, 'mobile');
  const res = await api('POST', '/mobile', { id: t.id, site, enabled });
  if (res.error) throw new Error('Open a site in the tab first, or give site.');
  await settle(page);
  return `${res.site} now opens in ${enabled ? 'iPhone' : 'desktop'} mode. Sites in iPhone mode: ${res.mobileSites.join(', ') || 'none'}.`;
});

tool('browser_keychain_fill', 'Fill the sign-in form of the page from the user\'s macOS Keychain. The user approves in a macOS dialog; the password goes straight into the page and is never returned to you. If the form only asks for the account first, call it again on the password step.', {
  account: z.string().optional().describe('Account to use when several are saved for the site.'),
  tab: tabArg,
}, async ({ account, tab }) => {
  const { tab: t } = await resolve(tab, 'keychain');
  const r = await api('POST', '/keychain/fill', { id: t.id, account });
  const msg = {
    filled: `Signed-in form filled for ${r.account} (password entered by wCLAUDE). Now click the sign-in button.`,
    account_only: `Account ${r.account} entered; this step has no password field. Continue to the next step, then call browser_keychain_fill again.`,
    choose: `Several accounts are saved for ${r.site}: ${(r.accounts || []).join(', ')}. Ask the user which one, then call again with account.`,
    no_item: `No sign-in for ${r.site} in the Keychain. Ask the user to add one (wCLAUDE menu File > Add a Sign-in to the Keychain) or to sign in themselves in the wCLAUDE window.`,
    no_field: 'No sign-in field found on this page.',
    no_site: 'The tab shows no website.',
    denied: 'The user did not approve. Do not retry unless they ask.',
    busy: 'Another fill is waiting for the user\'s approval.',
    error: 'The Keychain could not be read.',
  }[r.status] || `Status: ${r.status}`;
  return msg;
});

tool('browser_request_user', 'Hand over to the user and wait: wCLAUDE shows a bar asking them to act in its window (sign in, pass a CAPTCHA, enter a two-factor code, unblock the site…) and returns when they click DONE or Cancel. Write the reason in the user\'s language.', {
  reason: z.string().describe('What the user should do, in their language, e.g. "Connecte-toi à Nexus Mods puis clique sur C\'EST FAIT".'),
  kind: z.enum(['signin', 'captcha', 'blocked', 'other']).default('other'),
  tab: tabArg,
  wait_minutes: z.number().min(1).max(60).default(15),
}, async ({ reason, kind, tab, wait_minutes }) => {
  const { tab: t, page } = await resolve(tab, 'handoff');
  const { id } = await api('POST', '/handoff', { reason, kind, tabId: t.id, agent: agentName });
  const end = Date.now() + wait_minutes * 60000;
  let status = 'waiting';
  while (status === 'waiting' && Date.now() < end) {
    await sleep(1000);
    status = (await api('GET', `/handoff?id=${id}`)).status;
  }
  if (status === 'waiting') {
    await api('POST', '/handoff/cancel', { id }).catch(() => {});
    return `The user did not answer within ${wait_minutes} minutes. Ask them in the chat before trying again.`;
  }
  if (status === 'cancelled') return 'The user cancelled. Do not retry this step unless they ask.';
  await settle(page);
  return `The user is done.\n${await pageLine(page, t)}${await blockerNote(page)}`;
});

tool('browser_handle_dialog', 'Accept or dismiss the JavaScript dialog (alert, confirm, prompt, leave-page) open in a tab.', {
  accept: z.boolean(),
  prompt_text: z.string().optional(),
  tab: tabArg,
}, async ({ accept, prompt_text, tab }) => {
  const { page } = await resolve(tab, 'dialog');
  const d = dialogs.get(page);
  if (!d) return 'No dialog is open.';
  dialogs.delete(page);
  if (accept) await d.accept(prompt_text); else await d.dismiss();
  return `Dialog ${accept ? 'accepted' : 'dismissed'}.`;
});

tool('browser_console', 'Recent console messages and page errors of a tab (for debugging).', {
  tab: tabArg,
  clear: z.boolean().default(false),
}, async ({ tab, clear }) => {
  const { page } = await resolve(tab, 'console');
  const logs = consoleLogs.get(page) || [];
  const out = logs.slice(-100).join('\n') || 'No console messages since the agent connected to this tab.';
  if (clear) logs.length = 0;
  return out;
}, { readOnlyHint: true });

// ---------------------------------------------------------------- YouTube (official API)
// The OAuth key and tokens stay in the user's Keychain, inside wCLAUDE; the agent only gets API results.
async function yt(method, route, body, action = 'youtube') {
  await ensureApp();
  await activity(action);
  return api(method, route, body);
}
const NOT_READY = 'YouTube is not connected yet. Ask the user to open wCLAUDE › Settings › YouTube, choose their OAuth key file and click Connect YouTube (or call youtube_connect once the key is saved).';
const RECONNECT = 'The YouTube connection lacks a permission this action needs (it was made before subtitles were supported). Ask the user to reconnect once: wCLAUDE › Settings › YouTube › Reconnect YouTube, or call youtube_connect (the user approves in their usual browser).';
const ytError = (e) => {
  const m = String(e.message);
  if (/not_connected|no_client/.test(m)) throw new Error(NOT_READY);
  if (/reconnect_needed/.test(m)) throw new Error(RECONNECT);
  throw e;
};
const qs = (o) => new URLSearchParams(Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''))).toString();

tool('youtube_status', 'Whether the YouTube API is set up in wCLAUDE (OAuth key saved, channel connected).', {}, async () => {
  const s = await yt('GET', '/youtube/status');
  if (!s.clientConfigured) return 'No OAuth key yet. ' + NOT_READY;
  if (!s.connected) return 'OAuth key saved, channel not connected: call youtube_connect (the user approves in their usual browser).';
  const line = `Connected to the channel ${s.channel ? `"${s.channel.title}" (${s.channel.id})` : ''}.`;
  return s.needsReconnect ? `${line} ${RECONNECT}` : line;
}, { readOnlyHint: true });

tool('youtube_connect', 'Connect the user\'s YouTube channel: opens Google\'s consent page in the user\'s usual browser and waits (up to 5 minutes) for them to approve.', {}, async () => {
  const s = await yt('POST', '/youtube/connect').catch(ytError);
  return s.connected ? `Connected to "${s.channel && s.channel.title}".` : 'Not connected.';
});

tool('youtube_channel', 'The connected channel: name, subscribers, total views and video count.', {}, async () => {
  return JSON.stringify(await yt('GET', '/youtube/channel').catch(ytError), null, 2);
}, { readOnlyHint: true });

tool('youtube_list_videos', 'The channel\'s videos, newest first, with privacy, scheduled date, views, likes and comments.', {
  max_results: z.number().int().min(1).max(50).default(25),
  page_token: z.string().optional(),
}, async ({ max_results, page_token }) => {
  return JSON.stringify(await yt('GET', `/youtube/videos?${qs({ max: max_results, pageToken: page_token })}`).catch(ytError), null, 2);
}, { readOnlyHint: true });

tool('youtube_get_video', 'One video in detail: title, description, tags, category, privacy, schedule, processing, statistics.', {
  video_id: z.string(),
}, async ({ video_id }) => {
  return JSON.stringify(await yt('GET', `/youtube/video?${qs({ id: video_id })}`).catch(ytError), null, 2);
}, { readOnlyHint: true });

tool('youtube_update_video', 'Change a video\'s title, description, tags, category, privacy or scheduled publication. This changes public content: get the user\'s approval first.', {
  video_id: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  category_id: z.string().optional().describe('e.g. "20" Gaming, "24" Entertainment.'),
  privacy: z.enum(['private', 'unlisted', 'public']).optional(),
  publish_at: z.string().optional().describe('ISO 8601 date to publish automatically (the video stays private until then); empty string clears it.'),
}, async ({ video_id, title, description, tags, category_id, privacy, publish_at }) => {
  const v = await yt('POST', '/youtube/video', { id: video_id, title, description, tags, categoryId: category_id, privacy, publishAt: publish_at }).catch(ytError);
  return `Updated.\n${JSON.stringify(v, null, 2)}`;
});

tool('youtube_upload_video', 'Upload a local video file of any size to the channel (resumable, in the background). Private by default: get the user\'s approval before making anything public or scheduled. Returns a job id for youtube_upload_status.', {
  path: z.string().describe('Absolute path of the video file (~/ allowed).'),
  title: z.string().max(100),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  category_id: z.string().default('20'),
  privacy: z.enum(['private', 'unlisted', 'public']).default('private'),
  publish_at: z.string().optional().describe('ISO 8601 date for a scheduled publication.'),
  made_for_kids: z.boolean().default(false),
  notify_subscribers: z.boolean().default(false),
}, async (a) => {
  const file = expandPath(a.path);
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
  const job = await yt('POST', '/youtube/upload', { path: file, title: a.title, description: a.description, tags: a.tags, categoryId: a.category_id, privacy: a.privacy, publishAt: a.publish_at, madeForKids: a.made_for_kids, notifySubscribers: a.notify_subscribers }, 'upload').catch(ytError);
  if (job.error) throw new Error(job.error);
  return `Upload started: job ${job.id}, ${fmtSize(job.size)}. Follow it with youtube_upload_status.`;
});

tool('youtube_upload_status', 'Progress of a video upload; can wait for it to finish.', {
  job_id: z.number().int(),
  wait_seconds: z.number().min(0).max(1800).default(0),
}, async ({ job_id, wait_seconds }) => {
  const end = Date.now() + wait_seconds * 1000;
  let j = await yt('GET', `/youtube/upload?id=${job_id}`);
  while ((j.state === 'uploading' || j.state === 'starting') && Date.now() < end) {
    await sleep(2000);
    j = await api('GET', `/youtube/upload?id=${job_id}`);
  }
  if (j.error && !j.state) throw new Error('No such upload job.');
  const pct = j.size ? Math.floor((j.sent / j.size) * 100) : 0;
  if (j.state === 'done') return `Uploaded: ${j.url} (video id ${j.videoId}). YouTube now processes it; check with youtube_get_video.`;
  if (j.state === 'error') return `Upload failed: ${j.error}`;
  return `Uploading ${j.name}: ${pct}% (${fmtSize(j.sent)} of ${fmtSize(j.size)}).`;
}, { readOnlyHint: true });

tool('youtube_set_thumbnail', 'Set a video\'s custom thumbnail from a local JPEG or PNG (2 MB max). Changes public content: get the user\'s approval first.', {
  video_id: z.string(),
  path: z.string(),
}, async ({ video_id, path: p }) => {
  await yt('POST', '/youtube/thumbnail', { id: video_id, path: expandPath(p) }).catch(ytError);
  return 'Thumbnail set.';
});

tool('youtube_list_captions', 'The subtitle tracks of a video: id, language, name, kind (standard, or asr for automatic captions), draft, status.', {
  video_id: z.string(),
}, async ({ video_id }) => {
  const list = await yt('GET', `/youtube/captions?${qs({ videoId: video_id })}`).catch(ytError);
  return list.length ? JSON.stringify(list, null, 2) : 'No subtitle tracks.';
}, { readOnlyHint: true });

tool('youtube_upload_caption', 'Add a subtitle track to a video from a local file (SRT, VTT, SBV, SCC, TTML; UTF-8). Visible to viewers unless draft: get the user\'s approval first. YouTube refuses two tracks with the same language and name: set replace to update the existing one. Costs 400 quota units (450 when replacing).', {
  video_id: z.string(),
  path: z.string().describe('Local subtitle file.'),
  language: z.string().describe('BCP-47 language code of the subtitles, e.g. "en", "fr", "pt-BR".'),
  name: z.string().optional().describe('Track name shown to viewers; empty (default) for the main track of that language.'),
  draft: z.boolean().optional().describe('Upload as a draft, hidden from viewers. Default false.'),
  replace: z.boolean().optional().describe('Replace a track with the same language and name instead of failing. Default false.'),
}, async (a) => {
  const c = await yt('POST', '/youtube/caption', { videoId: a.video_id, path: expandPath(a.path), language: a.language, name: a.name, draft: a.draft, replace: a.replace }).catch(ytError);
  return `${c.replaced ? 'Replaced' : 'Added'} subtitle track ${c.id} (${c.language}${c.name ? `, "${c.name}"` : ''}${c.draft ? ', draft' : ''}). YouTube processes it in a few minutes; check with youtube_list_captions.`;
});

tool('youtube_analytics', 'Channel or video statistics from YouTube Analytics for a date range (views, watch time, average view duration, likes, subscribers gained…).', {
  start_date: z.string().describe('YYYY-MM-DD'),
  end_date: z.string().describe('YYYY-MM-DD'),
  metrics: z.string().optional().describe('Comma-separated, default views,estimatedMinutesWatched,averageViewDuration,likes,subscribersGained.'),
  dimensions: z.string().optional().describe('e.g. "day", "video", "country".'),
  video_id: z.string().optional(),
  sort: z.string().optional().describe('e.g. "-views".'),
  max_results: z.number().int().optional(),
}, async (a) => {
  const r = await yt('GET', `/youtube/analytics?${qs({ startDate: a.start_date, endDate: a.end_date, metrics: a.metrics, dimensions: a.dimensions, videoId: a.video_id, sort: a.sort, maxResults: a.max_results })}`).catch(ytError);
  const head = (r.columnHeaders || []).map((c) => c.name);
  const rows = (r.rows || []).map((row) => row.join('\t'));
  return [head.join('\t'), ...rows].join('\n') || 'No data for this period.';
}, { readOnlyHint: true });

// ---------------------------------------------------------------- Watch (deterministic page / feed / release monitoring)
// wCLAUDE checks the sources while no agent is around; agents read the digest when they come back. No AI in the app.
async function wapi(method, route, body) {
  await ensureApp();
  await activity('watch');
  return api(method, route, body);
}
const fmtAt = (ms) => (ms ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(ms)).replace(',', '') : 'never');
const fmtHour = (ms) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
const KIND_NAME = { page: 'page', feed: 'RSS/Atom feed', github: 'GitHub releases', version: 'version number on a page' };
const REASON = { challenge: 'anti-bot check or CAPTCHA', signin: 'sign-in wall' };

function itemLine(it, src, { lines = true } = {}) {
  const what = it.kind === 'version' ? `version ${it.from ? `${it.from} → ` : ''}${it.to}`
    : it.kind === 'entry' ? `new entry: ${it.title}`
    : `page changed (${it.count || it.lines.length} line${(it.count || it.lines.length) === 1 ? '' : 's'})`;
  const out = [`[${it.id}] ${src ? src.name : '?'} · ${what} · ${fmtAt(it.at)}${it.read ? ' · read' : ''}`];
  out.push(`     ${it.url || (src && src.url) || ''}`);
  if (lines) {
    if (it.kind === 'version' && it.title && it.title !== it.to) out.push(`     ${it.title}`);
    for (const l of (it.lines || []).slice(0, 12)) out.push(`     + ${l}`);
    if ((it.count || 0) > (it.lines || []).length) out.push(`     … ${it.count - it.lines.length} more added lines`);
  }
  return out.join('\n');
}

tool('watch_digest', 'What changed in the user\'s watched sources (pages, RSS feeds, GitHub releases) since they were last marked read: unread items grouped by group, with the group brief, each source\'s note for you (what matters), the link and the added lines; then sources that need the user or failed. Read it when you start working, then mark items read with watch_read.', {
  include_read: z.boolean().optional().describe('Also list the 10 most recent read items.'),
}, async ({ include_read }) => {
  const d = await wapi('GET', '/watch/digest');
  const srcById = new Map(d.sources.map((s) => [s.id, s]));
  const unread = d.items.filter((i) => !i.read).reverse();
  const head = `watch_digest · ${unread.length} unread · ${d.sources.length} source${d.sources.length === 1 ? '' : 's'} · last pass ${fmtAt(d.lastPass)}${d.running ? ' · checking now' : ''}`;
  if (!d.sources.length) return `${head}\n\nNo sources yet. Add one with watch_add (url, name, group, note).`;
  const out = [head];
  const groups = new Map();
  for (const it of unread) {
    const src = srcById.get(it.sourceId);
    const g = (src && src.group) || '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(it);
  }
  for (const [g, items] of groups) {
    const brief = (d.groups.find((x) => x.name === g) || {}).brief;
    out.push('', `## ${g || 'No group'}${brief ? `  (brief: ${brief})` : ''}`);
    const notes = new Set();
    for (const it of items) {
      const src = srcById.get(it.sourceId);
      out.push(itemLine(it, src));
      if (src && src.note && !notes.has(src.id)) { out.push(`     note: ${src.note}`); notes.add(src.id); }
    }
  }
  if (!unread.length) out.push('', 'No unread items.');
  const needs = d.sources.filter((s) => s.status === 'needs_user' || (s.reason && s.status !== 'error'));
  const failed = d.sources.filter((s) => s.status === 'error');
  if (needs.length) out.push('', `Needs the user: ${needs.map((s) => `${s.name} (${REASON[s.reason] || 'needs the user'})`).join(', ')} → open the page in a tab and call browser_request_user, then watch_check.`);
  if (failed.length) out.push('', `Failed: ${failed.map((s) => `${s.name} (${s.error}${s.nextCheck ? `, retry ${fmtHour(s.nextCheck)}` : ''})`).join(', ')}`);
  if (include_read) {
    const read = d.items.filter((i) => i.read).slice(0, 10);
    if (read.length) out.push('', '## Recently read', ...read.map((it) => itemLine(it, srcById.get(it.sourceId), { lines: false })));
  }
  if (unread.length) out.push('', `After reading: watch_read {"ids":[${unread.map((i) => i.id).join(',')}]}`);
  return out.join('\n');
}, { readOnlyHint: true });

tool('watch_list', 'The watched sources: id, name, group, type, how often they are checked, state (ok, new, needs_user, error, paused, pending), last check, unread count and note.', {}, async () => {
  const d = await wapi('GET', '/watch/digest');
  if (!d.sources.length) return 'No sources yet. Add one with watch_add.';
  const lines = d.sources.map((s) => `${s.id} · ${s.name}${s.group ? ` [${s.group}]` : ''} · ${KIND_NAME[s.kind] || s.kind} · every ${s.everyHours} h · ${s.status}${s.status === 'error' ? ` (${s.error})` : ''}${s.status === 'needs_user' ? ` (${REASON[s.reason] || ''})` : ''} · last check ${fmtAt(s.lastCheck)} · ${s.unread} unread${s.version ? ` · version ${s.version}` : ''}\n   ${s.url}${s.selector ? `\n   area: ${s.selector}` : ''}${s.keywords.length ? `\n   keywords: ${s.keywords.join(', ')}` : ''}${s.note ? `\n   note: ${s.note}` : ''}`);
  const briefs = d.groups.filter((g) => g.brief).map((g) => `${g.name}: ${g.brief}`);
  return `${lines.join('\n')}${briefs.length ? `\n\nGroup briefs:\n${briefs.join('\n')}` : ''}\nData file: ${d.file}`;
}, { readOnlyHint: true });

tool('watch_add', 'Add a source to watch, or update the one with the same address. The type is detected (GitHub releases, RSS/Atom feed announced by the page, otherwise the page text); the first reading is the reference and raises no alert. Pages are read in a hidden wCLAUDE view with the user\'s sessions; sign-in walls and anti-bot checks are never bypassed. Write the note in the user\'s language.', {
  url: z.string().describe('Address of the page, feed or GitHub repository.'),
  name: z.string().optional().describe('Short name shown in lists.'),
  group: z.string().optional().describe('Group name, e.g. "Rendering".'),
  group_brief: z.string().optional().describe('Brief shared by the whole group (what matters for these sources).'),
  every_hours: z.union([z.literal(1), z.literal(6), z.literal(24), z.literal(168)]).optional().describe('Check every 1, 6, 24 or 168 hours (default 24).'),
  selector: z.string().optional().describe('CSS selector of the page area to watch (e.g. "main article"), to avoid noise.'),
  keywords: z.array(z.string()).optional().describe('Only alert when one of these words appears in what was added.'),
  note: z.string().optional().describe('Note for the agent reading the digest: what matters, what to ignore.'),
  kind: z.enum(['page', 'version']).optional().describe('Force "page" (text changes) or "version" (highest version number on the page) instead of auto-detection.'),
}, async (a) => {
  const s = await wapi('POST', '/watch/add', { url: a.url, name: a.name, group: a.group, groupBrief: a.group_brief, everyHours: a.every_hours, selector: a.selector, keywords: a.keywords, note: a.note, kind: a.kind });
  return `Watching "${s.name}" (${s.id}) as ${KIND_NAME[s.kind] || s.kind}, every ${s.everyHours} h${s.group ? `, group ${s.group}` : ''}. The first reading is the reference (no alert). Check it now with watch_check {"id":"${s.id}"}.`;
});

tool('watch_check', 'Check one source (id) or all enabled sources now and wait for the result (a page takes a few seconds). New items appear in watch_digest.', {
  id: z.string().optional().describe('Source id from watch_list; omit to check all sources.'),
}, async ({ id }) => {
  const list = await wapi('POST', '/watch/check', { id, wait: true });
  return list.map((s) => `${s.name}: ${s.status}${s.status === 'error' ? ` (${s.error})` : ''}${s.status === 'needs_user' ? ` (${REASON[s.reason] || 'needs the user'} → browser_request_user)` : ''}${s.unread ? ` · ${s.unread} unread` : ''}${s.version ? ` · version ${s.version}` : ''}`).join('\n') + '\nRead the news with watch_digest.';
});

tool('watch_history', 'Recent items of one source, read or not, newest first.', {
  id: z.string().describe('Source id from watch_list.'),
  limit: z.number().int().min(1).max(50).optional(),
}, async ({ id, limit }) => {
  const h = await wapi('GET', `/watch/history?${new URLSearchParams({ id, limit: String(limit || 20) })}`);
  if (!h.items.length) return `${h.source.name}: no items yet (state ${h.source.status}, last check ${fmtAt(h.source.lastCheck)}).`;
  return `${h.source.name} · ${h.source.url}\n${h.items.map((it) => itemLine(it, h.source)).join('\n')}`;
}, { readOnlyHint: true });

tool('watch_read', 'Mark watch items as read (ids from watch_digest), or "all".', {
  ids: z.union([z.array(z.number().int()), z.literal('all')]),
}, async ({ ids }) => {
  const r = await wapi('POST', '/watch/read', { ids });
  return `${r.marked} item${r.marked === 1 ? '' : 's'} marked read.`;
});

const transport = new StdioServerTransport();
await server.connect(transport);
