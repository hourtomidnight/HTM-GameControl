const { test } = require('node:test');
const assert = require('node:assert');
const { createEventStore } = require('../src/event-store');
const { createGameStore } = require('../src/game-store');
const stk = require('../src/session-tracker');
const { createSheets, buildSessionRow, formatDuration, buildHotkeysRows } = require('../src/sheets');

function fakeGoogle() {
  const calls = { append: [], update: [], get: [], clear: [], batchUpdate: [] };
  let getRows = [['Sam'], ['Ana']];
  return {
    calls,
    setGetRows: (rows) => { getRows = rows; },
    api: {
      spreadsheets: {
        batchUpdate: async (b) => { calls.batchUpdate.push(b); return { data: {} }; },
        get: async (g) => { calls.get.push(g); return { data: { sheets: [
          { properties: { title: 'Sessions' } },
          { properties: { title: 'pi-Hint-SON' } },
          { properties: { title: 'Drop Down options' } },
        ] } }; },
        values: {
          append: async (a) => { calls.append.push(a);
            return { data: { updates: { updatedRange: `${a.range.split('!')[0]}!A5:N5` } } }; },
          update: async (u) => { calls.update.push(u); return { data: {} }; },
          get: async (g) => { calls.get.push(g); return { data: { values: getRows } }; },
          clear: async (c) => { calls.clear.push(c); return { data: {} }; },
        },
      },
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
  // default range when tab/column/row not configured
  assert.strictEqual(fg.calls.get[0].range, 'Drop Down options!B2:B');

  const noApi = createSheets({
    credentialsPath: '/nonexistent', eventStore: es, gameStore: gs, config: cfg,
  });
  assert.deepStrictEqual(await noApi.readOperators(), []);
  assert.strictEqual(noApi.enabled, false);
});

test('buildHotkeysRows flattens groups to [Group, Hint, Hotkey], skipping empty hints', () => {
  const groups = [
    { name: 'Puzzle 1', hints: [{ text: 'Look up', key: 'F1' }, { text: 'No key hint', key: '' }] },
    { name: '', hints: [{ text: 'Orphan', key: 'F2' }] },
    { name: 'Empty', hints: [{ text: '', key: 'F9' }] },
  ];
  assert.deepStrictEqual(buildHotkeysRows(groups), [
    ['Puzzle 1', 'Look up', 'F1'],
    ['Puzzle 1', 'No key hint', ''],
    ['', 'Orphan', 'F2'],
  ]);
  assert.deepStrictEqual(buildHotkeysRows(undefined), []);
});

test('syncHotkeysTab clears A:C then writes header + one row per hint', async () => {
  const es = createEventStore({ path: ':memory:' });
  const gs = createGameStore(es.db);
  const fg = fakeGoogle();
  const cfg = { current: () => ({
    sheets: { hintsSpreadsheetId: 'hid', hotkeysTabName: 'Hotkeys' },
    hintGroups: [{ name: 'P1', hints: [{ text: 'a', key: 'F1' }, { text: 'b', key: '' }] }],
  }) };
  const sheets = createSheets({
    credentialsPath: '/nonexistent', eventStore: es, gameStore: gs,
    config: cfg, googleFactory: () => fg.api,
  });
  await sheets.syncHotkeysTab();
  assert.strictEqual(fg.calls.batchUpdate[0].requestBody.requests[0].addSheet.properties.title, 'Hotkeys');
  assert.strictEqual(fg.calls.clear[0].range, 'Hotkeys!A:C');
  assert.strictEqual(fg.calls.update[0].range, 'Hotkeys!A1');
  assert.deepStrictEqual(fg.calls.update[0].requestBody.values, [
    ['Group', 'Hint', 'Hotkey'],
    ['P1', 'a', 'F1'],
    ['P1', 'b', ''],
  ]);

  // Defaults to a tab called "Hotkeys" when hotkeysTabName is not set
  const fg2 = fakeGoogle();
  const s2 = createSheets({
    credentialsPath: '/nonexistent', eventStore: es, gameStore: gs,
    config: { current: () => ({ sheets: { hintsSpreadsheetId: 'hid' }, hintGroups: [] }) },
    googleFactory: () => fg2.api,
  });
  await s2.syncHotkeysTab();
  assert.strictEqual(fg2.calls.clear[0].range, 'Hotkeys!A:C');
  assert.deepStrictEqual(fg2.calls.update[0].requestBody.values, [['Group', 'Hint', 'Hotkey']]);

  // No-op with no Hint Log spreadsheet configured
  const fg3 = fakeGoogle();
  const s3 = createSheets({
    credentialsPath: '/nonexistent', eventStore: es, gameStore: gs,
    config: { current: () => ({ sheets: {}, hintGroups: [] }) },
    googleFactory: () => fg3.api,
  });
  await s3.syncHotkeysTab();
  assert.strictEqual(fg3.calls.clear.length, 0);
  assert.strictEqual(fg3.calls.update.length, 0);
});

test('listTabs returns the spreadsheet tab titles, [] with no id / no api', async () => {
  const es = createEventStore({ path: ':memory:' });
  const gs = createGameStore(es.db);
  const fg = fakeGoogle();
  const sheets = createSheets({
    credentialsPath: '/nonexistent', eventStore: es, gameStore: gs,
    config: { current: () => ({ sheets: {} }) }, googleFactory: () => fg.api,
  });
  assert.deepStrictEqual(await sheets.listTabs('abc123'),
    ['Sessions', 'pi-Hint-SON', 'Drop Down options']);
  assert.strictEqual(fg.calls.get[0].spreadsheetId, 'abc123');
  assert.deepStrictEqual(await sheets.listTabs(''), []);

  const noApi = createSheets({
    credentialsPath: '/nonexistent', eventStore: es, gameStore: gs,
    config: { current: () => ({ sheets: {} }) },
  });
  assert.deepStrictEqual(await noApi.listTabs('abc123'), []);
});

test('readHotkeys parses A2:C into {group, hint, key}, skipping keyless-but-hintless rows', async () => {
  const es = createEventStore({ path: ':memory:' });
  const gs = createGameStore(es.db);
  const fg = fakeGoogle();
  fg.setGetRows([
    ['Puzzle 1', 'Look up', 'F1'],
    ['Puzzle 1', 'Open the safe', ''],
    ['', 'Loose hint', 'F5'],
    ['Puzzle 2', '', 'F9'],   // no hint text -> dropped
  ]);
  const sheets = createSheets({
    credentialsPath: '/nonexistent', eventStore: es, gameStore: gs,
    config: { current: () => ({ sheets: { hintsSpreadsheetId: 'hid' } }) },
    googleFactory: () => fg.api,
  });
  const rows = await sheets.readHotkeys();
  assert.strictEqual(fg.calls.get[0].range, 'Hotkeys!A2:C');
  assert.deepStrictEqual(rows, [
    { group: 'Puzzle 1', hint: 'Look up', key: 'F1' },
    { group: 'Puzzle 1', hint: 'Open the safe', key: '' },
    { group: '', hint: 'Loose hint', key: 'F5' },
  ]);

  // [] when no Hint Log spreadsheet configured
  const s2 = createSheets({
    credentialsPath: '/nonexistent', eventStore: es, gameStore: gs,
    config: { current: () => ({ sheets: {} }) }, googleFactory: () => fakeGoogle().api,
  });
  assert.deepStrictEqual(await s2.readHotkeys(), []);
});

test('readOperators uses the configured tab / column / start row', async () => {
  const es = createEventStore({ path: ':memory:' });
  const gs = createGameStore(es.db);
  const fg = fakeGoogle();
  const cfg = { current: () => ({ sheets: {
    operatorsSpreadsheetId: 'oid',
    operatorsTabName: 'Staff List',
    operatorsColumn: 'd',
    operatorsStartRow: '5',
  } }) };
  const sheets = createSheets({
    credentialsPath: '/nonexistent', eventStore: es, gameStore: gs,
    config: cfg, googleFactory: () => fg.api,
  });
  await sheets.readOperators();
  assert.strictEqual(fg.calls.get[0].range, 'Staff List!D5:D');
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
