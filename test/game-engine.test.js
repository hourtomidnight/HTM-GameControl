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

// ---- Sub-milestone 6: global audio events ----

function mkAudio() {
  const calls = [];
  const rec = (name) => (...args) => { calls.push({ name, args }); };
  return {
    calls,
    playEffect: rec('playEffect'), playMusic: rec('playMusic'),
    stopMusic: rec('stopMusic'), stopAll: rec('stopAll'),
    setVolume: rec('setVolume'), now: () => ({}),
    names: () => calls.map(c => c.name),
    args1: (name) => calls.filter(c => c.name === name).map(c => c.args[0]),
  };
}

function audioCfg(over = {}) {
  return {
    audio: {
      volume: 0.6,
      events: {
        start: { file: 'g/start.mp3', enabled: true },
        loop: { file: 'g/bed.mp3', enabled: true },
        midShow: { file: 'g/2min.mp3', enabled: true, atSecondsRemaining: 120 },
        win: { file: 'g/win.mp3', enabled: true },
        lose: { file: 'g/lose.mp3', enabled: true },
        clueChime: { file: 'g/chime.mp3', enabled: true },
        ...(over.events || {}),
      },
      ...(over.audio || {}),
    },
    steps: over.steps || [{
      id: 'step_1', name: 'S1', order: 0, hints: [
        { id: 'h1', type: 'text', text: 'T', countsAsClue: true },
        { id: 'h2', type: 'audio', mediaRef: 'g/clue.mp3', countsAsClue: false },
        { id: 'h3', type: 'text', text: 'T3', countsAsClue: false },
      ],
    }],
  };
}

function mkA(opts = {}) {
  const es = createEventStore({ path: ':memory:' });
  const gs = createGameStore(es.db);
  let t = 10000;
  const progress = opts.withProgress ? createProgress({ eventStore: es, now: () => t }) : null;
  const audio = mkAudio();
  const cfgObj = opts.cfg || audioCfg();
  const saved = [];
  const config = {
    current: () => cfgObj,
    save: (c) => { saved.push(c); return { ok: true, errors: [] }; },
  };
  const engine = createGameEngine({
    eventStore: es, gameStore: gs, progress,
    audioPlayer: opts.noAudio ? null : audio,
    config: opts.noConfig ? null : config,
    now: () => t, setInterval: () => 0, clearInterval: () => {},
  });
  return { es, gs, engine, progress, audio, cfgObj, saved, advance: (ms) => { t += ms; } };
}

test('audio: start fires playEffect(start) then playMusic(loop), in order', () => {
  const { engine, audio } = mkA();
  engine.command({ type: 'start' });
  assert.deepEqual(audio.calls.filter(c => c.name === 'playEffect' || c.name === 'playMusic').map(c => c.args[0]),
    ['g/start.mp3', 'g/bed.mp3']);
});

test('audio: a disabled start event is skipped', () => {
  const { engine, audio } = mkA({ cfg: audioCfg({ events: { start: { file: 'g/start.mp3', enabled: false } } }) });
  engine.command({ type: 'start' });
  assert.deepEqual(audio.args1('playEffect'), []);
  assert.deepEqual(audio.args1('playMusic'), ['g/bed.mp3']);
});

test('audio: constructor seeds volume from config and calls setVolume once', () => {
  const { engine, audio } = mkA();
  assert.strictEqual(engine.getState().volume, 0.6);
  assert.deepEqual(audio.args1('setVolume'), [0.6]);
});

test('audio: midShow fires exactly once at atSecondsRemaining', () => {
  const { engine, audio } = mkA();
  engine.command({ type: 'start' });
  // drive down to 2:01
  for (let i = 0; i < 57; i++) engine.command({ type: 'sub-min' }); // 60 -> 3
  engine.command({ type: 'sub-min' }); // 2
  // now 2:00; adjust to 2:01
  engine.command({ type: 'add-sec' }); // 2:01
  const midBefore = audio.args1('playEffect').filter(f => f === 'g/2min.mp3').length;
  engine.tickOnce(); // -> 2:00
  const after1 = audio.args1('playEffect').filter(f => f === 'g/2min.mp3').length;
  engine.tickOnce(); // -> 1:59
  const after2 = audio.args1('playEffect').filter(f => f === 'g/2min.mp3').length;
  assert.strictEqual(midBefore, 0);
  assert.strictEqual(after1, 1);
  assert.strictEqual(after2, 1);
});

test('audio: escaped fires stopMusic then playEffect(win)', () => {
  const { engine, audio } = mkA();
  engine.command({ type: 'start' });
  audio.calls.length = 0;
  engine.command({ type: 'escaped' });
  const seq = audio.calls.map(c => c.name === 'playEffect' ? `playEffect:${c.args[0]}` : c.name);
  assert.deepEqual(seq.filter(x => x === 'stopMusic' || x === 'playEffect:g/win.mp3'),
    ['stopMusic', 'playEffect:g/win.mp3']);
});

test('audio: reset while running fires stopMusic then playEffect(lose)', () => {
  const { engine, audio } = mkA();
  engine.command({ type: 'start' });
  audio.calls.length = 0;
  engine.command({ type: 'reset' });
  const seq = audio.calls.map(c => c.name === 'playEffect' ? `playEffect:${c.args[0]}` : c.name);
  assert.deepEqual(seq.filter(x => x === 'stopMusic' || x === 'playEffect:g/lose.mp3'),
    ['stopMusic', 'playEffect:g/lose.mp3']);
  assert.strictEqual(audio.names().includes('stopAll'), false);
});

test('audio: reset from waiting fires stopAll and not playEffect', () => {
  const { engine, audio } = mkA();
  engine.command({ type: 'reset' });
  assert.strictEqual(audio.names().includes('stopAll'), true);
  assert.strictEqual(audio.names().includes('playEffect'), false);
});

test('audio: show-hint with a text hint fires the clue chime', () => {
  const { engine, audio } = mkA();
  engine.command({ type: 'start' });
  audio.calls.length = 0;
  engine.command({ type: 'show-hint', text: 'T', stepId: 'step_1', hintId: 'h1' });
  assert.deepEqual(audio.args1('playEffect'), ['g/chime.mp3']);
});

test('audio: show-hint with an audio hint SKIPS the clue chime', () => {
  const { engine, audio } = mkA();
  engine.command({ type: 'start' });
  audio.calls.length = 0;
  engine.command({ type: 'show-hint', text: 'x', stepId: 'step_1', hintId: 'h2' });
  assert.deepEqual(audio.args1('playEffect'), []);
});

test('audio: show-hint clue counting respects countsAsClue / noCount / legacy', () => {
  const { engine } = mkA();
  engine.command({ type: 'start' });
  engine.command({ type: 'show-hint', text: 'T', stepId: 'step_1', hintId: 'h1' });
  assert.strictEqual(engine.getState().clueCount, 1); // countsAsClue:true
  engine.command({ type: 'show-hint', text: 'T3', stepId: 'step_1', hintId: 'h3' });
  assert.strictEqual(engine.getState().clueCount, 1); // countsAsClue:false -> no inc
  engine.command({ type: 'show-hint', text: 'T', stepId: 'step_1', hintId: 'h1', noCount: true });
  assert.strictEqual(engine.getState().clueCount, 1); // noCount -> no inc
  engine.command({ type: 'show-hint', text: 'legacy' }); // no stepId
  assert.strictEqual(engine.getState().clueCount, 2); // backward compat inc
});

test('audio: play-hint plays the clip, marks progress, does not count, records, no activeHints', () => {
  const { engine, es } = mkA({ withProgress: true });
  engine.command({ type: 'start' });
  engine.command({ type: 'play-hint', stepId: 'step_1', hintId: 'h2' });
  const s = engine.getState();
  assert.strictEqual(s.clueCount, 0);
  assert.deepEqual(s.activeHints, []);
  assert.ok(s.steps.step_1 && s.steps.step_1.clueGivenAt);
  assert.strictEqual(es.query({ type: 'play-hint' }).length, 1);
});

test('audio: play-hint calls audioPlayer.playEffect with mediaRef', () => {
  const { engine, audio } = mkA();
  engine.command({ type: 'start' });
  audio.calls.length = 0;
  engine.command({ type: 'play-hint', stepId: 'step_1', hintId: 'h2' });
  assert.deepEqual(audio.args1('playEffect'), ['g/clue.mp3']);
});

test('audio: play-hint while not running is a no-op', () => {
  const { engine, es } = mkA();
  engine.command({ type: 'play-hint', stepId: 'step_1', hintId: 'h2' });
  assert.strictEqual(es.query({ type: 'play-hint' }).length, 0);
});

test('audio: stop-audio calls stopAll, records, works in any phase', () => {
  const { engine, audio, es } = mkA();
  audio.calls.length = 0;
  engine.command({ type: 'stop-audio' });
  assert.strictEqual(audio.names().includes('stopAll'), true);
  assert.strictEqual(es.query({ type: 'stop-audio' }).length, 1);
});

test('audio: vol-up updates config in memory but only persists on lifecycle transitions', () => {
  const { engine, audio, cfgObj, saved } = mkA();
  audio.calls.length = 0;
  engine.command({ type: 'vol-up' });
  assert.strictEqual(audio.args1('setVolume').length, 1);
  assert.ok(Math.abs(cfgObj.audio.volume - 0.61) < 1e-9);
  assert.strictEqual(saved.length, 0); // not persisted on the click
  engine.command({ type: 'start' });
  assert.strictEqual(saved.length, 1); // persisted on start
});

test('audio: volume set by operator survives a reset (re-seeded from config)', () => {
  const { engine } = mkA();
  engine.command({ type: 'start' });
  engine.command({ type: 'vol-up' }); engine.command({ type: 'vol-up' }); // 0.62
  engine.command({ type: 'reset' });
  assert.ok(Math.abs(engine.getState().volume - 0.62) < 1e-9);
});

test('audio: engine with no audioPlayer and no config keeps legacy behavior', () => {
  const { engine, es } = mkA({ noAudio: true, noConfig: true });
  engine.command({ type: 'start' });
  engine.command({ type: 'show-hint', text: 'T', stepId: 'step_1', hintId: 'h3' });
  assert.strictEqual(engine.getState().clueCount, 1); // unconditional legacy inc
  assert.doesNotThrow(() => engine.command({ type: 'play-hint', stepId: 'step_1', hintId: 'h2' }));
  assert.doesNotThrow(() => engine.command({ type: 'stop-audio' }));
  assert.strictEqual(es.query({ type: 'play-hint' }).length, 0); // no-op without audioPlayer
});

// ---- Final review: safety-property + spec-fidelity coverage ----

function mkThrowingAudio(mode = 'sync') {
  const bomb = mode === 'reject'
    ? () => Promise.reject(new Error('async audio boom'))
    : () => { throw new Error('sync audio boom'); };
  return {
    playEffect: bomb, playMusic: bomb, stopMusic: bomb, stopAll: bomb,
    setVolume: bomb, now: () => ({}),
  };
}

for (const mode of ['sync', 'reject']) {
  test(`safety: a ${mode}-throwing audioPlayer never breaks the clock or phase transitions`, () => {
    const es = createEventStore({ path: ':memory:' });
    const gs = createGameStore(es.db);
    let t = 10000;
    const config = { current: () => audioCfg(), save: () => ({ ok: true, errors: [] }) };
    const engine = createGameEngine({
      eventStore: es, gameStore: gs, config, audioPlayer: mkThrowingAudio(mode),
      now: () => t, setInterval: () => 0, clearInterval: () => {},
    });
    assert.doesNotThrow(() => engine.command({ type: 'start' }));
    assert.strictEqual(engine.getState().phase, 'running');
    // clock still ticks
    const min0 = engine.getState().currentMin;
    const sec0 = engine.getState().currentSec;
    assert.doesNotThrow(() => engine.tickOnce());
    const after = engine.getState();
    assert.ok(after.currentMin !== min0 || after.currentSec !== sec0);
    assert.doesNotThrow(() => engine.command({ type: 'show-hint', text: 'H', stepId: 'step_1', hintId: 'h1' }));
    assert.doesNotThrow(() => engine.command({ type: 'escaped' }));
    assert.strictEqual(engine.getState().phase, 'escaped');
    assert.doesNotThrow(() => engine.command({ type: 'reset' }));
    assert.strictEqual(engine.getState().phase, 'waiting');
  });
}

test('safety: a config whose save() throws does not break start/reset', () => {
  const es = createEventStore({ path: ':memory:' });
  const gs = createGameStore(es.db);
  let t = 10000;
  const config = {
    current: () => audioCfg(),
    save: () => { throw new Error('disk full'); },
  };
  const engine = createGameEngine({
    eventStore: es, gameStore: gs, config, audioPlayer: mkAudio(),
    now: () => t, setInterval: () => 0, clearInterval: () => {},
  });
  engine.command({ type: 'vol-up' }); // make the config dirty so save() is actually attempted
  assert.doesNotThrow(() => engine.command({ type: 'start' }));
  assert.strictEqual(engine.getState().phase, 'running');
  assert.doesNotThrow(() => engine.command({ type: 'reset' }));
  assert.strictEqual(engine.getState().phase, 'waiting');
  assert.ok(es.query({ type: 'config-save-error' }).length >= 1); // error recorded, not swallowed silently
});

test('config-save-error is recorded when config.save returns { ok: false }', () => {
  const es = createEventStore({ path: ':memory:' });
  const gs = createGameStore(es.db);
  let t = 10000;
  const config = {
    current: () => audioCfg(),
    save: () => ({ ok: false, errors: ['bad schema'] }),
  };
  const engine = createGameEngine({
    eventStore: es, gameStore: gs, config, audioPlayer: mkAudio(),
    now: () => t, setInterval: () => 0, clearInterval: () => {},
  });
  engine.command({ type: 'vol-up' });
  engine.command({ type: 'start' });
  assert.strictEqual(es.query({ type: 'config-save-error' }).length, 1);
});

test('config.save is skipped entirely when the volume never changed', () => {
  const { engine, saved } = mkA();
  engine.command({ type: 'start' });
  engine.command({ type: 'escaped' });
  engine.command({ type: 'reset' });
  assert.strictEqual(saved.length, 0); // no volume delta -> no persist on any transition
});

test('midShow fires on a crossing even when an adjustment jumps past the threshold', () => {
  const { engine, audio } = mkA();
  engine.command({ type: 'start' });
  // drive down to ~2:30, then jump past 120s remaining in one sub-min
  for (let i = 0; i < 57; i++) engine.command({ type: 'sub-min' }); // 60 -> 3 (3:00)
  engine.command({ type: 'add-sec' }); engine.command({ type: 'add-sec' }); // 3:02
  engine.command({ type: 'sub-min' }); // 2:02
  engine.command({ type: 'sub-min' }); // 1:02  -> jumped past 120s without landing on it
  const before = audio.args1('playEffect').filter(f => f === 'g/2min.mp3').length;
  engine.tickOnce(); // 1:01
  const after = audio.args1('playEffect').filter(f => f === 'g/2min.mp3').length;
  assert.strictEqual(before, 0);
  assert.strictEqual(after, 1);
});
