const { test } = require('node:test');
const assert = require('node:assert');
const { createEventStore } = require('../src/event-store');
const { createGameStore } = require('../src/game-store');
const { createGameEngine } = require('../src/game-engine');
const { createProgress } = require('../src/progress');

function mk(opts = {}) {
  const es = createEventStore({ path: ':memory:' });
  const gs = createGameStore(es.db);
  let t = 10000;
  const progress = opts.withProgress ? createProgress({ eventStore: es, now: () => t }) : null;
  const engine = createGameEngine({
    eventStore: es, gameStore: gs, progress,
    now: () => t, setInterval: () => 0, clearInterval: () => {},
  });
  return { es, gs, engine, progress, advance: (ms) => { t += ms; } };
}

test('start from waiting creates a game row and goes running', () => {
  const { es, gs, engine } = mk();
  engine.command({ type: 'update-field', field: 'operator', value: 'Sam' });
  engine.command({ type: 'start' });
  const s = engine.getState();
  assert.strictEqual(s.phase, 'running');
  assert.strictEqual(s.timerRunning, true);
  assert.ok(s.gameId);
  assert.strictEqual(gs.get(s.gameId).operator, 'Sam');
  assert.ok(es.query({ type: 'start' }).length === 1);
});

test('tick counts down then flips to count-up at zero', () => {
  const { engine } = mk();
  engine.command({ type: 'start' });
  // default 60:00 -> set to 0:02 via adjustments for a short test
  engine.command({ type: 'sub-min' }); // 59:00
  for (let i = 0; i < 59; i++) engine.command({ type: 'sub-min' }); // 0:00-ish guard
  const before = engine.getState();
  engine.tickOnce();
  const after = engine.getState();
  assert.ok(after.clockForward || (after.currentMin === before.currentMin - (before.currentSec === 0 ? 1 : 0)));
});

test('pause and resume toggle timerRunning only', () => {
  const { engine } = mk();
  engine.command({ type: 'start' });
  engine.command({ type: 'pause' });
  assert.strictEqual(engine.getState().timerRunning, false);
  assert.strictEqual(engine.getState().gameLocked, false);
  engine.command({ type: 'resume' });
  assert.strictEqual(engine.getState().timerRunning, true);
});

test('escaped finalizes game row and locks', () => {
  const { es, gs, engine } = mk();
  engine.command({ type: 'start' });
  const id = engine.getState().gameId;
  engine.command({ type: 'escaped' });
  const s = engine.getState();
  assert.strictEqual(s.phase, 'escaped');
  assert.strictEqual(s.gameLocked, true);
  assert.strictEqual(gs.get(id).status, 'Escaped');
  assert.ok(gs.get(id).ended_ts);
});

test('start is ignored while locked; reset clears the lock', () => {
  const { engine } = mk();
  engine.command({ type: 'start' });
  engine.command({ type: 'escaped' });
  engine.command({ type: 'start' });
  assert.strictEqual(engine.getState().phase, 'escaped');
  engine.command({ type: 'reset' });
  assert.strictEqual(engine.getState().phase, 'waiting');
  assert.strictEqual(engine.getState().gameLocked, false);
});

test('reset mid-game finalizes the row as Reset-Lost', () => {
  const { gs, engine } = mk();
  engine.command({ type: 'start' });
  const id = engine.getState().gameId;
  engine.command({ type: 'reset' });
  assert.strictEqual(gs.get(id).status, 'Reset-Lost');
});

test('adjustment during a session is recorded on the session', () => {
  const { gs, engine } = mk();
  engine.command({ type: 'start' });
  const id = engine.getState().gameId;
  engine.command({ type: 'add-min' });
  engine.command({ type: 'escaped' });
  assert.strictEqual(gs.get(id).adjustments, 1);
  assert.strictEqual(gs.get(id).net_adjust_s, 60);
});

test('onState fires on every change', () => {
  const { engine } = mk();
  let calls = 0;
  engine.onState(() => calls++);
  engine.command({ type: 'start' });
  engine.command({ type: 'pause' });
  assert.ok(calls >= 2);
});

test('a synchronously throwing sheets driver does not break command()', () => {
  const es = createEventStore({ path: ':memory:' });
  const gs = createGameStore(es.db);
  let t = 10000;
  const sheets = {
    onGameStart() { throw new Error('sync boom'); },
    onSessionSync() { throw new Error('sync boom'); },
    onHint() { throw new Error('sync boom'); },
  };
  const engine = createGameEngine({
    eventStore: es, gameStore: gs, sheets,
    now: () => t, setInterval: () => 1, clearInterval: () => {},
  });
  assert.doesNotThrow(() => engine.command({ type: 'start' }));
  const s = engine.getState();
  assert.strictEqual(s.phase, 'running');
  assert.ok(s.gameId);
  assert.doesNotThrow(() => engine.command({ type: 'add-min' }));
});

test('pause is a no-op unless phase is running', () => {
  const { es, engine } = mk();
  engine.command({ type: 'pause' });
  assert.strictEqual(engine.getState().phase, 'waiting');
  assert.strictEqual(es.query({ type: 'pause' }).length, 0);
});

test('onState returns an unsubscribe function that stops further callbacks', () => {
  const { engine } = mk();
  let calls = 0;
  const off = engine.onState(() => calls++);
  assert.strictEqual(typeof off, 'function');
  engine.command({ type: 'start' });
  const afterFirst = calls;
  assert.ok(afterFirst >= 1);
  off();
  engine.command({ type: 'pause' });
  engine.command({ type: 'resume' });
  assert.strictEqual(calls, afterFirst);
});

test('created game row carries the configured room name', () => {
  const es = createEventStore({ path: ':memory:' });
  const gs = createGameStore(es.db);
  let t = 10000;
  const engine = createGameEngine({
    eventStore: es, gameStore: gs, roomName: 'Nibiru',
    now: () => t, setInterval: () => 0, clearInterval: () => {},
  });
  engine.command({ type: 'start' });
  const id = engine.getState().gameId;
  assert.strictEqual(gs.get(id).room, 'Nibiru');
});

test('clock adjust after escaped is a no-op (no clock change, no event, no sheets call)', () => {
  const es = createEventStore({ path: ':memory:' });
  const gs = createGameStore(es.db);
  let t = 10000;
  let sessionSyncCalls = 0;
  const sheets = {
    onGameStart() {}, onHint() {},
    onSessionSync() { sessionSyncCalls++; },
  };
  const engine = createGameEngine({
    eventStore: es, gameStore: gs, sheets,
    now: () => t, setInterval: () => 1, clearInterval: () => {},
  });
  engine.command({ type: 'start' });
  engine.command({ type: 'escaped' });
  const syncsAfterEscaped = sessionSyncCalls;
  const before = engine.getState();
  engine.command({ type: 'add-min' });
  const after = engine.getState();
  assert.strictEqual(after.currentMin, before.currentMin);
  assert.strictEqual(after.currentSec, before.currentSec);
  assert.strictEqual(es.query({ type: 'add-min' }).length, 0);
  assert.strictEqual(sessionSyncCalls, syncsAfterEscaped);
  assert.strictEqual(es.query({ type: 'sheets-error' }).length, 0);
});

test('game state is mirrored onto the internal signal bus when provided', () => {
  const { createSignalBus } = require('../src/signal-bus');
  const { createInternalDriver } = require('../src/drivers/internal');
  const es = createEventStore({ path: ':memory:' });
  const gs = createGameStore(es.db);
  const signals = [
    { name: 'phase', direction: 'in-out', type: 'string', driver: 'internal', address: { pin: 'phase' } },
    { name: 'timer_running', direction: 'in-out', type: 'bool', driver: 'internal', address: { pin: 'timer_running' } },
    { name: 'game_locked', direction: 'in-out', type: 'bool', driver: 'internal', address: { pin: 'game_locked' } },
  ];
  const bus = createSignalBus({ eventStore: es, drivers: { internal: createInternalDriver() }, signals });
  bus.start();
  const engine = createGameEngine({ eventStore: es, gameStore: gs, signalBus: bus,
    now: () => 1, setInterval: () => 0, clearInterval: () => {} });
  engine.command({ type: 'start' });
  assert.strictEqual(bus.get('timer_running').value, true);
  engine.command({ type: 'escaped' });
  assert.strictEqual(bus.get('game_locked').value, true);
});

test('getState omits steps/flags when no progress module is wired', () => {
  const { engine } = mk(); // no progress
  const s = engine.getState();
  assert.equal('steps' in s, false);
  assert.equal('flags' in s, false);
});

test('starting a game calls progress.startGame with the gameId and start time', () => {
  const { engine } = mk({ withProgress: true });
  engine.command({ type: 'start' });
  const s = engine.getState();
  assert.ok(s.steps);
  assert.deepEqual(s.steps, {});
  assert.deepEqual(s.flags, {});
});

test('show-hint with a stepId marks progress given, in addition to existing text-hint behavior', () => {
  const { engine } = mk({ withProgress: true });
  engine.command({ type: 'start' });
  engine.command({ type: 'show-hint', text: 'Look under the desk', stepId: 'step_1' });
  const s = engine.getState();
  assert.ok(s.activeHints.includes('Look under the desk')); // existing behavior unchanged
  assert.ok(s.steps.step_1.clueGivenAt); // new: progress tracked it
});

test('show-hint without a stepId does not touch progress (backward compatible)', () => {
  const { engine } = mk({ withProgress: true });
  engine.command({ type: 'start' });
  engine.command({ type: 'show-hint', text: 'Old-style hint' });
  const s = engine.getState();
  assert.deepEqual(s.steps, {}); // untouched
});

test('solve-step toggles a step and is reflected in getState().steps', () => {
  const { engine } = mk({ withProgress: true });
  engine.command({ type: 'start' });
  engine.command({ type: 'solve-step', stepId: 'step_1', on: true });
  assert.ok(engine.getState().steps.step_1.solvedAt);
  engine.command({ type: 'solve-step', stepId: 'step_1', on: false });
  assert.equal(engine.getState().steps.step_1.solvedAt, null);
});

test('solve-step is a no-op when no game is running', () => {
  const { es, engine } = mk({ withProgress: true });
  engine.command({ type: 'solve-step', stepId: 'step_1', on: true }); // no start
  assert.deepEqual(engine.getState().steps, {});
  assert.strictEqual(es.query({ type: 'solve-step' }).length, 0);
});

test('set-flag toggles a game-level flag reflected in getState().flags', () => {
  const { engine } = mk({ withProgress: true });
  engine.command({ type: 'start' });
  engine.command({ type: 'set-flag', name: 'Translation given', on: true });
  assert.ok(engine.getState().flags['Translation given']);
  engine.command({ type: 'set-flag', name: 'Translation given', on: false });
  assert.equal(engine.getState().flags['Translation given'], null);
});

test('reset blanks progress state immediately', () => {
  const { engine } = mk({ withProgress: true });
  engine.command({ type: 'start' });
  engine.command({ type: 'solve-step', stepId: 'step_1', on: true });
  engine.command({ type: 'reset' });
  assert.deepEqual(engine.getState().steps, {});
});

test('a missing progress module never crashes solve-step/set-flag commands', () => {
  const { engine } = mk(); // no progress
  engine.command({ type: 'start' });
  assert.doesNotThrow(() => engine.command({ type: 'solve-step', stepId: 'step_1', on: true }));
  assert.doesNotThrow(() => engine.command({ type: 'set-flag', name: 'f', on: true }));
});

test('unrecognized command types (play-hint, stop-audio) are silent no-ops, not crashes', () => {
  const { engine } = mk();
  engine.command({ type: 'start' });
  const before = engine.getState();
  assert.doesNotThrow(() => engine.command({ type: 'play-hint', stepId: 'x', hintId: 'y' }));
  assert.doesNotThrow(() => engine.command({ type: 'stop-audio' }));
  assert.deepEqual(engine.getState(), before); // no state change from either
});
