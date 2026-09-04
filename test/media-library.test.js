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
  const { lib, root, cleanup } = makeLib();
  try {
    lib.save('ghost.mp3', Buffer.from('x'));
    fs.rmSync(path.join(root, 'ghost.mp3'), { force: true });
    const listed = lib.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].missing, true);
  } finally { cleanup(); }
});

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
