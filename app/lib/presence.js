// wCLAUDE — présence de l'appli : Dock, barre de menus en haut de l'écran, ou les deux (préférence « iconMode »).
// Modèle : hERALD (Presence.swift). Clic gauche sur l'icône : affiche ou masque la fenêtre ; clic droit (ou Ctrl-clic) :
// menu, ouvert par wCLAUDE lui-même juste sous l'icône (jamais tray.setContextMenu, que macOS place parfois loin
// de l'icône sur plusieurs écrans).
const { app, Tray, Menu, nativeImage } = require('electron');
const path = require('path');

const MODES = ['dock', 'menubar', 'both'];
let tray = null;
let hooks = null; // { getWindow, showWindow, buildMenu, tooltip }

function normalize(mode) {
  return MODES.includes(mode) ? mode : 'menubar';
}

function apply(mode) {
  const m = normalize(mode);
  if (app.dock) {
    if (m === 'menubar') app.dock.hide();
    else app.dock.show().catch(() => {});
  }
  if (m === 'dock') removeTray();
  else installTray();
  return m;
}

function installTray() {
  if (tray && !tray.isDestroyed()) return;
  // silhouette en couleur (fenêtre claire + « w » argile), sans carré de fond : pas une image « modèle »
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'ui', 'tray.png'));
  img.setTemplateImage(false);
  tray = new Tray(img);
  tray.setToolTip(hooks.tooltip());
  tray.setIgnoreDoubleClickEvents(true);
  tray.on('click', (e) => (e.ctrlKey ? popMenu() : toggle()));
  tray.on('right-click', () => popMenu());
}

function removeTray() {
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = null;
}

function popMenu() {
  if (!tray) return;
  // popUpContextMenu ouvre le menu sous l'icône, à la manière de NSMenu.popUp(positioning:at:in:)
  tray.popUpContextMenu(Menu.buildFromTemplate(hooks.buildMenu()));
}

/** Fenêtre devant (visible, active, non réduite) : on la masque ; sinon on l'amène devant. */
function toggle() {
  const w = hooks.getWindow();
  if (w && w.isVisible() && w.isFocused() && !w.isMinimized()) w.hide();
  else hooks.showWindow();
}

function refreshTooltip() {
  if (tray && !tray.isDestroyed()) tray.setToolTip(hooks.tooltip());
}

function init(h) {
  hooks = h;
}

module.exports = { MODES, init, apply, normalize, toggle, refreshTooltip };
