const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createEventStore } = require('../src/event-store');
const { createProgress } = require('../src/progress');

function mk() {
  const es = createEventStore({ path: ':memory:' });
  let t = 100000;
  const progress = createProgress({ eventStore: es, now: () => t });
  return { es, progress, advance: (ms) => { t += ms; } };
}

test('startGame clears state and records progress-reset with game_id', () => {
  const { es, progress } = mk();
  progress.markGiven('step_1');
  progress.startGame(42, 100000);
  assert.deepEqual(progress.snapshot(), { steps: {}, flags: {} });
  const events = es.query({ type: 'progress-reset' });
  assert.equal(events.length, 1);
  assert.equal(events[0].game_id, 42);
  assert.equal(events[0].source, 'progress');
});

test('markGiven sets clueGivenAt on first call and is a no-op after', () => {
  const { es, progress, advance } = mk();
  progress.startGame(1, 100000);
  progress.markGiven('step_1');
  const snap1 = progress.snapshot();
  assert.ok(snap1.steps.step_1.clueGivenAt);
  assert.equal(es.query({ type: 'hint-given' }).length, 1);

  advance(5000);
  progress.markGiven('step_1'); // second call — no-op
  const snap2 = progress.snapshot();
  assert.equal(snap2.steps.step_1.clueGivenAt, snap1.steps.step_1.clueGivenAt); // unchanged
  assert.equal(es.query({ type: 'hint-given' }).length, 1); // still just 1 event
});

test('solveStep(on) records elapsedMs and clueToSolveMs when a clue was given', () => {
  const { es, progress, advance } = mk();
  progress.startGame(1, 100000);
  advance(3000);
  progress.markGiven('step_1'); // clueGivenAt = 103000
  advance(2000);
  progress.solveStep('step_1', true); // solvedAt = 105000

  const snap = progress.snapshot();
  assert.equal(snap.steps.step_1.solvedAt, 105000);

  const events = es.query({ type: 'step-solved' });
  assert.equal(events.length, 1);
  assert.equal(events[0].subject, 'step_1');
  const detail = events[0].detail;
  assert.equal(detail.elapsedMs, 5000); // 105000 - 100000
  assert.equal(detail.clueToSolveMs, 2000); // 105000 - 103000
});

test('solveStep(on) omits clueToSolveMs when no clue was given', () => {
  const { es, progress, advance } = mk();
  progress.startGame(1, 100000);
  advance(4000);
  progress.solveStep('step_2', true); // no markGiven call first

  const events = es.query({ type: 'step-solved' });
  const detail = events[0].detail;
  assert.equal(detail.elapsedMs, 4000);
  assert.equal('clueToSolveMs' in detail, false);
});

test('solveStep(off) clears solvedAt and records step-unsolved with no detail', () => {
  const { es, progress } = mk();
  progress.startGame(1, 100000);
  progress.solveStep('step_1', true);
  progress.solveStep('step_1', false);

  assert.equal(progress.snapshot().steps.step_1.solvedAt, null);
  const events = es.query({ type: 'step-unsolved' });
  assert.equal(events.length, 1);
  assert.equal(events[0].subject, 'step_1');
});

test('setFlag sets and clears with the correct top-level value field', () => {
  const { es, progress } = mk();
  progress.startGame(1, 100000);
  progress.setFlag('Translation given', true);
  assert.ok(progress.snapshot().flags['Translation given']);

  let events = es.query({ type: 'flag-set' });
  assert.equal(events.length, 1);
  assert.equal(events[0].subject, 'Translation given');
  assert.equal(events[0].value, true); // encode/decode round-trips boolean true back to true

  progress.setFlag('Translation given', false);
  assert.equal(progress.snapshot().flags['Translation given'], null);
  events = es.query({ type: 'flag-set' });
  assert.equal(events.length, 2);
});

test('snapshot returns a copy, not a live reference', () => {
  const { progress } = mk();
  progress.startGame(1, 100000);
  progress.markGiven('step_1');
  const snap = progress.snapshot();
  snap.steps.step_1.clueGivenAt = 'tampered';
  const snap2 = progress.snapshot();
  assert.notEqual(snap2.steps.step_1.clueGivenAt, 'tampered');
});

test('all recorded events carry the current game_id', () => {
  const { es, progress } = mk();
  progress.startGame(7, 100000);
  progress.markGiven('step_1');
  progress.solveStep('step_1', true);
  progress.setFlag('f', true);
  const all = es.query({ game_id: 7 });
  assert.ok(all.length >= 4); // progress-reset + hint-given + step-solved + flag-set
  assert.ok(all.every(e => e.game_id === 7));
});
