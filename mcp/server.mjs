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
  return `Tab #${tab.id}${tab.mobile ? ' (iPhone mode)' : ''}: ${title || '(no title)'} — ${page.url()}`;
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
      'Ask the user before publishing, posting, sending a message, buying, accepting terms or deleting anything. Never try to solve CAPTCHAs: ask the user to do it in the wCLAUDE window.',
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
  return (await pageLine(page, t)) + dialogNote(page);
});

tool('browser_snapshot', 'Accessibility snapshot of the page with element refs to use in other tools. Call it before acting and after the page changes.', {
  tab: tabArg,
  ref: z.string().optional().describe('Only snapshot this element and its content.'),
  max_chars: z.number().int().min(2000).max(200000).default(40000),
}, async ({ tab, ref, max_chars }) => {
  const { tab: t, page } = await resolve(tab, 'read');
  const snap = ref ? await page.locator(`aria-ref=${ref}`).ariaSnapshot({ mode: 'ai' }) : await page.ariaSnapshot({ mode: 'ai' });
  const cut = snap.length > max_chars;
  return `${await pageLine(page, t)}${dialogNote(page)}\n\n${cut ? snap.slice(0, max_chars) + `\n… (truncated at ${max_chars} of ${snap.length} characters: pass ref= to read one part, or raise max_chars)` : snap}`;
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
  return `Clicked.\n${await pageLine(page, t)}${dialogNote(page)}`;
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

const transport = new StdioServerTransport();
await server.connect(transport);
