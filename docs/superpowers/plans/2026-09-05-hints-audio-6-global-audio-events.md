# Hints & Audio Sub-milestone 6: Global Audio Events — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire `game-engine`'s existing transitions to the server-side `audioPlayer` (sub-milestone 3) so start/loop/midShow/win/lose/idle beds and the clue chime fire automatically; give the deferred `play-hint`/`stop-audio` commands (from sub-milestones 4/5) their real handlers; make hint clue-counting respect `countsAsClue` and a Ctrl-click "silent clue"; route `vol-up`/`vol-down` through `audioPlayer.setVolume` with `config.audio.volume` persistence and restore-on-boot; and strip the now-redundant browser audio from `game.js`/`game.html`.

**Architecture:** `game-engine` gains two new OPTIONAL injected deps, `audioPlayer` and `config`, following the exact `sheets = null` / `progress = null` pattern already established (sub-milestones 4). Every `audioPlayer` call is best-effort — wrapped so a rejected promise or synchronous throw never blocks the clock, identical to the existing `safeSheets()` helper. `config` is used read-only for `config.current().audio.events` / `.audio.volume` / `.steps`, and write via `config.save(config.current())` on coarse lifecycle transitions only (never per volume click — see Global Constraints). `game.html` becomes purely visual: the `<audio>` elements and `makeAudio`/`handleAudio`/`playTimerMusic`/`playFinaleMusic`/`playClueSound` code in `game.js` are deleted.

**Tech Stack:** No new dependency. `audioPlayer` is the already-shipped `src/audio-player.js` (`playEffect`/`playMusic`/`stopMusic`/`stopAll`/`setVolume`/`now`). `config` is the already-shipped `src/config.js` (`load`/`save`/`current`).

**Spec:** `docs/superpowers/specs/2026-08-30-hints-and-audio-design.md`, §6 (Global audio events) — the binding section — plus §4.3 (`setVolume` "Persisted to `config.audio.volume`; restored on boot"), §7.2 (Ctrl-click silent clue, `countsAsClue`), §7.4 (`play-hint`/`stop-audio` command semantics). This is build-order item 6 from §11.

## Global Constraints

- No new npm dependency.
- `audioPlayer` and `config` are OPTIONAL `game-engine` deps (default `null`), same pattern as `sheets`/`progress`. Every unit test for pre-existing behavior that omits them must keep passing unchanged. When `audioPlayer` is absent, all audio-event code paths are skipped silently; when `config` is absent, `config`-dependent logic (event lookup, `countsAsClue` lookup, volume persistence) degrades to its pre-sub-milestone-6 behavior (no audio events, unconditional `clueCount++` as today).
- Every `audioPlayer.*` call is wrapped so a synchronous throw OR a rejected promise is swallowed and never blocks the game clock — reuse/extend the existing `safeSheets()`-style guard already in `game-engine.js` (e.g. a `safeAudio(fn)` helper with the same shape).
- **Volume persistence is coarse, not per-click** (ruling, decided here since spec §6's "persist `config.audio.volume`" doesn't specify frequency and per-click `config.save()` would spam the append-only `config_history` table with dozens of rows per game): on every `vol-up`/`vol-down`, update `config.current().audio.volume` IN MEMORY immediately (cheap, no I/O) and call `audioPlayer.setVolume(newVol)`; call `config.save(config.current())` to persist to disk ONLY on the coarse lifecycle transitions `start`, `escaped`, and `reset` (so the operator's last-set level survives a restart without a write per keystroke). Cost if wrong: a crash between the last volume change and the next lifecycle transition loses that volume delta on the next boot — a minor, self-correcting UX nit, not data loss.
- **Volume restore on boot:** when `config` is provided, `game-engine`'s constructor seeds its initial `s.volume` from `config.current().audio?.volume` (falling back to the current `0.4` default when absent/invalid) and calls `audioPlayer.setVolume(that)` once at construction (guarded). `blankState()` currently hardcodes `volume: 0.4` — after a `reset` re-seed `s.volume` from `config.current().audio?.volume` so the operator's setting isn't silently reset to 40% between games (the existing `reset` handler does `s = blankState()`; add the re-seed right after).
- **`config.audio.events` shape** (from spec §2.1, already validated by `config-schema.js` sub-milestone 1): `events.<name> = { file: string, enabled: bool }`, and `events.midShow` additionally `{ atSecondsRemaining: number }`. Event names: `start`, `loop`, `midShow`, `win`, `lose`, `clueChime`. A file path is relative to `media/` (the same `mediaRef` convention `audioPlayer.playEffect`/`playMusic` already resolve). An event with `enabled:false` or a missing/empty `file` is skipped.
- **The audio-transition table (spec §6), implemented exactly:**
  | Transition | Action |
  |---|---|
  | `start`/`force-start` accepted | `playEffect(events.start.file)` if enabled, then `playMusic(events.loop.file)` if enabled |
  | timer tick reaches `events.midShow.atSecondsRemaining` seconds remaining, once per game | `playEffect(events.midShow.file)` if enabled |
  | `escaped` (win) | `stopMusic()`, then `playEffect(events.win.file)` if enabled |
  | `reset` while `phase === 'running'` (lose) | `stopMusic()`, then `playEffect(events.lose.file)` if enabled |
  | `reset` to waiting when NOT running (idle) | `stopAll()` |
  | `show-hint` accepted | `playEffect(events.clueChime.file)` if enabled — **SKIPPED when the shown hint is `type:'audio'`** (its own clip is the sound) |
  | `vol-up` / `vol-down` | `audioPlayer.setVolume(newVol)` + in-memory `config.audio.volume` update (persist per the coarse rule above) |
- **`play-hint` command** (`{ type:'play-hint', stepId, hintId, noCount? }`) — only while a game is active (`s.phase === 'running'`, matching `solve-step`/`set-flag`'s guard). Look up the hint in `config.current().steps` by `stepId` + `hintId`; if found and it has a `mediaRef`: `audioPlayer.playEffect(hint.mediaRef)` (guarded), `progress.markGiven(stepId)` (guarded, if `progress` present), and increment `s.clueCount` UNLESS `hint.countsAsClue === false` OR `msg.noCount === true`. Record an `operator`-sourced event (`record('play-hint', { subject: stepId, value: hintId, _source })`). Emit. Nothing renders on the game screen (no `activeHints` change).
- **`stop-audio` command** (`{ type:'stop-audio' }`) — `audioPlayer.stopAll()` (guarded), record `record('stop-audio', { _source })`, emit. Allowed in any phase (an operator may need to kill a stuck bed).
- **`show-hint` clue-counting change:** `show-hint` currently does `s.clueCount++` unconditionally. New behavior: when `config` is present AND `msg.stepId`/`msg.hintId` resolve to a hint in `config.current().steps`, increment `s.clueCount` only if that hint's `countsAsClue !== false` AND `msg.noCount !== true`. When `config` is absent OR the hint can't be resolved (e.g. a legacy flat `show-hint` with only `text`), keep the current unconditional `clueCount++` (backward compatible). The `progress.markGiven(msg.stepId)` call added in sub-milestone 4 is unchanged.
- **`game.js`/`game.html` browser-audio removal:** delete the three `<audio>` elements from `game.html` (`#timer-music`, `#finale-music`, `#clue-audio`); in `game.js` delete `makeAudio`, the `timerMusic`/`finaleMusic`/`clueSound` consts, `timerMusic.loop = true`, the `handleAudio(before, after)` function and its call site in `paint()`/the state handler, and the audio-volume lines inside `applyVolume` (keep `applyVolume`'s `volumeBarEl` text update — the on-screen "Vol: N%" display stays, it's just no longer driving any `<audio>.volume`). The `setup-pi.sh` "Audio assets needed in public/assets/" reminder for `TimerMusic.mp3`/`FinaleMusic.mp3`/`ClueSound.mp3` becomes stale — update that echo block to point at the `media/` dir + config Audio Events instead (do not delete `public/assets/` itself or its `.gitkeep`).

---

### Task 1: `game-engine.js` — audio-event wiring, `play-hint`/`stop-audio`, `countsAsClue`, volume routing

**Files:**
- Modify: `src/game-engine.js`
- Test: `test/game-engine.test.js` (extend — match its existing `mk()` fixture style; you'll add `audioPlayer` and `config` params to it)

**Interfaces:**
- Consumes: `src/audio-player.js`'s `createAudioPlayer(...)` return shape (`{ playEffect, playMusic, stopMusic, stopAll, setVolume, now }`) — but tests inject a FAKE recording each call, never the real module. `src/config.js`'s `{ current, save }` — tests inject a fake `{ current: () => fakeCfg, save: (c) => { saved = c } }`.
- Produces: `createGameEngine(deps)` accepts optional `audioPlayer = null` and `config = null`. New command types `play-hint` and `stop-audio` handled in `command(msg)`. No change to `getState()`'s shape. No new exported function.

- [ ] **Step 1: Read `src/game-engine.js` in full** — re-confirm current line context for: the destructured `deps` block (add `audioPlayer = null, config = null`), the `safeSheets` helper (model `safeAudio` on it), `blankState()` (the `volume: 0.4` literal), the constructor body after `let s = blankState()` (add volume restore), `tickOnce()` (add the midShow check), and each command branch that needs an audio call (`start`/`force-start`, `escaped`, `reset`, `show-hint`, `vol-up`/`vol-down`) plus where to add the two new branches (`play-hint`/`stop-audio`, near `solve-step`/`set-flag`).

- [ ] **Step 2: Write the failing tests**

Extend `test/game-engine.test.js`'s `mk()` to optionally build a fake `audioPlayer` (recording every call name + args into an array) and a fake `config` (returning a supplied config object from `current()`, recording `save()` calls). Then add tests covering — at minimum — every row of the audio-transition table plus the new commands:

```js
function mkAudio() {
  const calls = [];
  const rec = (name) => (...args) => { calls.push({ name, args }); };
  return { calls, playEffect: rec('playEffect'), playMusic: rec('playMusic'),
    stopMusic: rec('stopMusic'), stopAll: rec('stopAll'), setVolume: rec('setVolume'), now: () => ({}) };
}

const AUDIO_CFG = {
  audio: { volume: 0.6, events: {
    start:     { file: 'g/start.mp3', enabled: true },
    loop:      { file: 'g/bed.mp3',   enabled: true },
    midShow:   { file: 'g/2min.mp3',  enabled: true, atSecondsRemaining: 120 },
    win:       { file: 'g/win.mp3',   enabled: true },
    lose:      { file: 'g/lose.mp3',  enabled: true },
    clueChime: { file: 'g/chime.mp3', enabled: true },
  }},
  steps: [{ id: 'step_1', name: 'S1', hints: [
    { id: 'h1', type: 'text',  text: 'T', countsAsClue: true },
    { id: 'h2', type: 'audio', mediaRef: 'g/clue.mp3', countsAsClue: false },
    { id: 'h3', type: 'text',  text: 'T3', countsAsClue: false },
  ]}],
};
```

- `start` fires `playEffect('g/start.mp3')` then `playMusic('g/bed.mp3')`, in that order; a disabled event (set `enabled:false`) is skipped.
- constructor with `config` seeds `s.volume` from `config.audio.volume` (0.6, not 0.4) and calls `audioPlayer.setVolume(0.6)` once at construction.
- `tickOnce` fires `playEffect('g/2min.mp3')` exactly once when seconds-remaining hits 120 (drive the clock down to 2:01 → tick → 2:00; assert one call; tick again → 1:59; assert still one call).
- `escaped` fires `stopMusic()` then `playEffect('g/win.mp3')`.
- `reset` while `phase==='running'` fires `stopMusic()` then `playEffect('g/lose.mp3')`; `reset` from `waiting` fires `stopAll()` (and NOT `playEffect`).
- `show-hint` with a `stepId`/`hintId` resolving to a `type:'text'` hint fires `playEffect('g/chime.mp3')`; with a `type:'audio'` hint, the chime is SKIPPED.
- `show-hint` clue-counting: `h1` (`countsAsClue:true`) increments `clueCount`; `h3` (`countsAsClue:false`) does NOT; `{ ..., noCount:true }` on `h1` does NOT; a legacy `show-hint` with only `text` (no `stepId`) still increments (backward compat).
- `play-hint` with `h2` (audio, `countsAsClue:false`): calls `audioPlayer.playEffect('g/clue.mp3')`, calls `progress.markGiven('step_1')` if `progress` wired, does NOT increment `clueCount`, records a `play-hint` event, does NOT add to `activeHints`. `play-hint` while not running is a no-op.
- `stop-audio` calls `audioPlayer.stopAll()`, records a `stop-audio` event, works in any phase.
- `vol-up` calls `audioPlayer.setVolume(newVol)` and updates `config.current().audio.volume` in memory; `config.save` is NOT called on the `vol-up` itself but IS called on the next `start`/`escaped`/`reset`.
- **Regression:** an engine built with NO `audioPlayer` and NO `config` (the existing default `mk()`) still passes every pre-existing test, and `play-hint`/`stop-audio` are still safe no-ops (the sub-milestone-5 regression test) — now they DO something only when `audioPlayer` is present.

- [ ] **Step 3: Run to verify failure**

Run: `node --test test/game-engine.test.js`
Expected: FAIL on the new tests, PASS on all pre-existing ones.

- [ ] **Step 4: Implement in `src/game-engine.js`**

- Add `audioPlayer = null, config = null` to the destructured `deps`.
- Add a `safeAudio(fn)` helper mirroring `safeSheets`: `try { const p = fn(); if (p && typeof p.then === 'function') p.catch(() => {}); } catch {}`.
- Add a helper `audioEvents()` → `(config && config.current().audio && config.current().audio.events) || {}` and `findHint(stepId, hintId)` → walk `config.current().steps` (guard for missing `config`/`steps`).
- Constructor, after `let s = blankState()`: `if (config) { const v = Number(config.current().audio && config.current().audio.volume); if (Number.isFinite(v)) s.volume = Math.max(0, Math.min(1, v)); } if (audioPlayer) safeAudio(() => audioPlayer.setVolume(s.volume));`
- In the `start`/`force-start` success block, after `emit()`-adjacent audio-safe point (order: after the game is fully started): `const ev = audioEvents(); if (audioPlayer) { if (ev.start && ev.start.enabled && ev.start.file) safeAudio(() => audioPlayer.playEffect(ev.start.file)); if (ev.loop && ev.loop.enabled && ev.loop.file) safeAudio(() => audioPlayer.playMusic(ev.loop.file)); } if (config) safeConfigSave();` — where `safeConfigSave()` is `try { config.save(config.current()); } catch {}`.
- In `tickOnce()`, after the countdown math and before/after `emit()`: track a per-game `midShowFired` boolean (reset it to `false` on each `start` and `reset`). When `!s.clockForward` and `(s.currentMin * 60 + s.currentSec) === ev.midShow.atSecondsRemaining` and `ev.midShow.enabled` and `ev.midShow.file` and `!midShowFired`: `safeAudio(() => audioPlayer.playEffect(ev.midShow.file)); midShowFired = true;`
- `escaped` block: after setting `s.phase = 'escaped'` etc.: `if (audioPlayer) { safeAudio(() => audioPlayer.stopMusic()); if (ev.win && ev.win.enabled && ev.win.file) safeAudio(() => audioPlayer.playEffect(ev.win.file)); } if (config) safeConfigSave();`
- `reset` block: BEFORE `s = blankState()` capture `const wasRunning = s.phase === 'running';`. After the existing session-finalize logic: `if (audioPlayer) { if (wasRunning) { safeAudio(() => audioPlayer.stopMusic()); if (ev.lose && ev.lose.enabled && ev.lose.file) safeAudio(() => audioPlayer.playEffect(ev.lose.file)); } else { safeAudio(() => audioPlayer.stopAll()); } }` Then after `s = blankState()`: re-seed `s.volume` from `config` as in the constructor, and `midShowFired = false`. Then `if (config) safeConfigSave();`
- `show-hint` block: after the existing `st.applyHint`/`activeHints`/`progress.markGiven` logic, REPLACE the unconditional `s.clueCount++` with: `const hint = findHint(msg.stepId, msg.hintId); const counts = hint ? (hint.countsAsClue !== false) : true; if (counts && msg.noCount !== true) s.clueCount++;` — then, for the chime: `if (audioPlayer && (!hint || hint.type !== 'audio') && ev.clueChime && ev.clueChime.enabled && ev.clueChime.file) safeAudio(() => audioPlayer.playEffect(ev.clueChime.file));`
- `vol-up`/`vol-down` block: after `s.volume = Math.max(0, Math.min(1, s.volume + delta))`: `if (audioPlayer) safeAudio(() => audioPlayer.setVolume(s.volume)); if (config && config.current().audio) config.current().audio.volume = s.volume;` (do NOT call `config.save` here).
- New `play-hint` branch (near `solve-step`): `if (type === 'play-hint') { if (s.phase !== 'running') return; const hint = findHint(msg.stepId, msg.hintId); if (hint && hint.mediaRef && audioPlayer) safeAudio(() => audioPlayer.playEffect(hint.mediaRef)); if (progress && msg.stepId) { try { progress.markGiven(msg.stepId); } catch {} } const counts = hint ? (hint.countsAsClue !== false) : true; if (counts && msg.noCount !== true) s.clueCount++; record('play-hint', { subject: msg.stepId, value: msg.hintId, _source: msg._source }); emit(); return; }`
- New `stop-audio` branch: `if (type === 'stop-audio') { if (audioPlayer) safeAudio(() => audioPlayer.stopAll()); record('stop-audio', { _source: msg._source }); emit(); return; }`

- [ ] **Step 5: Run tests, fix, verify pass**

Run: `node --test test/game-engine.test.js`
Expected: PASS — all pre-existing tests plus the new ones.

- [ ] **Step 6: Run the whole suite**

Run: `node --test "test/**/*.test.js"`
Expected: PASS, no regressions.

- [ ] **Step 7: Commit**

```bash
git add src/game-engine.js test/game-engine.test.js
git commit -m "feat(audio): wire game-engine transitions to audioPlayer, add play-hint/stop-audio, countsAsClue"
```

---

### Task 2: `server.js` wiring

**Files:**
- Modify: `server.js`

**Interfaces:**
- Consumes: the `audioPlayer` instance already constructed in `server.js` (sub-milestone 3) and the `config` module instance already constructed there (sub-milestone 1).
- Produces: `createGameEngine({...})`'s call in `server.js` now also passes `audioPlayer` and `config`.

- [ ] **Step 1: Read `server.js`** — confirm `audioPlayer` and `config` are both in scope at the `createGameEngine({...})` call (they are — `config` is used for the startup validate, `audioPlayer` was added in sub-milestone 3). Add both to the deps object.

- [ ] **Step 2: Add them to the call**

```js
const engine = createGameEngine({
  eventStore, gameStore, sheets, signalBus, progress, audioPlayer, config,
  roomName: cfg.roomName || '',
});
```

(Match the actual current argument list — `progress` was added in sub-milestone 4; keep whatever's there and add `audioPlayer, config`.)

- [ ] **Step 3: Run the whole suite**

Run: `node --test "test/**/*.test.js"`
Expected: PASS, no regressions. (`server.js`'s wiring has no automated test seam — the integration smoke test builds its own module graph — so also do `node -c server.js` for a syntax check and note in the report that this wiring is syntax-checked + covered only indirectly.)

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(audio): pass audioPlayer + config into game-engine in server.js"
```

---

### Task 3: Strip browser audio from `game.js`/`game.html`, update `setup-pi.sh` reminder, wire Ctrl-click silent-clue in `operator.js`

**Files:**
- Modify: `public/game.js`
- Modify: `public/game.html`
- Modify: `scripts/setup-pi.sh`
- Modify: `public/operator.js`
- Test: `test/game-render.test.js` (check whether any assertion referenced audio — likely not, since `renderModel` is display-only; if a test breaks, it's a real signal)

**Interfaces:**
- Consumes: nothing new.
- Produces: `game.html` has no `<audio>` elements; `game.js` has no `Audio`/`makeAudio`/`handleAudio`/`playTimerMusic`/`playFinaleMusic`/`playClueSound`; `operator.js`'s board click handler sends `noCount: true` on a Ctrl/Cmd-click of a hint pad.

- [ ] **Step 1: Read `public/game.js` and `public/game.html` in full** — locate every audio reference (the earlier grep found: `game.js:49-58` the audio setup block, `game.js:103-116` `handleAudio`, `game.js:149` the `handleAudio(prev, s)` call, `game.html:44-46` the three `<audio>` tags). Also read `public/operator.js`'s board `#board-root` click delegate (from sub-milestone 5) to find where a `show-hint`/`play-hint` command is built.

- [ ] **Step 2: Delete the browser audio from `game.js`**

Remove: the `makeAudio` function, `timerMusic`/`finaleMusic`/`clueSound` consts, `timerMusic.loop = true`, the entire `handleAudio(before, after)` function, and its call site (the `handleAudio(prev, s)` line in `paint()`/the state handler). In `applyVolume`, remove the line `timerMusic.volume = finaleMusic.volume = clueSound.volume = vol;` but KEEP the function and its `volumeBarEl` text update (the on-screen volume % display stays). Verify no other code references the removed names (grep after).

- [ ] **Step 3: Delete the `<audio>` elements from `game.html`**

Remove lines 44-46 (`#timer-music`, `#finale-music`, `#clue-audio`).

- [ ] **Step 4: Update `scripts/setup-pi.sh`**

Replace the "Audio assets needed in: .../public/assets/ — TimerMusic.mp3 FinaleMusic.mp3 ClueSound.mp3 / (App runs without them — audio commands are silent)" echo block with a pointer to the new model, e.g.:

```bash
echo "  Server-side game/hint audio: upload files via the Media Library page,"
echo "  then set them in Config → Audio Events (start / loop / win / lose / chime)."
```

(Do NOT touch the `mpg123`/`alsa-utils` install block added in sub-milestone 3, and do NOT delete `public/assets/.gitkeep`.)

- [ ] **Step 5: Wire Ctrl-click silent-clue in `operator.js`**

In the `#board-root` delegated click handler (sub-milestone 5), when the clicked element's action is `show-hint` or `play-hint`, and `e.ctrlKey || e.metaKey` is true, add `noCount: true` to the posted command payload (spec §7.2: "Ctrl-click → force `countsAsClue:false` for that press (silent clue)"). This is a one-line addition to the existing command-build path — do not restructure the handler.

- [ ] **Step 6: Run the whole suite**

Run: `node --test "test/**/*.test.js"`
Expected: PASS. If `test/game-render.test.js` breaks, investigate — `renderModel` should be audio-free already, so a break means something unexpected.

- [ ] **Step 7: Manual smoke check**

Run: `npm start`; open `http://localhost:4000/game.html` and confirm it loads with no console errors and no missing-`<audio>` errors; open `http://localhost:4000/operator.html`, start a game, click a text hint pad and confirm it appears on the game screen (visual only now — no browser sound expected, and no server sound either unless `media/` files + `config.audio.events` are set up, which they won't be in a fresh dev config). Report honestly whether this manual check was performed (non-interactive environments can't).

- [ ] **Step 8: Commit**

```bash
git add public/game.js public/game.html scripts/setup-pi.sh public/operator.js
git commit -m "feat(audio): strip browser audio from game screen, Ctrl-click silent clue, update setup-pi reminder"
```

---

## Self-Review Notes (for the plan author, not a task)

- **Spec coverage:** §6's full transition table is Task 1's Global Constraints table + Step 4; §6's "`game.js` stops playing audio" is Task 3; §4.3's "persist to `config.audio.volume`, restore on boot" is Task 1's coarse-persist ruling + constructor re-seed; §7.2's Ctrl-click silent clue + `countsAsClue` is Task 1 (`show-hint`/`play-hint` counting logic) + Task 3 Step 5 (the `noCount` flag from the UI); §7.4's `play-hint`/`stop-audio` semantics are Task 1's two new branches.
- **Clears the deferrals from earlier sub-milestones:** sub-milestone 3's "`setVolume` restore-on-boot needs a constructor param" (now done via the `config` dep); sub-milestone 4's Ruling A / sub-milestone 5's Ruling C (`play-hint`/`stop-audio` handling — now real); sub-milestone 5's Ruling E (`countsAsClue` / Ctrl-click silent clue — now real). Update those sub-milestones' expectations as satisfied.
- **Type/name consistency:** `audioPlayer`'s method names (`playEffect`/`playMusic`/`stopMusic`/`stopAll`/`setVolume`) are checked against `src/audio-player.js`'s actual exports; `config`'s `current`/`save` against `src/config.js`; the `config.audio.events.<name>.{file,enabled,atSecondsRemaining}` shape against `src/config-schema.js`'s validation — Task 1 Step 1 mandates reading `game-engine.js`, and the implementer should cross-check `audio-player.js`/`config.js`/`config-schema.js` too, since a name/shape mismatch here silently produces an engine that never plays anything.
- **Not in scope:** the config-page "Audio Events" editor card (that's sub-milestone 7 — until then, `config.audio.events` is populated only by hand-editing `config.json` or the one-time importer, and the migration default from sub-milestone 1 sets every event `enabled:false`, so a fresh install plays nothing until sub-milestone 7 ships the UI — this is expected and correct).
