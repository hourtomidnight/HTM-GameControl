const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEventStore } = require('../src/event-store');
const { createConfig } = require('../src/config');

function tmpConfigPath() {
  return path.join(os.tmpdir(), `htm-cfg-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

const FULL_NESTED = {
  roomName: 'Nibiru',
  game: { timerMinutes: 60, volume: 0.4 },
  sheets: { sessionsSpreadsheetId: 'sid', sessionsTabName: 'Sessions' },
  plcs: [{ id: 'plc1', host: 'h', port: 502, pollMs: 100 }],
  signals: [
    { name: 'door', direction: 'in', type: 'bool', driver: 'modbus',
      address: { plc: 'plc1', fn: 'coil', register: 1 } },
  ],
};

test('partial page save merges — plcs/signals survive when omitted', () => {
  const es = createEventStore({ path: ':memory:' });
  const p = tmpConfigPath();
  try {
    const config = createConfig({ path: p, db: es.db });

    assert.deepStrictEqual(config.save(FULL_NESTED), { ok: true, errors: [] });

    // Simulate config.html's merged partial save: game + sheets + roomName only,
    // plcs/signals carried forward from the previous config.
    const merged = {
      ...config.current(),
      roomName: 'Nibiru',
      game: { ...config.current().game, timerMinutes: 75 },
      sheets: { ...config.current().sheets },
      hintGroups: [],
    };
    const r = config.save(merged);
    assert.strictEqual(r.ok, true);

    const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.strictEqual(onDisk.game.timerMinutes, 75);
    assert.deepStrictEqual(onDisk.plcs, FULL_NESTED.plcs);
    assert.deepStrictEqual(onDisk.signals, FULL_NESTED.signals);
  } finally {
    try { fs.unlinkSync(p); } catch {}
  }
});

test('a stray flat body is rejected with unknown top-level key errors', () => {
  const es = createEventStore({ path: ':memory:' });
  const p = tmpConfigPath();
  try {
    const config = createConfig({ path: p, db: es.db });
    config.save(FULL_NESTED);

    const r = config.save({ timerMinutes: 60 });
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some(e => /unknown top-level key: timerMinutes/.test(e)), r.errors.join(','));

    // The valid nested config on disk is untouched by the rejected flat save.
    const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.deepStrictEqual(onDisk.plcs, FULL_NESTED.plcs);
  } finally {
    try { fs.unlinkSync(p); } catch {}
  }
});

test('save returns {ok:false} instead of throwing when the file cannot be written', () => {
  const es = createEventStore({ path: ':memory:' });
  const p = path.join(os.tmpdir(), `htm-cfg-nodir-${Date.now()}`, 'nested', 'config.json');
  const config = createConfig({ path: p, db: es.db });
  let r;
  assert.doesNotThrow(() => { r = config.save(FULL_NESTED); });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some(e => /could not write config/.test(e)), r.errors.join(','));
  // No config_history row was inserted for the failed write.
  const n = es.db.prepare('SELECT COUNT(*) c FROM config_history').get().c;
  assert.strictEqual(n, 0);
});
