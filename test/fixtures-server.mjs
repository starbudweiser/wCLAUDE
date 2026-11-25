// Serveur de pages d'essai (127.0.0.1) : envoi de fichiers, sélecteur de fichiers caché, zone de dépôt,
// téléchargement, identité du navigateur, formulaire de connexion. Aucun fichier reçu n'est écrit sur le disque.
import http from 'node:http';

const PORT = Number(process.env.PORT || 8765);
const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title></head><body>${body}</body></html>`;

const routes = {
  '/': () => page('Upload form', `
    <h1>Upload form</h1>
    <form method="post" action="/upload" enctype="multipart/form-data">
      <label>Files <input type="file" name="f" multiple></label>
      <button type="submit">Send</button>
    </form>`),
  '/button': () => page('Hidden input', `
    <h1>Button upload</h1>
    <input id="hidden" type="file" style="display:none" multiple>
    <button id="pick" onclick="document.getElementById('hidden').click()">Choose a video</button>
    <p id="out">No file</p>
    <script>document.getElementById('hidden').onchange = (e) => {
      const f = [...e.target.files]; document.getElementById('out').textContent = 'Picked ' + f.map(x => x.name + ' ' + x.size).join(', ');
    };</script>`),
  // Champ de fichier caché dans un composant web (shadow DOM), comme l'éditeur de Reddit, sur une page lourde.
  '/shadow': () => page('Shadow upload', `
    <h1>Shadow upload</h1>
    <x-uploader></x-uploader>
    <p id="out">No file</p>
    <div id="bulk"></div>
    <script>
      document.getElementById('bulk').innerHTML = Array.from({ length: 20000 }, (_, i) => '<span>item ' + i + '</span>').join('');
      customElements.define('x-uploader', class extends HTMLElement {
        constructor() {
          super();
          const r = this.attachShadow({ mode: 'open' });
          r.innerHTML = '<button id="pick">Add a video</button><input id="f" type="file" accept="video/mp4" style="display:none">';
          r.getElementById('pick').onclick = () => r.getElementById('f').click();
          r.getElementById('f').onchange = (e) => {
            const f = [...e.target.files]; document.getElementById('out').textContent = 'Shadow got ' + f.map((x) => x.name + ' ' + x.size).join(', ');
          };
        }
      });
    </script>`),
  // Champ de fichier dans un cadre (iframe).
  '/framed': () => page('Framed upload', `<h1>Framed upload</h1><iframe src="/button" width="600" height="200"></iframe>`),
  '/drop': () => page('Drop zone', `
    <h1>Drop zone</h1>
    <div id="zone" style="width:300px;height:120px;border:2px dashed #888">Drop files here</div>
    <p id="out">Nothing dropped</p>
    <script>const z = document.getElementById('zone');
      z.addEventListener('dragover', (e) => e.preventDefault());
      z.addEventListener('drop', (e) => { e.preventDefault(); const f = [...e.dataTransfer.files];
        document.getElementById('out').textContent = 'Dropped ' + f.map(x => x.name + ' ' + x.size).join(', '); });</script>`),
  '/files': () => page('Download', `<h1>Download</h1><a href="/download">Get the archive</a>`),
  '/ua': () => page('Identity', `<h1>Identity</h1><pre id="id"></pre>
    <script>document.getElementById('id').textContent = JSON.stringify({ ua: navigator.userAgent, platform: navigator.platform,
      width: innerWidth, dpr: devicePixelRatio, touch: navigator.maxTouchPoints, mobile: matchMedia('(pointer: coarse)').matches });</script>`),
  '/login': () => page('Sign in', `<h1>Sign in</h1><form><input name="user" autocomplete="username" placeholder="Email"><input name="pw" type="password" placeholder="Password"><button>Sign in</button></form>`),
  // Veille : /watch/bump fait évoluer la page, le flux et la version ; /watch/wall imite un défi anti-robot.
  '/watch/page': () => page('Blog', `<header>Menu</header><main><article>${watchPosts().map((p) => `<h2>${p}</h2>`).join('')}</article><p>Updated ${new Date().toISOString()}</p></main><script>document.querySelector('header').textContent += ' (js)';</script>`),
  '/watch/version': () => page('Downloads', `<main><p>Latest release: v1.4.${2 + watchStep}</p><p>Older: v1.4.1, v1.3.9</p></main>`),
  '/watch/wall': () => page('Just a moment...', '<p>Checking your browser before accessing the site.</p>'),
  '/watch/withfeed': () => `<!doctype html><html><head><title>Feed blog</title><link rel="alternate" type="application/rss+xml" href="/watch/feed.xml"></head><body><p>Blog</p></body></html>`,
};
let watchStep = 0;
const watchPosts = () => ['CrossOver 26 is out', ...(watchStep ? ['CrossOver 27 Preview 1 is available', 'ARM64 build for macOS, no Rosetta 2'] : [])];
const watchFeed = () => `<?xml version="1.0"?><rss><channel><title>Feed</title>${watchPosts().map((p, i) => `<item><title>${p}</title><link>http://127.0.0.1:${PORT}/post/${i}</link><guid>post-${i}</guid><description>About ${p}</description></item>`).reverse().join('')}</channel></rss>`;

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/watch/bump') { watchStep++; res.end(String(watchStep)); return; }
  if (url.pathname === '/watch/feed.xml') { res.writeHead(200, { 'Content-Type': 'application/rss+xml' }); res.end(watchFeed()); return; }
  if (req.method === 'POST' && url.pathname === '/upload') {
    let bytes = 0;
    const names = [];
    req.on('data', (chunk) => {
      bytes += chunk.length;
      const head = chunk.toString('latin1', 0, Math.min(chunk.length, 4096));
      for (const m of head.matchAll(/filename="([^"]*)"/g)) names.push(m[1]);
    });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page('Received', `<h1>Received</h1><p id="r">Received ${bytes} bytes (${names.join(', ')})</p><p>Agent: ${req.headers['user-agent']}</p>`));
    });
    return;
  }
  if (url.pathname === '/download') {
    const size = 20 * 1024 * 1024;
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': size, 'Content-Disposition': 'attachment; filename="essai-wclaude.zip"' });
    const chunk = Buffer.alloc(1024 * 1024, 7);
    let sent = 0;
    const pump = () => { while (sent < size) { sent += chunk.length; if (!res.write(chunk)) return res.once('drain', pump); } res.end(); };
    pump();
    return;
  }
  const route = routes[url.pathname];
  res.writeHead(route ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(route ? route() : 'Not found');
}).listen(PORT, '127.0.0.1', () => console.log(`fixtures on http://127.0.0.1:${PORT}`));
