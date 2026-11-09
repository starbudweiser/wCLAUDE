// Sous-titres YouTube contre le faux serveur : ajout, refus d'un doublon, remplacement, liste.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('captions: insert, duplicate refused, replace, list', async () => {
  const port = 8767;
  const srv = spawn(process.execPath, [fileURLToPath(new URL('./fake-youtube.mjs', import.meta.url))], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r, j) => { srv.stdout.once('data', r); srv.once('exit', () => j(new Error('fake server exited'))); });
  try {
    Object.assign(process.env, { WCLAUDE_YT_TEST_TOKEN: 'test', WCLAUDE_YT_API: `http://127.0.0.1:${port}/youtube/v3`, WCLAUDE_YT_UPLOAD: `http://127.0.0.1:${port}/upload/youtube/v3` });
    const yt = createRequire(import.meta.url)('../app/lib/youtube.js');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wcl-')), 'v.fr.srt');
    fs.writeFileSync(file, '1\n00:00:00,250 --> 00:00:02,000\nC\'est fini… é\n');
    const a = await yt.uploadCaption({ videoId: 'vid1', path: file, language: 'fr' });
    assert.equal(a.language, 'fr'); assert.equal(a.replaced, false);
    await assert.rejects(yt.uploadCaption({ videoId: 'vid1', path: file, language: 'fr' }), /captionExists/);
    const b = await yt.uploadCaption({ videoId: 'vid1', path: file, language: 'fr', replace: true, draft: true });
    assert.equal(b.id, a.id); assert.equal(b.replaced, true); assert.equal(b.draft, true);
    await yt.uploadCaption({ videoId: 'vid1', path: file, language: 'en' });
    const list = await yt.listCaptions('vid1');
    assert.deepEqual(list.map((c) => c.language).sort(), ['en', 'fr']);
  } finally { srv.kill(); }
});
