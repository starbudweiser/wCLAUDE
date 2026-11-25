// Essai de bout en bout : un client MCP (comme un agent IA) pilote wCLAUDE sur les pages d'essai locales.
// Prérequis : wCLAUDE lancé, test/fixtures-server.mjs lancé, un gros fichier à envoyer.
// Usage : node test/e2e.mjs <gros-fichier> [commande du serveur MCP…]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import path from 'node:path';

const BIG = path.resolve(process.argv[2] || '');
const cmd = process.argv[3] || 'node';
const args = process.argv.length > 4 ? process.argv.slice(4) : [path.join(import.meta.dirname, '..', 'mcp', 'server.mjs')];
const BASE = 'http://127.0.0.1:' + (process.env.PORT || 8765);

const client = new Client({ name: 'wclaude-e2e', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: cmd, args, env: { ...process.env }, stderr: 'ignore' }));

let failures = 0;
const text = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
async function call(name, a = {}) {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: a }, undefined, { timeout: 600000 });
  const out = text(r);
  console.log(`\n▶ ${name} ${JSON.stringify(a)} (${Date.now() - t0} ms)${r.isError ? ' [error]' : ''}\n${out.slice(0, 600)}`);
  return { r, out };
}
function check(label, ok) {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failures++;
}
const refOf = (snap, re) => (snap.split('\n').find((l) => re.test(l)) || '').match(/\[ref=(\w+)\]/)?.[1];

const { tools } = await client.listTools();
check(`${tools.length} tools exposed`, tools.length >= 18);

await call('browser_tabs', { action: 'list' });
const nt = await call('browser_tabs', { action: 'new', url: BASE + '/' });
const tabId = Number(nt.out.match(/tab #(\d+)/)[1]);

// 1. Gros fichier dans un champ de fichier puis envoi du formulaire
let { out: snap } = await call('browser_snapshot', { tab: tabId });
const fileRef = refOf(snap, /button "(Files|Choose File)"/);
const size = fs.statSync(BIG).size;
await call('browser_upload_files', { tab: tabId, paths: [BIG], ref: fileRef });
({ out: snap } = await call('browser_snapshot', { tab: tabId }));
await call('browser_click', { tab: tabId, ref: refOf(snap, /button "Send"/) });
await call('browser_wait_for', { tab: tabId, text: 'Received', seconds: 300 });
const { out: received } = await call('browser_page_text', { tab: tabId });
const got = Number((received.match(/Received (\d+) bytes/) || [])[1] || 0);
check(`upload of ${size} bytes reached the server (${got} bytes with multipart overhead)`, got > size && got - size < 4096);

// 2. Bouton qui ouvre le sélecteur de fichiers (champ caché)
await call('browser_navigate', { tab: tabId, url: BASE + '/button' });
({ out: snap } = await call('browser_snapshot', { tab: tabId }));
await call('browser_upload_files', { tab: tabId, paths: [BIG], ref: refOf(snap, /Choose a video/) });
const { out: picked } = await call('browser_page_text', { tab: tabId });
check('file picker opened by a button got the file', picked.includes(`Picked ${path.basename(BIG)} ${size}`));

// 2 bis. Champ caché dans un shadow DOM, sur une page lourde (cas de Reddit : blocage puis plantage de l'onglet)
await call('browser_navigate', { tab: tabId, url: BASE + '/shadow' });
({ out: snap } = await call('browser_snapshot', { tab: tabId }));
const t0 = Date.now();
await call('browser_upload_files', { tab: tabId, paths: [BIG], ref: refOf(snap, /Add a video/) });
const { out: shadowed } = await call('browser_page_text', { tab: tabId });
check(`file input inside a shadow root got the file in ${Date.now() - t0} ms`, shadowed.includes(`Shadow got ${path.basename(BIG)} ${size}`) && Date.now() - t0 < 30000);

// 2 ter. Champ dans un cadre
await call('browser_navigate', { tab: tabId, url: BASE + '/framed' });
await call('browser_upload_files', { tab: tabId, paths: [BIG], selector: 'iframe >> nth=0 >> internal:control=enter-frame >> #hidden' });
const framedOk = await call('browser_evaluate', { tab: tabId, script: "return document.querySelector('iframe').contentDocument.getElementById('hidden').files[0]?.size || 0" });
check('file input inside a frame got the file', framedOk.out.includes(String(size)));

// 3. Zone de dépôt
await call('browser_navigate', { tab: tabId, url: BASE + '/drop' });
({ out: snap } = await call('browser_snapshot', { tab: tabId }));
await call('browser_upload_files', { tab: tabId, paths: [BIG], text: 'Drop files here', mode: 'drop' });
const { out: dropped } = await call('browser_page_text', { tab: tabId });
check('drop zone got the file', dropped.includes(`Dropped ${path.basename(BIG)} ${size}`));

// 4. Téléchargement dans le dossier connu
await call('browser_navigate', { tab: tabId, url: BASE + '/files' });
await call('browser_click', { tab: tabId, text: 'Get the archive' });
const { out: dl } = await call('browser_downloads', { wait_seconds: 60 });
const dlPath = (dl.match(/completed\s+(\S.*?essai-wclaude[^ ]*\.zip)/) || [])[1];
check('download saved in the downloads folder', !!dlPath && fs.existsSync(dlPath) && fs.statSync(dlPath).size === 20 * 1024 * 1024);

// 5. Version iPhone par site
await call('browser_navigate', { tab: tabId, url: BASE + '/ua' });
await call('browser_mobile_mode', { tab: tabId, enabled: true });
await call('browser_navigate', { tab: tabId, url: BASE + '/ua' });
const { out: mob } = await call('browser_page_text', { tab: tabId });
check('iPhone mode: user agent, width 390, touch', /iPhone/.test(mob) && /"width":390/.test(mob) && /"touch":5/.test(mob) && /"mobile":true/.test(mob));
const shot = await call('browser_screenshot', { tab: tabId });
check('screenshot returned an image', shot.r.content.some((c) => c.type === 'image' && c.data.length > 1000));
await call('browser_mobile_mode', { tab: tabId, enabled: false });
await call('browser_navigate', { tab: tabId, url: BASE + '/ua' });
const { out: desk } = await call('browser_page_text', { tab: tabId });
check('desktop mode restored', /Macintosh/.test(desk) && !/"width":390/.test(desk));

// 6. Garde-fous : champ de mot de passe refusé, Trousseau sans identifiant
await call('browser_navigate', { tab: tabId, url: BASE + '/login' });
({ out: snap } = await call('browser_snapshot', { tab: tabId }));
const pw = await call('browser_type', { tab: tabId, ref: refOf(snap, /textbox "Password"/), value: 'secret' });
check('typing into a password field is refused', pw.r.isError && /blocked/.test(pw.out));
const kc = await call('browser_keychain_fill', { tab: tabId });
check('keychain fill without a saved sign-in asks the user to add one', /No sign-in for 127\.0\.0\.1/.test(kc.out));

await call('browser_tabs', { action: 'close', tab: tabId });
await client.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
