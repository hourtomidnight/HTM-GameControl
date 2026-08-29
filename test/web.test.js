const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createEventStore } = require('../src/event-store');
const { createGameStore } = require('../src/game-store');
const { createGameEngine } = require('../src/game-engine');
const { createWebServer } = require('../src/web');

function boot(overrides = {}) {
  const es = createEventStore({ path: ':memory:' });
  const gs = createGameStore(es.db);
  const engine = createGameEngine({ eventStore: es, gameStore: gs,
    now: () => 1, setInterval: () => 0, clearInterval: () => {} });
  const cfg = overrides.config || { current: () => ({ roomName: 'X' }), save: (o) => ({ ok: true, errors: [] }) };
  const sheets = overrides.sheets || { readOperators: async () => ['Sam'] };
  const signalBus = overrides.signalBus || { snapshot: () => ({}), on: () => {}, off: () => {} };
  const { server, close } = createWebServer({ engine, config: cfg, sheets, signalBus,
    eventStore: es, gameStore: gs, publicDir: __dirname + '/../public', port: 0 });
  return { server, close, es, gs };
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
