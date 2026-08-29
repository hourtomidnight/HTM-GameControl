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
