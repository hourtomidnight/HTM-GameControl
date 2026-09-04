const { test } = require('node:test');
const assert = require('node:assert');
const { migrateHintGroupsToSteps } = require('../src/config-migrate');

test('converts hintGroups into steps with deterministic ids, leaves hintGroups untouched', () => {
  const old = {
    roomName: 'Nibiru Brain',
    hintGroups: [
      { name: 'Briefcase', hints: [{ text: 'Look at the calendar', key: 'F1' }, { text: 'Try a date', key: '' }] },
      { name: 'Chessboard', hints: [{ text: 'Only white pieces move', key: 'F6' }] },
    ],
  };
  const { cfg, migrated } = migrateHintGroupsToSteps(old);
  assert.strictEqual(migrated, true);
  assert.deepStrictEqual(cfg.hintGroups, old.hintGroups); // untouched, still present
  assert.strictEqual(cfg.roomName, 'Nibiru Brain'); // other keys preserved
  assert.deepStrictEqual(cfg.sections, []);
  assert.strictEqual(cfg.steps.length, 2);

  assert.deepStrictEqual(cfg.steps[0], {
    id: 'step_1', name: 'Briefcase', order: 1, sectionId: null,
    hints: [
      { id: 'step_1_h1', type: 'text', text: 'Look at the calendar', key: 'F1', countsAsClue: true },
      { id: 'step_1_h2', type: 'text', text: 'Try a date', key: '', countsAsClue: true },
    ],
  });
  assert.deepStrictEqual(cfg.steps[1], {
    id: 'step_2', name: 'Chessboard', order: 2, sectionId: null,
    hints: [{ id: 'step_2_h1', type: 'text', text: 'Only white pieces move', key: 'F6', countsAsClue: true }],
  });

  assert.deepStrictEqual(cfg.progress, { flags: [] });
  assert.strictEqual(cfg.audio.volume, 0.4);
  for (const name of ['start', 'loop', 'midShow', 'win', 'lose', 'clueChime']) {
    assert.strictEqual(cfg.audio.events[name].enabled, false);
  }
  assert.strictEqual(cfg.audio.events.midShow.atSecondsRemaining, 120);
});

test('unnamed groups get a fallback name, missing hints array is treated as empty', () => {
  const { cfg } = migrateHintGroupsToSteps({ hintGroups: [{ hints: [] }, {}] });
  assert.strictEqual(cfg.steps[0].name, 'Group 1');
  assert.strictEqual(cfg.steps[1].name, 'Group 2');
  assert.deepStrictEqual(cfg.steps[1].hints, []);
});

test('carries over an existing game.volume as the audio default when present', () => {
  const { cfg } = migrateHintGroupsToSteps({ hintGroups: [], game: { volume: 0.7 } });
  assert.strictEqual(cfg.audio.volume, 0.7);
});

test('is a no-op when steps already exists', () => {
  const already = { hintGroups: [{ name: 'X', hints: [] }], steps: [{ id: 's1', name: 'X', order: 1, hints: [] }] };
  const { cfg, migrated } = migrateHintGroupsToSteps(already);
  assert.strictEqual(migrated, false);
  assert.strictEqual(cfg, already); // same reference — untouched
});

test('is a no-op when hintGroups is absent', () => {
  const bare = { roomName: 'X' };
  const { cfg, migrated } = migrateHintGroupsToSteps(bare);
  assert.strictEqual(migrated, false);
  assert.strictEqual(cfg, bare);
});

test('is a no-op for an empty or non-object input', () => {
  assert.deepStrictEqual(migrateHintGroupsToSteps({}), { cfg: {}, migrated: false });
  assert.deepStrictEqual(migrateHintGroupsToSteps(null), { cfg: {}, migrated: false });
  assert.deepStrictEqual(migrateHintGroupsToSteps(undefined), { cfg: {}, migrated: false });
});
