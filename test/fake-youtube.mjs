// Faux serveur de l'API YouTube (127.0.0.1) pour essayer wCLAUDE sans compte : envoi par morceaux (avec une panne
// simulée pour vérifier la reprise), chaîne, liste et détail des vidéos, statistiques. Rien n'est écrit sur le disque.
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 8766);
const TOKEN = 'Bearer test';
const sessions = new Map();
let failedOnce = false;
const videos = [];

const json = (res, code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };

http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (req.headers.authorization !== TOKEN) return json(res, 401, { error: { message: 'bad token' } });

  if (req.method === 'POST' && url.pathname === '/upload/youtube/v3/videos') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const id = crypto.randomBytes(4).toString('hex');
      sessions.set(id, { total: Number(req.headers['x-upload-content-length']), received: 0, hash: crypto.createHash('sha256'), meta: JSON.parse(raw), chunks: 0 });
      json(res, 200, {}, { Location: `http://127.0.0.1:${PORT}/session/${id}` });
    });
    return;
  }
  if (req.method === 'PUT' && url.pathname.startsWith('/session/')) {
    const s = sessions.get(url.pathname.split('/')[2]);
    if (!s) return json(res, 404, { error: { message: 'no session' } });
    const range = String(req.headers['content-range'] || '');
    const status = range.match(/^bytes \*\/(\d+)$/);
    if (status) { req.resume(); return req.on('end', () => { res.writeHead(308, s.received ? { Range: `bytes=0-${s.received - 1}` } : {}); res.end(); }); }
    const m = range.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
    if (!m || Number(m[1]) !== s.received) { req.resume(); return json(res, 400, { error: { message: `bad range ${range}, expected start ${s.received}` } }); }
    s.chunks++;
    if (s.chunks === 2 && !failedOnce) { failedOnce = true; req.resume(); return req.on('end', () => json(res, 503, { error: { message: 'simulated outage' } })); }
    req.on('data', (c) => { s.received += c.length; s.hash.update(c); });
    req.on('end', () => {
      if (s.received < s.total) { res.writeHead(308, { Range: `bytes=0-${s.received - 1}` }); return res.end(); }
      const video = { id: 'fake' + crypto.randomBytes(3).toString('hex'), snippet: { title: s.meta.snippet.title, description: s.meta.snippet.description, publishedAt: new Date().toISOString(), categoryId: s.meta.snippet.categoryId }, status: { privacyStatus: s.meta.status.privacyStatus, uploadStatus: 'uploaded' }, statistics: { viewCount: '0', likeCount: '0', commentCount: '0' }, contentDetails: { duration: 'PT0S' }, bytes: s.received, sha256: s.hash.digest('hex') };
      videos.unshift(video);
      console.log(`received ${s.received} bytes in ${s.chunks} chunks (one failed): ${video.id} ${video.sha256}`);
      json(res, 200, video);
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/youtube/v3/channels') {
    return json(res, 200, { items: [{ id: 'UCfake', snippet: { title: 'Chaîne d\'essai', customUrl: '@essai' }, statistics: { subscriberCount: '42', viewCount: '1234', videoCount: String(videos.length) }, contentDetails: { relatedPlaylists: { uploads: 'UUfake' } } }] });
  }
  if (req.method === 'GET' && url.pathname === '/youtube/v3/playlistItems') {
    return json(res, 200, { items: videos.map((v) => ({ contentDetails: { videoId: v.id } })) });
  }
  if (req.method === 'GET' && url.pathname === '/youtube/v3/videos') {
    const ids = (url.searchParams.get('id') || '').split(',');
    return json(res, 200, { items: videos.filter((v) => ids.includes(v.id)) });
  }
  json(res, 404, { error: { message: 'not found ' + url.pathname } });
}).listen(PORT, '127.0.0.1', () => console.log(`fake YouTube on http://127.0.0.1:${PORT}`));
