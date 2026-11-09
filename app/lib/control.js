// Interface de pilotage locale (127.0.0.1 seulement, jeton obligatoire) utilisée par le serveur MCP :
// onglets, version iPhone, téléchargements, Trousseau, activité de l'agent.
// Le jeton et les ports sont écrits dans control.json (droits 600), lisible par l'utilisateur seul.
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { CONTROL_FILE, SUPPORT_DIR } = require('./config');

let server = null;
let token = null;

function writeControlFile(info) {
  fs.mkdirSync(SUPPORT_DIR, { recursive: true });
  fs.writeFileSync(CONTROL_FILE, JSON.stringify(info, null, 2), { mode: 0o600 });
  fs.chmodSync(CONTROL_FILE, 0o600);
}

function removeControlFile() {
  try {
    const info = JSON.parse(fs.readFileSync(CONTROL_FILE, 'utf8'));
    if (info.pid === process.pid) fs.unlinkSync(CONTROL_FILE);
  } catch { /* rien */ }
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => resolve(s));
  });
}

/** routes : { 'GET /state': async (body, query) => ({...}), … } */
async function start(routes, extraInfo) {
  token = crypto.randomBytes(24).toString('hex');
  try {
    server = await listen(9334);
  } catch {
    server = await listen(0);
  }
  server.on('request', async (req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    // Pas de navigateur : refuse toute requête venue d'une page web (en-tête Origin) ou sans jeton.
    if (req.headers.origin || req.headers['x-wclaude-token'] !== token) return send(403, { error: 'forbidden' });
    const url = new URL(req.url, 'http://127.0.0.1');
    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) return send(404, { error: 'not_found' });
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      try {
        const body = raw ? JSON.parse(raw) : {};
        send(200, (await handler(body, Object.fromEntries(url.searchParams), req)) ?? {});
      } catch (e) {
        send(500, { error: String(e && e.message ? e.message : e) });
      }
    });
  });
  const info = { controlPort: server.address().port, token, pid: process.pid, ...extraInfo };
  writeControlFile(info);
  return info;
}

function stop() {
  removeControlFile();
  if (server) server.close();
}

module.exports = { start, stop };
