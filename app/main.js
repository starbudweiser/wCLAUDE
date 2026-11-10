// wCLAUDE — navigateur pilotable par un agent IA (MCP), interface Socle.
const {
  app, BrowserWindow, WebContentsView, Menu, ipcMain, session, shell, screen, clipboard, nativeTheme, Notification, dialog,
} = require('electron');
const path = require('path');
const fs = require('fs');
const config = require('./lib/config');
const i18n = require('./lib/i18n');
const keychain = require('./lib/keychain');
const updater = require('./lib/updater');
const control = require('./lib/control');
const youtube = require('./lib/youtube');
const presence = require('./lib/presence');
const autostart = require('./lib/autostart');
const pkg = require('../package.json');

const UI = path.join(__dirname, 'ui');
const { pathToFileURL } = require('url');
const NEWTAB_BASE = pathToFileURL(path.join(UI, 'newtab.html')).href;
let NEWTAB = NEWTAB_BASE; // complété après le choix de la langue (textes passés dans l'adresse)
const isNewTab = (url) => String(url || '').startsWith(NEWTAB_BASE);
const CHROME_UA = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
const IPHONE = { width: 390, height: 844, scale: 3 };
let TOOLBAR_H = 92; // rangée des onglets (40) + barre de navigation (52) + barre du relais quand elle est affichée (mesurée par la page)
const BACKGROUND = process.argv.includes('--background');

// ---------- avant le démarrage ----------
// Dossier de données d'abord : le verrou « une seule instance » en dépend (une édition d'essai a le sien).
app.setName('wCLAUDE');
app.setPath('userData', config.SUPPORT_DIR);
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.userAgentFallback = CHROME_UA;
const AGENT_CONTROL = config.get('agentControl') !== false;
const CDP_PORT = Number(process.env.WCLAUDE_CDP_PORT || config.get('cdpPort') || 9333);
if (AGENT_CONTROL) {
  app.commandLine.appendSwitch('remote-debugging-port', String(CDP_PORT));
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
}
// Une fenêtre cachée derrière d'autres applis continue d'afficher et d'agir : l'agent peut travailler en arrière-plan.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

// ---------- état ----------
let win = null;
const tabs = [];
let activeId = null;
let nextTabId = 1;
let fullscreen = false;
const downloads = [];
let nextDownloadId = 1;
let notice = null;
let noticeTimer = null;
const agent = { label: '', name: '', at: 0, tabId: null };
let pushQueued = false;
// Relais humain : l'agent attend que l'utilisateur agisse lui-même dans la fenêtre (connexion, CAPTCHA, blocage…).
let handoff = null; // { id, reason, kind, agent, tabId, at, status: waiting | done | cancelled }
let nextHandoffId = 1;

const t = (k, v) => i18n.t(k, v);
const tabById = (id) => tabs.find((x) => x.id === Number(id));
const tabByWc = (wc) => tabs.find((x) => x.wc === wc || x.wc.id === (wc && wc.id));
const activeTab = () => tabById(activeId);
const isBusy = () => Date.now() - agent.at < 120000 || downloads.some((d) => d.state === 'progressing') || (handoff && handoff.status === 'waiting') || youtube.uploading();

// ---------- barre d'outils ----------
function publicTab(tab) {
  const url = tab.wc.isDestroyed() ? '' : tab.wc.getURL();
  return {
    id: tab.id,
    targetId: tab.targetId,
    url: isNewTab(url) ? '' : url,
    title: tab.title || '',
    favicon: tab.favicon || '',
    loading: tab.loading,
    mobile: tab.mobile,
    active: tab.id === activeId,
    canBack: !tab.wc.isDestroyed() && tab.wc.navigationHistory.canGoBack(),
    canForward: !tab.wc.isDestroyed() && tab.wc.navigationHistory.canGoForward(),
  };
}

function pushState() {
  if (pushQueued) return;
  pushQueued = true;
  setImmediate(() => {
    pushQueued = false;
    if (!win || win.isDestroyed()) return;
    const tab = activeTab();
    const site = tab ? config.registrableDomain(config.hostOf(tab.wc.getURL())) : '';
    win.webContents.send('state', {
      tabs: tabs.map(publicTab),
      activeId,
      site,
      mobile: tab ? tab.mobile : false,
      fullscreen,
      downloads: {
        active: downloads.filter((d) => d.state === 'progressing').length,
        count: downloads.length,
      },
      agent: { label: agent.label, name: agent.name || t('agent.generic'), at: agent.at, tabId: agent.tabId },
      notice,
      handoff: handoff && handoff.status === 'waiting' ? { id: handoff.id, reason: handoff.reason, kind: handoff.kind, agent: handoff.agent || t('agent.generic') } : null,
    });
  });
}

function showNotice(text, kind = 'help', action = null) {
  notice = { text, kind, action, at: Date.now() };
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice = null; pushState(); }, action ? 15000 : 6000);
  pushState();
}

// ---------- disposition ----------
function layout() {
  if (!win || win.isDestroyed()) return;
  const [w, h] = win.getContentSize();
  for (const tab of tabs) {
    if (tab.id !== activeId) {
      tab.view.setVisible(false);
      continue;
    }
    tab.view.setVisible(true);
    if (fullscreen) tab.view.setBounds({ x: 0, y: 0, width: w, height: h });
    else if (tab.mobile) {
      const vw = Math.min(IPHONE.width, w);
      tab.view.setBounds({ x: Math.round((w - vw) / 2), y: TOOLBAR_H, width: vw, height: Math.max(0, h - TOOLBAR_H) });
      const size = mobileSize(tab);
      if (tab.wc.debugger.isAttached() && (size.width !== tab.lastW || size.height !== tab.lastH)) {
        tab.lastW = size.width; tab.lastH = size.height;
        tab.wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: IPHONE.scale, mobile: true, screenWidth: IPHONE.width, screenHeight: IPHONE.height }).catch(() => {});
      }
    } else tab.view.setBounds({ x: 0, y: TOOLBAR_H, width: w, height: Math.max(0, h - TOOLBAR_H) });
  }
}

// ---------- version iPhone ----------
function mobileSize(tab) {
  const b = tab.view.getBounds();
  return { width: Math.max(1, b.width || IPHONE.width), height: Math.max(1, b.height || IPHONE.height) };
}

const IPHONE_PLATFORM = "Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'iPhone', configurable: true });";

async function applyEmulation(tab) {
  const d = tab.wc.debugger;
  if (!d.isAttached()) return;
  try {
    if (tab.mobile) {
      const { width, height } = mobileSize(tab);
      await d.sendCommand('Emulation.setUserAgentOverride', { userAgent: IPHONE_UA, platform: 'iPhone' });
      await d.sendCommand('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: IPHONE.scale, mobile: true,
        screenWidth: IPHONE.width, screenHeight: IPHONE.height,
      });
      await d.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await d.sendCommand('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
      if (!tab.platformScript) {
        tab.platformScript = (await d.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: IPHONE_PLATFORM })).identifier;
      }
    } else {
      await d.sendCommand('Emulation.setUserAgentOverride', { userAgent: CHROME_UA, platform: 'MacIntel' });
      await d.sendCommand('Emulation.clearDeviceMetricsOverride');
      await d.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: false });
      await d.sendCommand('Emulation.setEmitTouchEventsForMouse', { enabled: false });
      if (tab.platformScript) {
        await d.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: tab.platformScript });
        tab.platformScript = null;
      }
    }
  } catch { /* onglet fermé entre-temps */ }
}

async function setMobile(tab, mobile, { reload = false } = {}) {
  const changed = tab.mobile !== mobile;
  tab.mobile = mobile;
  tab.lastW = tab.lastH = 0;
  if (changed) layout();
  await applyEmulation(tab);
  if (changed && reload && !tab.wc.isDestroyed()) tab.wc.reload();
  pushState();
}

async function setMobileSite(site, enabled) {
  if (!site) return;
  config.setMobileSite(site, enabled);
  for (const tab of tabs) {
    const url = tab.wc.getURL();
    if (config.registrableDomain(config.hostOf(url)) === site || config.hostOf(url).endsWith('.' + site)) {
      await setMobile(tab, enabled, { reload: true });
    }
  }
  pushState();
}

// ---------- onglets ----------
function toUrl(text) {
  text = String(text || '').trim();
  if (!text) return null;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(text)) return 'http://' + text;
  if (/^(https?|file|about|data|chrome):/i.test(text)) return text;
  if (!/\s/.test(text) && /^[^\s/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(text)) return 'https://' + text;
  return 'https://www.google.com/search?q=' + encodeURIComponent(text);
}

async function attachDebugger(tab) {
  try {
    tab.wc.debugger.attach('1.3');
    const { targetInfo } = await tab.wc.debugger.sendCommand('Target.getTargetInfo');
    await tab.wc.debugger.sendCommand('Page.enable');
    tab.targetId = targetInfo.targetId;
  } catch { /* outils de développement déjà ouverts sur cet onglet */ }
}

function createTab(url, { activate = true, webContents = null } = {}) {
  ensureWindow();
  const view = webContents
    ? new WebContentsView({ webContents })
    : new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, spellcheck: true } });
  const tab = { id: nextTabId++, view, wc: view.webContents, mobile: false, title: '', favicon: '', loading: false, targetId: null };
  tabs.push(tab);
  win.contentView.addChildView(view);
  const wc = tab.wc;

  wc.on('page-title-updated', (_e, title) => { tab.title = title; pushState(); });
  wc.on('page-favicon-updated', (_e, icons) => { tab.favicon = icons[0] || ''; pushState(); });
  wc.on('did-start-loading', () => { tab.loading = true; pushState(); });
  wc.on('did-stop-loading', () => { tab.loading = false; pushState(); });
  wc.on('did-navigate', () => { tab.favicon = ''; pushState(); });
  wc.on('did-navigate-in-page', () => pushState());
  wc.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    const want = config.isMobileUrl(details.url);
    if (want !== tab.mobile) setMobile(tab, want);
  });
  wc.on('enter-html-full-screen', () => { fullscreen = true; win.setFullScreen(true); layout(); pushState(); });
  wc.on('leave-html-full-screen', () => { fullscreen = false; win.setFullScreen(false); layout(); pushState(); });
  wc.on('context-menu', (_e, params) => contextMenu(tab, params));
  wc.setWindowOpenHandler(({ url, disposition }) => {
    // Les fenêtres ouvertes par la page (connexion, partage…) deviennent des onglets et gardent leur lien avec elle.
    return {
      action: 'allow',
      createWindow: (options) => {
        const child = createTab(null, { activate: disposition !== 'background-tab', webContents: options.webContents });
        return child.wc;
      },
      outlivesOpener: true,
    };
  });

  tab.ready = attachDebugger(tab).then(() => applyEmulation(tab));
  if (url !== null) wc.loadURL(url || NEWTAB).catch(() => {});
  if (activate) selectTab(tab.id);
  else layout();
  pushState();
  return tab;
}

function selectTab(id) {
  const tab = tabById(id);
  if (!tab) return;
  activeId = tab.id;
  layout();
  pushState();
}

function closeTab(id) {
  const i = tabs.findIndex((x) => x.id === Number(id));
  if (i < 0) return;
  const [tab] = tabs.splice(i, 1);
  if (win && !win.isDestroyed()) win.contentView.removeChildView(tab.view);
  if (!tab.wc.isDestroyed()) tab.wc.close();
  if (activeId === tab.id) activeId = tabs.length ? tabs[Math.min(i, tabs.length - 1)].id : null;
  if (!tabs.length && win && !win.isDestroyed()) createTab('');
  layout();
  pushState();
}

function cycleTab(dir) {
  if (tabs.length < 2) return;
  const i = tabs.findIndex((x) => x.id === activeId);
  selectTab(tabs[(i + dir + tabs.length) % tabs.length].id);
}

function contextMenu(tab, p) {
  const items = [];
  if (p.linkURL) {
    items.push({ label: t('ctx.openLinkInTab'), click: () => createTab(p.linkURL, { activate: false }) });
    items.push({ label: t('ctx.copyLink'), click: () => clipboard.writeText(p.linkURL) });
    items.push({ type: 'separator' });
  }
  if (p.mediaType === 'image') {
    items.push({ label: t('ctx.copyImage'), click: () => tab.wc.copyImageAt(p.x, p.y) });
    items.push({ type: 'separator' });
  }
  if (p.isEditable) {
    items.push({ label: t('ctx.cut'), role: 'cut', enabled: p.editFlags.canCut });
    items.push({ label: t('ctx.copy'), role: 'copy', enabled: p.editFlags.canCopy });
    items.push({ label: t('ctx.paste'), role: 'paste', enabled: p.editFlags.canPaste });
    items.push({ label: t('ctx.selectAll'), role: 'selectAll' });
    items.push({ type: 'separator' });
  } else if (p.selectionText) {
    items.push({ label: t('ctx.copy'), role: 'copy' });
    items.push({ type: 'separator' });
  }
  const h = tab.wc.navigationHistory;
  items.push({ label: t('ctx.back'), enabled: h.canGoBack(), click: () => h.goBack() });
  items.push({ label: t('ctx.forward'), enabled: h.canGoForward(), click: () => h.goForward() });
  items.push({ label: t('ctx.reload'), click: () => tab.wc.reload() });
  items.push({ type: 'separator' });
  items.push({ label: t('ctx.inspect'), click: () => tab.wc.inspectElement(p.x, p.y) });
  Menu.buildFromTemplate(items).popup({ window: win });
}

// ---------- fenêtre principale ----------
let shownOnce = false; // la fenêtre a déjà été affichée une fois depuis le lancement
// quiet : fenêtre recréée pour un agent (ou appli lancée par lui) : elle reste cachée, l'agent travaille sans
// rien faire passer devant le travail de l'utilisateur ; elle s'ouvre d'un clic sur l'icône (barre de menus ou Dock).
function ensureWindow({ quiet = false } = {}) {
  if (win && !win.isDestroyed()) return win;
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const saved = config.get('windowSize') || { width: 1360, height: 900 };
  const width = Math.min(saved.width, area.width);
  const height = Math.min(saved.height, area.height);
  win = new BrowserWindow({
    width, height,
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    minWidth: 760, minHeight: 480,
    show: false,
    title: 'wCLAUDE',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 13 },
    backgroundColor: '#1e1e1e',
    webPreferences: { preload: path.join(UI, 'preload.js'), sandbox: true, contextIsolation: true },
  });
  win.loadFile(path.join(UI, 'toolbar.html'));
  const hidden = quiet || (BACKGROUND && !shownOnce);
  win.once('ready-to-show', () => { if (!hidden) win.show(); });
  win.once('show', () => { shownOnce = true; });
  let sizeTimer;
  win.on('resize', () => {
    layout();
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(() => {
      if (win && !win.isDestroyed() && !win.isFullScreen()) {
        const [w, h] = win.getSize();
        config.set('windowSize', { width: w, height: h });
      }
    }, 500);
  });
  win.on('close', () => saveTabs());
  win.on('closed', () => {
    for (const tab of tabs.splice(0)) if (!tab.wc.isDestroyed()) tab.wc.close();
    activeId = null;
    win = null;
  });
  return win;
}

function saveTabs() {
  const urls = tabs.map((x) => x.wc.getURL()).filter((u) => u && !isNewTab(u) && /^https?:/.test(u));
  config.set('lastTabs', urls);
}

function openStartTabs() {
  const urls = config.get('lastTabs') || [];
  if (urls.length) urls.forEach((u, i) => createTab(u, { activate: i === 0 }));
  else createTab('');
}

/** Amène la fenêtre principale devant (la recrée si elle a été fermée, la rouvre si elle est masquée ou réduite). */
function showWindow() {
  if (!win || win.isDestroyed()) { ensureWindow(); openStartTabs(); }
  if (win.isMinimized()) win.restore();
  win.show();
  app.focus({ steal: true });
}

/** Menu de l'icône de la barre de menus (clic droit). */
function trayMenu() {
  const shown = win && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
  const front = (fn) => () => { app.focus({ steal: true }); fn(); };
  return [
    shown
      ? { label: t('tray.hide'), click: () => win.hide() }
      : { label: t('tray.show'), click: () => showWindow() },
    { label: t('menu.newTab'), click: () => { showWindow(); createTab(''); focusAddress(); } },
    { type: 'separator' },
    {
      label: t('settings.icon'),
      submenu: presence.MODES.map((mode) => ({
        label: t(`settings.icon.${mode}`), type: 'radio', checked: presence.normalize(config.get('iconMode')) === mode,
        click: () => { config.set('iconMode', presence.apply(mode)); if (mode === 'dock') showWindow(); },
      })),
    },
    { label: t('menu.settings'), click: front(() => openPanel('settings', 1160)) },
    { label: t('menu.checkUpdates'), click: front(() => openPanel('update', 480, { manual: '1' })) },
    { label: t('menu.about'), click: front(() => openPanel('about', 356)) },
    { type: 'separator' },
    { label: t('menu.quit'), click: () => app.quit() },
  ];
}

// ---------- fenêtres secondaires (À propos, Réglages, mise à jour, Trousseau) ----------
const panels = {};
function openPanel(name, width, query = {}) {
  if (panels[name] && !panels[name].isDestroyed()) {
    panels[name].show();
    return panels[name];
  }
  const titles = { about: 'about.title', settings: 'settings.title', update: 'upd.title', kcadd: 'kcadd.title' };
  const p = new BrowserWindow({
    width, height: 200, show: false, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    title: t(titles[name]),
    backgroundColor: '#1e1e1e',
    webPreferences: { preload: path.join(UI, 'preload.js'), sandbox: true, contextIsolation: true },
  });
  p.__width = width;
  p.setMenuBarVisibility(false);
  p.loadFile(path.join(UI, name + '.html'), { query });
  panels[name] = p;
  p.on('closed', () => { delete panels[name]; });
  return p;
}

function centerOnApp(p, w, h) {
  const ref = win && !win.isDestroyed() && win.isVisible() ? win.getBounds() : screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  p.setBounds({ x: Math.round(ref.x + (ref.width - w) / 2), y: Math.round(ref.y + (ref.height - h) / 2), width: w, height: h });
}

ipcMain.on('panel:ready', (e, height) => {
  const p = BrowserWindow.fromWebContents(e.sender);
  if (!p || p === win) return;
  const w = p.__width;
  p.setContentSize(w, Math.ceil(height));
  const [ow, oh] = p.getSize();
  centerOnApp(p, ow, oh);
  if (!p.isVisible()) p.show();
});
ipcMain.on('panel:close', (e) => {
  const p = BrowserWindow.fromWebContents(e.sender);
  if (p && p !== win) p.close();
});

// ---------- menus ----------
function buildMenu() {
  const tabAction = (fn) => () => { const tab = activeTab(); if (tab) fn(tab); };
  const template = [
    {
      label: 'wCLAUDE',
      submenu: [
        { label: t('menu.about'), click: () => openPanel('about', 356) },
        { label: t('menu.checkUpdates'), click: () => openPanel('update', 480, { manual: '1' }) },
        { type: 'separator' },
        { label: t('menu.settings'), accelerator: 'CmdOrCtrl+,', click: () => openPanel('settings', 1160) },
        { type: 'separator' },
        { label: t('menu.services'), role: 'services' },
        { type: 'separator' },
        { label: t('menu.hide'), role: 'hide' },
        { label: t('menu.hideOthers'), role: 'hideOthers' },
        { label: t('menu.showAll'), role: 'unhide' },
        { type: 'separator' },
        { label: t('menu.quit'), role: 'quit' },
      ],
    },
    {
      label: t('menu.file'),
      submenu: [
        { label: t('menu.newTab'), accelerator: 'CmdOrCtrl+T', click: () => { createTab(''); focusAddress(); } },
        { label: t('menu.closeTab'), accelerator: 'CmdOrCtrl+W', click: () => { if (activeId) closeTab(activeId); } },
        { label: t('menu.openLocation'), accelerator: 'CmdOrCtrl+L', click: () => focusAddress() },
        { type: 'separator' },
        { label: t('menu.addKeychain'), click: () => openKeychainAdd() },
      ],
    },
    {
      label: t('menu.edit'),
      submenu: [
        { label: t('menu.undo'), role: 'undo' },
        { label: t('menu.redo'), role: 'redo' },
        { type: 'separator' },
        { label: t('menu.cut'), role: 'cut' },
        { label: t('menu.copy'), role: 'copy' },
        { label: t('menu.paste'), role: 'paste' },
        { label: t('menu.selectAll'), role: 'selectAll' },
      ],
    },
    {
      label: t('menu.view'),
      submenu: [
        { label: t('menu.reload'), accelerator: 'CmdOrCtrl+R', click: tabAction((tab) => tab.wc.reload()) },
        { label: t('nav.back'), accelerator: 'CmdOrCtrl+[', click: tabAction((tab) => tab.wc.navigationHistory.goBack()) },
        { label: t('nav.forward'), accelerator: 'CmdOrCtrl+]', click: tabAction((tab) => tab.wc.navigationHistory.goForward()) },
        { type: 'separator' },
        { label: t('menu.toggleMobile'), accelerator: 'CmdOrCtrl+Shift+M', click: () => toggleMobileForActive() },
        { label: t('menu.openDownloads'), accelerator: 'CmdOrCtrl+Shift+J', click: () => openDownloadsFolder() },
        { type: 'separator' },
        { label: t('menu.devtools'), accelerator: 'Alt+CmdOrCtrl+I', click: tabAction((tab) => tab.wc.toggleDevTools()) },
      ],
    },
    {
      label: t('menu.window'),
      submenu: [
        { label: t('menu.minimize'), role: 'minimize' },
        { label: t('menu.zoom'), role: 'zoom' },
        { type: 'separator' },
        { label: t('menu.nextTab'), accelerator: 'Ctrl+Tab', click: () => cycleTab(1) },
        { label: t('menu.prevTab'), accelerator: 'Ctrl+Shift+Tab', click: () => cycleTab(-1) },
        { type: 'separator' },
        { label: t('menu.front'), role: 'front' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function focusAddress() {
  if (!win || win.isDestroyed()) return;
  win.webContents.focus();
  win.webContents.send('focus-address');
}

function openDownloadsFolder() {
  fs.mkdirSync(config.DOWNLOADS_DIR, { recursive: true });
  shell.openPath(config.DOWNLOADS_DIR);
}

function toggleMobileForActive() {
  const tab = activeTab();
  const site = tab ? config.registrableDomain(config.hostOf(tab.wc.getURL())) : '';
  if (!site) return showNotice(t('mobile.noSite'), 'help');
  setMobileSite(site, !tab.mobile);
}

function openKeychainAdd() {
  const tab = activeTab();
  const site = tab ? config.registrableDomain(config.hostOf(tab.wc.getURL())) : '';
  openPanel('kcadd', 480, { site });
}

// ---------- Trousseau ----------
const KEYCHAIN_NOTICES = {
  filled: ['keychain.filled', 'tip'],
  account_only: ['keychain.accountOnly', 'help'],
  denied: ['keychain.denied', 'warning'],
  no_field: ['keychain.noField', 'warning'],
  no_site: ['mobile.noSite', 'help'],
  error: ['keychain.error', 'danger'],
};

async function keychainFill(tab, account, { fromUser = false } = {}) {
  const res = await keychain.fill(tab.wc, account);
  if (fromUser && res.status === 'choose') {
    const items = res.accounts.map((a) => ({ label: a, click: () => keychainFill(tab, a, { fromUser: true }) }));
    Menu.buildFromTemplate([{ label: t('keychain.chooseAccount'), enabled: false }, ...items]).popup({ window: win });
    return res;
  }
  if (res.status === 'no_item') {
    showNotice(t('keychain.none', { site: res.site }), 'help', { id: 'kcadd', label: t('keychain.addEntry') });
  } else if (KEYCHAIN_NOTICES[res.status]) {
    const [key, kind] = KEYCHAIN_NOTICES[res.status];
    showNotice(t(key, { account: res.account || '', site: res.site || '' }), kind);
  }
  return res;
}

// ---------- téléchargements ----------
function uniqueName(dir, name) {
  name = (name || 'download').replace(/[/:]/g, '_');
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let n = 2; fs.existsSync(path.join(dir, candidate)); n++) candidate = `${base} (${n})${ext}`;
  return candidate;
}

function setupDownloads(ses) {
  ses.on('will-download', (_e, item, wc) => {
    fs.mkdirSync(config.DOWNLOADS_DIR, { recursive: true });
    const name = uniqueName(config.DOWNLOADS_DIR, item.getFilename());
    const file = path.join(config.DOWNLOADS_DIR, name);
    item.setSavePath(file);
    const tab = tabByWc(wc);
    const d = {
      id: nextDownloadId++, name, path: file, url: item.getURL(), state: 'progressing',
      received: 0, total: item.getTotalBytes(), startedAt: Date.now(), endedAt: null, tabId: tab ? tab.id : null,
    };
    downloads.unshift(d);
    item.on('updated', (_ev, st) => {
      d.received = item.getReceivedBytes();
      d.total = item.getTotalBytes();
      d.state = st === 'interrupted' ? 'interrupted' : 'progressing';
      pushState();
    });
    item.once('done', (_ev, st) => {
      d.state = st; // completed | cancelled | interrupted
      d.received = item.getReceivedBytes();
      d.endedAt = Date.now();
      if (st === 'completed') showNotice(t('downloads.finished', { name }), 'tip');
      pushState();
    });
    pushState();
  });
}

function downloadsMenu() {
  const items = downloads.slice(0, 12).map((d) => {
    const pct = d.total ? Math.floor((d.received / d.total) * 100) : 0;
    const status = d.state === 'completed' ? t('downloads.done')
      : d.state === 'progressing' ? t('downloads.progress', { percent: pct })
      : d.state === 'cancelled' ? t('downloads.cancelled') : t('downloads.failed');
    return { label: `${d.name} — ${status}`, click: () => (d.state === 'completed' ? shell.showItemInFolder(d.path) : null) };
  });
  if (!items.length) items.push({ label: t('downloads.empty'), enabled: false });
  items.push({ type: 'separator' }, { label: t('downloads.openFolder'), click: openDownloadsFolder });
  Menu.buildFromTemplate(items).popup({ window: win });
}

// ---------- session : identité, version iPhone, autorisations ----------
function setupSession(ses) {
  ses.setUserAgent(CHROME_UA);
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    const tab = tabs.find((x) => x.wc.id === details.webContentsId);
    let mobile = tab ? tab.mobile : false;
    if (details.resourceType === 'mainFrame') mobile = config.isMobileUrl(details.url);
    const headers = details.requestHeaders;
    if (mobile) {
      headers['User-Agent'] = IPHONE_UA;
      for (const k of Object.keys(headers)) if (/^sec-ch-ua/i.test(k)) delete headers[k];
    }
    cb({ requestHeaders: headers });
  });
  const allowed = new Set(['clipboard-sanitized-write', 'fullscreen', 'notifications', 'pointerLock']);
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  setupDownloads(ses);
}

// ---------- IPC de la barre d'outils et des fenêtres ----------
ipcMain.on('i18n', (e) => { e.returnValue = { lang: i18n.lang, strings: i18n.strings }; });
ipcMain.on('nav', (_e, { action, url }) => {
  const tab = activeTab();
  if (!tab) return;
  const h = tab.wc.navigationHistory;
  if (action === 'go') {
    const target = toUrl(url);
    if (target) tab.wc.loadURL(target).catch(() => {});
    tab.wc.focus();
  } else if (action === 'back') h.goBack();
  else if (action === 'forward') h.goForward();
  else if (action === 'reload') tab.wc.reload();
  else if (action === 'stop') tab.wc.stop();
});
ipcMain.on('tab:new', () => { createTab(''); focusAddress(); });
ipcMain.on('tab:select', (_e, id) => selectTab(id));
ipcMain.on('tab:close', (_e, id) => closeTab(id));
ipcMain.on('mobile:toggle', () => toggleMobileForActive());
ipcMain.on('keychain:fill', () => { const tab = activeTab(); if (tab) keychainFill(tab, null, { fromUser: true }); });
ipcMain.on('downloads:menu', () => downloadsMenu());
ipcMain.on('downloads:open', () => openDownloadsFolder());
ipcMain.on('notice:action', (_e, id) => {
  notice = null;
  pushState();
  if (id === 'kcadd') openKeychainAdd();
  if (id === 'update') openPanel('update', 480);
});
ipcMain.on('state:request', () => pushState());
ipcMain.on('toolbar:height', (_e, h) => {
  const v = Math.max(92, Math.min(400, Math.round(Number(h) || 92)));
  if (v !== TOOLBAR_H) { TOOLBAR_H = v; layout(); }
});
ipcMain.on('handoff:answer', (_e, { id, done }) => answerHandoff(id, done ? 'done' : 'cancelled'));

function startHandoff({ reason, kind, agentName, tabId }) {
  if (handoff && handoff.status === 'waiting') handoff.status = 'cancelled';
  handoff = { id: nextHandoffId++, reason: String(reason || '').slice(0, 300), kind: kind || 'other', agent: agentName || '', tabId: tabId || null, at: Date.now(), status: 'waiting' };
  if (tabId && tabById(tabId)) selectTab(tabId);
  ensureWindow();
  // Prévenir sans voler le focus : notification du système et rebond discret dans le Dock.
  try {
    const n = new Notification({ title: 'wCLAUDE', body: t('handoff.notify', { agent: handoff.agent || t('agent.generic'), reason: handoff.reason || t('handoff.kind.' + handoff.kind) }) });
    n.on('click', () => showWindow());
    n.show();
  } catch { /* notifications refusées */ }
  if (app.dock) app.dock.bounce('informational');
  pushState();
  return handoff;
}

function answerHandoff(id, status) {
  if (!handoff || handoff.id !== Number(id) || handoff.status !== 'waiting') return false;
  handoff.status = status;
  pushState();
  return true;
}

ipcMain.handle('about:info', () => {
  let build = '';
  try {
    const plist = fs.readFileSync(path.join(process.resourcesPath, '..', 'Info.plist'), 'utf8');
    build = (plist.match(/<key>CFBundleVersion<\/key>\s*<string>([^<]*)<\/string>/) || [])[1] || '';
  } catch { /* lancement depuis les sources */ }
  return { version: app.getVersion(), build: build || 'dev' };
});
ipcMain.handle('settings:get', () => ({
  mobileSites: config.get('mobileSites'),
  autoInstall: !!config.get('autoInstall'),
  agentControl: config.get('agentControl') !== false,
  agentActive: AGENT_CONTROL,
  cdpPort: CDP_PORT,
  downloadsDir: config.DOWNLOADS_DIR,
  lastAgent: config.get('lastAgent') || '',
  update: updater.publicState(),
  iconMode: presence.normalize(config.get('iconMode')),
  autoStart: app.isPackaged && autostart.isEnabled(process.execPath),
  autoStartAvailable: app.isPackaged,
}));
ipcMain.handle('settings:set', (_e, { key, value }) => {
  if (['autoInstall', 'agentControl'].includes(key)) config.set(key, !!value);
  if (key === 'iconMode' && presence.MODES.includes(value)) config.set('iconMode', presence.apply(value));
  if (key === 'autoStart' && app.isPackaged) return autostart.setEnabled(process.execPath, !!value);
  return true;
});
ipcMain.handle('settings:removeMobile', (_e, site) => setMobileSite(site, false));
ipcMain.handle('settings:copyConfig', () => {
  clipboard.writeText(JSON.stringify({ mcpServers: { wclaude: { command: mcpLauncher(), args: [] } } }, null, 2));
  return true;
});
ipcMain.handle('update:state', () => updater.publicState());
ipcMain.handle('update:check', () => updater.check({ lang: i18n.lang }).then(() => updater.publicState()));
ipcMain.handle('update:install', async () => {
  if (isBusy()) return { error: 'busy' };
  try {
    await updater.prepare();
    if (updater.installOnExit(true)) setTimeout(() => app.quit(), 200);
    return { ok: true };
  } catch (e) {
    return { error: String(e.message || e).startsWith('verify') ? 'verify' : 'network' };
  }
});
// ---------- YouTube (API officielle) ----------
const ytPage = (ok) => `<!doctype html><html lang="${i18n.lang}"><head><meta charset="utf-8"><title>wCLAUDE</title>
<style>html,body{margin:0;height:100%;background:#1e1e1e;color:#ddd;font:15px/22px -apple-system,BlinkMacSystemFont,sans-serif}
body{display:grid;place-items:center}div{max-width:520px;padding:24px;text-align:center}b{color:#fff;font-size:20px;display:block;margin-bottom:12px}
span{color:#d97757}</style></head><body><div><b><span>w</span>CLAUDE</b>${ok ? t('yt.pageOk') : t('yt.pageFail')}</div></body></html>`;

async function youtubeConnect() {
  return youtube.connect({ openExternal: (url) => shell.openExternal(url), page: ytPage });
}

function watchUpload(job) {
  const timer = setInterval(() => {
    const j = youtube.uploadStatus(job.id);
    if (!j || j.state === 'uploading' || j.state === 'starting') return;
    clearInterval(timer);
    if (j.state === 'done') showNotice(t('yt.uploaded', { name: j.name }), 'tip');
    else showNotice(t('yt.uploadFailed', { name: j.name }), 'danger');
  }, 2000);
}

ipcMain.handle('yt:status', () => youtube.status().catch(() => ({ clientConfigured: false, connected: false })));
ipcMain.handle('yt:import', async (e) => {
  const parent = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(parent, { properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (r.canceled || !r.filePaths[0]) return { cancelled: true };
  try { return await youtube.importClient(r.filePaths[0]); } catch { return { error: 'client_file' }; }
});
ipcMain.handle('yt:saveClient', async (_e, { clientId, clientSecret }) => {
  try { return await youtube.saveClient(clientId, clientSecret); } catch { return { error: 'client_values' }; }
});
ipcMain.handle('yt:connect', async () => { try { return await youtubeConnect(); } catch (err) { return { error: String(err.message || err) }; } });
ipcMain.handle('yt:disconnect', () => youtube.disconnect());

ipcMain.handle('kc:add', async (_e, { site, account, password }) => {
  const res = await keychain.addEntry(site, account, password);
  if (res.saved) showNotice(t('kcadd.saved', { site: res.site }), 'tip');
  return res;
});

function mcpLauncher() {
  return path.join(__dirname, 'bin', 'wclaude-mcp');
}

updater.onChange((s) => {
  if (s.status === 'ready' && config.get('autoInstall')) showNotice(t('upd.ready', { version: s.latest }), 'tip');
  for (const p of Object.values(panels)) if (!p.isDestroyed()) p.webContents.send('update:state', updater.publicState());
});

// ---------- interface de pilotage pour le serveur MCP ----------
async function waitTarget(tab) {
  await tab.ready;
  return publicTab(tab);
}

const routes = {
  'GET /state': () => ({
    version: app.getVersion(),
    tabs: tabs.map(publicTab),
    activeId,
    downloadsDir: config.DOWNLOADS_DIR,
    mobileSites: config.get('mobileSites'),
  }),
  'POST /tabs/ensure': async () => {
    const created = !win || win.isDestroyed() || !tabs.length;
    if (!win || win.isDestroyed()) ensureWindow({ quiet: true });
    if (!tabs.length) openStartTabs();
    await Promise.all(tabs.map((x) => x.ready));
    return { created, tabs: tabs.map(publicTab), activeId };
  },
  'POST /tabs/new': async (b) => {
    const tab = createTab(b.url ? toUrl(b.url) : '', { activate: b.activate !== false });
    return { tab: await waitTarget(tab) };
  },
  'POST /tabs/select': (b) => { selectTab(b.id); return { ok: !!tabById(b.id) }; },
  'POST /tabs/close': (b) => { const ok = !!tabById(b.id); closeTab(b.id); return { ok }; },
  'POST /mobile': async (b) => {
    const tab = tabById(b.id) || activeTab();
    const site = b.site ? config.registrableDomain(String(b.site).replace(/^https?:\/\//, '').split('/')[0]) : tab ? config.registrableDomain(config.hostOf(tab.wc.getURL())) : '';
    if (!site) return { error: 'no_site' };
    await setMobileSite(site, !!b.enabled);
    return { site, enabled: !!b.enabled, mobileSites: config.get('mobileSites') };
  },
  'GET /downloads': () => ({ dir: config.DOWNLOADS_DIR, downloads }),
  'GET /keychain/accounts': async (_b, q) => {
    const tab = tabById(q.id) || activeTab();
    const site = tab ? config.registrableDomain(config.hostOf(tab.wc.getURL())) : '';
    return { site, accounts: [...new Set((await keychain.listAccounts(site)).map((a) => a.account))] };
  },
  'POST /keychain/fill': async (b) => {
    const tab = tabById(b.id) || activeTab();
    if (!tab) return { status: 'no_site' };
    selectTab(tab.id);
    return keychainFill(tab, b.account || null);
  },
  'POST /handoff': (b) => {
    const h = startHandoff({ reason: b.reason, kind: b.kind, agentName: b.agent, tabId: b.tabId });
    return { id: h.id };
  },
  'GET /handoff': (_b, q) => ({ status: handoff && handoff.id === Number(q.id) ? handoff.status : 'cancelled' }),
  'POST /handoff/cancel': (b) => ({ ok: answerHandoff(b.id, 'cancelled') }),
  'GET /youtube/status': () => youtube.status(),
  'POST /youtube/connect': () => youtubeConnect(),
  'GET /youtube/channel': () => youtube.channel(),
  'GET /youtube/videos': (_b, q) => youtube.listVideos({ max: Number(q.max) || 25, pageToken: q.pageToken }),
  'GET /youtube/video': (_b, q) => youtube.getVideo(q.id),
  'POST /youtube/video': (b) => youtube.updateVideo(b.id, b),
  'POST /youtube/thumbnail': (b) => youtube.setThumbnail(b.id, b.path),
  'POST /youtube/upload': (b) => { const job = youtube.startUpload(b); watchUpload(job); return youtube.uploadStatus(job.id); },
  'GET /youtube/upload': (_b, q) => youtube.uploadStatus(q.id) || { error: 'no_job' },
  'GET /youtube/analytics': (_b, q) => youtube.analytics(q),
  'GET /youtube/captions': (_b, q) => youtube.listCaptions(q.videoId),
  'POST /youtube/caption': (b) => youtube.uploadCaption(b),
  'POST /activity': (b) => {
    const key = 'act.' + String(b.action || '');
    agent.label = i18n.strings[key] ? t(key) : String(b.action || '').slice(0, 40);
    agent.name = String(b.agent || '').slice(0, 40);
    agent.at = Date.now();
    agent.tabId = b.tabId || null;
    if (agent.name && agent.name !== config.get('lastAgent')) config.set('lastAgent', agent.name);
    if (b.tabId && tabById(b.tabId) && b.tabId !== activeId) selectTab(b.tabId);
    pushState();
    return { ok: true };
  },
};

// ---------- démarrage ----------
app.whenReady().then(async () => {
  i18n.init(app.getPreferredSystemLanguages());
  NEWTAB = `${NEWTAB_BASE}?t=${encodeURIComponent(t('tab.new'))}&d=${encodeURIComponent(t('app.description'))}`;
  nativeTheme.themeSource = 'dark'; // toujours sombre, pages web comprises
  // Lancement depuis les sources : l'icône de wCLAUDE dans le Dock (l'appli compilée a la sienne dans son paquet).
  if (!app.isPackaged && app.dock) {
    const devIcon = path.join(__dirname, '..', 'assets', 'icon-1024.png');
    if (fs.existsSync(devIcon)) app.dock.setIcon(devIcon);
  }
  setupSession(session.defaultSession);
  buildMenu();
  presence.init({ getWindow: () => (win && !win.isDestroyed() ? win : null), showWindow, buildMenu: trayMenu, tooltip: () => 'wCLAUDE' });
  presence.apply(config.get('iconMode'));
  ensureWindow();
  openStartTabs();
  if (AGENT_CONTROL) {
    await control.start(routes, { cdpPort: CDP_PORT, version: app.getVersion(), app: app.isPackaged ? path.resolve(process.execPath, '..', '..', '..') : null });
  }
  if (app.isPackaged) {
    updater.schedule({
      lang: i18n.lang,
      isBusy,
      onAvailable: (s) => showNotice(t('upd.available', { version: s.latest, current: app.getVersion() }), 'help', { id: 'update', label: t('upd.notes') }),
    });
  }
});

app.on('second-instance', () => {
  ensureWindow();
  if (!tabs.length) openStartTabs();
  win.show();
});
app.on('activate', () => {
  if (!win || win.isDestroyed()) { ensureWindow(); openStartTabs(); }
  else if (!win.isVisible()) win.show(); // fenêtre masquée depuis la barre de menus, rouverte par le Dock
});
app.on('window-all-closed', () => { /* macOS : l'appli reste ouverte, l'agent peut rouvrir une fenêtre */ });
app.on('before-quit', () => { if (win && !win.isDestroyed()) saveTabs(); control.stop(); });
