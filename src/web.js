// HTTP server: static files + SSE event relay + REST API.
// Node built-ins only. Factory: createWebServer(deps) -> { server, close }.
// Owns NO game state — delegates to the injected engine.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

function toInt(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? undefined : n;
}

function createWebServer(deps) {
  const {
    engine, config, sheets, signalBus, eventStore, gameStore, publicDir,
    port = 0,
  } = deps;

  const ROOT = path.resolve(publicDir);
  const startedAt = Date.now();
  const clients = new Set();

  function broadcast(obj) {
    const line = 'data: ' + JSON.stringify(obj) + '\n\n';
    for (const res of clients) {
      try { res.write(line); } catch { clients.delete(res); }
    }
  }

  function handleSignals(res) {
    let defs = [];
    try { defs = (config.current() || {}).signals || []; } catch { defs = []; }
    const defByName = new Map(defs.map((d) => [d.name, d]));
    let snap = {};
    try { snap = signalBus.snapshot() || {}; } catch { snap = {}; }
    const names = new Set([...Object.keys(snap), ...defByName.keys()]);
    const out = [];
    for (const name of names) {
      const s = snap[name] || {};
      const def = defByName.get(name) || {};
      out.push({
        name,
        value: s.value !== undefined ? s.value : null,
        quality: s.quality !== undefined ? s.quality : 'stale',
        direction: def.direction, // best-effort; undefined if unknown
        ts: s.ts,
      });
    }
    sendJson(res, 200, out);
  }

  async function handleOperators(res) {
    let operators = [];
    try { operators = await sheets.readOperators(); } catch { operators = []; }
    if (!Array.isArray(operators)) operators = [];
    sendJson(res, 200, { operators });
  }

  function serveStatic(req, res, urlPath) {
    const rel = urlPath === '/' ? '/operator.html' : urlPath;
    const filePath = path.join(ROOT, decodeURIComponent(rel));
    if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
      res.writeHead(403); res.end('Forbidden');
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found: ' + urlPath); return; }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    });
  }

  const server = http.createServer(async (req, res) => {
    cors(res);

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const parsed = new URL(req.url, 'http://localhost');
    const url = parsed.pathname;
    const q = parsed.searchParams;

    // ── GET /events — SSE ────────────────────────────────────────────────
    if (url === '/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      const send = (obj) => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch {} };
      try { send(engine.getState()); } catch {}
      const offState = engine.onState(send);
      const onChange = (e) => send({ type: 'signal-change', ...e });
      signalBus.on('change', onChange);
      clients.add(res);
      req.on('close', () => {
        clients.delete(res);
        try { if (typeof offState === 'function') offState(); } catch {}
        try { signalBus.off('change', onChange); } catch {}
      });
      return;
    }

    // ── POST /cmd ───────────────────────────────────────────────────────
    if (url === '/cmd' && req.method === 'POST') {
      try {
        const msg = JSON.parse(await readBody(req));
        try { engine.command(msg); } catch (e) { /* engine guards internally */ }
        res.writeHead(204); res.end();
      } catch {
        res.writeHead(400); res.end('Bad JSON');
      }
      return;
    }

    // ── GET /config ─────────────────────────────────────────────────────
    if (url === '/config' && req.method === 'GET') {
      let cur = {};
      try { cur = config.current(); } catch { cur = {}; }
      sendJson(res, 200, cur);
      return;
    }

    // ── POST /config ────────────────────────────────────────────────────
    if (url === '/config' && req.method === 'POST') {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        res.writeHead(400); res.end('Bad JSON');
        return;
      }
      const result = config.save(body) || {};
      if (result.ok) {
        broadcast({ type: 'config-updated' });
        res.writeHead(204); res.end();
      } else {
        sendJson(res, 400, { errors: result.errors || [] });
      }
      return;
    }

    // ── GET /api/signals ────────────────────────────────────────────────
    if (url === '/api/signals' && req.method === 'GET') {
      handleSignals(res);
      return;
    }

    // ── GET /api/operators ──────────────────────────────────────────────
    if (url === '/api/operators' && req.method === 'GET') {
      await handleOperators(res);
      return;
    }

    // ── GET /api/games ──────────────────────────────────────────────────
    if (url === '/api/games' && req.method === 'GET') {
      const limit = toInt(q.get('limit')) || 20;
      let rows = [];
      try { rows = gameStore.recent(limit); } catch { rows = []; }
      sendJson(res, 200, rows);
      return;
    }

    // ── GET /api/events ─────────────────────────────────────────────────
    if (url === '/api/events' && req.method === 'GET') {
      const filter = {};
      const gameId = toInt(q.get('game_id'));
      const from = toInt(q.get('from'));
      const to = toInt(q.get('to'));
      const limit = toInt(q.get('limit'));
      if (gameId !== undefined) filter.game_id = gameId;
      if (from !== undefined) filter.from = from;
      if (to !== undefined) filter.to = to;
      if (limit !== undefined) filter.limit = limit;
      if (q.get('type')) filter.type = q.get('type');
      if (q.get('source')) filter.source = q.get('source');
      let rows = [];
      try { rows = eventStore.query(filter); } catch { rows = []; }
      sendJson(res, 200, rows);
      return;
    }

    // ── GET /healthz ────────────────────────────────────────────────────
    if (url === '/healthz' && req.method === 'GET') {
      let sheetsOk = false;
      try { sheetsOk = !!sheets && typeof sheets.readOperators === 'function'; } catch { sheetsOk = false; }
      sendJson(res, 200, { ok: true, uptime: process.uptime(), sheets: sheetsOk, db: true });
      return;
    }

    // ── Static ──────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      serveStatic(req, res, url);
      return;
    }

    res.writeHead(404); res.end('Not found');
  });

  // A truthy port means "listen now"; port 0 / falsy leaves listening to the
  // caller (tests call server.listen(0) themselves to grab an ephemeral port).
  if (port) {
    server.listen(port);
  }

  function close() {
    for (const res of clients) { try { res.end(); } catch {} }
    clients.clear();
    server.close();
  }

  return { server, close, broadcast, startedAt };
}

module.exports = { createWebServer };
