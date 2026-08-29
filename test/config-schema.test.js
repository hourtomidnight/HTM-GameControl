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
