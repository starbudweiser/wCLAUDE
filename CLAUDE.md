# wCLAUDE — notes de projet

Interface : suivre le design system Socle — https://claude.ai/artifact/TkNj2Y6SQGZwT6EyME92Ah (copie locale
`/Volumes/SKYRIM/TOOLS/DESIGN/Socle`). wCLAUDE est **toujours en thème sombre** (`data-theme="dark"`,
`nativeTheme.themeSource = 'dark'`). Le « w » du nom est en couleur argile `#d97757` (relevée sur le logo).

## Structure
- `app/main.js` : fenêtre, onglets (WebContentsView), version iPhone (CDP via `webContents.debugger` +
  en-têtes réécrits), téléchargements, menus, interface de pilotage (`app/lib/control.js`).
- `app/lib/` : réglages, langues, Trousseau (`keychain.js` + outil Swift `helper/keychain.swift` compilé en
  `app/bin/wCLAUDE`), mise à jour (`updater.js`).
- `app/ui/` : barre d'outils et fenêtres (HTML/CSS/JS, tokens Socle copiés dans `app/socle/`).
- `mcp/server.mjs` : serveur MCP (stdio), Playwright `connectOverCDP` ; outils et textes pour les agents en anglais.
- `app/bin/wclaude-mcp` : lanceur du serveur avec le moteur de l'appli (`ELECTRON_RUN_AS_NODE`).

## Points délicats
- Playwright refuse les fichiers de plus de 50 Mo sur un navigateur connecté : les fichiers passent par
  `DOM.setFileInputFiles` (fonction `setFiles`), jamais par `setInputFiles`.
- Playwright détourne les téléchargements vers son dossier temporaire : le serveur remet
  `Browser.setDownloadBehavior { behavior: 'default' }` après la connexion.
- Un clic sur un lien de téléchargement doit avoir `noWaitAfter: true`.
- Le serveur ne doit pas transmettre `ELECTRON_RUN_AS_NODE` à l'appli qu'il lance.
- Textes visibles : clés dans `app/locales/{fr,en,es,it}.json` (français d'abord), vérifiées par `npm test`.

- Connexion Google : refusée dans une fenêtre pilotée ; contournée proprement par l'import de session depuis un
  navigateur Chromium installé (menu Fichier, `app/lib/browserimport.js`), cookies conservés dans le profil persistant.

## Build et essais
`scripts/build.sh` (signe avec `sign_app.sh`, installe dans `~/Applications/Applications Personnelles`),
`npm test`, `node test/e2e.mjs <gros-fichier> [lanceur]` avec `node test/fixtures-server.mjs` lancé.
Essais en arrière-plan : `open -g -n -a node_modules/electron/dist/Electron.app --env WCLAUDE_SUPPORT_DIR=… --args "$PWD" --background`.
