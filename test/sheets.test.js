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

test('onSessionSync updates A{row}:N{row} — 14 cols => end col N', async () => {
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
  await sheets.onGameStart(id, session);          // sets sheets_row = 5
  stk.finalizeSession(session, 2, 'Escaped');
  await sheets.onSessionSync(id, session);
  assert.strictEqual(fg.calls.update.length, 1);
  assert.strictEqual(fg.calls.update[0].range, 'Sessions!A5:N5');
});

test('onHint appends a hint row to the hints tab', async () => {
  const es = createEventStore({ path: ':memory:' });
  const gs = createGameStore(es.db);
  const fg = fakeGoogle();
  const sheets = createSheets({
    credentialsPath: '/nonexistent', eventStore: es, gameStore: gs,
    config: { current: () => ({ sheets: { hintsSpreadsheetId: 'hid', hintsTabName: 'Hints' } }) },
    googleFactory: () => fg.api,
  });
  const session = stk.createSession({ startTime: 1 });
  const rec = stk.applyHint(session, 'look under the rug', 2);
  await sheets.onHint(1, session, rec);
  assert.strictEqual(fg.calls.append.length, 1);
  assert.strictEqual(fg.calls.append[0].range, 'Hints!A1');
  assert.strictEqual(fg.calls.append[0].requestBody.values[0][2], 'look under the rug');
});

test('readOperators returns the fake names, and [] when api is null', async () => {
  const es = createEventStore({ path: ':memory:' });
  const gs = createGameStore(es.db);
  const fg = fakeGoogle();
  const cfg = { current: () => ({ sheets: { operatorsSpreadsheetId: 'oid' } }) };
  const withApi = createSheets({
    credentialsPath: '/nonexistent', eventStore: es, gameStore: gs,
    config: cfg, googleFactory: () => fg.api,
  });
  assert.deepStrictEqual(await withApi.readOperators(), ['Sam', 'Ana']);
  assert.strictEqual(withApi.enabled, true);

  const noApi = createSheets({
    credentialsPath: '/nonexistent', eventStore: es, gameStore: gs, config: cfg,
  });
  assert.deepStrictEqual(await noApi.readOperators(), []);
  assert.strictEqual(noApi.enabled, false);
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
