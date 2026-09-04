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

test('accepts a valid sections/steps/progress/audio config', () => {
  const r = validateConfig({
    sections: [{ id: 'sec_desk', name: 'Desk', order: 1, note: '' }],
    steps: [
      {
        id: 'step_briefcase', name: 'Briefcase', order: 1, sectionId: 'sec_desk',
        hints: [
          { id: 'h1', type: 'text', text: 'Look at the calendar', key: 'F1', countsAsClue: true },
          { id: 'h2', type: 'audio', mediaRef: 'nibiru/briefcase_2.mp3', label: 'Clue 2', color: '#4a8aff', icon: '🎧', key: 'F2' },
        ],
      },
      { id: 'step_pendant', name: 'Pendant', order: 2, hints: [] },
    ],
    progress: { flags: ['Translation given'] },
    audio: {
      volume: 0.4,
      events: {
        start: { file: 'global/start.mp3', enabled: true },
        midShow: { file: 'global/2min.mp3', enabled: true, atSecondsRemaining: 120 },
      },
    },
  });
  assert.deepStrictEqual(r, { ok: true, errors: [] });
});

test('rejects duplicate section / step / hint ids', () => {
  const dupSection = validateConfig({ sections: [
    { id: 'sec_a', name: 'A', order: 1 }, { id: 'sec_a', name: 'B', order: 2 },
  ] });
  assert.ok(dupSection.errors.some(e => /duplicate section id: sec_a/.test(e)));

  const dupStep = validateConfig({ steps: [
    { id: 'step_a', name: 'A', order: 1, hints: [] }, { id: 'step_a', name: 'B', order: 2, hints: [] },
  ] });
  assert.ok(dupStep.errors.some(e => /duplicate step id: step_a/.test(e)));

  const dupHint = validateConfig({ steps: [
    { id: 'step_a', name: 'A', order: 1, hints: [{ id: 'h1', type: 'text', text: 'x' }] },
    { id: 'step_b', name: 'B', order: 2, hints: [{ id: 'h1', type: 'text', text: 'y' }] },
  ] });
  assert.ok(dupHint.errors.some(e => /duplicate hint id: h1/.test(e)));
});

test('rejects a step referencing an unknown section', () => {
  const r = validateConfig({ steps: [
    { id: 'step_a', name: 'A', order: 1, sectionId: 'sec_ghost', hints: [] },
  ] });
  assert.ok(r.errors.some(e => /steps\[0\] references unknown section: sec_ghost/.test(e)));
});

test('rejects hint type "video" (reserved) and enforces text/audio required fields', () => {
  const badType = validateConfig({ steps: [
    { id: 'step_a', name: 'A', order: 1, hints: [{ id: 'h1', type: 'video', text: 'x' }] },
  ] });
  assert.ok(badType.errors.some(e => /type invalid \(must be text or audio\)/.test(e)));

  const missingText = validateConfig({ steps: [
    { id: 'step_a', name: 'A', order: 1, hints: [{ id: 'h1', type: 'text' }] },
  ] });
  assert.ok(missingText.errors.some(e => /hints\[0\]\.text must be a non-empty string/.test(e)));

  const missingMediaRef = validateConfig({ steps: [
    { id: 'step_a', name: 'A', order: 1, hints: [{ id: 'h1', type: 'audio' }] },
  ] });
  assert.ok(missingMediaRef.errors.some(e => /hints\[0\]\.mediaRef must be a non-empty string/.test(e)));
});

test('requires audio.events.midShow.atSecondsRemaining when midShow is enabled', () => {
  const missing = validateConfig({ audio: { events: { midShow: { file: 'x.mp3', enabled: true } } } });
  assert.ok(missing.errors.some(e => /midShow\.atSecondsRemaining must be a positive number/.test(e)));

  const okDisabled = validateConfig({ audio: { events: { midShow: { file: 'x.mp3', enabled: false } } } });
  assert.deepStrictEqual(okDisabled, { ok: true, errors: [] });
});

test('progress.flags must be an array of strings', () => {
  const r = validateConfig({ progress: { flags: ['ok', 5] } });
  assert.ok(r.errors.some(e => /progress\.flags\[1\] must be a string/.test(e)));
});

test('sections/steps/progress/audio are on the allowed top-level key list', () => {
  const r = validateConfig({ sections: [], steps: [], progress: { flags: [] }, audio: { events: {} } });
  assert.deepStrictEqual(r, { ok: true, errors: [] });
});
