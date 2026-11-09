// API officielle de YouTube (Data API v3 et Analytics) : connexion OAuth par le navigateur habituel de l'utilisateur,
// vidéos, métadonnées, miniatures, statistiques et envoi de vidéos de toute taille (envoi par morceaux avec reprise).
// La clé OAuth et les jetons restent dans le Trousseau ; l'agent IA ne les voit jamais.
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const keychain = require('./keychain');

const SERVICE = 'wCLAUDE YouTube';
const SCOPES = [
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
  'https://www.googleapis.com/auth/youtube.force-ssl', // sous-titres (captions.*)
];
// Adresses remplaçables pour les essais (serveur YouTube simulé) ; jamais réglées dans l'appli livrée.
const URLS = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: process.env.WCLAUDE_YT_TOKEN_URL || 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  api: process.env.WCLAUDE_YT_API || 'https://www.googleapis.com/youtube/v3',
  upload: process.env.WCLAUDE_YT_UPLOAD || 'https://www.googleapis.com/upload/youtube/v3',
  analytics: process.env.WCLAUDE_YT_ANALYTICS || 'https://youtubeanalytics.googleapis.com/v2',
};
const CHUNK = 32 * 1024 * 1024; // multiple de 256 Kio, exigé par YouTube
const jobs = new Map();
let nextJob = 1;
let tokenCache = null;

const readJSON = async (account) => {
  const v = await keychain.secretGet(SERVICE, account);
  return v ? JSON.parse(v) : null;
};
const writeJSON = (account, obj) => keychain.secretSet(SERVICE, account, JSON.stringify(obj));

// ---------- clé et connexion ----------
async function importClient(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const c = data.installed || data.web || data;
  if (!c.client_id || !c.client_secret) throw new Error('client_file');
  await writeJSON('client', { client_id: c.client_id, client_secret: c.client_secret });
  return status();
}

async function saveClient(clientId, clientSecret) {
  clientId = String(clientId || '').trim();
  clientSecret = String(clientSecret || '').trim();
  if (!/\.apps\.googleusercontent\.com$/.test(clientId) || clientSecret.length < 10) throw new Error('client_values');
  await writeJSON('client', { client_id: clientId, client_secret: clientSecret });
  return status();
}

async function status() {
  const client = await readJSON('client').catch(() => null);
  let token = await readJSON('token').catch(() => null);
  const connected = !!(token && token.refresh_token);
  // Jeton antérieur à l'enregistrement des autorisations : un rafraîchissement les fait connaître.
  if (connected && token.scopes === undefined && !process.env.WCLAUDE_YT_TEST_TOKEN) {
    await accessToken().catch(() => {});
    token = await readJSON('token').catch(() => token);
  }
  const granted = connected && typeof token.scopes === 'string' ? token.scopes.split(/\s+/) : null;
  const missingScopes = granted ? SCOPES.filter((s) => !granted.includes(s)) : [];
  return { clientConfigured: !!client, connected, needsReconnect: missingScopes.length > 0, missingScopes, channel: token ? token.channel || null : null };
}

async function tokenRequest(params) {
  const res = await fetch(URLS.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error_description || data.error || `token ${res.status}`);
    err.code = data.error;
    throw err;
  }
  return data;
}

/**
 * Ouvre la page d'autorisation de Google dans le navigateur habituel (exigence de Google pour les applis de bureau),
 * reçoit le code sur 127.0.0.1, l'échange contre des jetons et les range dans le Trousseau.
 */
async function connect({ openExternal, page }) {
  const client = await readJSON('client');
  if (!client) throw new Error('no_client');
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('hex');
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const redirect = `http://127.0.0.1:${server.address().port}`;
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 5 * 60 * 1000);
    server.on('request', (req, res) => {
      const u = new URL(req.url, redirect);
      if (u.pathname !== '/') { res.writeHead(404); return res.end(); }
      const ok = u.searchParams.get('state') === state && u.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page(!!ok));
      clearTimeout(timer);
      if (ok) resolve(u.searchParams.get('code'));
      else reject(new Error(u.searchParams.get('error') || 'denied'));
    });
    const url = new URL(URLS.auth);
    url.search = new URLSearchParams({
      client_id: client.client_id, redirect_uri: redirect, response_type: 'code', scope: SCOPES.join(' '),
      code_challenge: challenge, code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent', state,
    }).toString();
    openExternal(url.toString());
  }).finally(() => server.close());
  const tok = await tokenRequest({ code, client_id: client.client_id, client_secret: client.client_secret, redirect_uri: redirect, grant_type: 'authorization_code', code_verifier: verifier });
  tokenCache = { access_token: tok.access_token, expires_at: Date.now() + tok.expires_in * 1000 };
  const token = { refresh_token: tok.refresh_token, scopes: tok.scope || SCOPES.join(' '), channel: null };
  await writeJSON('token', token);
  const ch = await channel().catch(() => null);
  token.channel = ch ? { id: ch.id, title: ch.title } : null;
  await writeJSON('token', token);
  return status();
}

async function disconnect() {
  const token = await readJSON('token').catch(() => null);
  if (token && token.refresh_token) {
    await fetch(`${URLS.revoke}?token=${encodeURIComponent(token.refresh_token)}`, { method: 'POST' }).catch(() => {});
  }
  tokenCache = null;
  await keychain.secretDelete(SERVICE, 'token');
  return status();
}

async function accessToken() {
  if (process.env.WCLAUDE_YT_TEST_TOKEN) return process.env.WCLAUDE_YT_TEST_TOKEN;
  if (tokenCache && tokenCache.expires_at - 60000 > Date.now()) return tokenCache.access_token;
  const client = await readJSON('client');
  const token = await readJSON('token');
  if (!client || !token || !token.refresh_token) throw new Error('not_connected');
  try {
    const tok = await tokenRequest({ client_id: client.client_id, client_secret: client.client_secret, refresh_token: token.refresh_token, grant_type: 'refresh_token' });
    tokenCache = { access_token: tok.access_token, expires_at: Date.now() + tok.expires_in * 1000 };
    if (tok.scope && tok.scope !== token.scopes) await writeJSON('token', { ...token, scopes: tok.scope }).catch(() => {});
    return tok.access_token;
  } catch (e) {
    if (e.code === 'invalid_grant') { await keychain.secretDelete(SERVICE, 'token'); throw new Error('not_connected'); }
    throw e;
  }
}

async function call(method, base, route, { query, body, headers = {} } = {}) {
  const url = new URL(base + route);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, ...(body && !(body instanceof Buffer) ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? (body instanceof Buffer ? body : JSON.stringify(body)) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data.error || {};
    const reason = ((e.errors || [])[0] || {}).reason;
    // Connexion faite avant l'ajout d'une autorisation (ex. sous-titres) : il faut reconnecter la chaîne.
    if (res.status === 403 && (reason === 'insufficientPermissions' || /insufficient (authentication )?scopes/i.test(e.message || ''))) throw new Error('reconnect_needed');
    const err = new Error(e.message || e.status || `YouTube ${res.status}`);
    err.reason = reason;
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------- lecture ----------
async function channel() {
  const d = await call('GET', URLS.api, '/channels', { query: { part: 'snippet,statistics,contentDetails', mine: 'true' } });
  const c = (d.items || [])[0];
  if (!c) throw new Error('no_channel');
  return {
    id: c.id, title: c.snippet.title, customUrl: c.snippet.customUrl,
    subscribers: c.statistics.subscriberCount, views: c.statistics.viewCount, videos: c.statistics.videoCount,
    uploadsPlaylist: c.contentDetails.relatedPlaylists.uploads,
  };
}

const simplify = (v) => ({
  id: v.id,
  title: v.snippet && v.snippet.title,
  publishedAt: v.snippet && v.snippet.publishedAt,
  privacy: v.status && v.status.privacyStatus,
  publishAt: v.status && v.status.publishAt,
  uploadStatus: v.status && v.status.uploadStatus,
  duration: v.contentDetails && v.contentDetails.duration,
  views: v.statistics && v.statistics.viewCount,
  likes: v.statistics && v.statistics.likeCount,
  comments: v.statistics && v.statistics.commentCount,
  url: `https://youtu.be/${v.id}`,
});

async function listVideos({ max = 25, pageToken } = {}) {
  const ch = await channel();
  const items = await call('GET', URLS.api, '/playlistItems', { query: { part: 'contentDetails', playlistId: ch.uploadsPlaylist, maxResults: Math.min(50, max), pageToken } });
  const ids = (items.items || []).map((i) => i.contentDetails.videoId);
  if (!ids.length) return { videos: [], nextPageToken: null };
  const vids = await call('GET', URLS.api, '/videos', { query: { part: 'snippet,status,statistics,contentDetails', id: ids.join(',') } });
  return { videos: (vids.items || []).map(simplify), nextPageToken: items.nextPageToken || null };
}

async function getVideo(id) {
  const d = await call('GET', URLS.api, '/videos', { query: { part: 'snippet,status,statistics,contentDetails,processingDetails', id } });
  const v = (d.items || [])[0];
  if (!v) throw new Error('video_not_found');
  return { ...simplify(v), description: v.snippet.description, tags: v.snippet.tags || [], categoryId: v.snippet.categoryId, madeForKids: v.status.madeForKids, processing: v.processingDetails && v.processingDetails.processingStatus };
}

async function analytics({ startDate, endDate, metrics, dimensions, videoId, sort, maxResults }) {
  return call('GET', URLS.analytics, '/reports', {
    query: {
      ids: 'channel==MINE', startDate, endDate,
      metrics: metrics || 'views,estimatedMinutesWatched,averageViewDuration,likes,subscribersGained',
      dimensions, sort, maxResults, filters: videoId ? `video==${videoId}` : undefined,
    },
  });
}

// ---------- modification ----------
async function updateVideo(id, patch) {
  const d = await call('GET', URLS.api, '/videos', { query: { part: 'snippet,status', id } });
  const v = (d.items || [])[0];
  if (!v) throw new Error('video_not_found');
  const snippet = { title: v.snippet.title, description: v.snippet.description, tags: v.snippet.tags, categoryId: v.snippet.categoryId, defaultLanguage: v.snippet.defaultLanguage };
  const st = { privacyStatus: v.status.privacyStatus, publishAt: v.status.publishAt, selfDeclaredMadeForKids: v.status.selfDeclaredMadeForKids, embeddable: v.status.embeddable, license: v.status.license, publicStatsViewable: v.status.publicStatsViewable };
  if (patch.title !== undefined) snippet.title = patch.title;
  if (patch.description !== undefined) snippet.description = patch.description;
  if (patch.tags !== undefined) snippet.tags = patch.tags;
  if (patch.categoryId !== undefined) snippet.categoryId = patch.categoryId;
  if (patch.privacy !== undefined) st.privacyStatus = patch.privacy;
  if (patch.publishAt !== undefined) { st.publishAt = patch.publishAt || undefined; if (patch.publishAt) st.privacyStatus = 'private'; }
  const res = await call('PUT', URLS.api, '/videos', { query: { part: 'snippet,status' }, body: { id, snippet, status: st } });
  return simplify(res);
}

async function setThumbnail(id, file) {
  const buf = fs.readFileSync(file);
  if (buf.length > 2 * 1024 * 1024) throw new Error('thumbnail_too_big');
  const type = /\.png$/i.test(file) ? 'image/png' : 'image/jpeg';
  return call('POST', URLS.upload, '/thumbnails/set', { query: { videoId: id, uploadType: 'media' }, body: buf, headers: { 'Content-Type': type } });
}

// ---------- sous-titres ----------
const simplifyCaption = (c) => ({
  id: c.id, language: c.snippet.language, name: c.snippet.name || '', kind: c.snippet.trackKind,
  draft: !!c.snippet.isDraft, status: c.snippet.status, lastUpdated: c.snippet.lastUpdated,
});

async function listCaptions(videoId) {
  if (!videoId) throw new Error('video_id_required');
  const d = await call('GET', URLS.api, '/captions', { query: { part: 'snippet', videoId } });
  return (d.items || []).map(simplifyCaption);
}

/**
 * Ajoute une piste de sous-titres (SRT, VTT, SBV, SCC, TTML…) à une vidéo. Avec `replace`, une piste de même langue
 * et de même nom est remplacée au lieu d'en créer une seconde (YouTube refuse les doublons).
 */
async function uploadCaption({ videoId, path: file, language, name = '', draft = false, replace = false }) {
  if (!videoId) throw new Error('video_id_required');
  if (!language) throw new Error('language_required');
  const st = fs.statSync(file);
  if (!st.isFile()) throw new Error('file_not_found');
  if (st.size > 100 * 1024 * 1024) throw new Error('caption_too_big');
  name = String(name || '');
  const existing = replace
    ? (await listCaptions(videoId)).find((c) => c.kind !== 'asr' && c.language.toLowerCase() === language.toLowerCase() && c.name === name)
    : null;
  const meta = existing ? { id: existing.id, snippet: { isDraft: !!draft } } : { snippet: { videoId, language, name, isDraft: !!draft } };
  const boundary = 'wclaude' + crypto.randomBytes(12).toString('hex');
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
    fs.readFileSync(file),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await call(existing ? 'PUT' : 'POST', URLS.upload, '/captions', {
    query: { part: 'snippet', uploadType: 'multipart' }, body, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
  });
  return { ...simplifyCaption(res), replaced: !!existing };
}

// ---------- envoi de vidéo (par morceaux, reprise automatique) ----------
const VIDEO_TYPES = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo' };

function startUpload(opts) {
  const st = fs.statSync(opts.path);
  if (!st.isFile()) throw new Error('file_not_found');
  const job = { id: nextJob++, path: opts.path, name: path.basename(opts.path), size: st.size, sent: 0, state: 'starting', videoId: null, error: null, startedAt: Date.now(), endedAt: null };
  jobs.set(job.id, job);
  runUpload(job, opts).catch((e) => { job.state = 'error'; job.error = String(e.message || e); job.endedAt = Date.now(); });
  return job;
}

async function runUpload(job, o) {
  const type = VIDEO_TYPES[path.extname(job.path).toLowerCase()] || 'application/octet-stream';
  const meta = {
    snippet: { title: o.title, description: o.description || '', tags: o.tags || undefined, categoryId: o.categoryId || '20' },
    status: { privacyStatus: o.publishAt ? 'private' : (o.privacy || 'private'), publishAt: o.publishAt || undefined, selfDeclaredMadeForKids: !!o.madeForKids },
  };
  const init = await fetch(`${URLS.upload}/videos?uploadType=resumable&part=snippet,status&notifySubscribers=${o.notifySubscribers ? 'true' : 'false'}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(job.size), 'X-Upload-Content-Type': type },
    body: JSON.stringify(meta),
  });
  if (!init.ok) {
    const d = await init.json().catch(() => ({}));
    throw new Error((d.error && d.error.message) || `YouTube ${init.status}`);
  }
  const session = init.headers.get('location');
  if (!session) throw new Error('no_upload_session');
  job.state = 'uploading';
  const fd = fs.openSync(job.path, 'r');
  try {
    let failures = 0;
    while (job.state === 'uploading') {
      const start = job.sent;
      const end = Math.min(start + CHUNK, job.size) - 1;
      const buf = Buffer.alloc(end - start + 1);
      fs.readSync(fd, buf, 0, buf.length, start);
      let res;
      try {
        res = await fetch(session, {
          method: 'PUT', redirect: 'manual',
          headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Length': String(buf.length), 'Content-Range': `bytes ${start}-${end}/${job.size}`, 'Content-Type': type },
          body: buf,
        });
      } catch (e) {
        if (++failures > 6) throw e;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** failures));
        res = await fetch(session, { method: 'PUT', redirect: 'manual', headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Length': '0', 'Content-Range': `bytes */${job.size}` } }).catch(() => null);
        if (!res) continue;
      }
      if (res.status === 308) {
        const range = res.headers.get('range');
        job.sent = range ? Number(range.split('-')[1]) + 1 : 0;
        failures = 0;
        continue;
      }
      if (res.status === 200 || res.status === 201) {
        const v = await res.json();
        job.sent = job.size;
        job.videoId = v.id;
        job.state = 'done';
        job.endedAt = Date.now();
        return;
      }
      if (res.status >= 500 && ++failures <= 6) { await new Promise((r) => setTimeout(r, 1000 * 2 ** failures)); continue; }
      const d = await res.json().catch(() => ({}));
      throw new Error((d.error && d.error.message) || `YouTube ${res.status}`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

const publicJob = (j) => j && { id: j.id, name: j.name, path: j.path, size: j.size, sent: j.sent, state: j.state, videoId: j.videoId, url: j.videoId ? `https://youtu.be/${j.videoId}` : null, error: j.error, startedAt: j.startedAt, endedAt: j.endedAt };
const uploadStatus = (id) => publicJob(jobs.get(Number(id)));
const uploading = () => [...jobs.values()].some((j) => j.state === 'uploading' || j.state === 'starting');

module.exports = { importClient, saveClient, status, connect, disconnect, channel, listVideos, getVideo, analytics, updateVideo, setThumbnail, listCaptions, uploadCaption, startUpload, uploadStatus, uploading, SCOPES };
