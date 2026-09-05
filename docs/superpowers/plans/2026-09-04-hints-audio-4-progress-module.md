# Hints & Audio Sub-milestone 4: Progress Module — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-game progress state — which steps have had a hint given, which are solved, and game-level flags — recorded as first-class events (`hint-given`, `step-solved`/`step-unsolved`, `flag-set`, `progress-reset`) so the paper checklist's clue-given/solved/duration columns become queryable from the event store, and pushed into the operator's SSE `state.{steps,flags}` payload. No operator UI in this sub-milestone (that's sub-milestone 5) — this wires the mechanism only.

**Architecture:** `src/progress.js` is a standalone factory, `createProgress({ eventStore, now })`, holding only in-memory per-game state (no DB table of its own — the event store is the durable record, matching spec §5.2's "this yields exactly the paper checklist's columns... queryable via `/api/events?game_id=...`" without a new schema). `src/game-engine.js` composes it the same way it already composes `sheets`/`signalBus` — an optional injected dependency, guarded so a missing `progress` never breaks the clock (matches the existing `if (sheets) safeSheets(...)` pattern already in the file). `game-engine`'s `getState()` merges `progress.snapshot()` into the returned state object as `steps`/`flags` keys, and three `/cmd` types route to it: `show-hint` (extended, backward-compatible) calls `markGiven`, and two new types (`solve-step`, `set-flag`) call `solveStep`/`setFlag`.

**Tech Stack:** No new dependency. Pure in-memory JS + the existing `eventStore.record()` call shape.

**Spec:** `docs/superpowers/specs/2026-08-30-hints-and-audio-design.md`, §5 (Progress tracking) and its testing row in §10. This plan implements build-order item 4 from §11 ("Progress module — `src/progress.js`, game-engine composition, SSE `state.{steps,flags}`, new `/cmd` types. No operator UI yet").

## Global Constraints

- No new npm dependency; `src/progress.js` is pure in-memory state plus `eventStore.record()` calls — the exact same "wrap and record, never throw" pattern already used by `src/audio-player.js`'s `record()` helper and `src/sheets.js`'s `guard()`.
- Every recorded event carries `game_id` (spec §5.2), matching `event-store.js`'s existing `game_id` column and the `record()` helper pattern already in `game-engine.js` (`record(type, extra)` → `eventStore.record({ ts, source, type, subject, value, game_id: gameId, detail })`).
- `elapsedMs` is measured from the game's `started_ts` — `startGame(gameId, startedTs)` takes the start timestamp explicitly (the caller, `game-engine`, already has this value as its own `now()` call at game-start time — see Task 2) rather than `progress.js` inventing its own clock source.
- `clueToSolveMs` is included in a `step-solved` event's `detail` **only when** a `clueGivenAt` exists for that step (spec §5.1) — never `null`/`undefined` as a placeholder key; the field is simply absent otherwise.
- `markGiven` is idempotent after the first call per step (spec §5.1: "if `clueGivenAt` is null, set it") — a second call for an already-given step is a silent no-op (no second event).
- **Scope ruling (decided here, since neither the plan nor spec §11 item 4 resolves it and a real ambiguity exists — recorded so the final review can verify it against the spec rather than treat it as a gap):** spec §7.4 lists five new `/cmd` types (`show-hint` extended, `play-hint`, `solve-step`, `set-flag`, `stop-audio`). This sub-milestone implements only the three that have no dependency on the audio player (`show-hint`'s extension, `solve-step`, `set-flag`) — `play-hint` and `stop-audio` require `game-engine` to hold an `audioPlayer` reference, which spec §11 explicitly assigns to sub-milestone 6 ("Global audio events — game-engine transitions → `audioPlayer`"). Implementing `play-hint`/`stop-audio` here would mean either wiring `audioPlayer` into `game-engine` early (out of order versus the spec's own build sequence) or adding dead command branches with nothing to call. Deferred to sub-milestone 6's plan.
- **Scope ruling (decided here):** on the `reset` command, `game-engine` also blanks progress state immediately (rather than waiting for the next `start`) so a stale prior game's `steps`/`flags` don't linger in the SSE payload between games. Spec §5.1 only defines `startGame` firing at game start; it does not say what happens to progress state between a `reset` and the next `start`. Blanking immediately on `reset` is the safer default (matches `s = blankState()`'s own immediate-blank behavior on the same command) and costs nothing if wrong (the next `start` would have blanked it anyway) — implemented as `progress.startGame(null, now())`, which records a `progress-reset` event with `game_id: null` (acceptable: `reset`'s own `record(type, ...)` call already fires with `gameId` freshly nulled at that point in the existing code, so a `null` game_id on a reset-triggered progress-reset is consistent with the surrounding code's own convention, not a special case).

---

### Task 1: `src/progress.js`

**Files:**
- Create: `src/progress.js`
- Test: `test/progress.test.js`

**Interfaces:**
- Consumes: `eventStore.record({...})` (existing, see `src/event-store.js`).
- Produces: `createProgress({ eventStore, now = () => Date.now() }) → { startGame, markGiven, solveStep, setFlag, snapshot }`.
  - `startGame(gameId, startedTs)` — clears all step/flag state; records `{ source:'progress', type:'progress-reset', game_id: gameId }`.
  - `markGiven(stepId)` — if that step's `clueGivenAt` is currently `null`/unset, sets it to `now()` and records `{ source:'progress', type:'hint-given', subject: stepId, game_id }`; otherwise a no-op (no event, no state change).
  - `solveStep(stepId, on)` — `on === true`: sets `solvedAt = now()`, records `{ source:'progress', type:'step-solved', subject: stepId, detail: { elapsedMs, clueToSolveMs? }, game_id }` where `elapsedMs = solvedAt - startedTs` and `clueToSolveMs` is `solvedAt - clueGivenAt` ONLY when that step has a `clueGivenAt`, omitted from `detail` otherwise. `on === false`: clears `solvedAt` to `null`, records `{ source:'progress', type:'step-unsolved', subject: stepId, game_id }` (no `detail`).
  - `setFlag(name, on)` — sets/clears that flag's timestamp (`now()` when `on`, `null` when not); records `{ source:'progress', type:'flag-set', subject: name, value: on, game_id }` (note: `value` at the event's top level, matching `event-store.js`'s existing top-level `value` column — NOT nested inside `detail`).
  - `snapshot()` — `{ steps: { [stepId]: { clueGivenAt, solvedAt } }, flags: { [flagName]: tsOrNull } }`. Returns a fresh shallow-copied object each call (callers must not be able to mutate internal state by mutating the returned snapshot).

- [ ] **Step 1: Write the failing tests**

Create `test/progress.test.js`:

```js
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
  const detail = JSON.parse(events[0].detail);
  assert.equal(detail.elapsedMs, 5000); // 105000 - 100000
  assert.equal(detail.clueToSolveMs, 2000); // 105000 - 103000
});

test('solveStep(on) omits clueToSolveMs when no clue was given', () => {
  const { es, progress, advance } = mk();
  progress.startGame(1, 100000);
  advance(4000);
  progress.solveStep('step_2', true); // no markGiven call first

  const events = es.query({ type: 'step-solved' });
  const detail = JSON.parse(events[0].detail);
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
  assert.equal(events[0].value, 'true'); // event-store round-trips booleans through its encode/decode — see note below

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
```

Note: read `src/event-store.js`'s `encode`/`decode` helpers before trusting the exact `events[0].value` assertion in the `setFlag` test above — the plan's illustrative assertion (`'true'`) is a guess at how the store round-trips a boolean through its `encode()` function; verify against the real `decode`/`encode` implementation and correct the assertion to match reality (it may decode back to the boolean `true` rather than the string `'true'`, depending on `event-store.js`'s actual encode/decode logic) before treating this test as final.

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/progress.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/progress.js`**

```js
function createProgress({ eventStore, now = () => Date.now() }) {
  let gameId = null;
  let startedTs = null;
  let steps = {};
  let flags = {};

  function record(type, subject, extra = {}) {
    try {
      eventStore.record({ source: 'progress', type, subject, game_id: gameId, ...extra });
    } catch {}
  }

  function startGame(newGameId, newStartedTs) {
    gameId = newGameId;
    startedTs = newStartedTs;
    steps = {};
    flags = {};
    record('progress-reset', undefined);
  }

  function ensureStep(stepId) {
    if (!steps[stepId]) steps[stepId] = { clueGivenAt: null, solvedAt: null };
    return steps[stepId];
  }

  function markGiven(stepId) {
    const step = ensureStep(stepId);
    if (step.clueGivenAt != null) return; // idempotent no-op
    step.clueGivenAt = now();
    record('hint-given', stepId);
  }

  function solveStep(stepId, on) {
    const step = ensureStep(stepId);
    if (on) {
      const solvedAt = now();
      step.solvedAt = solvedAt;
      const detail = { elapsedMs: solvedAt - startedTs };
      if (step.clueGivenAt != null) detail.clueToSolveMs = solvedAt - step.clueGivenAt;
      record('step-solved', stepId, { detail });
    } else {
      step.solvedAt = null;
      record('step-unsolved', stepId);
    }
  }

  function setFlag(name, on) {
    flags[name] = on ? now() : null;
    record('flag-set', name, { value: on });
  }

  function snapshot() {
    const stepsCopy = {};
    for (const [id, v] of Object.entries(steps)) stepsCopy[id] = { ...v };
    return { steps: stepsCopy, flags: { ...flags } };
  }

  return { startGame, markGiven, solveStep, setFlag, snapshot };
}

module.exports = { createProgress };
```

- [ ] **Step 4: Run tests, verify pass**

Run: `node --test test/progress.test.js`
Expected: PASS, all 8 tests (after correcting the `setFlag` value-encoding assertion per Step 1's note if needed).

- [ ] **Step 5: Run the whole suite**

Run: `node --test "test/**/*.test.js"`
Expected: PASS, no regressions.

- [ ] **Step 6: Commit**

```bash
git add src/progress.js test/progress.test.js
git commit -m "feat(progress): src/progress.js (per-game step/flag state, event-sourced)"
```

---

### Task 2: `game-engine` composition — `progress` dependency, SSE snapshot, `solve-step`/`set-flag`/extended `show-hint`

**Files:**
- Modify: `src/game-engine.js`
- Modify: `server.js` (construct `progress`, pass into `createGameEngine`)
- Test: `test/game-engine.test.js` (extend the existing file — read it first to match its harness/fixture style, shown in the plan's context above)

**Interfaces:**
- Consumes: `createProgress` from Task 1 (`src/progress.js`, already implemented and committed): `{ startGame, markGiven, solveStep, setFlag, snapshot }`.
- Produces: `createGameEngine(deps)` accepts an optional new dep `progress` (defaulting to `null`, same style as the existing `sheets = null` default) — the module must not crash if `progress` is omitted (unit tests for pre-existing behavior that don't pass `progress` must keep passing unchanged). `getState()` merges `progress.snapshot()`'s `steps`/`flags` into the returned state object when `progress` is present; when absent, `steps`/`flags` are omitted entirely (not present as empty objects — a consumer checks for their presence to know whether progress tracking is active, consistent with how `sheets`/`signalBus` are each optional with no placeholder shape when absent).

- [ ] **Step 1: Read `src/game-engine.js` in full** (already summarized in this plan's context, but re-confirm against the live file before editing — line numbers may have shifted) to find: the `start`/`force-start` success block (needs a `progress.startGame(gameId, startTime)` call), the `reset` command block (needs a `progress.startGame(null, now())` call per this plan's scope ruling), the `show-hint` command block (needs the `msg.stepId` extension), `getState()` (needs the snapshot merge), and the `command(msg)` dispatch chain (needs two new `if (type === ...)` branches for `solve-step` and `set-flag`, placed consistently with the existing chain's style — e.g. near `show-hint`/`dismiss-hint`).

- [ ] **Step 2: Write the failing tests**

Read `test/game-engine.test.js`'s existing `mk()` helper (shown in this plan's context) and extend it to optionally accept a `progress` instance, e.g.:

```js
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
```

Then add tests such as:

```js
test('getState omits steps/flags when no progress module is wired', () => {
  const { engine } = mk(); // no progress
  const s = engine.getState();
  assert.equal('steps' in s, false);
  assert.equal('flags' in s, false);
});

test('starting a game calls progress.startGame with the gameId and start time', () => {
  const { engine, progress } = mk({ withProgress: true });
  engine.command({ type: 'start' });
  const s = engine.getState();
  assert.ok(s.steps);
  assert.deepEqual(s.steps, {});
  assert.deepEqual(s.flags, {});
});

test('show-hint with a stepId marks progress given, in addition to existing text-hint behavior', () => {
  const { engine, progress } = mk({ withProgress: true });
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
  const { engine } = mk({ withProgress: true });
  engine.command({ type: 'solve-step', stepId: 'step_1', on: true }); // no start
  assert.deepEqual(engine.getState(), engine.getState()); // doesn't throw
  // guarded: since progress hasn't been startGame'd, ensure no crash; exact assertion
  // depends on the implementer's chosen guard — see Step 3's guard note.
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
```

The "no game running" guard test above is intentionally under-specified — the implementer decides during Step 3 whether `solve-step`/`set-flag` require `s.phase === 'running'` (matching spec §7.4's "allowed only while a game is active") and should firm up this test's assertion to match whatever guard they implement (e.g. assert the event store recorded no `step-solved` event when called before `start`), rather than leaving it as a non-assertion.

- [ ] **Step 3: Run to verify failure**

Run: `node --test test/game-engine.test.js`
Expected: FAIL on the new tests.

- [ ] **Step 4: Implement the changes in `src/game-engine.js`**

Add `progress = null` to the destructured `deps` (alongside `sheets = null`). In `getState()`:

```js
function getState() {
  const base = { ...s, activeHints: s.activeHints.slice() };
  if (progress) {
    const snap = progress.snapshot();
    base.steps = snap.steps;
    base.flags = snap.flags;
  }
  return base;
}
```

In the `start`/`force-start` success block, after `gameId = g.id;` and before `emit()`:

```js
if (progress) { try { progress.startGame(gameId, startTime); } catch {} }
```

In the `reset` command block, after `gameId = null;` (per this plan's scope ruling):

```js
if (progress) { try { progress.startGame(null, now()); } catch {} }
```

In the existing `show-hint` block, after the existing `st.applyHint(...)`/`activeHints`/`clueCount` logic, add (guarded, and only touching progress when a `stepId` is present — preserving the old flat-hint call sites that pass only `text`):

```js
if (progress && msg.stepId) { try { progress.markGiven(msg.stepId); } catch {} }
```

Add two new command branches in the dispatch chain (placed near `show-hint`/`dismiss-hint`, matching the existing style exactly — guard/record/emit):

```js
if (type === 'solve-step') {
  if (!progress || s.phase !== 'running' || s.gameLocked) return;
  progress.solveStep(msg.stepId, !!msg.on);
  record(type, { subject: msg.stepId, value: !!msg.on, _source: msg._source });
  emit();
  return;
}
if (type === 'set-flag') {
  if (!progress || s.phase !== 'running' || s.gameLocked) return;
  progress.setFlag(msg.name, !!msg.on);
  record(type, { subject: msg.name, value: !!msg.on, _source: msg._source });
  emit();
  return;
}
```

(The exact guard condition — `s.phase !== 'running' || s.gameLocked` — mirrors the existing `pause`/`ADJ` commands' own guards in the same file; read the live file to confirm this matches the surrounding style before finalizing, per Step 1.)

- [ ] **Step 5: Run tests, fix, verify pass**

Run: `node --test test/game-engine.test.js`
Expected: PASS, all prior tests (unchanged) plus the new ones. Firm up the "no game running" test's assertion (per Step 2's note) to match the guard actually implemented.

- [ ] **Step 6: Wire `progress` into `server.js`**

Read the current `server.js` (it now also constructs `mediaLibrary` and `audioPlayer` from prior sub-milestones) and add, near where `sheets`/`signalBus` are constructed and before `createGameEngine({...})` is called:

```js
const { createProgress } = require('./src/progress');
const progress = createProgress({ eventStore });
```

Add `progress` to the `createGameEngine({...})` call's argument object (alongside `eventStore, gameStore, sheets, signalBus, roomName`).

- [ ] **Step 7: Run the whole suite**

Run: `node --test "test/**/*.test.js"`
Expected: PASS, no regressions.

- [ ] **Step 8: Commit**

```bash
git add src/game-engine.js server.js test/game-engine.test.js
git commit -m "feat(progress): compose progress into game-engine, SSE state.{steps,flags}, solve-step/set-flag commands"
```

---

## Self-Review Notes (for the plan author, not a task)

- **Spec coverage:** §5.1's full API (`startGame`, `markGiven`, `solveStep`, `setFlag`, `snapshot`) is Task 1 verbatim; §5.2's event shapes (`progress-reset`, `hint-given`, `step-solved`/`step-unsolved` with `elapsedMs`/`clueToSolveMs`, `flag-set`) are Task 1's `record()` calls; §7.4's `solve-step`/`set-flag`/extended-`show-hint` command types are Task 2; §10's `progress` test row (startGame clears; markGiven first-only; solveStep on/off with elapsedMs+clueToSolveMs; snapshot shape) is Task 1's tests. §10's "section-complete derivation from snapshot" is explicitly a UI-layer concern per spec §5.1 ("Section completion is derived by the UI... Not stored") — correctly out of scope for this plan (belongs to sub-milestone 5's `renderBoard`).
- **Explicitly deferred, not forgotten:** `play-hint`/`stop-audio` commands (sub-milestone 6, needs `audioPlayer` composed into `game-engine`); the operator board's actual rendering of `state.steps`/`state.flags` (sub-milestone 5); `config.progress.flags[]`-driven flag list (this sub-milestone's `set-flag` command works with any flag name string sent by a caller — sub-milestone 5's UI is what will constrain callers to only send names from `config.progress.flags`).
- **Type/name consistency check:** `progress.js`'s method names (`startGame`, `markGiven`, `solveStep`, `setFlag`, `snapshot`) match spec §5.1 verbatim, and the `game-engine`'s new command type names (`solve-step`, `set-flag`) match spec §7.4's table verbatim — checked directly against the spec text, not just this plan's internal consistency, since sub-milestone 5's operator board will call these exact command names later.
