const { test } = require('node:test');
const assert = require('node:assert');
const st = require('../src/session-tracker');

test('createSession seeds defaults', () => {
  const s = st.createSession({ startTime: 100, room: 'A' });
  assert.strictEqual(s.startTime, 100);
  assert.strictEqual(s.room, 'A');
  assert.deepStrictEqual(s.adjustments, []);
  assert.deepStrictEqual(s.hints, []);
  assert.strictEqual(s.status, null);
});

test('applyAdjustment records type and time; netAdjustmentSeconds sums', () => {
  const s = st.createSession({ startTime: 0 });
  st.applyAdjustment(s, 'add-min', 1);
  st.applyAdjustment(s, 'sub-sec', 2);
  assert.strictEqual(s.adjustments.length, 2);
  assert.strictEqual(st.netAdjustmentSeconds(s), 59);
});

test('applyHint returns record and appends', () => {
  const s = st.createSession({ startTime: 0 });
  const rec = st.applyHint(s, 'look up', 5);
  assert.deepStrictEqual(rec, { text: 'look up', time: 5 });
  assert.strictEqual(s.hints.length, 1);
});

test('updateField rejects unknown field', () => {
  const s = st.createSession({ startTime: 0 });
  assert.throws(() => st.updateField(s, 'nope', 1), /Unknown session field/);
  st.updateField(s, 'teamName', 'Red');
  assert.strictEqual(s.teamName, 'Red');
});

test('finalizeSession sets duration and status', () => {
  const s = st.createSession({ startTime: 1000 });
  st.finalizeSession(s, 4000, 'Escaped');
  assert.strictEqual(s.duration, 3000);
  assert.strictEqual(s.status, 'Escaped');
});
