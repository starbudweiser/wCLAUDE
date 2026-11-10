// Pont de la page interne Veille (wclaude://veille) : seulement les canaux watch:*, et seulement sur cette page.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'file:' && /\/ui\/watch\.html$/.test(location.pathname)) {
  const INVOKE = new Set(['watch:get', 'watch:test', 'watch:add', 'watch:remove', 'watch:enable', 'watch:read', 'watch:readSource', 'watch:check', 'watch:open']);
  const i18n = ipcRenderer.sendSync('i18n');
  contextBridge.exposeInMainWorld('wclaude', {
    lang: i18n.lang,
    t: (key, vars) => {
      let s = i18n.strings[key] ?? key;
      if (vars) for (const [k, v] of Object.entries(vars)) s = s.split('{' + k + '}').join(String(v));
      return s;
    },
    invoke: (channel, payload) => (INVOKE.has(channel) ? ipcRenderer.invoke(channel, payload) : Promise.reject(new Error('channel'))),
    onChange: (fn) => ipcRenderer.on('watch:changed', () => fn()),
  });
}
