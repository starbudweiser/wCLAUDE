// Pont entre les pages de l'interface (barre d'outils, fenêtres) et le processus principal.
const { contextBridge, ipcRenderer } = require('electron');

const SEND = new Set(['nav', 'tab:new', 'tab:select', 'tab:close', 'mobile:toggle', 'keychain:fill', 'downloads:menu', 'downloads:open', 'notice:action', 'state:request', 'panel:close', 'toolbar:height', 'handoff:answer']);
const INVOKE = new Set(['about:info', 'settings:get', 'settings:set', 'settings:removeMobile', 'settings:copyConfig', 'update:state', 'update:check', 'update:install', 'kc:add']);
const ON = new Set(['state', 'focus-address', 'update:state']);

const i18n = ipcRenderer.sendSync('i18n');

contextBridge.exposeInMainWorld('wclaude', {
  lang: i18n.lang,
  t: (key, vars) => {
    let s = i18n.strings[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.split('{' + k + '}').join(String(v));
    return s;
  },
  send: (channel, payload) => { if (SEND.has(channel)) ipcRenderer.send(channel, payload); },
  invoke: (channel, payload) => (INVOKE.has(channel) ? ipcRenderer.invoke(channel, payload) : Promise.reject(new Error('channel'))),
  on: (channel, fn) => { if (ON.has(channel)) ipcRenderer.on(channel, (_e, data) => fn(data)); },
  ready: (height) => ipcRenderer.send('panel:ready', height),
});
