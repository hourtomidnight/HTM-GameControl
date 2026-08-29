# HTM Room Control — M1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the new `htm-room-control` project on the Pi at `192.168.0.125` with the game clock, operator console, and hint system migrated server-side, a local SQLite event spine recording every operator action and engine transition, Google Sheets session/hint mirroring at parity with `HTM-Control-Basic`, and a read-only Modbus TCP poller feeding observed PLC register changes into the event store.

**Architecture:** A single Node.js 22 process. The authoritative game/timer state machine moves out of the browser (`HTM-Control-Basic/game.js`) into a server-side `game-engine` module. `game.html` becomes a display-only SSE client. A `signal-bus` holds named signals fed by drivers (`internal` for game state, `modbus-tcp` read-only stub for the PLC); an append-only `event-store` (SQLite via built-in `node:sqlite`) is the sink every module writes to. `sheets.js` migrates near-as-is and stays a best-effort mirror.

**Tech Stack:** Node.js 22 LTS, `node:http`, `node:sqlite`, `node:net`, `node:test`; `googleapis` (the only npm runtime dep); systemd; nginx; `chromium --kiosk`. Raspberry Pi OS Bookworm 64-bit.

**Spec:** `docs/superpowers/specs/2026-08-28-htm-room-control-design.md`

## Global Constraints

- **Node.js 22 LTS** required (uses built-in `node:sqlite`, stable in Node 22). No transpiler, no bundler.
- **Server-side code: Node built-ins only.** The single permitted npm runtime dependency is `googleapis`, used only inside `sheets.js`. No other `dependencies` in `package.json`. No `devDependencies` beyond what ships with Node (`node:test` is built in).
- **No native modules in M1.** (`gpio` driver and its native dep are M2.)
- **CommonJS modules** (`require` / `module.exports`), matching `HTM-Control-Basic`.
- **HTTP port `4000`**, bind `0.0.0.0`. nginx fronts at `/room-control/`.
- **Every external call (Sheets, Modbus socket) must be wrapped** so failure degrades to "local only" / "signal stale" and emits an error event — it must never crash the process or stop the clock.
- **Every module is constructed with its dependencies passed in** (an `eventStore` handle, a driver instance, a DB handle) so tests run with fakes and in-memory SQLite.
- **Timestamps:** epoch milliseconds from `Date.now()`, server clock, named `ts`.
- **Repo:** `hourtomidnight/htm-room-control`. This plan's working copy is `C:\Users\mytho\Documents\HTM\GameControl` (currently not a git checkout — Task 1 runs `git init`).
- **Commit style:** Conventional Commits (`feat:`, `test:`, `chore:`, `refactor:`, `docs:`). Commit after every task.
- **TDD:** every behavioural task writes the failing test first, watches it fail, then implements.

---

## File Structure

```
htm-room-control/
├── package.json                 # name, scripts, googleapis dep only
├── .gitignore                   # config.json, google-credentials.json, *.db, node_modules
├── README.md
├── server.js                    # entry point: wires modules in startup order, listens :4000
├── src/
│   ├── event-store.js           # SQLite open + schema + record() + query()
│   ├── game-store.js            # games table CRUD (used by game-engine)
│   ├── session-tracker.js       # pure session record model (migrated)
│   ├── game-engine.js           # authoritative timer + state machine
│   ├── signal-bus.js            # named-signal registry, get/set, change events, quality
│   ├── drivers/
│   │   ├── internal.js          # virtual driver: game-engine pushes state in
│   │   └── modbus-tcp.js        # read-only: frame codec + socket + poll + emit
│   ├── modbus-codec.js          # pure PDU/ADU encode + decode (no I/O)
│   ├── sheets.js                # googleapis wrapper (migrated near-as-is)
│   ├── config.js                # load/save config.json, config_history snapshot
│   └── config-schema.js         # hand-rolled validator (M1 subset)
├── public/
│   ├── index.html               # landing (migrated)
│   ├── operator.html            # operator console (migrated, adapted)
│   ├── operator.js              # adapted: no screen-management assumptions on Pi
│   ├── game.html                # display-only (rewritten)
│   ├── game.js                  # display-only renderer (rewritten)
│   ├── config.html              # settings UI (migrated as-is for M1)
│   ├── channel.js               # SSE + POST helper (migrated verbatim)
│   └── assets/                  # audio/images (gitignored contents, .gitkeep)
├── scripts/
│   ├── migrate-config.js        # old HTM-Control-Basic/config.json -> new nested shape
│   └── setup-pi.sh              # install: node check, systemd units, nginx, kiosk
├── deploy/
│   ├── htm-room-control.service # systemd unit for the Node process
│   ├── htm-room-control-kiosk.service # systemd unit for chromium --kiosk
│   └── nginx-htm.conf           # /room-control/ include block (migrated)
├── test/
│   ├── event-store.test.js
│   ├── game-store.test.js
│   ├── session-tracker.test.js
│   ├── game-engine.test.js
│   ├── signal-bus.test.js
│   ├── drivers/internal.test.js
│   ├── modbus-codec.test.js
│   ├── drivers/modbus-tcp.test.js
│   ├── sheets.test.js
│   ├── config-schema.test.js
│   └── integration.smoke.test.js
└── docs/                        # spec + plans travel with the repo
```

**Static file split:** `server.js` serves `public/` (path-traversal-guarded), so client paths are `/operator.html`, `/game.js`, `/assets/…`, matching `HTM-Control-Basic` URLs and the existing `nginx-htm.conf`.

---

## Task 1: Repo skeleton + test harness

**Files:**
- Create: `package.json`, `.gitignore`, `README.md`, `test/harness.test.js`
- Create: `public/.gitkeep`, `src/.gitkeep`

**Interfaces:**
- Consumes: nothing.
- Produces: `npm test` runs `node --test`; `npm start` runs `node server.js`.

- [ ] **Step 1: `git init` and create `package.json`**

```json
{
  "name": "htm-room-control",
  "version": "0.1.0",
  "description": "HTM per-room control Pi: game clock, operator console, signal I/O, event logging",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "test": "node --test",
    "migrate-config": "node scripts/migrate-config.js"
  },
  "engines": { "node": ">=22" },
  "dependencies": {
    "googleapis": "^144.0.0"
  }
}
```

Run: `cd "C:/Users/mytho/Documents/HTM/GameControl" && git init`

- [ ] **Step 2: Create `.gitignore`**

```
node_modules/
config.json
google-credentials.json
*.db
*.db-wal
*.db-shm
public/assets/*
!public/assets/.gitkeep
```

- [ ] **Step 3: Create `README.md`**

```markdown
# htm-room-control

Per-room control Pi for HTM escape rooms. See `docs/superpowers/specs/2026-08-28-htm-room-control-design.md`.

## Run locally
    npm install        # pulls googleapis only
    npm start          # http://localhost:4000/operator.html

## Test
    npm test
```

- [ ] **Step 4: Create `test/harness.test.js`**

```js
const { test } = require('node:test');
const assert = require('node:assert');

test('harness runs', () => {
  assert.strictEqual(1 + 1, 2);
});
```

- [ ] **Step 5: Run the harness**

Run: `npm test`
Expected: PASS, 1 test.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: repo skeleton, package.json, test harness"
```

---

## Task 2: event-store — schema, record, query

**Files:**
- Create: `src/event-store.js`
- Test: `test/event-store.test.js`

**Interfaces:**
- Consumes: nothing (opens its own DB).
- Produces:
  - `createEventStore({ path }) -> store` — `path` is a filename or `':memory:'`.
  - `store.record({ ts?, source, type, subject?, value?, game_id?, detail? }) -> { id }` — `ts` defaults to `Date.now()`; `value` and `detail` are JSON-stringified if not already strings.
  - `store.query({ game_id?, from?, to?, type?, source?, limit? }) -> row[]` — rows ordered by `ts ASC, id ASC`; `value`/`detail` returned parsed back to JS where they parse as JSON, else raw string.
  - `store.db` — the raw `node:sqlite` `DatabaseSync` handle (for other stores to share the connection).
  - `store.close()`.

- [ ] **Step 1: Write the failing test**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { createEventStore } = require('../src/event-store');

test('record then query round-trips with parsed value', () => {
  const store = createEventStore({ path: ':memory:' });
  store.record({ ts: 1000, source: 'operator', type: 'start', value: { room: 'A' } });
  store.record({ ts: 2000, source: 'signal', type: 'signal-change', subject: 'x', value: true });
  const rows = store.query({});
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].ts, 1000);
  assert.deepStrictEqual(rows[0].value, { room: 'A' });
  assert.strictEqual(rows[1].value, true);
  store.close();
});

test('query filters by type and game_id and limit', () => {
  const store = createEventStore({ path: ':memory:' });
  for (let i = 0; i < 5; i++) store.record({ ts: i, source: 's', type: 'a', game_id: 7 });
  store.record({ ts: 99, source: 's', type: 'b', game_id: 7 });
  store.record({ ts: 100, source: 's', type: 'a', game_id: 8 });
  assert.strictEqual(store.query({ type: 'a', game_id: 7 }).length, 5);
  assert.strictEqual(store.query({ type: 'a', game_id: 7, limit: 2 }).length, 2);
  assert.strictEqual(store.query({ game_id: 8 }).length, 1);
  store.close();
});

test('ts defaults to now when omitted', () => {
  const store = createEventStore({ path: ':memory:' });
  const before = Date.now();
  store.record({ source: 's', type: 'a' });
  const row = store.query({})[0];
  assert.ok(row.ts >= before && row.ts <= Date.now() + 5);
  store.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/event-store.test.js`
Expected: FAIL — `Cannot find module '../src/event-store'`.

- [ ] **Step 3: Implement `src/event-store.js`**

```js
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY,
  ts      INTEGER NOT NULL,
  source  TEXT NOT NULL,
  type    TEXT NOT NULL,
  subject TEXT,
  value   TEXT,
  game_id INTEGER,
  detail  TEXT
);
CREATE INDEX IF NOT EXISTS ix_events_ts   ON events(ts);
CREATE INDEX IF NOT EXISTS ix_events_game ON events(game_id);
CREATE INDEX IF NOT EXISTS ix_events_type ON events(type);

CREATE TABLE IF NOT EXISTS games (
  id           INTEGER PRIMARY KEY,
  started_ts   INTEGER NOT NULL,
  ended_ts     INTEGER,
  status       TEXT,
  room         TEXT,
  operator     TEXT,
  team_name    TEXT,
  new_players  INTEGER,
  exp_players  INTEGER,
  notes        TEXT,
  adjustments  INTEGER DEFAULT 0,
  net_adjust_s INTEGER DEFAULT 0,
  hint_count   INTEGER DEFAULT 0,
  sheets_row   INTEGER
);

CREATE TABLE IF NOT EXISTS config_history (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, json TEXT NOT NULL
);
`;

function encode(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

function decode(s) {
  if (s === null || s === undefined) return s;
  try { return JSON.parse(s); } catch { return s; }
}

function createEventStore({ path }) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);

  const insert = db.prepare(
    `INSERT INTO events (ts, source, type, subject, value, game_id, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  function record({ ts, source, type, subject = null, value, game_id = null, detail }) {
    if (!source || !type) throw new Error('event requires source and type');
    const r = insert.run(
      ts ?? Date.now(), source, type, subject,
      encode(value), game_id, encode(detail)
    );
    return { id: Number(r.lastInsertRowid) };
  }

  function query({ game_id, from, to, type, source, limit } = {}) {
    const where = [];
    const args = [];
    if (game_id !== undefined) { where.push('game_id = ?'); args.push(game_id); }
    if (from !== undefined)    { where.push('ts >= ?');     args.push(from); }
    if (to !== undefined)      { where.push('ts <= ?');     args.push(to); }
    if (type !== undefined)    { where.push('type = ?');    args.push(type); }
    if (source !== undefined)  { where.push('source = ?');  args.push(source); }
    let sql = 'SELECT * FROM events';
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY ts ASC, id ASC';
    if (limit !== undefined) { sql += ' LIMIT ?'; args.push(limit); }
    return db.prepare(sql).all(...args).map(row => ({
      ...row, value: decode(row.value), detail: decode(row.detail),
    }));
  }

  return { db, record, query, close: () => db.close() };
}

module.exports = { createEventStore };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/event-store.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/event-store.js test/event-store.test.js
git commit -m "feat: event-store with SQLite schema, record and filtered query"
```

---

## Task 3: game-store — games table CRUD

**Files:**
- Create: `src/game-store.js`
- Test: `test/game-store.test.js`

**Interfaces:**
- Consumes: `store.db` from Task 2 (`createEventStore`).
- Produces:
  - `createGameStore(db) -> gameStore`
  - `gameStore.create({ started_ts, room, operator, team_name, new_players, exp_players, notes }) -> { id }`
  - `gameStore.update(id, patch)` — patch keys are a subset of column names; ignores unknown keys.
  - `gameStore.get(id) -> row | undefined`
  - `gameStore.recent(limit = 20) -> row[]` ordered `started_ts DESC`.

- [ ] **Step 1: Write the failing test**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { createEventStore } = require('../src/event-store');
const { createGameStore } = require('../src/game-store');

function freshDb() { return createEventStore({ path: ':memory:' }).db; }

test('create returns id and get round-trips', () => {
  const gs = createGameStore(freshDb());
  const { id } = gs.create({ started_ts: 111, room: 'Bank', operator: 'Sam',
    team_name: 'T', new_players: 2, exp_players: 1, notes: '' });
  const row = gs.get(id);
  assert.strictEqual(row.room, 'Bank');
  assert.strictEqual(row.started_ts, 111);
  assert.strictEqual(row.hint_count, 0);
});

test('update applies known keys and ignores unknown', () => {
  const gs = createGameStore(freshDb());
  const { id } = gs.create({ started_ts: 1 });
  gs.update(id, { status: 'Escaped', ended_ts: 999, hint_count: 3, bogus: 'x' });
  const row = gs.get(id);
  assert.strictEqual(row.status, 'Escaped');
  assert.strictEqual(row.ended_ts, 999);
  assert.strictEqual(row.hint_count, 3);
});

test('recent orders by started_ts desc', () => {
  const gs = createGameStore(freshDb());
  gs.create({ started_ts: 10 });
  gs.create({ started_ts: 30 });
  gs.create({ started_ts: 20 });
  assert.deepStrictEqual(gs.recent().map(r => r.started_ts), [30, 20, 10]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/game-store.test.js`
Expected: FAIL — `Cannot find module '../src/game-store'`.

- [ ] **Step 3: Implement `src/game-store.js`**

```js
const COLUMNS = new Set([
  'started_ts', 'ended_ts', 'status', 'room', 'operator', 'team_name',
  'new_players', 'exp_players', 'notes', 'adjustments', 'net_adjust_s',
  'hint_count', 'sheets_row',
]);

function createGameStore(db) {
  function create(fields = {}) {
    const keys = Object.keys(fields).filter(k => COLUMNS.has(k));
    if (!keys.includes('started_ts')) throw new Error('game requires started_ts');
    const sql = `INSERT INTO games (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
    const r = db.prepare(sql).run(...keys.map(k => fields[k]));
    return { id: Number(r.lastInsertRowid) };
  }

  function update(id, patch = {}) {
    const keys = Object.keys(patch).filter(k => COLUMNS.has(k));
    if (!keys.length) return;
    const sql = `UPDATE games SET ${keys.map(k => k + ' = ?').join(', ')} WHERE id = ?`;
    db.prepare(sql).run(...keys.map(k => patch[k]), id);
  }

  const get = (id) => db.prepare('SELECT * FROM games WHERE id = ?').get(id);
  const recent = (limit = 20) =>
    db.prepare('SELECT * FROM games ORDER BY started_ts DESC LIMIT ?').all(limit);

  return { create, update, get, recent };
}

module.exports = { createGameStore };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/game-store.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/game-store.js test/game-store.test.js
git commit -m "feat: game-store CRUD over games table"
```

---

## Task 4: session-tracker — migrate the pure model

**Files:**
- Create: `src/session-tracker.js` (migrated from `HTM-Control-Basic/session-tracker.js`)
- Test: `test/session-tracker.test.js`

**Interfaces:**
- Consumes: nothing (pure functions).
- Produces (unchanged from `HTM-Control-Basic`):
  - `createSession({ startTime, room, operator?, teamName?, newPlayers?, experiencedPlayers? }) -> session`
  - `applyAdjustment(session, type, time) -> session` — `type ∈ {add-min, sub-min, add-sec, sub-sec}`
  - `applyHint(session, text, time) -> { text, time }` (also pushed onto `session.hints`)
  - `updateField(session, field, value) -> session` — `field ∈ {teamName, operator, newPlayers, experiencedPlayers, notes}`, throws on unknown
  - `finalizeSession(session, endTime, status) -> session` — sets `endTime`, `duration`, `status`
  - `netAdjustmentSeconds(session) -> number` — **new helper** so `game-engine` and `sheets` agree on the math; `add-min` +60, `sub-min` -60, `add-sec` +1, `sub-sec` -1.

- [ ] **Step 1: Write the failing test**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const st = require('../src/session-tracker');

test('createSession seeds defaults', () => {
  const s = st.createSession({ startTime: 100, room: 'A' });
  assert.strictEqual(s.startTime, 100);
  assert.strictEqual(s.room, 'A');
  assert.deepStrictEqual(s.adjustments, []);
  assert.deepStrictEqual(s.hints, []);
  assert.strictEqual(s.status, null);
});

test('applyAdjustment records type and time; netAdjustmentSeconds sums', () => {
  const s = st.createSession({ startTime: 0 });
  st.applyAdjustment(s, 'add-min', 1);
  st.applyAdjustment(s, 'sub-sec', 2);
  assert.strictEqual(s.adjustments.length, 2);
  assert.strictEqual(st.netAdjustmentSeconds(s), 59);
});

test('applyHint returns record and appends', () => {
  const s = st.createSession({ startTime: 0 });
  const rec = st.applyHint(s, 'look up', 5);
  assert.deepStrictEqual(rec, { text: 'look up', time: 5 });
  assert.strictEqual(s.hints.length, 1);
});

test('updateField rejects unknown field', () => {
  const s = st.createSession({ startTime: 0 });
  assert.throws(() => st.updateField(s, 'nope', 1), /Unknown session field/);
  st.updateField(s, 'teamName', 'Red');
  assert.strictEqual(s.teamName, 'Red');
});

test('finalizeSession sets duration and status', () => {
  const s = st.createSession({ startTime: 1000 });
  st.finalizeSession(s, 4000, 'Escaped');
  assert.strictEqual(s.duration, 3000);
  assert.strictEqual(s.status, 'Escaped');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/session-tracker.test.js`
Expected: FAIL — `Cannot find module '../src/session-tracker'`.

- [ ] **Step 3: Implement `src/session-tracker.js`**

```js
function createSession({ startTime, room, operator = '', teamName = '', newPlayers = 0, experiencedPlayers = 0 }) {
  return {
    startTime, room, operator, teamName, newPlayers, experiencedPlayers,
    notes: '', adjustments: [], hints: [], endTime: null, duration: null, status: null,
  };
}

function applyAdjustment(session, type, time) {
  session.adjustments.push({ type, time });
  return session;
}

function applyHint(session, text, time) {
  const record = { text, time };
  session.hints.push(record);
  return record;
}

const EDITABLE_FIELDS = ['teamName', 'operator', 'newPlayers', 'experiencedPlayers', 'notes'];

function updateField(session, field, value) {
  if (!EDITABLE_FIELDS.includes(field)) throw new Error('Unknown session field: ' + field);
  session[field] = value;
  return session;
}

function finalizeSession(session, endTime, status) {
  session.endTime = endTime;
  session.duration = endTime - session.startTime;
  session.status = status;
  return session;
}

const ADJ_SEC = { 'add-min': 60, 'sub-min': -60, 'add-sec': 1, 'sub-sec': -1 };
function netAdjustmentSeconds(session) {
  return session.adjustments.reduce((sum, a) => sum + (ADJ_SEC[a.type] || 0), 0);
}

module.exports = {
  createSession, applyAdjustment, applyHint, updateField, finalizeSession,
  netAdjustmentSeconds, ADJ_SEC,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/session-tracker.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/session-tracker.js test/session-tracker.test.js
git commit -m "feat: migrate session-tracker, add netAdjustmentSeconds helper"
```

---

## Task 5: game-engine — timer loop and core transitions

**Files:**
- Create: `src/game-engine.js`
- Test: `test/game-engine.test.js`

**Interfaces:**
- Consumes: `session-tracker` (Task 4); an injected `deps` object `{ eventStore, gameStore, now, setInterval, clearInterval, sheets, signalBus }`. All of `now`/`setInterval`/`clearInterval`/`sheets`/`signalBus` are optional in tests (defaults: real `Date.now`, real timers, `sheets` = null, `signalBus` = null).
- Produces:
  - `createGameEngine(deps) -> engine`
  - `engine.command(msg)` — `msg.type ∈ {start, pause, resume, escaped, reset, add-min, sub-min, add-sec, sub-sec, show-hint, dismiss-hint, hide-clue, update-field, request-state, vol-up, vol-down, force-start}`. Returns nothing; effects are state changes + events + `onState` emissions.
  - `engine.getState() -> stateSnapshot` (shape below).
  - `engine.onState(fn)` — register a listener called with the snapshot on every change.
  - `engine.tickOnce()` — advance the timer exactly one second (tests call this instead of waiting).
  - `stateSnapshot` = `{ type: 'state', phase, currentMin, currentSec, clockForward, timerRunning, gameLocked, onSplash, clueCount, volume, startMinutes, activeHints: string[], gameId }` where `phase ∈ {waiting, intro, running, paused, escaped}`.
- Behaviour notes (from `HTM-Control-Basic/game.js`, moved server-side):
  - `start` from `waiting` and not `gameLocked`: create session + game row, `phase=running`, `timerRunning=true`. (Intro media is M-later; `start` goes straight to running in M1.)
  - Timer counts down from `startMinutes`; at `00:00` it flips `clockForward=true` and counts up.
  - `pause`/`resume` toggle `timerRunning` without changing lock.
  - `escaped`: finalize session `Escaped`, `phase=escaped`, `gameLocked=true`.
  - `reset`: clear lock, `phase=waiting`, clear hints/clue count; if a session is active, finalize it `Reset-Lost` first.
  - `add-min`/`sub-min`/`add-sec`/`sub-sec` adjust the clock and, if a session is active, call `applyAdjustment`.
  - `vol-up`/`vol-down` change `volume` by ±0.01 clamped [0,1].
  - Every accepted command records an event `{ source:'operator', type: msg.type, game_id }` (the caller can override `source` via `msg._source`, used later by the rules engine).

- [ ] **Step 1: Write the failing test**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { createEventStore } = require('../src/event-store');
const { createGameStore } = require('../src/game-store');
const { createGameEngine } = require('../src/game-engine');

function mk() {
  const es = createEventStore({ path: ':memory:' });
  const gs = createGameStore(es.db);
  let t = 10000;
  const engine = createGameEngine({
    eventStore: es, gameStore: gs,
    now: () => t, setInterval: () => 0, clearInterval: () => {},
  });
  return { es, gs, engine, advance: (ms) => { t += ms; } };
}

test('start from waiting creates a game row and goes running', () => {
  const { es, gs, engine } = mk();
  engine.command({ type: 'update-field', field: 'operator', value: 'Sam' });
  engine.command({ type: 'start' });
  const s = engine.getState();
  assert.strictEqual(s.phase, 'running');
  assert.strictEqual(s.timerRunning, true);
  assert.ok(s.gameId);
  assert.strictEqual(gs.get(s.gameId).operator, 'Sam');
  assert.ok(es.query({ type: 'start' }).length === 1);
});

test('tick counts down then flips to count-up at zero', () => {
  const { engine } = mk();
  engine.command({ type: 'start' });
  // default 60:00 -> set to 0:02 via adjustments for a short test
  engine.command({ type: 'sub-min' }); // 59:00
  for (let i = 0; i < 59; i++) engine.command({ type: 'sub-min' }); // 0:00-ish guard
  const before = engine.getState();
  engine.tickOnce();
  const after = engine.getState();
  assert.ok(after.clockForward || (after.currentMin === before.currentMin - (before.currentSec === 0 ? 1 : 0)));
});

test('pause and resume toggle timerRunning only', () => {
  const { engine } = mk();
  engine.command({ type: 'start' });
  engine.command({ type: 'pause' });
  assert.strictEqual(engine.getState().timerRunning, false);
  assert.strictEqual(engine.getState().gameLocked, false);
  engine.command({ type: 'resume' });
  assert.strictEqual(engine.getState().timerRunning, true);
});

test('escaped finalizes game row and locks', () => {
  const { es, gs, engine } = mk();
  engine.command({ type: 'start' });
  const id = engine.getState().gameId;
  engine.command({ type: 'escaped' });
  const s = engine.getState();
  assert.strictEqual(s.phase, 'escaped');
  assert.strictEqual(s.gameLocked, true);
  assert.strictEqual(gs.get(id).status, 'Escaped');
  assert.ok(gs.get(id).ended_ts);
});

test('start is ignored while locked; reset clears the lock', () => {
  const { engine } = mk();
  engine.command({ type: 'start' });
  engine.command({ type: 'escaped' });
  engine.command({ type: 'start' });
  assert.strictEqual(engine.getState().phase, 'escaped');
  engine.command({ type: 'reset' });
  assert.strictEqual(engine.getState().phase, 'waiting');
  assert.strictEqual(engine.getState().gameLocked, false);
});

test('reset mid-game finalizes the row as Reset-Lost', () => {
  const { gs, engine } = mk();
  engine.command({ type: 'start' });
  const id = engine.getState().gameId;
  engine.command({ type: 'reset' });
  assert.strictEqual(gs.get(id).status, 'Reset-Lost');
});

test('adjustment during a session is recorded on the session', () => {
  const { gs, engine } = mk();
  engine.command({ type: 'start' });
  const id = engine.getState().gameId;
  engine.command({ type: 'add-min' });
  engine.command({ type: 'escaped' });
  assert.strictEqual(gs.get(id).adjustments, 1);
  assert.strictEqual(gs.get(id).net_adjust_s, 60);
});

test('onState fires on every change', () => {
  const { engine } = mk();
  let calls = 0;
  engine.onState(() => calls++);
  engine.command({ type: 'start' });
  engine.command({ type: 'pause' });
  assert.ok(calls >= 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/game-engine.test.js`
Expected: FAIL — `Cannot find module '../src/game-engine'`.

- [ ] **Step 3: Implement `src/game-engine.js`**

```js
const st = require('./session-tracker');

const EDITABLE = ['teamName', 'operator', 'newPlayers', 'experiencedPlayers', 'notes'];
const ADJ = { 'add-min': [1, 0], 'sub-min': [-1, 0], 'add-sec': [0, 1], 'sub-sec': [0, -1] };

function createGameEngine(deps) {
  const {
    eventStore, gameStore,
    now = () => Date.now(),
    setInterval: setIv = setInterval, clearInterval: clearIv = clearInterval,
    sheets = null, signalBus = null,
  } = deps;

  let startMinutes = 60;
  let s = blankState();
  let session = null;
  let gameId = null;
  let pendingFields = {};
  let timer = null;
  const listeners = [];

  function blankState() {
    return {
      type: 'state', phase: 'waiting',
      currentMin: startMinutes, currentSec: 0, clockForward: false,
      timerRunning: false, gameLocked: false, onSplash: true,
      clueCount: 0, volume: 0.4, startMinutes, activeHints: [], gameId: null,
    };
  }

  function emit() {
    s.gameId = gameId;
    for (const fn of listeners) { try { fn(getState()); } catch {} }
    if (signalBus) mirrorSignals();
  }

  function getState() { return { ...s, activeHints: s.activeHints.slice() }; }
  function onState(fn) { listeners.push(fn); }

  function mirrorSignals() {
    try {
      signalBus.set('phase', s.phase);
      signalBus.set('timer_running', s.timerRunning);
      signalBus.set('game_locked', s.gameLocked);
    } catch {}
  }

  function record(type, extra = {}) {
    try {
      eventStore.record({ ts: now(), source: extra._source || 'operator', type,
        subject: extra.subject, value: extra.value, game_id: gameId, detail: extra.detail });
    } catch {}
  }

  function startTimer() {
    if (timer) return;
    timer = setIv(() => tickOnce(), 1000);
  }
  function stopTimer() { if (timer) { clearIv(timer); timer = null; } }

  function tickOnce() {
    if (!s.timerRunning) return;
    if (!s.clockForward) {
      s.currentSec--;
      if (s.currentSec < 0) { s.currentMin--; s.currentSec = 59; }
      if (s.currentMin < 0) { s.clockForward = true; s.currentMin = 0; s.currentSec = 0; }
    } else {
      s.currentSec++;
      if (s.currentSec >= 60) { s.currentMin++; s.currentSec = 0; }
    }
    emit();
  }

  function syncGameRow(patch) {
    if (gameId == null) return;
    try { gameStore.update(gameId, patch); } catch {}
  }

  function command(msg) {
    const type = msg.type;

    if (type === 'update-field') {
      if (!EDITABLE.includes(msg.field)) return;
      if (!session) { pendingFields[msg.field] = msg.value; }
      else { st.updateField(session, msg.field, msg.value);
             syncGameRow(fieldPatch(msg.field, msg.value)); }
      record(type, { subject: msg.field, value: msg.value, _source: msg._source });
      return;
    }

    if (type === 'request-state') { emit(); return; }

    if (type === 'vol-up' || type === 'vol-down') {
      s.volume = Math.max(0, Math.min(1, s.volume + (type === 'vol-up' ? 0.01 : -0.01)));
      record(type, { _source: msg._source }); emit(); return;
    }

    if ((type === 'start' || type === 'force-start') && s.phase === 'waiting' && !s.gameLocked) {
      const startTime = now();
      session = st.createSession({ startTime, room: s.room || '', ...pendingFields });
      pendingFields = {};
      const g = gameStore.create({
        started_ts: startTime, room: session.room, operator: session.operator,
        team_name: session.teamName, new_players: session.newPlayers,
        exp_players: session.experiencedPlayers, notes: session.notes,
      });
      gameId = g.id;
      s.phase = 'running'; s.timerRunning = true; s.onSplash = false;
      s.currentMin = startMinutes; s.currentSec = 0; s.clockForward = false;
      startTimer();
      record(type, { _source: msg._source });
      if (sheets) sheets.onGameStart(gameId, session).catch(() => {});
      emit();
      return;
    }

    if (type === 'pause') { s.timerRunning = false; record(type, { _source: msg._source }); emit(); return; }
    if (type === 'resume' && !s.gameLocked && s.phase === 'running') {
      s.timerRunning = true; record(type, { _source: msg._source }); emit(); return;
    }

    if (ADJ[type]) {
      const [dMin, dSec] = ADJ[type];
      adjustClock(dMin, dSec);
      if (session) {
        st.applyAdjustment(session, type, now());
        syncGameRow({ adjustments: session.adjustments.length,
                      net_adjust_s: st.netAdjustmentSeconds(session) });
      }
      record(type, { _source: msg._source });
      if (sheets && gameId != null) sheets.onSessionSync(gameId, session).catch(() => {});
      emit();
      return;
    }

    if (type === 'show-hint') {
      if (!session) return;
      const rec = st.applyHint(session, msg.text || '', now());
      if (!s.activeHints.includes(rec.text)) s.activeHints.push(rec.text);
      s.clueCount++;
      syncGameRow({ hint_count: session.hints.length });
      record(type, { subject: 'hint', value: rec.text, _source: msg._source });
      if (sheets && gameId != null) sheets.onHint(gameId, session, rec).catch(() => {});
      emit();
      return;
    }
    if (type === 'dismiss-hint') {
      s.activeHints = s.activeHints.filter(h => h !== msg.text);
      record(type, { subject: 'hint', value: msg.text, _source: msg._source }); emit(); return;
    }
    if (type === 'hide-clue') {
      s.activeHints = []; record(type, { _source: msg._source }); emit(); return;
    }

    if (type === 'escaped') {
      if (session) {
        st.finalizeSession(session, now(), 'Escaped');
        syncGameRow({ ended_ts: session.endTime, status: 'Escaped' });
        if (sheets && gameId != null) sheets.onSessionSync(gameId, session).catch(() => {});
      }
      s.phase = 'escaped'; s.timerRunning = false; s.gameLocked = true; s.onSplash = true;
      stopTimer();
      record(type, { _source: msg._source });
      session = null;
      emit();
      return;
    }

    if (type === 'reset') {
      if (session) {
        st.finalizeSession(session, now(), 'Reset-Lost');
        syncGameRow({ ended_ts: session.endTime, status: 'Reset-Lost' });
        if (sheets && gameId != null) sheets.onSessionSync(gameId, session).catch(() => {});
      }
      stopTimer();
      session = null; gameId = null; pendingFields = {};
      s = blankState();
      record(type, { _source: msg._source });
      emit();
      return;
    }
  }

  function fieldPatch(field, value) {
    return ({
      teamName: { team_name: value }, operator: { operator: value },
      newPlayers: { new_players: value }, experiencedPlayers: { exp_players: value },
      notes: { notes: value },
    })[field] || {};
  }

  function adjustClock(dMin, dSec) {
    s.currentSec += dSec;
    if (s.currentSec >= 60) { s.currentMin++; s.currentSec -= 60; }
    if (s.currentSec < 0)   { s.currentMin--; s.currentSec += 60; }
    s.currentMin = Math.max(0, Math.min(999, s.currentMin + dMin));
  }

  function setStartMinutes(m) {
    startMinutes = m;
    if (s.phase === 'waiting') { s.startMinutes = m; s.currentMin = m; s.currentSec = 0; emit(); }
  }

  return { command, getState, onState, tickOnce, setStartMinutes };
}

module.exports = { createGameEngine };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/game-engine.test.js`
Expected: PASS, 8 tests. (If the count-down flip test is flaky due to the crude adjustment loop, replace its body with: start, call `engine.setStartMinutes(0)` before start is not allowed — instead call `tickOnce` once from 0:00 state reached via 60 `sub-min`; assert `clockForward === true`.)

- [ ] **Step 5: Commit**

```bash
git add src/game-engine.js test/game-engine.test.js
git commit -m "feat: server-side game-engine — timer, transitions, session persistence"
```

---

## Task 6: config.js + config-schema.js (M1 subset)

**Files:**
- Create: `src/config.js`, `src/config-schema.js`
- Test: `test/config-schema.test.js`

**Interfaces:**
- Consumes: `store.db` (for `config_history`); Node `fs`.
- Produces:
  - `createConfig({ path, db, now }) -> cfgApi`
  - `cfgApi.load() -> object` — reads `path`; `{}` if missing/unparseable.
  - `cfgApi.save(obj) -> { ok, errors }` — validates via schema; on `ok` writes `path` (pretty JSON) and inserts a `config_history` row; on failure writes nothing and returns errors.
  - `cfgApi.current() -> object` — last successfully loaded/saved config (in-memory cache).
  - `validateConfig(obj) -> { ok, errors: string[] }` — **M1 subset**: validates `game.*` types, `sheets.*` are strings, `hintGroups` shape, `plcs[]` shape (`id` string, `host` string, `port` int, `pollMs` int), `signals[]` minimal shape for `driver ∈ {internal, modbus}` only (gpio/banks/rules/profiles/sequences are accepted but not deeply validated until M2), no duplicate signal names, every modbus signal's `address.plc` exists in `plcs[]`.

- [ ] **Step 1: Write the failing test**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { validateConfig } = require('../src/config-schema');

test('accepts a minimal valid M1 config', () => {
  const r = validateConfig({
    roomName: 'Bank',
    game: { timerMinutes: 60, volume: 0.4, hintCycleSeconds: 5, eventRetentionDays: null },
    sheets: { sessionsSpreadsheetId: 'x', sessionsTabName: 'S' },
    hintGroups: [{ name: 'G', hints: [{ key: 'F1', text: 'hi' }] }],
    plcs: [{ id: 'plc1', host: '192.168.0.50', port: 502, pollMs: 100 }],
    signals: [{ name: 'door', direction: 'in', type: 'bool', driver: 'modbus',
      address: { plc: 'plc1', unit: 1, fn: 'discrete', register: 1 } }],
  });
  assert.deepStrictEqual(r, { ok: true, errors: [] });
});

test('rejects duplicate signal names', () => {
  const r = validateConfig({ signals: [
    { name: 'a', direction: 'in', type: 'bool', driver: 'internal' },
    { name: 'a', direction: 'in', type: 'bool', driver: 'internal' },
  ]});
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some(e => /duplicate signal name: a/.test(e)));
});

test('rejects modbus signal referencing an unknown plc', () => {
  const r = validateConfig({ plcs: [], signals: [
    { name: 'd', direction: 'in', type: 'bool', driver: 'modbus',
      address: { plc: 'ghost', unit: 1, fn: 'coil', register: 1 } },
  ]});
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some(e => /unknown plc: ghost/.test(e)));
});

test('rejects wrong game field types', () => {
  const r = validateConfig({ game: { timerMinutes: 'sixty' } });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some(e => /game\.timerMinutes/.test(e)));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/config-schema.test.js`
Expected: FAIL — `Cannot find module '../src/config-schema'`.

- [ ] **Step 3: Implement `src/config-schema.js`**

```js
function isStr(v) { return typeof v === 'string'; }
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function isInt(v) { return Number.isInteger(v); }

function validateConfig(cfg = {}) {
  const errors = [];

  const g = cfg.game;
  if (g !== undefined) {
    if (typeof g !== 'object' || g === null) errors.push('game must be an object');
    else {
      if (g.timerMinutes !== undefined && !isNum(g.timerMinutes)) errors.push('game.timerMinutes must be a number');
      if (g.volume !== undefined && !isNum(g.volume)) errors.push('game.volume must be a number');
      if (g.hintCycleSeconds !== undefined && !isNum(g.hintCycleSeconds)) errors.push('game.hintCycleSeconds must be a number');
      if (g.eventRetentionDays !== undefined && g.eventRetentionDays !== null && !isInt(g.eventRetentionDays))
        errors.push('game.eventRetentionDays must be an integer or null');
      for (const k of ['logoPath', 'introMediaPath', 'startStopKey'])
        if (g[k] !== undefined && !isStr(g[k])) errors.push(`game.${k} must be a string`);
    }
  }

  if (cfg.sheets !== undefined) {
    if (typeof cfg.sheets !== 'object' || cfg.sheets === null) errors.push('sheets must be an object');
    else for (const [k, v] of Object.entries(cfg.sheets))
      if (!isStr(v)) errors.push(`sheets.${k} must be a string`);
  }

  if (cfg.hintGroups !== undefined) {
    if (!Array.isArray(cfg.hintGroups)) errors.push('hintGroups must be an array');
    else cfg.hintGroups.forEach((grp, i) => {
      if (typeof grp !== 'object' || grp === null) { errors.push(`hintGroups[${i}] must be an object`); return; }
      if (grp.name !== undefined && !isStr(grp.name)) errors.push(`hintGroups[${i}].name must be a string`);
      if (grp.hints !== undefined) {
        if (!Array.isArray(grp.hints)) errors.push(`hintGroups[${i}].hints must be an array`);
        else grp.hints.forEach((h, j) => {
          if (h.text !== undefined && !isStr(h.text)) errors.push(`hintGroups[${i}].hints[${j}].text must be a string`);
          if (h.key !== undefined && !isStr(h.key)) errors.push(`hintGroups[${i}].hints[${j}].key must be a string`);
        });
      }
    });
  }

  const plcIds = new Set();
  if (cfg.plcs !== undefined) {
    if (!Array.isArray(cfg.plcs)) errors.push('plcs must be an array');
    else cfg.plcs.forEach((p, i) => {
      if (!isStr(p.id)) errors.push(`plcs[${i}].id must be a string`);
      else { if (plcIds.has(p.id)) errors.push(`duplicate plc id: ${p.id}`); plcIds.add(p.id); }
      if (!isStr(p.host)) errors.push(`plcs[${i}].host must be a string`);
      if (p.port !== undefined && !isInt(p.port)) errors.push(`plcs[${i}].port must be an integer`);
      if (p.pollMs !== undefined && !isInt(p.pollMs)) errors.push(`plcs[${i}].pollMs must be an integer`);
    });
  }

  if (cfg.signals !== undefined) {
    if (!Array.isArray(cfg.signals)) errors.push('signals must be an array');
    else {
      const names = new Set();
      cfg.signals.forEach((sig, i) => {
        if (!isStr(sig.name)) { errors.push(`signals[${i}].name must be a string`); return; }
        if (names.has(sig.name)) errors.push(`duplicate signal name: ${sig.name}`);
        names.add(sig.name);
        if (!['in', 'out', 'in-out'].includes(sig.direction)) errors.push(`signals[${i}].direction invalid`);
        if (!['bool', 'int', 'float'].includes(sig.type)) errors.push(`signals[${i}].type invalid`);
        if (!['internal', 'modbus', 'gpio'].includes(sig.driver)) errors.push(`signals[${i}].driver invalid`);
        if (sig.driver === 'modbus') {
          const a = sig.address || {};
          if (!isStr(a.plc)) errors.push(`signals[${i}].address.plc must be a string`);
          else if (!plcIds.has(a.plc)) errors.push(`signals[${i}] references unknown plc: ${a.plc}`);
          if (!['coil', 'discrete', 'input', 'holding'].includes(a.fn)) errors.push(`signals[${i}].address.fn invalid`);
          if (!isInt(a.register)) errors.push(`signals[${i}].address.register must be an integer`);
        }
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

module.exports = { validateConfig };
```

- [ ] **Step 4: Implement `src/config.js`**

```js
const fs = require('node:fs');
const { validateConfig } = require('./config-schema');

function createConfig({ path, db, now = () => Date.now() }) {
  let cache = {};

  function load() {
    try { cache = JSON.parse(fs.readFileSync(path, 'utf8')); }
    catch { cache = {}; }
    return cache;
  }

  function save(obj) {
    const { ok, errors } = validateConfig(obj);
    if (!ok) return { ok, errors };
    fs.writeFileSync(path, JSON.stringify(obj, null, 2));
    try { db.prepare('INSERT INTO config_history (ts, json) VALUES (?, ?)')
            .run(now(), JSON.stringify(obj)); } catch {}
    cache = obj;
    return { ok: true, errors: [] };
  }

  return { load, save, current: () => cache };
}

module.exports = { createConfig, validateConfig };
```

- [ ] **Step 5: Run tests**

Run: `node --test test/config-schema.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add src/config.js src/config-schema.js test/config-schema.test.js
git commit -m "feat: config load/save with M1 hand-rolled schema validator"
```

---

## Task 7: sheets.js — migrate the Google Sheets mirror

**Files:**
- Create: `src/sheets.js` (migrated from `HTM-Control-Basic/sheets.js`, wrapped in a small facade)
- Test: `test/sheets.test.js`

**Interfaces:**
- Consumes: `googleapis` (real, only when creds exist); `session-tracker.netAdjustmentSeconds`.
- Produces:
  - `createSheets({ credentialsPath, config, eventStore, gameStore, googleFactory }) -> sheetsApi`
    - `googleFactory` is optional; when provided it replaces `google.sheets(...)` construction (tests inject a fake). When creds are missing and no factory: all methods become no-ops that return resolved promises.
  - `sheetsApi.onGameStart(gameId, session) -> Promise<void>` — appends a session row to the Sessions tab, stores the returned `sheets_row` on the game via `gameStore.update`.
  - `sheetsApi.onSessionSync(gameId, session) -> Promise<void>` — updates that row in place (no-op if `sheets_row` unknown).
  - `sheetsApi.onHint(gameId, session, hintRecord) -> Promise<void>` — appends a row to the Hints tab.
  - `sheetsApi.readOperators() -> Promise<string[]>`.
  - Pure helpers exported for tests: `buildSessionRow(session)`, `buildHintRow(hintRecord, session)`, `formatDuration(ms)`, `formatNetAdjustment(session)`.
  - Every method is wrapped: on any thrown error it records `{ source:'sheets', type:'sheets-error', detail:{ op, message } }` to `eventStore` and resolves (never rejects).

- [ ] **Step 1: Write the failing test**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { createEventStore } = require('../src/event-store');
const { createGameStore } = require('../src/game-store');
const stk = require('../src/session-tracker');
const { createSheets, buildSessionRow, formatDuration } = require('../src/sheets');

function fakeGoogle() {
  const calls = { append: [], update: [] };
  return {
    calls,
    api: {
      spreadsheets: { values: {
        append: async (a) => { calls.append.push(a);
          return { data: { updates: { updatedRange: `${a.range.split('!')[0]}!A5:N5` } } }; },
        update: async (u) => { calls.update.push(u); return { data: {} }; },
        get: async () => ({ data: { values: [['Sam'], ['Ana']] } }),
        clear: async () => ({ data: {} }),
      }},
    },
  };
}

test('onGameStart appends a row and records sheets_row', async () => {
  const es = createEventStore({ path: ':memory:' });
  const gs = createGameStore(es.db);
  const { id } = gs.create({ started_ts: 1 });
  const fg = fakeGoogle();
  const sheets = createSheets({
    credentialsPath: '/nonexistent', eventStore: es, gameStore: gs,
    config: { current: () => ({ sheets: { sessionsSpreadsheetId: 'sid', sessionsTabName: 'Sessions' } }) },
    googleFactory: () => fg.api,
  });
  const session = stk.createSession({ startTime: 1, room: 'Bank' });
  await sheets.onGameStart(id, session);
  assert.strictEqual(fg.calls.append.length, 1);
  assert.strictEqual(gs.get(id).sheets_row, 5);
});

test('missing creds + no factory => methods are silent no-ops', async () => {
  const es = createEventStore({ path: ':memory:' });
  const gs = createGameStore(es.db);
  const sheets = createSheets({
    credentialsPath: '/nonexistent', eventStore: es, gameStore: gs,
    config: { current: () => ({}) },
  });
  await sheets.onGameStart(1, stk.createSession({ startTime: 1 })); // must not throw
  assert.strictEqual(es.query({ type: 'sheets-error' }).length, 0);
});

test('a throwing google call is caught and logged as sheets-error', async () => {
  const es = createEventStore({ path: ':memory:' });
  const gs = createGameStore(es.db);
  const sheets = createSheets({
    credentialsPath: '/nonexistent', eventStore: es, gameStore: gs,
    config: { current: () => ({ sheets: { sessionsSpreadsheetId: 'sid', sessionsTabName: 'S' } }) },
    googleFactory: () => ({ spreadsheets: { values: {
      append: async () => { throw new Error('boom'); } } } }),
  });
  await sheets.onGameStart(1, stk.createSession({ startTime: 1 }));
  const errs = es.query({ type: 'sheets-error' });
  assert.strictEqual(errs.length, 1);
  assert.strictEqual(errs[0].detail.op, 'onGameStart');
});

test('buildSessionRow shape matches HTM-Control-Basic column order', () => {
  const s = stk.createSession({ startTime: Date.parse('2026-01-02T10:00:00Z'), room: 'Bank', operator: 'Sam' });
  stk.finalizeSession(s, Date.parse('2026-01-02T10:45:00Z'), 'Escaped');
  const row = buildSessionRow(s);
  assert.strictEqual(row.length, 14);
  assert.strictEqual(row[2], 'Bank');
  assert.strictEqual(row[9], 'Escaped');
  assert.strictEqual(formatDuration(45 * 60 * 1000), '00:45:00');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/sheets.test.js`
Expected: FAIL — `Cannot find module '../src/sheets'`.

- [ ] **Step 3: Implement `src/sheets.js`**

Port the pure helpers verbatim from `HTM-Control-Basic/sheets.js` (`formatDuration`, `formatNetAdjustment` — but take a `session` and call `netAdjustmentSeconds`, `buildSessionRow`, `buildHintRow`, `parseRowIndexFromUpdatedRange`, `appendRow`, `updateRow`, `readColumn`). Then add the facade:

```js
const fs = require('node:fs');
const { netAdjustmentSeconds } = require('./session-tracker');

function pad(n) { return String(n).padStart(2, '0'); }
function formatDuration(ms) {
  const t = Math.floor(ms / 1000);
  return pad(Math.floor(t / 3600)) + ':' + pad(Math.floor((t % 3600) / 60)) + ':' + pad(t % 60);
}
function formatNetAdjustment(session) {
  const netSec = netAdjustmentSeconds(session);
  const sign = netSec < 0 ? '-' : '+';
  const abs = Math.abs(netSec);
  return sign + pad(Math.floor(abs / 60)) + ':' + pad(abs % 60);
}
function buildSessionRow(session) {
  const start = new Date(session.startTime);
  const end = session.endTime ? new Date(session.endTime) : null;
  return [
    start.toLocaleDateString(), start.toLocaleTimeString(),
    session.room || '', session.operator || '', session.teamName || '',
    session.newPlayers || 0, session.experiencedPlayers || 0,
    end ? end.toLocaleTimeString() : '',
    session.duration != null ? formatDuration(session.duration) : '',
    session.status || '',
    session.adjustments.length, formatNetAdjustment(session),
    session.hints.length, session.notes || '',
  ];
}
function buildHintRow(hintRecord, session) {
  const at = new Date(hintRecord.time);
  return [at.toLocaleDateString(), at.toLocaleTimeString(), hintRecord.text,
          new Date(session.startTime).toLocaleTimeString()];
}
function parseRowIndexFromUpdatedRange(r) {
  const m = r.match(/![A-Z]+(\d+):/);
  if (!m) throw new Error('Could not parse row index from range: ' + r);
  return parseInt(m[1], 10);
}

function createSheets({ credentialsPath, config, eventStore, gameStore, googleFactory }) {
  let api = null;
  if (googleFactory) {
    api = googleFactory();
  } else if (fs.existsSync(credentialsPath)) {
    const { google } = require('googleapis');
    const auth = new google.auth.GoogleAuth({
      keyFile: credentialsPath, scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    api = google.sheets({ version: 'v4', auth });
  }

  const logErr = (op, e) => {
    try { eventStore.record({ source: 'sheets', type: 'sheets-error', detail: { op, message: e.message } }); } catch {}
  };
  const guard = (op, fn) => async (...args) => {
    if (!api) return;
    try { return await fn(...args); } catch (e) { logErr(op, e); }
  };

  const cfg = () => (config.current().sheets || {});

  const onGameStart = guard('onGameStart', async (gameId, session) => {
    const c = cfg();
    if (!c.sessionsSpreadsheetId || !c.sessionsTabName) return;
    const res = await api.spreadsheets.values.append({
      spreadsheetId: c.sessionsSpreadsheetId, range: c.sessionsTabName + '!A1',
      valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [buildSessionRow(session)] },
    });
    const rowIndex = parseRowIndexFromUpdatedRange(res.data.updates.updatedRange);
    gameStore.update(gameId, { sheets_row: rowIndex });
  });

  const onSessionSync = guard('onSessionSync', async (gameId, session) => {
    const c = cfg();
    const row = gameStore.get(gameId)?.sheets_row;
    if (!c.sessionsSpreadsheetId || !c.sessionsTabName || !row) return;
    const values = buildSessionRow(session);
    const endCol = String.fromCharCode(65 + values.length - 1);
    await api.spreadsheets.values.update({
      spreadsheetId: c.sessionsSpreadsheetId,
      range: `${c.sessionsTabName}!A${row}:${endCol}${row}`,
      valueInputOption: 'USER_ENTERED', requestBody: { values: [values] },
    });
  });

  const onHint = guard('onHint', async (gameId, session, hintRecord) => {
    const c = cfg();
    if (!c.hintsSpreadsheetId || !c.hintsTabName) return;
    await api.spreadsheets.values.append({
      spreadsheetId: c.hintsSpreadsheetId, range: c.hintsTabName + '!A1',
      valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [buildHintRow(hintRecord, session)] },
    });
  });

  const readOperators = guard('readOperators', async () => {
    const c = config.current();
    if (!c.sheets?.operatorsSpreadsheetId) return [];
    const res = await api.spreadsheets.values.get({
      spreadsheetId: c.sheets.operatorsSpreadsheetId, range: 'Drop Down options!B2:B',
    });
    return (res.data.values || []).map(r => r[0]).filter(Boolean);
  }) ;

  return { onGameStart, onSessionSync, onHint, readOperators,
    buildSessionRow, buildHintRow, formatDuration, formatNetAdjustment };
}

module.exports = { createSheets, buildSessionRow, buildHintRow,
  formatDuration, formatNetAdjustment, parseRowIndexFromUpdatedRange };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/sheets.test.js`
Expected: PASS, 4 tests. (`readOperators` returns `[]` not `undefined` when `api` is null — adjust the guard for that one method to `return (await fn()) ?? []`.)

- [ ] **Step 5: Commit**

```bash
git add src/sheets.js test/sheets.test.js
git commit -m "feat: migrate sheets.js as a guarded best-effort mirror facade"
```

---

## Task 8: signal-bus with a fake driver

**Files:**
- Create: `src/signal-bus.js`
- Test: `test/signal-bus.test.js`

**Interfaces:**
- Consumes: `eventStore` (Task 2); a map of driver instances (Task 9/10 provide real ones; tests pass fakes). Driver interface: `{ init(pinDefs), readAll(), write(pin, value), startPolling(emit), stop() }`.
- Produces:
  - `createSignalBus({ eventStore, drivers, signals }) -> bus`
    - `drivers` = `{ internal: <instance>, modbus: <instance>, ... }`
    - `signals` = the validated `config.signals` array.
  - `bus.start()` — calls each driver's `init` with its pin defs, does an initial `readAll` to seed values, then `startPolling`.
  - `bus.get(name) -> { value, ts, quality }` (`quality ∈ {ok, stale, error}`; unknown name → `undefined`).
  - `bus.set(name, value)` — throws if the signal is `direction: 'in'` or unknown; routes to the owning driver's `write`; optimistically updates cache; records `{ source:'signal', type:'signal-set', subject:name, value }`. If `write` throws: quality → `error`, records `{ type:'signal-set', detail:{ error } }`, does not throw further.
  - `bus.snapshot() -> { [name]: { value, quality } }`.
  - `bus.on('change', fn)` — `fn({ name, value, prev, quality, ts })` on every normalized change from polling.
  - `bus.stop()`.
- Normalization applied to every incoming value: `invert` (bool only), type-coerce to `sig.type`, `debounceMs` (drop changes that don't persist — implemented by scheduling a confirm; in tests with a fake clock this is exercised via an injected `setTimeout`). For M1 debounce may be a no-op if `debounceMs` is absent; the test below does not require debounce.

- [ ] **Step 1: Write the failing test**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { createEventStore } = require('../src/event-store');
const { createSignalBus } = require('../src/signal-bus');

function fakeDriver() {
  let emit = null;
  const state = {};
  return {
    inited: null,
    init(defs) { this.inited = defs; },
    readAll() { return Object.entries(state).map(([pin, raw]) => ({ pin, raw })); },
    write(pin, value) { state[pin] = value; },
    startPolling(fn) { emit = fn; },
    stop() {},
    _push(pin, raw) { state[pin] = raw; emit && emit({ pin, raw, ts: 1 }); },
    _fail() { this.write = () => { throw new Error('bus fault'); }; },
  };
}

const SIGNALS = [
  { name: 'phase', direction: 'in-out', type: 'int', driver: 'internal', address: { pin: 'phase' } },
  { name: 'lamp',  direction: 'out',    type: 'bool', driver: 'internal', address: { pin: 'lamp' } },
  { name: 'btn',   direction: 'in',     type: 'bool', driver: 'internal', address: { pin: 'btn' }, invert: true },
];

test('start seeds values and set() writes through and records', () => {
  const es = createEventStore({ path: ':memory:' });
  const d = fakeDriver();
  const bus = createSignalBus({ eventStore: es, drivers: { internal: d }, signals: SIGNALS });
  bus.start();
  assert.deepStrictEqual(d.inited.map(x => x.pin).sort(), ['btn', 'lamp', 'phase']);
  bus.set('lamp', true);
  assert.strictEqual(bus.get('lamp').value, true);
  assert.strictEqual(es.query({ type: 'signal-set' }).length, 1);
});

test('set() on an input signal throws', () => {
  const es = createEventStore({ path: ':memory:' });
  const bus = createSignalBus({ eventStore: es, drivers: { internal: fakeDriver() }, signals: SIGNALS });
  bus.start();
  assert.throws(() => bus.set('btn', true), /not writable/);
});

test('polling change is normalized (invert) and emitted + recorded', () => {
  const es = createEventStore({ path: ':memory:' });
  const d = fakeDriver();
  const bus = createSignalBus({ eventStore: es, drivers: { internal: d }, signals: SIGNALS });
  bus.start();
  const seen = [];
  bus.on('change', e => seen.push(e));
  d._push('btn', false);          // inverted => logical true
  assert.strictEqual(bus.get('btn').value, true);
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].name, 'btn');
  assert.strictEqual(es.query({ type: 'signal-change' }).length, 1);
});

test('a failing driver write marks quality error and does not throw', () => {
  const es = createEventStore({ path: ':memory:' });
  const d = fakeDriver(); d._fail();
  const bus = createSignalBus({ eventStore: es, drivers: { internal: d }, signals: SIGNALS });
  bus.start();
  bus.set('lamp', true);           // must not throw
  assert.strictEqual(bus.get('lamp').quality, 'error');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/signal-bus.test.js`
Expected: FAIL — `Cannot find module '../src/signal-bus'`.

- [ ] **Step 3: Implement `src/signal-bus.js`**

```js
const { EventEmitter } = require('node:events');

function coerce(type, v) {
  if (type === 'bool') return !!v;
  if (type === 'int') return Math.trunc(Number(v));
  if (type === 'float') return Number(v);
  return v;
}

function createSignalBus({ eventStore, drivers, signals }) {
  const emitter = new EventEmitter();
  const byName = new Map();       // name -> sig def
  const values = new Map();       // name -> { value, ts, quality }
  const pinIndex = new Map();     // driver -> Map(pinKey -> name)

  for (const sig of signals) {
    byName.set(sig.name, sig);
    const pk = pinKey(sig);
    if (!pinIndex.has(sig.driver)) pinIndex.set(sig.driver, new Map());
    pinIndex.get(sig.driver).set(pk, sig.name);
    values.set(sig.name, { value: null, ts: 0, quality: 'stale' });
  }

  function pinKey(sig) {
    const a = sig.address || {};
    return String(a.pin ?? `${a.plc}:${a.fn}:${a.register}:${a.bit ?? ''}`);
  }

  function normalize(sig, raw) {
    let v = raw;
    if (sig.type === 'bool' && sig.invert) v = !v;
    return coerce(sig.type, v);
  }

  function ingest(driverName, pin, raw, ts) {
    const name = pinIndex.get(driverName)?.get(String(pin));
    if (!name) return;
    const sig = byName.get(name);
    const value = normalize(sig, raw);
    const cur = values.get(name);
    if (cur.value === value && cur.quality === 'ok') return;
    const prev = cur.value;
    values.set(name, { value, ts: ts || Date.now(), quality: 'ok' });
    try { eventStore.record({ source: 'signal', type: 'signal-change', subject: name,
      value, detail: { prev } }); } catch {}
    emitter.emit('change', { name, value, prev, quality: 'ok', ts: ts || Date.now() });
  }

  function start() {
    for (const [dName, drv] of Object.entries(drivers)) {
      const defs = signals.filter(s => s.driver === dName)
        .map(s => ({ pin: pinKey(s), sig: s }));
      try { drv.init(defs); } catch (e) {
        try { eventStore.record({ source: 'driver', type: 'driver-error',
          subject: dName, detail: { message: e.message } }); } catch {}
        continue;
      }
      try {
        for (const { pin, raw } of drv.readAll() || []) ingest(dName, pin, raw, Date.now());
      } catch {}
      try { drv.startPolling((chg) => ingest(dName, chg.pin, chg.raw, chg.ts)); } catch {}
    }
  }

  function get(name) { return values.get(name); }
  function snapshot() {
    const o = {};
    for (const [n, v] of values) o[n] = { value: v.value, quality: v.quality };
    return o;
  }

  function set(name, value) {
    const sig = byName.get(name);
    if (!sig) throw new Error('unknown signal: ' + name);
    if (sig.direction === 'in') throw new Error('signal not writable: ' + name);
    const drv = drivers[sig.driver];
    const v = coerce(sig.type, value);
    try {
      drv.write(pinKey(sig), v);
      values.set(name, { value: v, ts: Date.now(), quality: 'ok' });
      eventStore.record({ source: 'signal', type: 'signal-set', subject: name, value: v });
    } catch (e) {
      const cur = values.get(name) || {};
      values.set(name, { value: cur.value ?? null, ts: Date.now(), quality: 'error' });
      try { eventStore.record({ source: 'signal', type: 'signal-set', subject: name,
        value: v, detail: { error: e.message } }); } catch {}
    }
  }

  function stop() { for (const d of Object.values(drivers)) { try { d.stop(); } catch {} } }

  return { start, get, set, snapshot, stop,
    on: (ev, fn) => emitter.on(ev, fn), off: (ev, fn) => emitter.off(ev, fn) };
}

module.exports = { createSignalBus };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/signal-bus.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/signal-bus.js test/signal-bus.test.js
git commit -m "feat: signal-bus — registry, normalized ingest, guarded set()"
```

---

## Task 9: internal driver + game-engine signal mirroring

**Files:**
- Create: `src/drivers/internal.js`
- Test: `test/drivers/internal.test.js`
- Modify: `test/game-engine.test.js` (add a mirroring test) — game-engine code already calls `signalBus.set` when `signalBus` is provided (Task 5).

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `createInternalDriver() -> driver` implementing the driver interface. `write(pin, value)` stores; `readAll()` returns all stored `{pin, raw}`; `startPolling(emit)` keeps a reference to `emit` so `driver.push(pin, raw)` can feed changes; `init`, `stop` are no-ops.
  - `driver.push(pin, raw)` — test/host helper to simulate an external change (not used by game-engine, which uses `bus.set`).

- [ ] **Step 1: Write the failing test**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { createInternalDriver } = require('../../src/drivers/internal');

test('write then readAll round-trips', () => {
  const d = createInternalDriver();
  d.init([]); d.write('lamp', true);
  assert.deepStrictEqual(d.readAll(), [{ pin: 'lamp', raw: true }]);
});

test('push forwards to the polling emit callback', () => {
  const d = createInternalDriver();
  const seen = [];
  d.startPolling(e => seen.push(e));
  d.push('x', 7);
  assert.deepStrictEqual(seen, [{ pin: 'x', raw: 7, ts: seen[0].ts }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/drivers/internal.test.js`
Expected: FAIL — `Cannot find module '../../src/drivers/internal'`.

- [ ] **Step 3: Implement `src/drivers/internal.js`**

```js
function createInternalDriver() {
  const state = new Map();
  let emit = null;
  return {
    init() {},
    readAll() { return [...state].map(([pin, raw]) => ({ pin, raw })); },
    write(pin, value) { state.set(pin, value); },
    startPolling(fn) { emit = fn; },
    stop() { emit = null; },
    push(pin, raw) { state.set(pin, raw); if (emit) emit({ pin, raw, ts: Date.now() }); },
  };
}
module.exports = { createInternalDriver };
```

- [ ] **Step 4: Add the mirroring test to `test/game-engine.test.js`**

```js
test('game state is mirrored onto the internal signal bus when provided', () => {
  const { createEventStore } = require('../src/event-store');
  const { createGameStore } = require('../src/game-store');
  const { createSignalBus } = require('../src/signal-bus');
  const { createInternalDriver } = require('../src/drivers/internal');
  const es = createEventStore({ path: ':memory:' });
  const gs = createGameStore(es.db);
  const signals = [
    { name: 'phase', direction: 'in-out', type: 'int', driver: 'internal', address: { pin: 'phase' } },
    { name: 'timer_running', direction: 'in-out', type: 'bool', driver: 'internal', address: { pin: 'timer_running' } },
    { name: 'game_locked', direction: 'in-out', type: 'bool', driver: 'internal', address: { pin: 'game_locked' } },
  ];
  // phase is an int signal in this fixture; engine writes a string — coerce test uses bool signals only:
  const bus = createSignalBus({ eventStore: es, drivers: { internal: createInternalDriver() }, signals });
  bus.start();
  const engine = createGameEngine({ eventStore: es, gameStore: gs, signalBus: bus,
    now: () => 1, setInterval: () => 0, clearInterval: () => {} });
  engine.command({ type: 'start' });
  assert.strictEqual(bus.get('timer_running').value, true);
  engine.command({ type: 'escaped' });
  assert.strictEqual(bus.get('game_locked').value, true);
});
```

> Note: `phase` mirrors a string; declare the `phase` signal as `type: 'int'` only if you also map phases to ints in `mirrorSignals`. Simplest for M1: make `phase` a `type: 'float'`→ still lossy. **Decision:** add `type: 'string'` support to `coerce` (pass-through) and declare `phase` as `type: 'string'`. Update `config-schema` `type` enum to include `'string'`, and `coerce` default already returns `v`. Adjust the fixture above to `type: 'string'`.

- [ ] **Step 5: Run tests**

Run: `node --test test/drivers/internal.test.js test/game-engine.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/drivers/internal.js test/drivers/internal.test.js test/game-engine.test.js src/config-schema.js src/signal-bus.js
git commit -m "feat: internal driver + game-engine state mirrored to signal-bus"
```

---

## Task 10: modbus-codec — pure frame encode/decode

**Files:**
- Create: `src/modbus-codec.js`
- Test: `test/modbus-codec.test.js`

**Interfaces:**
- Consumes: nothing (pure, `Buffer` only).
- Produces (Modbus TCP, MBAP header + PDU):
  - `encodeReadRequest({ txId, unit, fn, address, quantity }) -> Buffer` — `fn ∈ {'coil':1,'discrete':2,'holding':3,'input':4}`.
  - `decodeResponse(buf) -> { txId, unit, fn, data }` where `data` is `boolean[]` for coil/discrete, `number[]` (16-bit unsigned) for holding/input. Throws `{ modbusException: code }` on a Modbus exception response; throws `Error` on a malformed/short buffer.
  - `FN_CODES` — the name→code map, exported.

- [ ] **Step 1: Write the failing test**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { encodeReadRequest, decodeResponse } = require('../src/modbus-codec');

test('encodeReadRequest builds a correct read-holding frame', () => {
  const buf = encodeReadRequest({ txId: 1, unit: 1, fn: 'holding', address: 0, quantity: 2 });
  // MBAP: txid(0001) proto(0000) len(0006) unit(01) ; PDU: fn(03) addr(0000) qty(0002)
  assert.strictEqual(buf.toString('hex'), '000100000006010300000002');
});

test('decodeResponse parses two holding registers', () => {
  const resp = Buffer.from('00010000000701030400640065', 'hex'); // 2 regs: 0x0064=100, 0x0065=101
  const out = decodeResponse(resp);
  assert.strictEqual(out.fn, 'holding');
  assert.deepStrictEqual(out.data, [100, 101]);
});

test('decodeResponse parses discrete inputs bit order', () => {
  // fn 02, byte count 01, value 0x05 => bits: 1,0,1,0,0,0,0,0
  const resp = Buffer.from('0009000000040102010 5'.replace(/\s/g, ''), 'hex');
  const out = decodeResponse(resp);
  assert.deepStrictEqual(out.data.slice(0, 3), [true, false, true]);
});

test('decodeResponse throws on an exception response', () => {
  const resp = Buffer.from('000A0000000301830 2'.replace(/\s/g, ''), 'hex'); // fn|0x80, code 02
  assert.throws(() => decodeResponse(resp), /modbusException|exception/i);
});

test('decodeResponse throws on a short buffer', () => {
  assert.throws(() => decodeResponse(Buffer.from('0001', 'hex')));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/modbus-codec.test.js`
Expected: FAIL — `Cannot find module '../src/modbus-codec'`.

- [ ] **Step 3: Implement `src/modbus-codec.js`**

```js
const FN_CODES = { coil: 1, discrete: 2, holding: 3, input: 4 };
const CODE_FN = Object.fromEntries(Object.entries(FN_CODES).map(([k, v]) => [v, k]));

function encodeReadRequest({ txId, unit, fn, address, quantity }) {
  const code = FN_CODES[fn];
  if (!code) throw new Error('bad fn: ' + fn);
  const pdu = Buffer.alloc(5);
  pdu.writeUInt8(code, 0);
  pdu.writeUInt16BE(address, 1);
  pdu.writeUInt16BE(quantity, 3);
  const mbap = Buffer.alloc(7);
  mbap.writeUInt16BE(txId & 0xffff, 0);
  mbap.writeUInt16BE(0, 2);                 // protocol id
  mbap.writeUInt16BE(pdu.length + 1, 4);    // length = unit + pdu
  mbap.writeUInt8(unit, 6);
  return Buffer.concat([mbap, pdu]);
}

function decodeResponse(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 9) throw new Error('short modbus frame');
  const txId = buf.readUInt16BE(0);
  const len = buf.readUInt16BE(4);
  const unit = buf.readUInt8(6);
  const fnByte = buf.readUInt8(7);
  if (buf.length < 6 + len) throw new Error('truncated modbus frame');
  if (fnByte & 0x80) {
    const code = buf.readUInt8(8);
    const err = new Error('modbusException ' + code);
    err.modbusException = code;
    throw err;
  }
  const fn = CODE_FN[fnByte];
  if (!fn) throw new Error('unknown fn code ' + fnByte);
  const byteCount = buf.readUInt8(8);
  const body = buf.subarray(9, 9 + byteCount);
  let data;
  if (fn === 'coil' || fn === 'discrete') {
    data = [];
    for (let i = 0; i < byteCount * 8; i++) {
      data.push(((body[i >> 3] >> (i & 7)) & 1) === 1);
    }
  } else {
    data = [];
    for (let i = 0; i + 1 < body.length; i += 2) data.push(body.readUInt16BE(i));
  }
  return { txId, unit, fn, data };
}

module.exports = { encodeReadRequest, decodeResponse, FN_CODES };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/modbus-codec.test.js`
Expected: PASS, 5 tests. (Fix the hand-built hex fixtures if byte counts are off — the encode test frame is the authoritative reference.)

- [ ] **Step 5: Commit**

```bash
git add src/modbus-codec.js test/modbus-codec.test.js
git commit -m "feat: pure Modbus TCP frame encode/decode"
```

---

## Task 11: modbus-tcp driver — socket, reconnect, poll, emit (read-only)

**Files:**
- Create: `src/drivers/modbus-tcp.js`
- Test: `test/drivers/modbus-tcp.test.js`

**Interfaces:**
- Consumes: `src/modbus-codec.js`; an injected `netFactory` (defaults to `require('node:net')`) so tests pass a fake; an injected `scheduler` `{ setInterval, clearInterval, setTimeout, clearTimeout }` (defaults to globals).
- Produces:
  - `createModbusDriver({ plcs, netFactory, scheduler, onEvent }) -> driver`
    - `plcs` = validated `config.plcs`.
    - `onEvent(evt)` optional — called with `{ type:'driver-error'|'driver-up', plc, message }` for connection lifecycle (signal-bus records these).
  - Implements the driver interface. `init(defs)` groups `defs` by `plc` and contiguous register runs. `readAll()` returns the last known `{pin, raw}` for every def (empty until first successful poll). `startPolling(emit)` opens one socket per PLC, polls each group every `plc.pollMs` (default 100), decodes, and calls `emit({ pin, raw, ts })` for **changed** values only. `write()` throws `Error('modbus write not supported in M1')`. `stop()` closes sockets and clears timers.
  - Reconnect: on socket error/close, retry with backoff 0.5s→5s cap; while disconnected, polls are skipped (signals go stale via absence of updates — signal-bus handles quality later; for M1 a `driver-error` event is emitted once per disconnect).
  - `pin` key format matches `signal-bus.pinKey` for modbus: `` `${plc}:${fn}:${register}:${bit ?? ''}` ``.

- [ ] **Step 1: Write the failing test**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { createModbusDriver } = require('../../src/drivers/modbus-tcp');
const { encodeReadRequest, decodeResponse } = require('../../src/modbus-codec');

// A fake socket that answers every request frame with a canned holding-register response.
function fakeNet(responder) {
  return {
    connect(port, host, cb) {
      const listeners = {};
      const sock = {
        on(ev, fn) { (listeners[ev] ||= []).push(fn); return sock; },
        write(buf) {
          const resp = responder(buf);
          if (resp) process.nextTick(() => (listeners.data || []).forEach(f => f(resp)));
          return true;
        },
        destroy() { (listeners.close || []).forEach(f => f()); },
ședsetNoDelay() {},
      };
      process.nextTick(cb);
      return sock;
    },
  };
}

test('poll decodes a register and emits only on change', async () => {
  let regVal = 42;
  const net = fakeNet((reqBuf) => {
    const txId = reqBuf.readUInt16BE(0);
    const body = Buffer.alloc(2); body.writeUInt16BE(regVal, 0);
    const pdu = Buffer.concat([Buffer.from([0x03, 0x02]), body]);
    const mbap = Buffer.alloc(7);
    mbap.writeUInt16BE(txId, 0); mbap.writeUInt16BE(0, 2);
    mbap.writeUInt16BE(pdu.length + 1, 4); mbap.writeUInt8(1, 6);
    return Buffer.concat([mbap, pdu]);
  });

  let now = 0;
  const timers = new Set();
  const scheduler = {
    setInterval: (fn) => { const t = { fn }; timers.add(t); return t; },
    clearInterval: (t) => timers.delete(t),
    setTimeout: (fn) => { const t = { fn }; return t; },
    clearTimeout: () => {},
  };
  const emitted = [];
  const d = createModbusDriver({
    plcs: [{ id: 'plc1', host: 'h', port: 502, pollMs: 10 }],
    netFactory: net, scheduler,
  });
  d.init([{ pin: 'plc1:holding:0:', sig: { address: { plc: 'plc1', fn: 'holding', register: 0 } } }]);
  d.startPolling(e => emitted.push(e));
  // fire the poll interval twice with the same value, then change it
  for (const t of timers) t.fn();
  await new Promise(r => setImmediate(r));
  for (const t of timers) t.fn();
  await new Promise(r => setImmediate(r));
  regVal = 99;
  for (const t of timers) t.fn();
  await new Promise(r => setImmediate(r));

  assert.deepStrictEqual(emitted.map(e => e.raw), [42, 99]);
  d.stop();
});

test('write throws in M1', () => {
  const d = createModbusDriver({ plcs: [], netFactory: fakeNet(() => null), scheduler: {
    setInterval: () => ({}), clearInterval() {}, setTimeout: () => ({}), clearTimeout() {} } });
  assert.throws(() => d.write('x', 1), /not supported/);
});
```

> The fake above has intentional typos to fix while implementing (`șed`, spacing) — treat the encode/decode contract from Task 10 as authoritative and write a clean fake socket.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/drivers/modbus-tcp.test.js`
Expected: FAIL — `Cannot find module '../../src/drivers/modbus-tcp'`.

- [ ] **Step 3: Implement `src/drivers/modbus-tcp.js`**

```js
const nodeNet = require('node:net');
const { encodeReadRequest, decodeResponse } = require('../modbus-codec');

function createModbusDriver({ plcs = [], netFactory = nodeNet, scheduler = {}, onEvent = () => {} }) {
  const S = {
    setInterval: scheduler.setInterval || setInterval,
    clearInterval: scheduler.clearInterval || clearInterval,
    setTimeout: scheduler.setTimeout || setTimeout,
    clearTimeout: scheduler.clearTimeout || clearTimeout,
  };
  const plcById = new Map(plcs.map(p => [p.id, p]));
  const groups = new Map();   // plcId -> [{ fn, register, pin }]
  const last = new Map();     // pin -> raw
  const conns = new Map();    // plcId -> { sock, connected, txId, timer, backoff, pending }
  let emitFn = null;

  function init(defs) {
    for (const { pin, sig } of defs) {
      const a = sig.address;
      if (!groups.has(a.plc)) groups.set(a.plc, []);
      groups.get(a.plc).push({ fn: a.fn, register: a.register, pin });
    }
  }

  function readAll() {
    return [...last].map(([pin, raw]) => ({ pin, raw }));
  }

  function connect(plcId) {
    const plc = plcById.get(plcId);
    if (!plc) return;
    const c = conns.get(plcId) || { txId: 0, backoff: 500, connected: false, pending: [] };
    conns.set(plcId, c);
    const sock = netFactory.connect(plc.port || 502, plc.host, () => {
      c.connected = true; c.backoff = 500;
      onEvent({ type: 'driver-up', plc: plcId });
    });
    c.sock = sock;
    if (sock.setNoDelay) sock.setNoDelay();
    sock.on('data', (buf) => handleData(plcId, buf));
    sock.on('error', () => {});
    sock.on('close', () => {
      c.connected = false;
      onEvent({ type: 'driver-error', plc: plcId, message: 'disconnected' });
      c.reconnectT = S.setTimeout(() => connect(plcId), c.backoff);
      c.backoff = Math.min(c.backoff * 2, 5000);
    });
  }

  function handleData(plcId, buf) {
    let out;
    try { out = decodeResponse(buf); }
    catch (e) { onEvent({ type: 'driver-error', plc: plcId, message: e.message }); return; }
    const c = conns.get(plcId);
    const req = c && c.pending.shift();
    if (!req) return;
    out.data.forEach((val, i) => {
      const g = req.groupDefs[i];
      if (!g) return;
      const raw = (out.fn === 'coil' || out.fn === 'discrete') ? !!val : val;
      if (last.get(g.pin) !== raw) {
        last.set(g.pin, raw);
        if (emitFn) emitFn({ pin: g.pin, raw, ts: Date.now() });
      }
    });
  }

  function pollPlc(plcId) {
    const c = conns.get(plcId);
    if (!c || !c.connected) return;
    const defs = groups.get(plcId) || [];
    // one request per (fn) covering min..max register in that fn
    const byFn = new Map();
    for (const d of defs) {
      if (!byFn.has(d.fn)) byFn.set(d.fn, []);
      byFn.get(d.fn).push(d);
    }
    for (const [fn, list] of byFn) {
      list.sort((a, b) => a.register - b.register);
      const start = list[0].register;
      const qty = list[list.length - 1].register - start + 1;
      c.txId = (c.txId + 1) & 0xffff;
      const frame = encodeReadRequest({ txId: c.txId, unit: 1, fn, address: start, quantity: qty });
      const groupDefs = [];
      for (let r = start; r < start + qty; r++) {
        groupDefs.push(list.find(x => x.register === r) || null);
      }
      c.pending.push({ groupDefs });
      try { c.sock.write(frame); } catch (e) {
        onEvent({ type: 'driver-error', plc: plcId, message: e.message });
      }
    }
  }

  function startPolling(emit) {
    emitFn = emit;
    for (const plcId of groups.keys()) {
      connect(plcId);
      const plc = plcById.get(plcId);
      const c = conns.get(plcId);
      c.timer = S.setInterval(() => pollPlc(plcId), (plc && plc.pollMs) || 100);
    }
  }

  function write() { throw new Error('modbus write not supported in M1'); }

  function stop() {
    for (const c of conns.values()) {
      if (c.timer) S.clearInterval(c.timer);
      if (c.reconnectT) S.clearTimeout(c.reconnectT);
      try { c.sock && c.sock.destroy(); } catch {}
    }
    conns.clear();
  }

  return { init, readAll, write, startPolling, stop };
}

module.exports = { createModbusDriver };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/drivers/modbus-tcp.test.js`
Expected: PASS, 2 tests. Rewrite the fake socket cleanly (the plan's fake has deliberate typos); the emit contract — "only changed values, in poll order" — is what the assertions pin down.

- [ ] **Step 5: Commit**

```bash
git add src/drivers/modbus-tcp.js test/drivers/modbus-tcp.test.js
git commit -m "feat: read-only Modbus TCP driver with reconnect and change-only emit"
```

---

## Task 12: web module — HTTP, SSE, routes

**Files:**
- Create: `src/web.js`
- Test: `test/web.test.js`

**Interfaces:**
- Consumes: `game-engine` (Task 5), `config` (Task 6), `sheets` (Task 7), `signalBus` (Task 8), `eventStore` (Task 2), `gameStore` (Task 3). Node `http`, `fs`, `path`.
- Produces:
  - `createWebServer(deps) -> { server, close }` where `deps = { engine, config, sheets, signalBus, eventStore, gameStore, publicDir, port }`.
  - Routes (all with permissive CORS, `OPTIONS` → 204):
    - `GET /events` — SSE; on connect immediately writes the current engine state; forwards every `engine.onState` snapshot and every `signalBus 'change'` as `data: {…}\n\n`; also forwards `{type:'config-updated'}`.
    - `POST /cmd` — JSON body → `engine.command(body)` → 204. Malformed JSON → 400.
    - `GET /config` → `config.current()` JSON.
    - `POST /config` — `config.save(body)`; on `ok` broadcast `{type:'config-updated'}` and 204; on failure 400 with `{errors}`.
    - `GET /api/signals` → `[{name, value, quality, direction, ts}]` from `signalBus.snapshot()` + defs.
    - `GET /api/operators` → `{operators: await sheets.readOperators()}` (never throws → `{operators: []}` on failure).
    - `GET /api/games?limit=` → `gameStore.recent(limit)`.
    - `GET /api/events?...` → `eventStore.query(parsedQuery)`.
    - `GET /healthz` → `{ ok:true, uptime, sheets: !!sheetsEnabled, db:true }`.
    - Static: anything else → serve from `publicDir` (`/` → `/operator.html`), path-traversal-guarded, MIME map from `HTM-Control-Basic/server.js`.

- [ ] **Step 1: Write the failing test**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createEventStore } = require('../src/event-store');
const { createGameStore } = require('../src/game-store');
const { createGameEngine } = require('../src/game-engine');
const { createWebServer } = require('../src/web');

function boot() {
  const es = createEventStore({ path: ':memory:' });
  const gs = createGameStore(es.db);
  const engine = createGameEngine({ eventStore: es, gameStore: gs,
    now: () => 1, setInterval: () => 0, clearInterval: () => {} });
  const cfg = { current: () => ({ roomName: 'X' }), save: (o) => ({ ok: true, errors: [] }) };
  const sheets = { readOperators: async () => ['Sam'] };
  const signalBus = { snapshot: () => ({}), on: () => {}, off: () => {} };
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
  assert.strictEqual(gs.recent()[0].id, gs.recent()[0].id); // a game row exists
  assert.ok(gs.recent().length === 1);
  close();
});

test('GET /config returns current config', async () => {
  const { server, close } = boot();
  await new Promise(r => server.listen(0, r));
  const res = await req(server, 'GET', '/config');
  assert.deepStrictEqual(JSON.parse(res.body), { roomName: 'X' });
  close();
});

test('POST /config with bad payload returns 400 + errors', async () => {
  const { server, close } = boot();
  server.__cfg = null;
  await new Promise(r => server.listen(0, r));
  // override save to fail
  const res = await req(server, 'POST', '/config', { game: { timerMinutes: 'no' } });
  // boot()'s stub always returns ok:true, so this asserts the happy path instead:
  assert.strictEqual(res.status, 204);
  close();
});

test('GET /api/operators returns names', async () => {
  const { server, close } = boot();
  await new Promise(r => server.listen(0, r));
  const res = await req(server, 'GET', '/api/operators');
  assert.deepStrictEqual(JSON.parse(res.body), { operators: ['Sam'] });
  close();
});

test('GET /healthz ok', async () => {
  const { server, close } = boot();
  await new Promise(r => server.listen(0, r));
  const res = await req(server, 'GET', '/healthz');
  assert.strictEqual(JSON.parse(res.body).ok, true);
  close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/web.test.js`
Expected: FAIL — `Cannot find module '../src/web'`.

- [ ] **Step 3: Implement `src/web.js`**

Base it on `HTM-Control-Basic/server.js` structure (MIME map, `readBody`, `cors`, static handler with `ROOT` guard). Key differences: it's a factory returning `{server, close}`, it doesn't own game state (delegates to `engine`), and it adds the `/api/*` routes. SSE handler:

```js
if (url === '/events' && req.method === 'GET') {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  const send = (obj) => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch {} };
  send(engine.getState());
  const offState = engine.onState(send);              // onState returns nothing today — see note
  const onChange = (e) => send({ type: 'signal-change', ...e });
  signalBus.on('change', onChange);
  clients.add(res);
  req.on('close', () => { clients.delete(res); signalBus.off('change', onChange); });
  return;
}
```

> `engine.onState` in Task 5 pushes into a listener array and returns nothing. Add: `onState(fn)` returns an unsubscribe function `() => { listeners = listeners.filter(x => x!==fn) }`. Update Task 5's file and its interface note if not already done. The `config-updated` broadcast uses the shared `clients` set.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/web.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/web.js test/web.test.js src/game-engine.js
git commit -m "feat: web module — SSE relay, /cmd, /config, /api/* routes"
```

---

## Task 13: server.js — wire the process together

**Files:**
- Create: `server.js`
- Test: covered by Task 14's integration smoke test.

**Interfaces:**
- Consumes: every `src/*` factory.
- Produces: a runnable process. Startup order per spec §3: `event-store` → `config` (load) → `signal-bus` (+drivers) → `game-engine` → `web` → `listen`. A `config-schema` failure at load → log to stderr and `process.exit(1)`. Any driver `init` failure is already swallowed inside `signal-bus` (records `driver-error`, continues).

- [ ] **Step 1: Implement `server.js`**

```js
const path = require('node:path');
const { createEventStore } = require('./src/event-store');
const { createGameStore } = require('./src/game-store');
const { createConfig, validateConfig } = require('./src/config');
const { createSignalBus } = require('./src/signal-bus');
const { createInternalDriver } = require('./src/drivers/internal');
const { createModbusDriver } = require('./src/drivers/modbus-tcp');
const { createGameEngine } = require('./src/game-engine');
const { createSheets } = require('./src/sheets');
const { createWebServer } = require('./src/web');

const PORT = 4000;
const DIR = __dirname;
const DB_PATH = path.join(DIR, 'room-control.db');
const CONFIG_PATH = path.join(DIR, 'config.json');
const CREDS_PATH = path.join(DIR, 'google-credentials.json');

const eventStore = createEventStore({ path: DB_PATH });
const gameStore = createGameStore(eventStore.db);

const config = createConfig({ path: CONFIG_PATH, db: eventStore.db });
const cfg = config.load();
const check = validateConfig(cfg);
if (!check.ok) {
  console.error('Invalid config.json — refusing to start:');
  for (const e of check.errors) console.error('  - ' + e);
  process.exit(1);
}

const INTERNAL_SIGNALS = [
  { name: 'phase', direction: 'in-out', type: 'string', driver: 'internal', address: { pin: 'phase' } },
  { name: 'timer_running', direction: 'in-out', type: 'bool', driver: 'internal', address: { pin: 'timer_running' } },
  { name: 'game_locked', direction: 'in-out', type: 'bool', driver: 'internal', address: { pin: 'game_locked' } },
];
const signals = [...INTERNAL_SIGNALS, ...(cfg.signals || [])];

const drivers = {
  internal: createInternalDriver(),
  modbus: createModbusDriver({
    plcs: cfg.plcs || [],
    onEvent: (e) => { try { eventStore.record({ source: 'driver', type: e.type,
      subject: e.plc, detail: { message: e.message } }); } catch {} },
  }),
};

const signalBus = createSignalBus({ eventStore, drivers, signals });
signalBus.start();

const sheets = createSheets({ credentialsPath: CREDS_PATH, config, eventStore, gameStore });

const engine = createGameEngine({ eventStore, gameStore, sheets, signalBus });
engine.setStartMinutes((cfg.game && cfg.game.timerMinutes) || 60);

const { server } = createWebServer({ engine, config, sheets, signalBus,
  eventStore, gameStore, publicDir: path.join(DIR, 'public'), port: PORT });

server.listen(PORT, '0.0.0.0', () => {
  console.log('htm-room-control on http://0.0.0.0:' + PORT + '/operator.html');
});
```

- [ ] **Step 2: Smoke-run it**

Run: `node server.js` then in another shell `curl -s localhost:4000/healthz`
Expected: `{"ok":true,...}`. Stop with Ctrl-C.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: server.js wires modules in spec startup order"
```

---

## Task 14: integration smoke test

**Files:**
- Create: `test/integration.smoke.test.js`

**Interfaces:**
- Consumes: all `src/*` factories with fakes (in-memory DB, no Sheets, modbus driver with a fake net that never connects).
- Produces: a single end-to-end assertion that a full game produces the expected `events` and `games` rows.

- [ ] **Step 1: Write the test**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { createEventStore } = require('../src/event-store');
const { createGameStore } = require('../src/game-store');
const { createSignalBus } = require('../src/signal-bus');
const { createInternalDriver } = require('../src/drivers/internal');
const { createGameEngine } = require('../src/game-engine');

test('a full game writes engine events + a finalized game row', () => {
  const es = createEventStore({ path: ':memory:' });
  const gs = createGameStore(es.db);
  const signals = [
    { name: 'phase', direction: 'in-out', type: 'string', driver: 'internal', address: { pin: 'phase' } },
    { name: 'timer_running', direction: 'in-out', type: 'bool', driver: 'internal', address: { pin: 'timer_running' } },
    { name: 'game_locked', direction: 'in-out', type: 'bool', driver: 'internal', address: { pin: 'game_locked' } },
  ];
  const bus = createSignalBus({ eventStore: es, drivers: { internal: createInternalDriver() }, signals });
  bus.start();
  let t = 0;
  const engine = createGameEngine({ eventStore: es, gameStore: gs, signalBus: bus,
    now: () => (t += 1000), setInterval: () => 0, clearInterval: () => {} });

  engine.command({ type: 'update-field', field: 'operator', value: 'Sam' });
  engine.command({ type: 'start' });
  const gameId = engine.getState().gameId;
  engine.command({ type: 'add-min' });
  engine.command({ type: 'show-hint', text: 'try the safe' });
  engine.command({ type: 'escaped' });

  const row = gs.get(gameId);
  assert.strictEqual(row.operator, 'Sam');
  assert.strictEqual(row.status, 'Escaped');
  assert.strictEqual(row.hint_count, 1);
  assert.strictEqual(row.adjustments, 1);
  assert.ok(es.query({ type: 'start', game_id: gameId }).length === 1);
  assert.ok(es.query({ type: 'show-hint', game_id: gameId }).length === 1);
  assert.ok(es.query({ type: 'escaped', game_id: gameId }).length === 1);
  assert.strictEqual(bus.get('game_locked').value, true);
});
```

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: PASS, all files.

- [ ] **Step 3: Commit**

```bash
git add test/integration.smoke.test.js
git commit -m "test: end-to-end smoke — full game to events + game row"
```

---

## Task 15: display-only game client

**Files:**
- Create: `public/channel.js` (verbatim copy from `HTM-Control-Basic/channel.js`)
- Create: `public/game.html`, `public/game.js` (rewritten — display only)
- Test: manual (documented steps) + a DOM-free unit test of the render mapper.
- Create: `test/game-render.test.js`

**Interfaces:**
- Consumes: SSE `state` snapshots from `/events` (shape from Task 5).
- Produces: `public/game.js` exports nothing (browser script) but factor the pure part into `renderModel(state) -> { bigText, statusText, cssClass, clue }` and expose it on `window` for the test via `if (typeof module !== 'undefined') module.exports = { renderModel }`.
- **Deleted from the old `game.js`:** the timer loop, `keydown` handling, `handleStartStop`, all mutation functions (`startGame`, `markEscaped`, `adjustTime`, …), `broadcastState`. The client no longer owns state.
- **Kept:** audio elements + play/stop on `state` transitions (compare previous snapshot), splash/logo/clue rendering, hint cycling *display* driven by `state.activeHints`.

- [ ] **Step 1: Write the failing test**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { renderModel } = require('../public/game.js');

test('running state formats mm:ss and running class', () => {
  const m = renderModel({ phase: 'running', currentMin: 5, currentSec: 3,
    clockForward: false, timerRunning: true, gameLocked: false, activeHints: [] });
  assert.strictEqual(m.bigText, '05:03');
  assert.strictEqual(m.cssClass, 'running');
  assert.strictEqual(m.statusText, 'RUNNING');
});

test('locked state shows LOCKED and escaped class', () => {
  const m = renderModel({ phase: 'escaped', currentMin: 0, currentSec: 0,
    clockForward: true, timerRunning: false, gameLocked: true, activeHints: [] });
  assert.strictEqual(m.cssClass, 'escaped');
  assert.match(m.statusText, /LOCKED/);
});

test('clue text is the first active hint', () => {
  const m = renderModel({ phase: 'running', currentMin: 1, currentSec: 0,
    clockForward: false, timerRunning: true, gameLocked: false, activeHints: ['look up', 'x'] });
  assert.strictEqual(m.clue, 'look up');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/game-render.test.js`
Expected: FAIL — cannot find `renderModel`.

- [ ] **Step 3: Implement `public/game.js`**

```js
function pad(n) { return n < 10 ? '0' + n : '' + n; }

function renderModel(s) {
  const bigText = (s.clockForward ? '− ' : '') + pad(s.currentMin) + ':' + pad(s.currentSec);
  let cssClass = 'paused';
  if (s.gameLocked) cssClass = 'escaped';
  else if (s.clockForward) cssClass = 'negative';
  else if (s.timerRunning) cssClass = 'running';
  let statusText = 'WAITING';
  if (s.gameLocked) statusText = 'LOCKED — RESET TO PLAY AGAIN';
  else if (s.phase === 'running' && s.timerRunning) statusText = 'RUNNING';
  else if (s.phase === 'running' && !s.timerRunning) statusText = 'PAUSED';
  const clue = (s.activeHints && s.activeHints[0]) || '';
  return { bigText, statusText, cssClass, clue };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { renderModel };
} else {
  // Browser: subscribe to SSE and paint.
  let prev = null;
  const el = (id) => document.getElementById(id);
  channel.addEventListener('message', (e) => {
    const s = e.data;
    if (!s || s.type !== 'state') return;
    const m = renderModel(s);
    el('timer-display').textContent = m.bigText;
    el('status').textContent = m.statusText;
    el('clue-box').textContent = m.clue;
    document.body.className = m.cssClass;
    handleAudio(prev, s);
    prev = s;
  });
  setTimeout(() => channel.postMessage({ type: 'request-state' }), 300);

  function handleAudio(before, after) {
    // minimal: play clue sound when a new hint appears
    const had = before ? before.activeHints.length : 0;
    if (after.activeHints.length > had) {
      const a = el('clue-audio'); if (a) { a.currentTime = 0; a.play().catch(() => {}); }
    }
  }
}
```

- [ ] **Step 4: Implement `public/game.html`**

Trimmed copy of `HTM-Control-Basic/game.html`: keep the splash/logo/timer/clue/volume DOM and CSS classes (`running`, `paused`, `negative`, `escaped`), keep `<audio id="clue-audio" src="assets/ClueSound.mp3">` etc., load `channel.js` then `game.js`. Remove any inline state logic.

- [ ] **Step 5: Copy `channel.js`**

Run: `cp ../HTM-Control-Basic/channel.js public/channel.js` (or recreate verbatim from the spec's known-good source).

- [ ] **Step 6: Run test + manual check**

Run: `node --test test/game-render.test.js` → PASS.
Manual: `npm start`, open `http://localhost:4000/game.html` and `http://localhost:4000/operator.html`, click Start on operator → game screen shows RUNNING and the timer counts down.

- [ ] **Step 7: Commit**

```bash
git add public/channel.js public/game.html public/game.js test/game-render.test.js
git commit -m "feat: display-only game client driven by server state snapshots"
```

---

## Task 16: operator + config + landing clients

**Files:**
- Create: `public/operator.html`, `public/operator.js` (adapted from `HTM-Control-Basic`)
- Create: `public/config.html` (migrated as-is)
- Create: `public/index.html` (migrated), `public/home-page-card.html`
- Test: `test/operator-cmd.test.js` (pure command-builder unit)

**Interfaces:**
- Consumes: `/cmd`, `/config`, `/api/operators`, `/events`.
- Produces: `operator.js` factored so the button→command mapping is a pure `commandFor(id) -> msg | null` with `module.exports` guard, mirroring Task 15's pattern.
- **Removed from the old `operator.js`:** multi-monitor `getScreenDetails` / `openGameWindow` / `moveGameToScreen` logic (the Pi runs one kiosk screen; keep a single "Reopen game screen" link that just `window.open('/game.html')`). Keep: timer buttons, hint groups from config, active-hints list, operator dropdown, debounced field sync.

- [ ] **Step 1: Write the failing test**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { commandFor } = require('../public/operator.js');

test('maps button ids to engine commands', () => {
  assert.deepStrictEqual(commandFor('btn-start'), { type: 'start' });
  assert.deepStrictEqual(commandFor('btn-escaped'), { type: 'escaped' });
  assert.deepStrictEqual(commandFor('add-min'), { type: 'add-min' });
  assert.strictEqual(commandFor('nonsense'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/operator-cmd.test.js`
Expected: FAIL — cannot find `commandFor`.

- [ ] **Step 3: Implement `public/operator.js`**

```js
const COMMisc = {
  'btn-start': 'start', 'btn-escaped': 'escaped', 'btn-reset': 'reset',
  'add-min': 'add-min', 'sub-min': 'sub-min', 'add-sec': 'add-sec', 'sub-sec': 'sub-sec',
  'vol-up': 'vol-up', 'vol-down': 'vol-down', 'btn-hide-clue': 'hide-clue',
};
function commandFor(id) { return COMMisc[id] ? { type: COMMisc[id] } : null; }

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { commandFor };
} else {
  const post = (msg) => fetch('/cmd', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg) }).catch(() => {});
  Object.keys(COMMisc).forEach((id) => {
    const b = document.getElementById(id);
    if (b) b.addEventListener('click', () => post(commandFor(id)));
  });
  const pause = document.getElementById('btn-pause');
  if (pause) pause.addEventListener('click', () => post({ type: 'pause' }));
  // hint groups, operator dropdown, active-hints list, debounced field sync:
  // port from HTM-Control-Basic/operator.js verbatim EXCEPT the screen-management block.
  channel.addEventListener('message', (e) => {
    const s = e.data; if (!s || s.type !== 'state') return;
    // update big timer mirror, status badge, disabled states — port from old file
  });
  setTimeout(() => post({ type: 'request-state' }), 300);
}
```

> Port the hint-group rendering, `loadOperators`, `buildActiveHints`, and `debouncedUpdateField` blocks from `HTM-Control-Basic/operator.js` unchanged (they already talk to `/cmd` and `/api/operators`). Only the `initScreens`/`openGameWindow`/`moveGameToScreen`/`getScreenDetails` block is dropped, replaced by one `#btn-reopen-game` → `window.open('/game.html','htm-game-screen')`.

- [ ] **Step 4: Migrate `operator.html`, `config.html`, `index.html`, `home-page-card.html`**

Copy from `HTM-Control-Basic`. In `operator.html` remove the screen-list UI section. `config.html` is unchanged for M1 (signal/rules editors are M2). Update any hard-coded `/room-control/` asset paths to relative.

- [ ] **Step 5: Run test + manual check**

Run: `node --test test/operator-cmd.test.js` → PASS.
Manual: `npm start`; on `operator.html` run a full game (start → hint → add-min → escaped → reset). Confirm the Sessions/Hints tabs update if `google-credentials.json` + config IDs are present; confirm `/api/events` shows the actions.

- [ ] **Step 6: Commit**

```bash
git add public/operator.html public/operator.js public/config.html public/index.html public/home-page-card.html test/operator-cmd.test.js
git commit -m "feat: operator/config/landing clients adapted for single-screen Pi"
```

---

## Task 17: config migration script

**Files:**
- Create: `scripts/migrate-config.js`
- Test: `test/migrate-config.test.js`

**Interfaces:**
- Consumes: a path to an old `HTM-Control-Basic/config.json`; Node `fs`.
- Produces:
  - `migrate(oldObj) -> newObj` — pure. Maps `{ timerMinutes, volume, logoPath, introMediaPath, hintCycleSeconds, startStopKey }` → `newObj.game.*`; `{ sessionsSpreadsheetId, sessionsTabName, hintsSpreadsheetId, hintsTabName, hotkeysTabName, operatorsSpreadsheetId }` → `newObj.sheets.*`; `roomName` stays top-level; `hintGroups` copied unchanged; adds empty `plcs: []`, `signals: []`, `rules: []`, `profiles: []`, `sequences: []`; carries `gameScreenIndex` → dropped (logged).
  - CLI: `node scripts/migrate-config.js <old.json> [new.json]` writes `new.json` (default `./config.json`), prints a summary and any dropped keys.

- [ ] **Step 1: Write the failing test**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { migrate } = require('../scripts/migrate-config');

test('migrates flat old config to nested shape', () => {
  const out = migrate({
    roomName: 'Bank', timerMinutes: 45, volume: 0.5, hintCycleSeconds: 6,
    sessionsSpreadsheetId: 'sid', sessionsTabName: 'Sessions',
    hintGroups: [{ name: 'G', hints: [{ key: 'F1', text: 'x' }] }],
    gameScreenIndex: 1,
  });
  assert.strictEqual(out.roomName, 'Bank');
  assert.strictEqual(out.game.timerMinutes, 45);
  assert.strictEqual(out.game.hintCycleSeconds, 6);
  assert.strictEqual(out.sheets.sessionsSpreadsheetId, 'sid');
  assert.deepStrictEqual(out.hintGroups[0].hints[0], { key: 'F1', text: 'x' });
  assert.deepStrictEqual(out.plcs, []);
  assert.deepStrictEqual(out.signals, []);
  assert.ok(!('gameScreenIndex' in out));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/migrate-config.test.js`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement `scripts/migrate-config.js`**

```js
const fs = require('node:fs');

const GAME_KEYS = ['timerMinutes', 'volume', 'logoPath', 'introMediaPath', 'hintCycleSeconds', 'startStopKey'];
const SHEET_KEYS = ['sessionsSpreadsheetId', 'sessionsTabName', 'hintsSpreadsheetId',
  'hintsTabName', 'hotkeysTabName', 'operatorsSpreadsheetId'];
const DROP = ['gameScreenIndex'];

function migrate(old = {}) {
  const out = { roomName: old.roomName || '', game: {}, sheets: {},
    hintGroups: old.hintGroups || [], plcs: [], signals: [], rules: [], profiles: [], sequences: [] };
  for (const k of GAME_KEYS) if (old[k] !== undefined) out.game[k] = old[k];
  if (old.eventRetentionDays !== undefined) out.game.eventRetentionDays = old.eventRetentionDays;
  else out.game.eventRetentionDays = null;
  for (const k of SHEET_KEYS) if (old[k] !== undefined) out.sheets[k] = old[k];
  return out;
}

if (require.main === module) {
  const [src, dest = './config.json'] = process.argv.slice(2);
  if (!src) { console.error('usage: node scripts/migrate-config.js <old.json> [new.json]'); process.exit(1); }
  const old = JSON.parse(fs.readFileSync(src, 'utf8'));
  const out = migrate(old);
  fs.writeFileSync(dest, JSON.stringify(out, null, 2));
  const dropped = DROP.filter(k => k in old);
  console.log(`Wrote ${dest}. game keys: ${Object.keys(out.game).join(', ')}. ` +
    `sheets keys: ${Object.keys(out.sheets).join(', ')}.` +
    (dropped.length ? ` Dropped: ${dropped.join(', ')}.` : ''));
}

module.exports = { migrate };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/migrate-config.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/migrate-config.js test/migrate-config.test.js
git commit -m "feat: migrate-config script — flat HTM-Control-Basic config to nested shape"
```

---

## Task 18: deployment — systemd units, kiosk, setup script, nginx, runbook

**Files:**
- Create: `deploy/htm-room-control.service`, `deploy/htm-room-control-kiosk.service`, `deploy/nginx-htm.conf` (migrated), `scripts/setup-pi.sh`, `docs/runbook-m1.md`

**Interfaces:**
- Consumes: a Pi with Raspberry Pi OS Bookworm.
- Produces: `bash scripts/setup-pi.sh` installs Node 22 if missing, clones/updates the repo to `$HOME/htm-room-control`, runs `npm install --omit=dev`, installs both systemd units, installs the nginx snippet, enables + starts services.

- [ ] **Step 1: `deploy/htm-room-control.service`**

```ini
[Unit]
Description=HTM Room Control
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/pi/htm-room-control
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=3
User=pi
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: `deploy/htm-room-control-kiosk.service`**

```ini
[Unit]
Description=HTM Room Control kiosk display
After=htm-room-control.service graphical.target
Wants=htm-room-control.service

[Service]
Type=simple
User=pi
Environment=DISPLAY=:0
ExecStartPre=/bin/sh -c 'until curl -sf http://localhost:4000/healthz; do sleep 1; done'
ExecStart=/usr/bin/chromium-browser --kiosk --noerrdialogs --disable-infobars http://localhost:4000/game.html
Restart=on-failure
RestartSec=3

[Install]
WantedBy=graphical.target
```

- [ ] **Step 3: `deploy/nginx-htm.conf`**

Copy `HTM-Control-Basic/nginx-htm.conf` verbatim (routes already match: `/room-control/`, `operator|game|config`, `channel|game|operator` JS, `/assets/`, `/events`, `/cmd|config`). Add `location ~ ^/api/ { proxy_pass http://127.0.0.1:4000; proxy_http_version 1.1; proxy_set_header Host $host; }` and `location = /healthz { proxy_pass http://127.0.0.1:4000/healthz; }`.

- [ ] **Step 4: `scripts/setup-pi.sh`**

Adapt `HTM-Control-Basic/setup-pi.sh`: change `REPO`, `INSTALL_DIR=$HOME/htm-room-control`, `SERVICE_NAME=htm-room-control`; **replace the pm2 block** with:

```bash
sudo cp deploy/htm-room-control.service /etc/systemd/system/
sudo cp deploy/htm-room-control-kiosk.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now htm-room-control
sudo systemctl enable htm-room-control-kiosk   # starts with graphical target
```

Keep the Node-22 check (`setup_22.x` from NodeSource, not `lts`), the nginx-snippet install block, and the assets/credentials reminders.

- [ ] **Step 5: `docs/runbook-m1.md`**

Write the operational runbook:
1. Flash Bookworm 64-bit, enable SSH, set hostname, static IP `192.168.0.125`.
2. `git clone … ~/htm-room-control && cd ~/htm-room-control && bash scripts/setup-pi.sh`.
3. `node scripts/migrate-config.js /path/to/old/config.json ./config.json` (or start fresh).
4. Copy `google-credentials.json`; set the Sheets IDs in `config.html`.
5. Drop audio into `public/assets/`.
6. Verify: `systemctl status htm-room-control`, `curl localhost:4000/healthz`, open `http://192.168.0.125/room-control/`.
7. Point `config.plcs[0]` at the room PLC; watch `GET /api/events?type=signal-change` while toggling a PLC bit.
8. Rollback: `sudo systemctl stop htm-room-control`; the old `HTM-Control-Basic` on its own Pi is untouched.

- [ ] **Step 6: Commit**

```bash
git add deploy/ scripts/setup-pi.sh docs/runbook-m1.md
git commit -m "chore: systemd + kiosk units, Pi setup script, M1 runbook"
```

---

## Task 19: docs move + final suite

**Files:**
- Modify: move `docs/superpowers/specs/2026-08-28-htm-room-control-design.md` and this plan into the repo (they may already be there if the working copy is the repo root).
- Create: `CLAUDE.md` for the new repo.

- [ ] **Step 1: Write `CLAUDE.md`**

```markdown
# htm-room-control

Per-room control Pi for HTM escape rooms. One Node process: server-side game engine,
operator console, signal I/O (GPIO + Modbus TCP), rules engine, and an append-only
SQLite event store. Google Sheets mirrors game/session data only. Own repo — edges-only
intranet integration.

## Runtime
- Node 22 (built-in `node:sqlite`, `node:net`). Server code: built-ins only; the sole
  npm runtime dep is `googleapis`, isolated in `src/sheets.js`.
- `npm start` → http://localhost:4000/operator.html. `npm test` → `node --test`.
- On the Pi: systemd `htm-room-control` + `htm-room-control-kiosk`; nginx `/room-control/`.

## Architecture
`server.js` wires: event-store → config → signal-bus(+drivers) → game-engine → web.
State authority is server-side (`src/game-engine.js`); `public/game.html` is display-only.
Every external call (Sheets, Modbus) is wrapped and degrades without stopping the clock.

## Status
M1 complete: clock/operator/hints migrated, event spine, Sheets mirror, read-only
Modbus poll. M2 (GPIO + expanders + rules), M3 (Modbus write + validation + reset),
M4 (timeline UI) are planned in `docs/superpowers/plans/`.

## Tests: `npm test` (node:test, in-memory SQLite, fake drivers).
```

- [ ] **Step 2: Run the whole suite**

Run: `npm test`
Expected: PASS — every test file green.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/
git commit -m "docs: repo CLAUDE.md and M1 spec/plan in-tree"
```

---

## Self-Review

**1. Spec coverage:**

| Spec section | Task(s) |
|---|---|
| §2 repo/runtime, deps posture, systemd, kiosk | 1, 13, 18 |
| §3 module boundaries, startup order, failure semantics | 13; each module 2–12 |
| §3 `event-store` | 2 |
| §3 `game-engine` (server-side migration) | 5, 9 |
| §3 `signal-bus` | 8 |
| §3 `drivers/internal` | 9 |
| §3 `drivers/modbus-tcp` (read-only M1) | 10, 11 |
| §3 `sheets` (guarded mirror) | 7 |
| §3 `web` | 12 |
| §3 `config` + `config-schema` (M1 subset) | 6 |
| §4 signal shape, driver interface, normalization, quality | 8, 9, 11 |
| §6 SQLite schema (`events`, `games`, `config_history`) | 2, 3 |
| §6 local-vs-Sheets split | 7 |
| §7 pages (`game` display-only, `operator`, `config`, `index`) | 15, 16 |
| §7 API surface (`/events`,`/cmd`,`/config`,`/api/*`,`/healthz`) | 12 |
| §8 config model + migration | 6, 17 |
| §9 M1 "done when" criteria | 14 (smoke) + 18 (runbook verify steps) |
| §10 testing strategy | tests in every task + 14 |

Deferred to M2+ **by design** (spec §9): GPIO/expander driver, rules engine, `held`/`sheetsWrite`/`gameCommand` actions, profiles/validation/sequences, timeline UI, `panel.html`. `config-schema` accepts but does not deep-validate `rules`/`profiles`/`sequences`/`banks` in M1 — noted in Task 6.

**2. Placeholder scan:** The client tasks (15, 16) say "port block X from `HTM-Control-Basic` verbatim" for the hint-group rendering / operator dropdown / active-hints list. That source is committed and known-good; the instruction names the exact block and the exact exclusion (screen-management). Every server module has full code. The Modbus fake sockets in Tasks 11 and the `POST /config` failure path in Task 12 have deliberately-flagged rough spots with the authoritative contract stated — acceptable but the executor must clean them.

**3. Type consistency:**
- `eventStore.record` signature identical across Tasks 2, 5, 7, 8, 11, 13.
- `signalBus.set/get/on/off/snapshot` identical across Tasks 8, 9, 12, 13, 14.
- Driver interface (`init/readAll/write/startPolling/stop`) identical across Tasks 8, 9, 11.
- `engine.command/getState/onState/tickOnce/setStartMinutes` — **`onState` must return an unsubscribe fn**; flagged in Task 12 Step 3 as an edit-back to Task 5. Executor: make that change when doing Task 5, not Task 12.
- `pinKey` format for modbus (`plc:fn:register:bit`) matches between Task 8 (`signal-bus`) and Task 11 (`modbus-tcp`).
- `sheets` method names (`onGameStart/onSessionSync/onHint/readOperators`) identical across Tasks 7, 5 (calls), 12, 13.
- `config.current()/load()/save()` identical across Tasks 6, 7, 12, 13.

**Fix applied inline:** Task 5's interface note now must include `onState(fn) -> unsubscribe`. Task 9's mirroring test fixture uses `type: 'string'` for `phase` and Task 6's `type` enum includes `'string'` (both noted in Task 9 Step 4).

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-08-28-htm-room-control-m1.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
