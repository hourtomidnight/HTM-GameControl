const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEventStore } = require('../src/event-store');
const { createGameStore } = require('../src/game-store');
const { createGameEngine } = require('../src/game-engine');
const { createMediaLibrary } = require('../src/media-library');
const { createWebServer } = require('../src/web');

function boot(overrides = {}) {
  const es = createEventStore({ path: ':memory:' });
  const gs = createGameStore(es.db);
  const engine = createGameEngine({ eventStore: es, gameStore: gs,
    now: () => 1, setInterval: () => 0, clearInterval: () => {} });
  const cfg = overrides.config || { current: () => ({ roomName: 'X' }), save: (o) => ({ ok: true, errors: [] }) };
  const sheets = overrides.sheets || { readOperators: async () => ['Sam'] };
  const signalBus = overrides.signalBus || { snapshot: () => ({}), on: () => {}, off: () => {} };
  const mediaRoot = overrides.mediaRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'media-'));
  const mediaLibrary = overrides.mediaLibrary || createMediaLibrary({
    db: es.db, root: mediaRoot, steps: overrides.steps || (() => []),
  });
  const { server, close } = createWebServer({ engine, config: cfg, sheets, signalBus,
    eventStore: es, gameStore: gs, mediaLibrary, mediaRoot, publicDir: __dirname + '/../public', port: 0 });
  return { server, close, es, gs, mediaLibrary, mediaRoot };
}

function buildMultipart(boundary, parts) {
  const CRLF = '\r\n';
  let body = '';
  for (const p of parts) {
    body += `--${boundary}${CRLF}`;
    if (p.filename !== undefined) {
      body += `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"${CRLF}`;
      body += `Content-Type: ${p.contentType || 'application/octet-stream'}${CRLF}${CRLF}`;
    } else {
      body += `Content-Disposition: form-data; name="${p.name}"${CRLF}${CRLF}`;
    }
    body += p.content + CRLF;
  }
  body += `--${boundary}--${CRLF}`;
  return Buffer.from(body, 'binary');
}

function reqRaw(server, method, urlPath, buf, headers) {
  const { port } = server.address();
  return new Promise((resolve) => {
    const r = http.request({ port, method, path: urlPath, headers }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    if (buf) r.write(buf);
    r.end();
  });
}

function req(server, method, path, body) {
  const { port } = server.address();
  return new Promise((resolve) => {
    const r = http.request({ port, method, path }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

test('POST /cmd drives the engine', async () => {
  const { server, close, gs } = boot();
  await new Promise(r => server.listen(0, r));
  const res = await req(server, 'POST', '/cmd', { type: 'start' });
  assert.strictEqual(res.status, 204);
  assert.ok(gs.recent().length === 1);
  close();
});

test('POST /cmd with bad JSON returns 400', async () => {
  const { server, close } = boot();
  await new Promise(r => server.listen(0, r));
  const { port } = server.address();
  const res = await new Promise((resolve) => {
    const r = http.request({ port, method: 'POST', path: '/cmd' }, (rs) => {
      let d = ''; rs.on('data', c => d += c); rs.on('end', () => resolve({ status: rs.statusCode, body: d }));
    });
    r.write('{not json');
    r.end();
  });
  assert.strictEqual(res.status, 400);
  close();
});

test('GET /config returns current config', async () => {
  const { server, close } = boot();
  await new Promise(r => server.listen(0, r));
  const res = await req(server, 'GET', '/config');
  assert.deepStrictEqual(JSON.parse(res.body), { roomName: 'X' });
  close();
});

test('POST /config returns 204 when save succeeds', async () => {
  const { server, close } = boot();
  await new Promise(r => server.listen(0, r));
  const res = await req(server, 'POST', '/config', { game: { timerMinutes: 'no' } });
  // boot()'s stub always returns ok:true, so this asserts the happy path.
  assert.strictEqual(res.status, 204);
  close();
});

test('POST /config failure path returns 400 with errors body', async () => {
  const { server, close } = boot({
    config: { current: () => ({}), save: () => ({ ok: false, errors: ['bad'] }) },
  });
  await new Promise(r => server.listen(0, r));
  const res = await req(server, 'POST', '/config', { anything: true });
  assert.strictEqual(res.status, 400);
  assert.match(res.body, /errors/);
  assert.deepStrictEqual(JSON.parse(res.body), { errors: ['bad'] });
  close();
});

test('GET /api/operators returns names', async () => {
  const { server, close } = boot();
  await new Promise(r => server.listen(0, r));
  const res = await req(server, 'GET', '/api/operators');
  assert.deepStrictEqual(JSON.parse(res.body), { operators: ['Sam'] });
  close();
});

test('GET /api/operators falls back to [] when sheets throws', async () => {
  const { server, close } = boot({
    sheets: { readOperators: async () => { throw new Error('nope'); } },
  });
  await new Promise(r => server.listen(0, r));
  const res = await req(server, 'GET', '/api/operators');
  assert.deepStrictEqual(JSON.parse(res.body), { operators: [] });
  close();
});

test('GET /api/signals merges snapshot with config defs', async () => {
  const { server, close } = boot({
    config: { current: () => ({ signals: [{ name: 'door', direction: 'in' }] }), save: () => ({ ok: true }) },
    signalBus: { snapshot: () => ({ door: { value: 1, quality: 'ok' } }), on: () => {}, off: () => {} },
  });
  await new Promise(r => server.listen(0, r));
  const res = await req(server, 'GET', '/api/signals');
  const arr = JSON.parse(res.body);
  assert.ok(Array.isArray(arr));
  assert.strictEqual(arr[0].name, 'door');
  assert.strictEqual(arr[0].value, 1);
  assert.strictEqual(arr[0].quality, 'ok');
  assert.strictEqual(arr[0].direction, 'in');
  close();
});

test('GET /api/games returns recent games', async () => {
  const { server, close, gs } = boot();
  await new Promise(r => server.listen(0, r));
  await req(server, 'POST', '/cmd', { type: 'start' });
  const res = await req(server, 'GET', '/api/games?limit=5');
  const arr = JSON.parse(res.body);
  assert.strictEqual(arr.length, 1);
  close();
});

test('GET /api/events queries the event store', async () => {
  const { server, close } = boot();
  await new Promise(r => server.listen(0, r));
  await req(server, 'POST', '/cmd', { type: 'start' });
  const res = await req(server, 'GET', '/api/events?type=start');
  const arr = JSON.parse(res.body);
  assert.ok(Array.isArray(arr));
  assert.ok(arr.every(e => e.type === 'start'));
  close();
});

test('GET /healthz ok', async () => {
  const { server, close } = boot();
  await new Promise(r => server.listen(0, r));
  const res = await req(server, 'GET', '/healthz');
  const j = JSON.parse(res.body);
  assert.strictEqual(j.ok, true);
  assert.strictEqual(j.db, true);
  assert.strictEqual(typeof j.uptime, 'number');
  close();
});

test('GET /% (malformed percent-escape) returns 400 and server stays responsive', async () => {
  const { server, close } = boot();
  await new Promise(r => server.listen(0, r));
  const bad = await req(server, 'GET', '/%');
  assert.strictEqual(bad.status, 400);
  const ok = await req(server, 'GET', '/healthz');
  assert.strictEqual(JSON.parse(ok.body).ok, true);
  close();
});

test('factory does not listen; caller owns server.listen', async () => {
  const { server, close } = boot();
  assert.strictEqual(server.listening, false);
  await new Promise(r => server.listen(0, r));
  assert.strictEqual(server.listening, true);
  close();
});

test('OPTIONS returns 204 with CORS headers', async () => {
  const { server, close } = boot();
  await new Promise(r => server.listen(0, r));
  const { port } = server.address();
  const res = await new Promise((resolve) => {
    const r = http.request({ port, method: 'OPTIONS', path: '/cmd' }, (rs) => {
      rs.on('data', () => {}); rs.on('end', () => resolve({ status: rs.statusCode, headers: rs.headers }));
    });
    r.end();
  });
  assert.strictEqual(res.status, 204);
  assert.strictEqual(res.headers['access-control-allow-origin'], '*');
  close();
});

test('GET /events streams SSE and detaches listeners on close', async () => {
  let onChangeRef = null;
  let offCalled = false;
  const signalBus = {
    snapshot: () => ({}),
    on: (ev, fn) => { if (ev === 'change') onChangeRef = fn; },
    off: (ev, fn) => { if (ev === 'change' && fn === onChangeRef) offCalled = true; },
  };
  const { server, close } = boot({ signalBus });
  await new Promise(r => server.listen(0, r));
  const { port } = server.address();
  await new Promise((resolve, reject) => {
    const r = http.request({ port, method: 'GET', path: '/events' }, (res) => {
      let d = '';
      res.on('data', (c) => {
        d += c;
        if (d.includes('retry: 3000') && d.includes('data:')) {
          assert.ok(onChangeRef, 'signalBus.on("change") registered');
          r.destroy();
          resolve();
        }
      });
      res.on('error', () => {});
    });
    r.on('error', reject);
    r.end();
  });
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(offCalled, true, 'signalBus.off called on client disconnect');
  close();
});

test('a malformed request path does not crash the server', async () => {
  const { server, close } = boot();
  await new Promise(r => server.listen(0, r));
  const bad = await req(server, 'GET', '//');
  assert.strictEqual(bad.status, 400);
  // server still serves normal requests afterward
  const ok = await req(server, 'GET', '/healthz');
  assert.strictEqual(ok.status, 200);
  close();
});

test('GET /api/media lists files', async () => {
  const { server, close, mediaLibrary } = boot();
  mediaLibrary.save('clip.mp3', Buffer.from('FAKE'));
  await new Promise(r => server.listen(0, r));
  const res = await req(server, 'GET', '/api/media');
  const body = JSON.parse(res.body);
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(body.files));
  assert.strictEqual(body.files.length, 1);
  assert.strictEqual(body.files[0].path, 'clip.mp3');
  close();
});

test('POST /api/media/upload with a valid mp3 multipart body saves it and returns 200', async () => {
  const { server, close, mediaLibrary } = boot();
  await new Promise(r => server.listen(0, r));
  const boundary = 'X-UPLOAD-BOUNDARY';
  const buf = buildMultipart(boundary, [
    { name: 'file', filename: 'clip.mp3', contentType: 'audio/mpeg', content: 'FAKE-MP3-BYTES' },
  ]);
  const res = await reqRaw(server, 'POST', '/api/media/upload', buf, {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'Content-Length': buf.length,
  });
  assert.strictEqual(res.status, 200);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.path, 'clip.mp3');
  assert.ok(mediaLibrary.list().some(f => f.path === 'clip.mp3'));
  close();
});

test('POST /api/media/upload with a disallowed extension returns 400', async () => {
  const { server, close } = boot();
  await new Promise(r => server.listen(0, r));
  const boundary = 'X-UPLOAD-BOUNDARY-2';
  const buf = buildMultipart(boundary, [
    { name: 'file', filename: 'virus.exe', contentType: 'application/octet-stream', content: 'BAD' },
  ]);
  const res = await reqRaw(server, 'POST', '/api/media/upload', buf, {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'Content-Length': buf.length,
  });
  assert.strictEqual(res.status, 400);
  const body = JSON.parse(res.body);
  assert.ok(body.error);
  close();
});

test('DELETE /api/media?path=… on a referenced file returns 409 with inUse', async () => {
  const steps = [{ id: 'step1', hints: [{ type: 'audio', mediaRef: 'clip.mp3' }] }];
  const { server, close, mediaLibrary } = boot({ steps: () => steps });
  mediaLibrary.save('clip.mp3', Buffer.from('FAKE'));
  await new Promise(r => server.listen(0, r));
  const res = await req(server, 'DELETE', '/api/media?path=clip.mp3');
  assert.strictEqual(res.status, 409);
  const body = JSON.parse(res.body);
  assert.deepStrictEqual(body.inUse, ['step1']);
  close();
});

test('POST /api/media/upload with a request stream error returns 400, not a crash', async () => {
  const { server, close } = boot();
  await new Promise(r => server.listen(0, r));
  const { port } = server.address();
  const boundary = 'X-ERR-BOUNDARY';
  const res = await new Promise((resolve, reject) => {
    const r = http.request({
      port, method: 'POST', path: '/api/media/upload',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    }, (rs) => {
      let d = ''; rs.on('data', c => d += c);
      rs.on('end', () => resolve({ status: rs.statusCode, body: d }));
    });
    r.on('error', () => {}); // client-side abort also errors the socket; ignore here
    // Write a partial body then abort the request mid-stream to trigger
    // a server-side 'error' event on req while the body is still being collected.
    r.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="clip.mp3"\r\n\r\npartial`);
    r.destroy(new Error('simulated client abort'));
    setTimeout(() => resolve({ status: 'no-response' }), 500).unref?.();
  });
  // The server must not crash or hang; either it responds with an error status,
  // or the connection is dropped without a response (both are safe outcomes —
  // what matters is the process stays alive to serve the next request).
  assert.ok(res.status === 400 || res.status === 'no-response');
  const ok = await req(server, 'GET', '/healthz');
  assert.strictEqual(ok.status, 200);
  close();
});

test('GET /media/<relPath> serves the file bytes', async () => {
  const { server, close, mediaLibrary } = boot();
  mediaLibrary.save('clip.mp3', Buffer.from('FAKE-MP3-BYTES'));
  await new Promise(r => server.listen(0, r));
  const res = await req(server, 'GET', '/media/clip.mp3');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body, 'FAKE-MP3-BYTES');
  close();
});

test('GET /media/<relPath> 404s for a missing file', async () => {
  const { server, close } = boot();
  await new Promise(r => server.listen(0, r));
  const res = await req(server, 'GET', '/media/nope.mp3');
  assert.strictEqual(res.status, 404);
  close();
});

test('GET /media/<relPath> 404s on a path-traversal attempt', async () => {
  const { server, close } = boot();
  await new Promise(r => server.listen(0, r));
  const res = await req(server, 'GET', '/media/..%2f..%2fpackage.json');
  assert.strictEqual(res.status, 404);
  close();
});

test('POST /api/media/meta sets title/tags and returns 200', async () => {
  const { server, close, mediaLibrary } = boot();
  mediaLibrary.save('clip.mp3', Buffer.from('FAKE'));
  await new Promise(r => server.listen(0, r));
  const res = await req(server, 'POST', '/api/media/meta', { path: 'clip.mp3', title: 'Clue 1', tags: 'a,b' });
  assert.strictEqual(res.status, 200);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.path, 'clip.mp3');
  assert.strictEqual(body.title, 'Clue 1');
  const file = mediaLibrary.list().find(f => f.path === 'clip.mp3');
  assert.strictEqual(file.title, 'Clue 1');
  assert.strictEqual(file.tags, 'a,b');
  close();
});

test('POST /api/media/move renames the file, rewrites mediaRef, and persists config', async () => {
  const steps = [{ id: 'step1', hints: [{ type: 'audio', mediaRef: 'clip.mp3' }] }];
  let saved = null;
  const cfg = {
    current: () => ({ steps }),
    save: (o) => { saved = o; return { ok: true, errors: [] }; },
  };
  const { server, close, mediaLibrary } = boot({ config: cfg, steps: () => steps });
  mediaLibrary.save('clip.mp3', Buffer.from('FAKE'));
  await new Promise(r => server.listen(0, r));
  const res = await req(server, 'POST', '/api/media/move', { from: 'clip.mp3', to: 'renamed.mp3' });
  assert.strictEqual(res.status, 200);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.path, 'renamed.mp3');
  assert.strictEqual(body.refsChanged, 1);
  assert.strictEqual(steps[0].hints[0].mediaRef, 'renamed.mp3');
  assert.ok(saved, 'config.save was called');
  assert.strictEqual(saved.steps[0].hints[0].mediaRef, 'renamed.mp3');
  close();
});

test('POST /api/media/move returns 500 with errors when config.save fails', async () => {
  const steps = [{ id: 'step1', hints: [{ type: 'audio', mediaRef: 'clip.mp3' }] }];
  const cfg = {
    current: () => ({ steps }),
    save: () => ({ ok: false, errors: ['bad config'] }),
  };
  const { server, close, mediaLibrary } = boot({ config: cfg, steps: () => steps });
  mediaLibrary.save('clip.mp3', Buffer.from('FAKE'));
  await new Promise(r => server.listen(0, r));
  const res = await req(server, 'POST', '/api/media/move', { from: 'clip.mp3', to: 'renamed.mp3' });
  assert.strictEqual(res.status, 500);
  const body = JSON.parse(res.body);
  assert.deepStrictEqual(body.errors, ['bad config']);
  close();
});

test('DELETE /api/media with missing path returns 400', async () => {
  const { server, close } = boot();
  await new Promise(r => server.listen(0, r));
  const res = await req(server, 'DELETE', '/api/media');
  assert.strictEqual(res.status, 400);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.error, 'missing path');
  close();
});

test('GET /api/media/usage returns bytes/count/freeBytes', async () => {
  const { server, close, mediaLibrary } = boot();
  mediaLibrary.save('clip.mp3', Buffer.from('FAKE-BYTES'));
  await new Promise(r => server.listen(0, r));
  const res = await req(server, 'GET', '/api/media/usage');
  assert.strictEqual(res.status, 200);
  const body = JSON.parse(res.body);
  assert.strictEqual(typeof body.bytes, 'number');
  assert.strictEqual(body.count, 1);
  assert.ok('freeBytes' in body);
  close();
});
