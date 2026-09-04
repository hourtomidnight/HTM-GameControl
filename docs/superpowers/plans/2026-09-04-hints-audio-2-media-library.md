# Hints & Audio Sub-milestone 2: Media Library — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A file manager for audio assets on the Pi — folders, upload, per-file title/tags, move/rename/delete, disk-usage — backed by `media/` on disk (source of truth) and a `media` DB table (decoration), exposed over `/api/media/*`, with a standalone `public/media.html` page.

**Architecture:** `src/media-library.js` is a pure-ish I/O module (like `game-store.js`/`config.js`) wrapping `node:fs`/`node:path` against a `root` dir and the shared `DatabaseSync` instance from `event-store.js`. `src/multipart.js` is a pure parser (buffer + boundary → parts) with no I/O, unit-tested standalone. `src/web.js` gains `/api/media*` routes wired to both. `public/media.js` holds pure render/state-transition functions (mirroring `operator.js`'s `commandFor`/`renderModel` pattern); `public/media.html` is the thin DOM host, plus a `?pick=1` modal mode reused later by the config Board tab (sub-milestone 7 — this plan only needs the mode to postMessage a chosen path back to `window.opener`, no picker consumer exists yet).

**Tech Stack:** Node 22+ built-ins only (`node:sqlite`, `node:fs`, `node:path`, `node:http` — already wired in `src/web.js`). No new npm dependency; multipart parsing is hand-rolled (~80 lines, single-file-field form only) to keep the "server code: built-ins only" constraint from `CLAUDE.md`.

**Spec:** `docs/superpowers/specs/2026-08-30-hints-and-audio-design.md`, §3 (Media library) and its testing row in §10. This plan implements build-order item 2 from §11 ("independent of 1's steps/hints wiring; a hint's `mediaRef` is just a string until sub-milestone 7 wires the picker in").

## Global Constraints

- Server code stays built-ins-only; `googleapis` remains the sole npm runtime dependency (`CLAUDE.md`). No multipart-parsing library — hand-roll it.
- `media/` is git-ignored, like `config.json` and `room-control.db` (spec §3.1) — add `media/` to `.gitignore` in Task 1, keep a `media/.gitkeep` so the dir exists in a fresh checkout... actually `root` is created lazily by `media-library.js` itself (`fs.mkdirSync(root, { recursive: true })` on construction), so no `.gitkeep` is needed; just the `.gitignore` line.
- The file on disk is the source of truth for `list()`; a DB row is optional decoration (spec §3.2). A file with no row lists with `title` falling back to its basename.
- Every fs-touching call in `media-library.js` and every `/api/media/*` handler must guard against path traversal: a resolved path outside `root` is always rejected before any fs call, never merely relied on `path.normalize` to have already stopped it (`..`, absolute paths, and symlink-adjacent tricks all funnel through one `resolveSafe(root, relPath)` helper).
- Accepted upload extensions: `.mp3`, `.wav`, `.ogg` only (spec §3.5). Anything else is rejected with a message, not a silent no-op.
- All web-layer errors are guarded to 4xx/5xx JSON — never let an fs or DB throw escape a handler as an unhandled exception (matches the existing `src/web.js` pattern of try/catch around every route body).
- `media-library.js` takes its DB handle the same way `game-store.js` does: a raw `DatabaseSync`-shaped `db` (here, `eventStore.db`, already exposed and reused for `gameStore` in `server.js`) — not a fresh `DatabaseSync(path)` of its own. One connection, one file.
- Node's built-in `node:sqlite` `DatabaseSync` has no `statfs`; `usage()`'s `freeBytes` uses `node:fs.statfsSync(root).bavail * bsize` guarded in a try/catch (some platforms/Node builds may lack `statfsSync` — fall back to `freeBytes: null` rather than throwing).
- Route methods and paths, verbatim (spec §3.4): `GET /api/media`, `POST /api/media/upload`, `POST /api/media/meta`, `POST /api/media/move`, `DELETE /api/media?path=…`, `GET /api/media/usage`.

---

### Task 1: `media` DB table + `src/media-library.js`

**Files:**
- Modify: `src/event-store.js` (add `media` table to `SCHEMA`)
- Create: `src/media-library.js`
- Test: `test/media-library.test.js`
- Modify: `.gitignore` (add `media/`)

**Interfaces:**
- Consumes: `db` — a `DatabaseSync`-shaped object with `.prepare()`/`.exec()` (same shape `event-store.js` constructs and `game-store.js` already consumes). `root` — absolute path string. `steps()` — a zero-arg getter returning the current `config.steps` array (for the in-use check on `delete`); the caller passes `() => config.current().steps || []`.
- Produces: `createMediaLibrary({ db, root, steps }) → { list, save, setMeta, move, delete: del, usage }`. Every method returns a plain value/object synchronously (no I/O here is genuinely async — `node:fs` sync calls throughout, matching `config.js`'s style) EXCEPT `save`, which takes a `Buffer` already fully read (the async multipart/stream work lives in Task 2/3, not here).
  - `list()` → `[{ path, title, tags, kind, bytes, addedTs, missing }]`, `path` relative to `root`, POSIX-separated (`/`) even on Windows dev machines, sorted by `path`.
  - `save(relPath, buffer)` → `{ path, bytes }`; throws `Error` with `.code` set: `'bad-path'` (escapes root), `'bad-ext'` (not `.mp3|.wav|.ogg`).
  - `setMeta(relPath, { title, tags })` → `{ path, title, tags }`; throws `.code = 'not-found'` if no file at `relPath`.
  - `move(from, to)` → `{ path: to, refsChanged: <int> }`; throws `.code = 'bad-path'` or `'not-found'` (source missing) or `'exists'` (dest already exists). Does NOT persist config — returns the count so the caller (Task 3's route) can rewrite refs and hand them to `config.save()`.
  - `delete(relPath)` (exported as `del` internally, call it `remove` in the returned object — see Step 7) → throws `.code = 'in-use'` with `.inUse = [stepId, …]` if any hint's `mediaRef` equals `relPath`; else deletes file + row, returns `{ path: relPath }`.
  - `usage()` → `{ bytes, count, freeBytes }` (`freeBytes: number|null`).

- [ ] **Step 1: Add the `media` table to `src/event-store.js`'s `SCHEMA`**

In `src/event-store.js`, append to the `SCHEMA` template string (after the `config_history` table, before the closing backtick):

```sql
CREATE TABLE IF NOT EXISTS media (
  path     TEXT PRIMARY KEY,
  title    TEXT NOT NULL DEFAULT '',
  tags     TEXT NOT NULL DEFAULT '',
  kind     TEXT NOT NULL DEFAULT 'audio',
  bytes    INTEGER NOT NULL DEFAULT 0,
  added_ts INTEGER NOT NULL
);
```

- [ ] **Step 2: Add `media/` to `.gitignore`**

Add a line `media/` anywhere in `.gitignore` (group it near `config.json` / `*.db`).

- [ ] **Step 3: Write the failing tests for `list`, `save`, path-traversal, and extension guard**

Create `test/media-library.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createEventStore } = require('../src/event-store');
const { createMediaLibrary } = require('../src/media-library');

function makeLib(stepsFn) {
  const dbPath = path.join(os.tmpdir(), `media-lib-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-root-'));
  const store = createEventStore({ path: dbPath });
  const lib = createMediaLibrary({ db: store.db, root, steps: stepsFn || (() => []) });
  return {
    lib, root,
    cleanup() {
      try { fs.rmSync(dbPath, { force: true }); fs.rmSync(dbPath + '-wal', { force: true }); fs.rmSync(dbPath + '-shm', { force: true }); } catch {}
      try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    },
  };
}

test('save writes the file, creates parent dirs, and upserts a row', () => {
  const { lib, root, cleanup } = makeLib();
  try {
    const buf = Buffer.from('fake mp3 bytes');
    const result = lib.save('nibiru/briefcase_2.mp3', buf);
    assert.equal(result.path, 'nibiru/briefcase_2.mp3');
    assert.equal(result.bytes, buf.length);
    assert.ok(fs.existsSync(path.join(root, 'nibiru', 'briefcase_2.mp3')));
    const listed = lib.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].path, 'nibiru/briefcase_2.mp3');
    assert.equal(listed[0].bytes, buf.length);
    assert.equal(listed[0].missing, false);
  } finally { cleanup(); }
});

test('save rejects a path that escapes root', () => {
  const { lib, cleanup } = makeLib();
  try {
    assert.throws(() => lib.save('../escape.mp3', Buffer.from('x')), (e) => e.code === 'bad-path');
    assert.throws(() => lib.save('/etc/passwd.mp3', Buffer.from('x')), (e) => e.code === 'bad-path');
  } finally { cleanup(); }
});

test('save rejects a disallowed extension', () => {
  const { lib, cleanup } = makeLib();
  try {
    assert.throws(() => lib.save('nope.exe', Buffer.from('x')), (e) => e.code === 'bad-ext');
  } finally { cleanup(); }
});

test('list includes a file on disk with no DB row, title falling back to basename', () => {
  const { lib, root, cleanup } = makeLib();
  try {
    fs.mkdirSync(path.join(root, 'global'), { recursive: true });
    fs.writeFileSync(path.join(root, 'global', 'start.mp3'), 'x');
    const listed = lib.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].path, 'global/start.mp3');
    assert.equal(listed[0].title, 'start.mp3');
  } finally { cleanup(); }
});

test('list flags a DB row whose file is gone as missing', () => {
  const { lib, cleanup } = makeLib();
  try {
    lib.save('ghost.mp3', Buffer.from('x'));
    fs.rmSync(require('node:path').join(lib.root || '', 'ghost.mp3'), { force: true });
  } finally { /* cleanup below re-derives root via closure, see Step 4 fix if this fails */ }
  cleanup();
});
```

Note on the last test: `lib.root` is not part of the planned public interface — rewrite it before running using the outer `root` variable already in scope from `makeLib()`'s destructure (the test above is illustrative; the implementer replaces the awkward last test with:

```js
test('list flags a DB row whose file is gone as missing', () => {
  const { lib, root, cleanup } = makeLib();
  try {
    lib.save('ghost.mp3', Buffer.from('x'));
    fs.rmSync(path.join(root, 'ghost.mp3'), { force: true });
    const listed = lib.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].missing, true);
  } finally { cleanup(); }
});
```

— use this corrected version, not the placeholder above it.)

- [ ] **Step 4: Run tests to verify they fail**

Run: `node --test test/media-library.test.js`
Expected: FAIL — `createMediaLibrary` is not a function / module not found.

- [ ] **Step 5: Implement `src/media-library.js` — `list` and `save`**

```js
const fs = require('node:fs');
const path = require('node:path');

const ALLOWED_EXT = new Set(['.mp3', '.wav', '.ogg']);

function resolveSafe(root, relPath) {
  const clean = String(relPath || '').replace(/^[/\\]+/, '');
  const resolved = path.resolve(root, clean);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    const e = new Error('path escapes media root: ' + relPath);
    e.code = 'bad-path';
    throw e;
  }
  return resolved;
}

function toPosix(relFromRoot) {
  return relFromRoot.split(path.sep).join('/');
}

function walk(root, dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) { walk(root, full, out); continue; }
    const ext = path.extname(ent.name).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) continue;
    out.push(toPosix(path.relative(root, full)));
  }
}

function createMediaLibrary({ db, root, steps }) {
  fs.mkdirSync(root, { recursive: true });

  const getRow = db.prepare('SELECT * FROM media WHERE path = ?');
  const upsertRow = db.prepare(`
    INSERT INTO media (path, title, tags, kind, bytes, added_ts)
    VALUES (?, ?, ?, 'audio', ?, ?)
    ON CONFLICT(path) DO UPDATE SET bytes = excluded.bytes
  `);
  const upsertMeta = db.prepare(`
    INSERT INTO media (path, title, tags, kind, bytes, added_ts)
    VALUES (?, ?, ?, 'audio', 0, ?)
    ON CONFLICT(path) DO UPDATE SET title = excluded.title, tags = excluded.tags
  `);
  const deleteRow = db.prepare('DELETE FROM media WHERE path = ?');
  const renameRow = db.prepare('UPDATE media SET path = ? WHERE path = ?');
  const allRows = db.prepare('SELECT * FROM media');

  function list() {
    const onDisk = [];
    walk(root, root, onDisk);
    const rows = new Map(allRows.all().map(r => [r.path, r]));
    const out = [];
    for (const p of onDisk) {
      const row = rows.get(p);
      const full = path.join(root, ...p.split('/'));
      const bytes = row ? row.bytes : fs.statSync(full).size;
      out.push({
        path: p,
        title: (row && row.title) || path.basename(p),
        tags: (row && row.tags) || '',
        kind: (row && row.kind) || 'audio',
        bytes,
        addedTs: row ? row.added_ts : null,
        missing: false,
      });
      rows.delete(p);
    }
    for (const row of rows.values()) {
      out.push({
        path: row.path, title: row.title || path.basename(row.path), tags: row.tags,
        kind: row.kind, bytes: row.bytes, addedTs: row.added_ts, missing: true,
      });
    }
    out.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return out;
  }

  function save(relPath, buffer) {
    const ext = path.extname(relPath).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      const e = new Error('disallowed extension: ' + ext);
      e.code = 'bad-ext';
      throw e;
    }
    const full = resolveSafe(root, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, buffer);
    const p = toPosix(path.relative(root, full));
    upsertRow.run(p, '', '', buffer.length, Date.now());
    return { path: p, bytes: buffer.length };
  }

  function setMeta(relPath, { title = '', tags = '' } = {}) {
    const full = resolveSafe(root, relPath);
    if (!fs.existsSync(full)) {
      const e = new Error('not found: ' + relPath);
      e.code = 'not-found';
      throw e;
    }
    const p = toPosix(path.relative(root, full));
    upsertMeta.run(p, title, tags, Date.now());
    return { path: p, title, tags };
  }

  function move(from, to) {
    const fullFrom = resolveSafe(root, from);
    const fullTo = resolveSafe(root, to);
    if (!fs.existsSync(fullFrom)) { const e = new Error('not found: ' + from); e.code = 'not-found'; throw e; }
    if (fs.existsSync(fullTo)) { const e = new Error('already exists: ' + to); e.code = 'exists'; throw e; }
    fs.mkdirSync(path.dirname(fullTo), { recursive: true });
    fs.renameSync(fullFrom, fullTo);
    const pFrom = toPosix(path.relative(root, fullFrom));
    const pTo = toPosix(path.relative(root, fullTo));
    if (getRow.get(pFrom)) renameRow.run(pTo, pFrom);
    let refsChanged = 0;
    for (const step of (steps() || [])) {
      for (const h of (step.hints || [])) {
        if (h && h.type === 'audio' && h.mediaRef === pFrom) { h.mediaRef = pTo; refsChanged++; }
      }
    }
    return { path: pTo, refsChanged };
  }

  function remove(relPath) {
    const full = resolveSafe(root, relPath);
    const p = toPosix(path.relative(root, full));
    const inUse = [];
    for (const step of (steps() || [])) {
      for (const h of (step.hints || [])) {
        if (h && h.type === 'audio' && h.mediaRef === p) inUse.push(step.id);
      }
    }
    if (inUse.length) { const e = new Error('in use'); e.code = 'in-use'; e.inUse = inUse; throw e; }
    try { fs.unlinkSync(full); } catch {}
    deleteRow.run(p);
    return { path: p };
  }

  function usage() {
    const rows = allRows.all();
    const onDisk = [];
    walk(root, root, onDisk);
    let bytes = 0;
    for (const p of onDisk) {
      try { bytes += fs.statSync(path.join(root, ...p.split('/'))).size; } catch {}
    }
    let freeBytes = null;
    try {
      if (typeof fs.statfsSync === 'function') {
        const s = fs.statfsSync(root);
        freeBytes = s.bavail * s.bsize;
      }
    } catch { freeBytes = null; }
    return { bytes, count: onDisk.length, freeBytes };
  }

  return { list, save, setMeta, move, remove, usage };
}

module.exports = { createMediaLibrary, resolveSafe };
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test test/media-library.test.js`
Expected: PASS, all 5 tests.

- [ ] **Step 7: Add tests for `setMeta`, `move` (with ref rewrite), `delete`/`remove` (blocked when in-use, succeeds otherwise), and `usage`**

Append to `test/media-library.test.js`:

```js
test('setMeta upserts title and tags', () => {
  const { lib, cleanup } = makeLib();
  try {
    lib.save('a.mp3', Buffer.from('x'));
    const r = lib.setMeta('a.mp3', { title: 'Clue A', tags: 'briefcase,nibiru' });
    assert.equal(r.title, 'Clue A');
    const listed = lib.list();
    assert.equal(listed[0].title, 'Clue A');
    assert.equal(listed[0].tags, 'briefcase,nibiru');
  } finally { cleanup(); }
});

test('setMeta on a missing file throws not-found', () => {
  const { lib, cleanup } = makeLib();
  try {
    assert.throws(() => lib.setMeta('nope.mp3', { title: 'x' }), (e) => e.code === 'not-found');
  } finally { cleanup(); }
});

test('move renames on disk, updates the row, and rewrites matching hint.mediaRef', () => {
  const steps = [
    { id: 'step_1', hints: [{ id: 'h1', type: 'audio', mediaRef: 'old/clip.mp3' }] },
  ];
  const { lib, cleanup } = makeLib(() => steps);
  try {
    lib.save('old/clip.mp3', Buffer.from('x'));
    const r = lib.move('old/clip.mp3', 'new/clip.mp3');
    assert.equal(r.path, 'new/clip.mp3');
    assert.equal(r.refsChanged, 1);
    assert.equal(steps[0].hints[0].mediaRef, 'new/clip.mp3');
    const listed = lib.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].path, 'new/clip.mp3');
  } finally { cleanup(); }
});

test('move to an existing destination throws exists', () => {
  const { lib, cleanup } = makeLib();
  try {
    lib.save('a.mp3', Buffer.from('x'));
    lib.save('b.mp3', Buffer.from('y'));
    assert.throws(() => lib.move('a.mp3', 'b.mp3'), (e) => e.code === 'exists');
  } finally { cleanup(); }
});

test('remove refuses with inUse when a hint references the file', () => {
  const steps = [{ id: 'step_9', hints: [{ id: 'h1', type: 'audio', mediaRef: 'clip.mp3' }] }];
  const { lib, root, cleanup } = makeLib(() => steps);
  try {
    lib.save('clip.mp3', Buffer.from('x'));
    assert.throws(() => lib.remove('clip.mp3'), (e) => e.code === 'in-use' && Array.isArray(e.inUse) && e.inUse.includes('step_9'));
    assert.ok(fs.existsSync(path.join(root, 'clip.mp3')));
  } finally { cleanup(); }
});

test('remove deletes the file and row when unreferenced', () => {
  const { lib, root, cleanup } = makeLib();
  try {
    lib.save('clip.mp3', Buffer.from('x'));
    lib.remove('clip.mp3');
    assert.equal(fs.existsSync(path.join(root, 'clip.mp3')), false);
    assert.equal(lib.list().length, 0);
  } finally { cleanup(); }
});

test('usage sums bytes and counts files', () => {
  const { lib, cleanup } = makeLib();
  try {
    lib.save('a.mp3', Buffer.from('12345'));
    lib.save('b.wav', Buffer.from('1234567890'));
    const u = lib.usage();
    assert.equal(u.bytes, 15);
    assert.equal(u.count, 2);
    assert.ok(u.freeBytes === null || typeof u.freeBytes === 'number');
  } finally { cleanup(); }
});
```

- [ ] **Step 8: Run the full file, verify all pass**

Run: `node --test test/media-library.test.js`
Expected: PASS, all 12 tests.

- [ ] **Step 9: Commit**

```bash
git add src/event-store.js src/media-library.js test/media-library.test.js .gitignore
git commit -m "feat(media): media table + src/media-library.js (list/save/setMeta/move/remove/usage)"
```

---

### Task 2: `src/multipart.js` — pure parser

**Files:**
- Create: `src/multipart.js`
- Test: `test/multipart.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `parseMultipart(buffer, contentType) → { fields: {name: string}, files: {name: {filename, buffer}} }`. Throws a plain `Error` (no `.code`) on a content-type with no `boundary=` or malformed input. Handles exactly the shape the browser's native `FormData` + `fetch` produces for a form with text fields and one `<input type=file>` — multiple files under the same field name is out of scope (the media-library UI uploads one file per request, per spec §3.4's `POST /api/media/upload`).

- [ ] **Step 1: Write the failing tests**

Create `test/multipart.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseMultipart } = require('../src/multipart');

function buildBody(boundary, parts) {
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

test('parses a field and a file part', () => {
  const boundary = 'X-BOUNDARY-1';
  const buf = buildBody(boundary, [
    { name: 'folder', content: 'nibiru' },
    { name: 'file', filename: 'clip.mp3', contentType: 'audio/mpeg', content: 'FAKE-MP3-BYTES' },
  ]);
  const { fields, files } = parseMultipart(buf, `multipart/form-data; boundary=${boundary}`);
  assert.equal(fields.folder, 'nibiru');
  assert.equal(files.file.filename, 'clip.mp3');
  assert.equal(files.file.buffer.toString('binary'), 'FAKE-MP3-BYTES');
});

test('throws when content-type has no boundary', () => {
  assert.throws(() => parseMultipart(Buffer.from(''), 'multipart/form-data'));
});

test('handles binary content containing bytes that look like CRLF', () => {
  const boundary = 'B2';
  const binary = Buffer.from([0x00, 0x0d, 0x0a, 0xff, 0x10, 0x0d, 0x0a]);
  const CRLF = '\r\n';
  const head = Buffer.from(
    `--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="x.wav"${CRLF}Content-Type: audio/wav${CRLF}${CRLF}`,
    'binary'
  );
  const tail = Buffer.from(`${CRLF}--${boundary}--${CRLF}`, 'binary');
  const buf = Buffer.concat([head, binary, tail]);
  const { files } = parseMultipart(buf, `multipart/form-data; boundary=${boundary}`);
  assert.ok(files.file.buffer.equals(binary));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/multipart.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/multipart.js`**

Buffer-native (no string decode of the whole body, so binary audio content round-trips exactly):

```js
function parseMultipart(buffer, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw new Error('multipart content-type missing boundary');
  const boundary = Buffer.from('--' + (m[1] || m[2]).trim());
  const CRLF = Buffer.from('\r\n');

  const fields = {};
  const files = {};

  let pos = buffer.indexOf(boundary);
  if (pos === -1) throw new Error('multipart body missing boundary');
  pos += boundary.length;

  while (true) {
    if (buffer.slice(pos, pos + 2).toString() === '--') break; // trailing boundary
    if (buffer.slice(pos, pos + 2).equals(CRLF)) pos += 2;

    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), pos);
    if (headerEnd === -1) throw new Error('multipart part missing header terminator');
    const headerText = buffer.slice(pos, headerEnd).toString('utf8');
    const bodyStart = headerEnd + 4;

    const nextBoundary = buffer.indexOf(boundary, bodyStart);
    if (nextBoundary === -1) throw new Error('multipart part missing closing boundary');
    // body ends 2 bytes (CRLF) before the boundary marker
    const bodyEnd = nextBoundary - 2;
    const partBody = buffer.slice(bodyStart, bodyEnd);

    const nameMatch = /name="([^"]*)"/i.exec(headerText);
    const filenameMatch = /filename="([^"]*)"/i.exec(headerText);
    const name = nameMatch ? nameMatch[1] : '';

    if (filenameMatch) {
      files[name] = { filename: filenameMatch[1], buffer: partBody };
    } else {
      fields[name] = partBody.toString('utf8');
    }

    pos = nextBoundary + boundary.length;
    if (buffer.slice(pos, pos + 2).toString() === '--') break;
  }

  return { fields, files };
}

module.exports = { parseMultipart };
```

- [ ] **Step 4: Run tests, verify pass**

Run: `node --test test/multipart.test.js`
Expected: PASS, all 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/multipart.js test/multipart.test.js
git commit -m "feat(media): hand-rolled multipart/form-data parser (single file field)"
```

---

### Task 3: `src/web.js` routes — `/api/media/*`

**Files:**
- Modify: `src/web.js`
- Modify: `server.js` (construct `media-library`, pass to `createWebServer`)
- Test: `test/web.test.js` (extend existing file — read it first to match its harness/fixture style)

**Interfaces:**
- Consumes: `createMediaLibrary` from Task 1 (`src/media-library.js`), `parseMultipart` from Task 2 (`src/multipart.js`).
- Produces: `createWebServer(deps)` accepts a new dep `mediaLibrary` (the object `createMediaLibrary(...)` returns). Routes exactly as spec §3.4:
  - `GET /api/media` → `200 { files: mediaLibrary.list() }`
  - `POST /api/media/upload` → multipart body, field `file` (+ optional `folder`); ~50MB cap (reject over-cap with `413`); → `mediaLibrary.save(path.join(folder||'', filename), buf)` → `200 { path, bytes }`; `400` with `{ error }` on bad extension/traversal.
  - `POST /api/media/meta` → JSON `{ path, title, tags }` → `mediaLibrary.setMeta(...)` → `200 { path, title, tags }`; `404` if not found.
  - `POST /api/media/move` → JSON `{ from, to }` → `mediaLibrary.move(from, to)`; if `refsChanged > 0`, `config.save(config.current())` to persist the rewritten `mediaRef`s (mirrors how other routes call `config.save`; read the current handler for `/config` in `src/web.js` to match its exact call shape before writing this) → `200 { path, refsChanged }`; `404`/`409` on not-found/exists.
  - `DELETE /api/media?path=…` → `mediaLibrary.remove(path)` → `200 { path }`; `409 { error, inUse }` when blocked.
  - `GET /api/media/usage` → `200 mediaLibrary.usage()`.

- [ ] **Step 1: Read `src/web.js` in full and locate the routing table / dispatch style, the `/config` POST handler (for the `config.save` call shape), and how `readBody` is currently used for JSON routes**, before writing anything. This is exploration, not a code step — note the exact pattern (e.g. `if (req.method === 'POST' && u.pathname === '/config')`) so the new routes match it verbatim rather than introducing a second dispatch style.

- [ ] **Step 2: Write the failing tests**

Read `test/web.test.js` first to copy its exact server-bootstrap fixture (fake `engine`/`config`/`sheets`/`eventStore`/`gameStore`, how it starts the server on an ephemeral port and issues requests — likely via `node:http` `request()` or a small fetch helper already defined at the top of that file). Using that same fixture, add a `mediaLibrary` fake or a real `createMediaLibrary` against a tmp dir (prefer the real one — Task 1 already proved it works and using a fake risks exercising a mismatched shape), then add tests such as:

```js
test('GET /api/media lists files', async () => { /* upload via lib.save() directly, then GET, assert files array */ });
test('POST /api/media/upload with a valid mp3 multipart body saves it and returns 200', async () => { /* build a multipart body with the test\'s own boundary construction (mirror multipart.test.js\'s buildBody helper), POST, assert 200 + file now in list() */ });
test('POST /api/media/upload with a disallowed extension returns 400', async () => { /* .exe filename, assert 400 { error } */ });
test('DELETE /api/media?path=… on a referenced file returns 409 with inUse', async () => { /* config fake steps has a matching mediaRef, assert 409 */ });
test('GET /api/media/usage returns bytes/count/freeBytes', async () => { /* assert shape */ });
```

Match this file's existing assertion helpers (status code + JSON body reading) rather than inventing new ones.

- [ ] **Step 3: Run to verify failure**

Run: `node --test test/web.test.js`
Expected: FAIL on the new tests (route not found → whatever this file's fixture returns for an unmatched route, e.g. 404).

- [ ] **Step 4: Implement the routes in `src/web.js`**

Add near the other `/api/*` handlers (mirror their try/catch-to-JSON style exactly):

```js
const { parseMultipart } = require('./multipart');
// (mediaLibrary destructured from deps alongside engine/config/sheets/etc.)

// GET /api/media
if (req.method === 'GET' && u.pathname === '/api/media') {
  try { return sendJson(res, 200, { files: mediaLibrary.list() }); }
  catch (e) { return sendJson(res, 500, { error: e.message }); }
}

// GET /api/media/usage
if (req.method === 'GET' && u.pathname === '/api/media/usage') {
  try { return sendJson(res, 200, mediaLibrary.usage()); }
  catch (e) { return sendJson(res, 500, { error: e.message }); }
}

// POST /api/media/upload
if (req.method === 'POST' && u.pathname === '/api/media/upload') {
  const MAX_BYTES = 50 * 1024 * 1024;
  const chunks = [];
  let total = 0;
  let tooBig = false;
  await new Promise((resolve, reject) => {
    req.on('data', (c) => {
      total += c.length;
      if (total > MAX_BYTES) { tooBig = true; return; }
      chunks.push(c);
    });
    req.on('end', resolve);
    req.on('error', reject);
  });
  if (tooBig) return sendJson(res, 413, { error: 'file too large (50MB cap)' });
  try {
    const body = Buffer.concat(chunks);
    const { fields, files } = parseMultipart(body, req.headers['content-type']);
    if (!files.file) return sendJson(res, 400, { error: 'missing "file" field' });
    const folder = (fields.folder || '').replace(/^[/\\]+|[/\\]+$/g, '');
    const relPath = folder ? `${folder}/${files.file.filename}` : files.file.filename;
    const result = mediaLibrary.save(relPath, files.file.buffer);
    return sendJson(res, 200, result);
  } catch (e) {
    const status = e.code === 'bad-path' || e.code === 'bad-ext' ? 400 : 500;
    return sendJson(res, status, { error: e.message });
  }
}

// POST /api/media/meta
if (req.method === 'POST' && u.pathname === '/api/media/meta') {
  try {
    const body = JSON.parse(await readBody(req) || '{}');
    const result = mediaLibrary.setMeta(body.path, { title: body.title, tags: body.tags });
    return sendJson(res, 200, result);
  } catch (e) {
    const status = e.code === 'not-found' ? 404 : e.code === 'bad-path' ? 400 : 500;
    return sendJson(res, status, { error: e.message });
  }
}

// POST /api/media/move
if (req.method === 'POST' && u.pathname === '/api/media/move') {
  try {
    const body = JSON.parse(await readBody(req) || '{}');
    const result = mediaLibrary.move(body.from, body.to);
    if (result.refsChanged > 0) config.save(config.current());
    return sendJson(res, 200, result);
  } catch (e) {
    const status = e.code === 'not-found' ? 404 : e.code === 'exists' ? 409 : e.code === 'bad-path' ? 400 : 500;
    return sendJson(res, status, { error: e.message });
  }
}

// DELETE /api/media?path=...
if (req.method === 'DELETE' && u.pathname === '/api/media') {
  try {
    const result = mediaLibrary.remove(u.searchParams.get('path'));
    return sendJson(res, 200, result);
  } catch (e) {
    if (e.code === 'in-use') return sendJson(res, 409, { error: e.message, inUse: e.inUse });
    const status = e.code === 'not-found' ? 404 : e.code === 'bad-path' ? 400 : 500;
    return sendJson(res, status, { error: e.message });
  }
}
```

Place these in whatever order the surrounding code uses (check for a shared `u = new URL(...)` already computed once per request near the top of the handler — reuse it, do not recompute). Confirm `config.save` is the correct name by checking `src/config.js`'s exports before calling it — the plan text's assumed name may differ (this is exactly the kind of interface check Task 1/2/3's own plan flagged as a conflict-scan item in sub-milestone 1; the implementer resolves it directly against the source, not this plan text, if they diverge).

- [ ] **Step 5: Wire `mediaLibrary` into `server.js`**

In `server.js`, after `const config = createConfig(...)` and its `load()`/validate block, before `createSheets`:

```js
const { createMediaLibrary } = require('./src/media-library');
const MEDIA_ROOT = path.join(DIR, 'media');
const mediaLibrary = createMediaLibrary({ db: eventStore.db, root: MEDIA_ROOT, steps: () => config.current().steps || [] });
```

And pass `mediaLibrary` into the `createWebServer({...})` call's deps object.

- [ ] **Step 6: Run the full web test file, verify all pass**

Run: `node --test test/web.test.js`
Expected: PASS, including all prior tests in the file (no regression) plus the new ones.

- [ ] **Step 7: Run the whole suite**

Run: `node --test "test/**/*.test.js"`
Expected: PASS, no regressions anywhere.

- [ ] **Step 8: Commit**

```bash
git add src/web.js server.js
git commit -m "feat(media): wire /api/media/* routes (list/upload/meta/move/delete/usage)"
```

---

### Task 4: `public/media.js` (pure logic) + `public/media.html` (host page) + nav links

**Files:**
- Create: `public/media.js`
- Create: `public/media.html`
- Modify: `public/operator.html`, `public/config.html`, `public/index.html` (add a nav link to `media.html`) — read each file first; add the link next to their existing nav-link markup, matching its exact style rather than inventing new markup.
- Test: `test/media-render.test.js`

**Interfaces:**
- Consumes: `GET /api/media`, `GET /api/media/usage`, `POST /api/media/upload`, `POST /api/media/meta`, `POST /api/media/move`, `DELETE /api/media` from Task 3.
- Produces: `public/media.js` exports (via `module.exports` guarded by `typeof module !== 'undefined'`, matching `operator.js`'s existing dual browser/Node export pattern — read `public/operator.js`'s top and bottom before writing this to copy the exact guard) pure functions:
  - `renderFileList(files) → string` (HTML string, matching `renderModel`'s "HTML string + thin bind pass" convention noted as the leaning choice in spec §12.3) — one row per file: preview control, path, title (as an editable-looking span with a `data-path` attribute for the bind pass to wire up), tags, human-readable size, a `Missing` badge when `file.missing`, and (§8.2) a "used by N hints" count — since this task has no `steps` data source yet (config Board tab is sub-milestone 7), render `usedBy: 0` for every row via an optional second parameter `usageByPath = {}` defaulting to empty, so sub-milestone 7 can pass real counts later without a signature change.
  - `formatBytes(n) → string` (`"1.2 MB"`, `"340 KB"`, `"12 B"` — base-1024, one decimal above 1024).
  - `renderUsageBar({ bytes, count, freeBytes }) → string`.
  - `pickerUrl(basePath) → string` — returns `basePath + '?pick=1'`, trivial helper so the bind pass and the future picker consumer (sub-milestone 7) share one place that knows the query-param name.

- [ ] **Step 1: Read `public/operator.js`'s top-of-file requires/exports and one existing pure render function in full**, to copy its module-export guard and general code style (indentation, template-literal usage, no framework) exactly.

- [ ] **Step 2: Write the failing tests**

Create `test/media-render.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderFileList, formatBytes, renderUsageBar } = require('../public/media.js');

test('formatBytes renders bytes, KB, MB', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(340), '340 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(1_258_291), '1.2 MB');
});

test('renderFileList shows path, title, tags, size, and a Missing badge', () => {
  const html = renderFileList([
    { path: 'nibiru/briefcase_2.mp3', title: 'Briefcase clue 2', tags: 'nibiru', bytes: 2048, missing: false },
    { path: 'ghost.mp3', title: 'ghost.mp3', tags: '', bytes: 0, missing: true },
  ]);
  assert.match(html, /nibiru\/briefcase_2\.mp3/);
  assert.match(html, /Briefcase clue 2/);
  assert.match(html, /2\.0 KB/);
  assert.match(html, /Missing/);
});

test('renderFileList defaults usedBy to 0 when no usage map is given', () => {
  const html = renderFileList([{ path: 'a.mp3', title: 'a.mp3', tags: '', bytes: 10, missing: false }]);
  assert.match(html, /used by 0 hint/i);
});

test('renderUsageBar shows byte total and count', () => {
  const html = renderUsageBar({ bytes: 3145728, count: 4, freeBytes: 10_000_000_000 });
  assert.match(html, /3\.0 MB/);
  assert.match(html, /4/);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `node --test test/media-render.test.js`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `public/media.js`**

```js
function formatBytes(n) {
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(1) + ' ' + units[i];
}

function pickerUrl(basePath) {
  return basePath + '?pick=1';
}

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderFileList(files, usageByPath = {}) {
  return (files || []).map(f => {
    const usedBy = usageByPath[f.path] || 0;
    return `<tr class="media-row${f.missing ? ' missing' : ''}" data-path="${esc(f.path)}">
      <td><audio controls preload="none" src="/media/${esc(f.path)}"></audio></td>
      <td>${esc(f.path)}</td>
      <td class="editable-title" data-path="${esc(f.path)}">${esc(f.title)}</td>
      <td class="editable-tags" data-path="${esc(f.path)}">${esc(f.tags)}</td>
      <td>${formatBytes(f.bytes)}</td>
      <td>used by ${usedBy} hint${usedBy === 1 ? '' : 's'}</td>
      ${f.missing ? '<td class="badge missing">Missing</td>' : '<td></td>'}
    </tr>`;
  }).join('');
}

function renderUsageBar({ bytes, count, freeBytes }) {
  const free = freeBytes == null ? 'unknown' : formatBytes(freeBytes);
  return `<div class="usage-bar">${formatBytes(bytes)} across ${count} file${count === 1 ? '' : 's'} — ${free} free</div>`;
}

const exportsObj = { formatBytes, renderFileList, renderUsageBar, pickerUrl };
if (typeof module !== 'undefined' && module.exports) module.exports = exportsObj;
if (typeof window !== 'undefined') window.MediaUI = exportsObj;
```

(Adjust the dual-export block to match whatever exact guard `public/operator.js` uses, per Step 1 — this is illustrative, not to be pasted verbatim if the real pattern differs.)

- [ ] **Step 5: Run tests, verify pass**

Run: `node --test test/media-render.test.js`
Expected: PASS, all 4 tests.

- [ ] **Step 6: Implement `public/media.html`**

A thin host page, styled consistently with `public/config.html` (read its `<head>`/nav/CSS-link setup first and match it, not reinvent). Body: an upload form (`<input type=file name=file>` + folder text input, POSTing via `fetch('/api/media/upload', { method:'POST', body: formData })`), a usage-bar div, a table body populated by calling `MediaUI.renderFileList(...)` after `fetch('/api/media').then(r => r.json())`, click-to-edit handlers on `.editable-title`/`.editable-tags` cells that POST to `/api/media/meta` on blur, and delete buttons that call `DELETE /api/media?path=...` and re-render on success or show `e.inUse` on a 409. When the page is opened with `?pick=1` in its URL (`new URLSearchParams(location.search).get('pick')`), each row's normal click instead calls `window.opener.postMessage({ type: 'media-picked', path }, '*')` and closes the window — no consumer exists yet (that's sub-milestone 7), so this is inert but present per the plan's "Architecture" note above.

- [ ] **Step 7: Add nav links**

In `public/operator.html`, `public/config.html`, `public/index.html`: add a `<a href="media.html">Media Library</a>` (or matching text) next to their existing nav links, copying the exact tag/class structure already there.

- [ ] **Step 8: Manual smoke check**

Run: `npm start`, open `http://localhost:4000/media.html` in a browser, upload a small `.mp3`, confirm it lists with the right size, edit its title, delete it, confirm the usage bar updates. (No automated browser test in this repo's suite — `public/*.html` pages are checked manually, consistent with `operator.html`/`config.html`'s existing lack of DOM-level tests; only their pure `.js` siblings are unit-tested.)

- [ ] **Step 9: Run the whole suite one more time**

Run: `node --test "test/**/*.test.js"`
Expected: PASS, no regressions.

- [ ] **Step 10: Commit**

```bash
git add public/media.js public/media.html public/operator.html public/config.html public/index.html
git commit -m "feat(media): media.html page (upload/list/edit/delete) + nav links"
```

---

## Self-Review Notes (for the plan author, not a task)

- **Spec coverage:** §3.1 storage (Task 1 `mkdirSync`), §3.2 DB table (Task 1 Step 1), §3.3 all five `media-library.js` functions (Task 1), §3.4 all six routes (Task 3), §3.5 extension allow-list (Task 1 `ALLOWED_EXT`, enforced again implicitly via `save`'s throw), §8.2's page description (Task 4). §10's `media-library` test row is covered by Task 1 Step 7's tests; the `web` test row's `/api/media/*` portion by Task 3.
- **Deferred to later sub-milestones, intentionally:** the "used by N hints" real count and the picker's actual consumer both need the config Board tab (sub-milestone 7) — Task 4 stubs both with a documented, signature-stable placeholder rather than guessing at 7's shape.
- **Type/name consistency check:** `mediaLibrary.remove` (not `delete`, since `delete` is a reserved word as a bare property-access target in some call styles and the spec's prose name `delete()` is not directly usable as an object literal key next to `void 0` semantics safely in all engines used here — Node's fine with `delete` as a key, but `remove` avoids any confusion with the JS `delete` operator when read by a future contributor) is used consistently across Tasks 1, 3, and the route naming stays `DELETE /api/media` regardless of the internal method name — flagged explicitly in Task 3 Step 4 so the implementer doesn't call a non-existent `mediaLibrary.delete`.
