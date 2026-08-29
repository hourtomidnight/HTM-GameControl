const { test } = require('node:test');
const assert = require('node:assert');
const { migrate } = require('../scripts/migrate-config');
const { validateConfig } = require('../src/config-schema');

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

test('migrated config validates against schema', () => {
  const oldConfig = {
    roomName: 'Escape Room 1',
    timerMinutes: 60,
    volume: 0.8,
    logoPath: '/assets/logo.png',
    introMediaPath: '/assets/intro.mp4',
    hintCycleSeconds: 30,
    startStopKey: 'Space',
    sessionsSpreadsheetId: 'abc123',
    sessionsTabName: 'Sessions',
    hintsSpreadsheetId: 'def456',
    hintsTabName: 'Hints',
    hotkeysTabName: 'Hotkeys',
    operatorsSpreadsheetId: 'ghi789',
    eventRetentionDays: 7,
    hintGroups: [
      {
        name: 'Technical Hints',
        hints: [
          { key: 'F1', text: 'Check the wiring' },
          { key: 'F2', text: 'Try the backup system' }
        ]
      }
    ],
    gameScreenIndex: 0,
  };
  const migratedConfig = migrate(oldConfig);
  const result = validateConfig(migratedConfig);
  assert.strictEqual(result.ok, true, `Schema validation failed: ${result.errors.join(', ')}`);
});
