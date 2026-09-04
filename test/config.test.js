const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEventStore } = require('../src/event-store');
const { createConfig } = require('../src/config');

function tmpConfigPath() {
  return path.join(os.tmpdir(), 'htm-config-test-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json');
}

test('load() migrates hintGroups to steps and writes the result back to disk', () => {
  const p = tmpConfigPath();
  const es = createEventStore({ path: ':memory:' });
  fs.writeFileSync(p, JSON.stringify({
    roomName: 'Nibiru Brain',
    hintGroups: [{ name: 'Briefcase', hints: [{ text: 'Look at the calendar', key: 'F1' }] }],
  }));

  const config = createConfig({ path: p, db: es.db });
  const loaded = config.load();

  assert.strictEqual(loaded.steps.length, 1);
  assert.strictEqual(loaded.steps[0].id, 'step_1');
  assert.deepStrictEqual(loaded.hintGroups, [{ name: 'Briefcase', hints: [{ text: 'Look at the calendar', key: 'F1' }] }]);

  // Written back to disk
  const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.strictEqual(onDisk.steps.length, 1);
  assert.strictEqual(onDisk.steps[0].name, 'Briefcase');

  // One config_history row recorded
  const rows = es.db.prepare('SELECT COUNT(*) c FROM config_history').get();
  assert.strictEqual(rows.c, 1);

  fs.unlinkSync(p);
});

test('load() does not rewrite the file when no migration is needed', () => {
  const p = tmpConfigPath();
  const es = createEventStore({ path: ':memory:' });
  const already = { roomName: 'X', steps: [{ id: 's1', name: 'X', order: 1, hints: [] }] };
  fs.writeFileSync(p, JSON.stringify(already));
  const before = fs.statSync(p).mtimeMs;

  const config = createConfig({ path: p, db: es.db });
  const loaded = config.load();

  assert.deepStrictEqual(loaded, already);
  const rows = es.db.prepare('SELECT COUNT(*) c FROM config_history').get();
  assert.strictEqual(rows.c, 0);

  fs.unlinkSync(p);
});

test('load() on a missing file returns {} and writes nothing', () => {
  const p = tmpConfigPath(); // never created
  const es = createEventStore({ path: ':memory:' });
  const config = createConfig({ path: p, db: es.db });
  const loaded = config.load();
  assert.deepStrictEqual(loaded, {});
  assert.strictEqual(fs.existsSync(p), false);
});
