const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEventStore } = require('../src/event-store');
const { createGameStore } = require('../src/game-store');
const { createConfig, validateConfig } = require('../src/config');
const { createSheets } = require('../src/sheets');

function fakeGoogleApi(calls) {
  return {
    spreadsheets: {
      batchUpdate: async (b) => { calls.batchUpdate.push(b); return { data: {} }; },
      get: async (g) => { calls.get.push(g); return { data: { sheets: [{ properties: { title: 'Hotkeys' } }] } }; },
      values: {
        clear: async (c) => { calls.clear.push(c); return { data: {} }; },
        update: async (u) => { calls.update.push(u); return { data: {} }; },
      },
    },
  };
}

test('an old-shape config on disk migrates, validates, and syncs to the Hotkeys tab', () => {
  const p = path.join(os.tmpdir(), 'htm-migration-smoke-' + Date.now() + '.json');
  fs.writeFileSync(p, JSON.stringify({
    roomName: 'Nibiru Brain',
    game: { timerMinutes: 60, volume: 0.5 },
    sheets: { hintsSpreadsheetId: 'hid' },
    hintGroups: [
      { name: 'Briefcase', hints: [{ text: 'Look at the calendar', key: 'F1' }] },
      { name: 'Chessboard', hints: [{ text: 'Only white pieces move', key: '' }] },
    ],
  }));

  const es = createEventStore({ path: ':memory:' });
  const gs = createGameStore(es.db);
  const config = createConfig({ path: p, db: es.db });
  const loaded = config.load();

  // Migrated shape is itself schema-valid
  const { ok, errors } = validateConfig(loaded);
  assert.deepStrictEqual({ ok, errors }, { ok: true, errors: [] });
  assert.strictEqual(loaded.steps.length, 2);
  assert.strictEqual(loaded.audio.volume, 0.5); // carried over from game.volume

  const calls = { batchUpdate: [], get: [], clear: [], update: [] };
  const sheets = createSheets({
    credentialsPath: '/nonexistent', eventStore: es, gameStore: gs,
    config, googleFactory: () => fakeGoogleApi(calls),
  });

  return sheets.syncHotkeysTab().then(() => {
    assert.deepStrictEqual(calls.update[0].requestBody.values, [
      ['Group', 'Hint', 'Hotkey'],
      ['Briefcase', 'Look at the calendar', 'F1'],
      ['Chessboard', 'Only white pieces move', ''],
    ]);
    fs.unlinkSync(p);
  });
});
