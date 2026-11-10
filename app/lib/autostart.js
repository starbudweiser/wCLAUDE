// wCLAUDE — service permanent : démarrage avec la session, caché (--background), relancé par macOS s'il s'arrête
// de façon inattendue. Un agent de lancement (~/Library/LaunchAgents) plutôt qu'un simple « élément d'ouverture » :
// celui-ci ne transmet pas --background sur les macOS récents et ne relance rien après un arrêt brutal.
// ⌘Q (sortie normale) arrête wCLAUDE jusqu'à la prochaine session : KeepAlive ne relance qu'après un échec.
const fs = require('fs');
const os = require('os');
const path = require('path');
const pkg = require('../../package.json');

const TEST = !!process.env.WCLAUDE_SUPPORT_DIR; // édition d'essai : son propre service, ses propres données
const LABEL = pkg.wclaude.bundleId + (TEST ? '.test' : '') + '.agent';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', LABEL + '.plist');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function plist(exe) {
  const env = ['WCLAUDE_SUPPORT_DIR', 'WCLAUDE_DOWNLOADS_DIR', 'WCLAUDE_CDP_PORT'].filter((k) => process.env[k]);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${esc(exe)}</string><string>--background</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>LimitLoadToSessionType</key><string>Aqua</string>${env.length ? `
  <key>EnvironmentVariables</key>
  <dict>${env.map((k) => `<key>${k}</key><string>${esc(process.env[k])}</string>`).join('')}</dict>` : ''}
</dict>
</plist>
`;
}

/** Le service pointe-t-il vers cette appli ? */
function isEnabled(exe) {
  try { return fs.readFileSync(PLIST, 'utf8').includes(`<string>${esc(exe)}</string>`); } catch { return false; }
}

/**
 * Écrit (ou retire) l'agent de lancement ; macOS le charge à la prochaine ouverture de session.
 * Pas de launchctl ici : charger le service lancerait une seconde instance tout de suite, et le décharger
 * arrêterait wCLAUDE lui-même s'il a été lancé par ce service.
 */
function setEnabled(exe, on) {
  if (on) {
    fs.mkdirSync(path.dirname(PLIST), { recursive: true });
    const tmp = PLIST + '.tmp';
    fs.writeFileSync(tmp, plist(exe));
    fs.renameSync(tmp, PLIST);
  } else {
    try { fs.unlinkSync(PLIST); } catch { /* déjà retiré */ }
  }
  return isEnabled(exe);
}

module.exports = { LABEL, PLIST, plist, isEnabled, setEnabled };
