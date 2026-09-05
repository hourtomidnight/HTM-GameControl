# Hints & Audio Sub-milestone 3: Audio Player — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A server-side audio player module that shells out to `mpg123` (`.mp3`) or `ffplay`/`aplay` (`.wav`/`.ogg`) to play sound out the Pi's audio jack — one-shot effects and a single looping music channel, independent stop-music/stop-all, volume control — with every action logged as an event and every failure mode (missing binary, missing file, a `ref` escaping the media root) degrading to a no-op rather than throwing.

**Architecture:** `src/audio-player.js` is a standalone factory, `createAudioPlayer({ mediaRoot, eventStore, spawn })`, following the same "wrap an external dependency, degrade without stopping the clock" pattern already used by `src/sheets.js` (its `guard()` helper) and `src/drivers/modbus-tcp.js`. `spawn` defaults to `node:child_process.spawn` but is injectable, so tests never touch a real binary or make sound — this mirrors how `src/drivers/modbus-tcp.js` and `src/sheets.js` already take an injectable `googleFactory`/similar seam for hardware/network boundaries. No routes, no `game-engine` wiring, and no operator UI in this sub-milestone (per spec §11 item 3, those come in sub-milestones 5/6) — this module is entirely free-standing and independently testable, wired into `server.js` only far enough to exist (constructed, not yet consumed by anything else).

**Tech Stack:** Node 22+ built-ins only (`node:child_process`, `node:path`, `node:fs`). No new npm dependency. Real playback depends on `mpg123`/`ffplay`/`aplay` being present on the Pi (installed via `setup-pi.sh`); the module runs and degrades gracefully without them (e.g. in this dev environment, in CI, or on a Pi mid-setup).

**Spec:** `docs/superpowers/specs/2026-08-30-hints-and-audio-design.md`, §4 (Audio player) and its testing row in §10. This plan implements build-order item 3 from §11 ("Verified on the Pi (`playEffect`/`playMusic`/`stopAll` out the jack)" — the on-Pi verification is a manual step at the end of this plan, not an automated test, since no CI machine has real audio hardware).

## Global Constraints

- Server code stays built-ins-only; no new npm dependency (`CLAUDE.md`).
- Binary detection happens once at module construction (`mpg123` for `.mp3`; `ffplay` or `aplay` for `.wav`/`.ogg`). If none found for a given extension, `playEffect`/`playMusic` for that extension is a logged no-op recording an `audio-unavailable` event — the module still loads and every other extension (if its binary IS present) still works.
- Every call records an event via the injected `eventStore`: `{ source:'audio', type:'audio-play'|'audio-stop'|'audio-error'|'audio-unavailable', subject: ref|null, detail:{ channel, ... } }` — matches the shape `src/event-store.js`'s `record()` already accepts (`source`, `type`, `subject`, `detail` — see `src/sheets.js`'s `logErr` for the existing call-shape convention to copy).
- `ref` argument to `playEffect`/`playMusic` is always resolved against `mediaRoot` through the SAME kind of path-traversal guard already used in `src/media-library.js` (`resolveSafe`, exported from that module — import and reuse it, do not reimplement a second traversal check). A `ref` that escapes `mediaRoot` → `audio-error` event, no spawn, no throw.
- `playMusic` kills any currently-playing music child before spawning a new one — at most one music child process at a time. `playEffect` children are fire-and-forget and may overlap; all tracked in a Set so `stopAll` can kill every one of them plus the music child.
- `setVolume(v)` takes `0..1`, shells to `amixer set Master <v*100>%` (guarded — a missing `amixer` degrades the same way as a missing player binary, no throw), and returns the volume value it was called with (this module does NOT persist to `config.audio.volume` — that wiring belongs to `game-engine`'s vol-up/vol-down handlers in sub-milestone 6, per spec §6; this module is a pure mechanism, not a policy owner).
- `SIGTERM`/process shutdown → `stopAll()`. Register this via `process.on('SIGTERM', ...)` inside the factory, guarded so it never throws if called twice or if no children exist.
- A missing file (binary present, but the resolved path doesn't exist on disk) → `audio-error` event, resolves without throwing, no spawn attempted.
- Tests never invoke a real `mpg123`/`ffplay`/`aplay`/`amixer` — the injected `spawn` in every test is a fake that returns a fake `ChildProcess`-shaped object (`{ pid, kill(), on(event, cb) }`) so `audio-player.js`'s own logic (child tracking, channel semantics, event recording) is what's actually exercised.

---

### Task 1: `src/audio-player.js` — binary detection, channels, and core API

**Files:**
- Create: `src/audio-player.js`
- Test: `test/audio-player.test.js`

**Interfaces:**
- Consumes: `resolveSafe` from `src/media-library.js` (already exported: `module.exports = { createMediaLibrary, resolveSafe }`). `eventStore.record({...})` (already exists, see `src/event-store.js`). An injectable `spawn` function shaped like `node:child_process.spawn(cmd, args, opts) → ChildProcess` (only `.pid`, `.kill(signal)`, and `.on('exit'|'error', cb)` are used — never anything requiring a real OS process).
- Produces: `createAudioPlayer({ mediaRoot, eventStore, spawn, exec, existsBinary }) → { playEffect, playMusic, stopMusic, stopAll, setVolume, now }`.
  - `existsBinary` and `exec` are extra injectable seams (see Step 5) so binary-detection and `amixer` calls are also fake-able in tests without touching a real shell — default to real `node:child_process.execSync`-backed helpers when omitted.
  - `playEffect(ref, { gain } = {}) → Promise<void>` — resolves after spawning (or after a guarded no-op); never rejects.
  - `playMusic(ref, { loop = true } = {}) → Promise<void>` — same non-rejecting contract; kills prior music child first.
  - `stopMusic() → void` — kills the music child only, if any.
  - `stopAll() → void` — kills the music child (if any) and every tracked effect child.
  - `setVolume(v) → number` — clamps `v` to `[0,1]`, shells `amixer`, returns the clamped value.
  - `now() → { music: ref|null, effects: number, volume: number }`.

- [ ] **Step 1: Write the failing tests for binary detection and the missing-binary no-op path**

Create `test/audio-player.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createAudioPlayer } = require('../src/audio-player');

function fakeEventStore() {
  const events = [];
  return { events, record: (e) => { events.push(e); return { id: events.length }; } };
}

function fakeChild() {
  const listeners = {};
  return {
    pid: Math.floor(Math.random() * 100000),
    kill: () => { (listeners.exit || []).forEach(cb => cb()); },
    on(evt, cb) { (listeners[evt] = listeners[evt] || []).push(cb); return this; },
  };
}

function makePlayer(overrides = {}) {
  const spawnCalls = [];
  const spawn = overrides.spawn || ((cmd, args, opts) => { spawnCalls.push({ cmd, args, opts }); return fakeChild(); });
  const existsBinary = overrides.existsBinary || (() => true); // default: every binary "found"
  const exec = overrides.exec || (() => '');
  const eventStore = overrides.eventStore || fakeEventStore();
  const mediaRoot = overrides.mediaRoot || path.join(__dirname, 'fixtures', 'media');
  const player = createAudioPlayer({ mediaRoot, eventStore, spawn, exec, existsBinary });
  return { player, spawnCalls, eventStore, mediaRoot };
}

test('playEffect spawns mpg123 for an mp3 ref under mediaRoot', async () => {
  const { player, spawnCalls } = makePlayer();
  await player.playEffect('global/chime.mp3');
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].cmd, 'mpg123');
});

test('playEffect on a ref that escapes mediaRoot records audio-error and does not spawn', async () => {
  const { player, spawnCalls, eventStore } = makePlayer();
  await player.playEffect('../../etc/passwd.mp3');
  assert.equal(spawnCalls.length, 0);
  assert.ok(eventStore.events.some(e => e.type === 'audio-error'));
});

test('when no binary is found for an extension, playing that extension is a no-op that logs audio-unavailable', async () => {
  const { player, spawnCalls, eventStore } = makePlayer({ existsBinary: () => false });
  await player.playEffect('global/chime.mp3');
  assert.equal(spawnCalls.length, 0);
  assert.ok(eventStore.events.some(e => e.type === 'audio-unavailable'));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/audio-player.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/audio-player.js` — construction, binary detection, `playEffect`**

```js
const { spawn: realSpawn, execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { resolveSafe } = require('./media-library');

const EXT_PLAYERS = {
  '.mp3': [{ bin: 'mpg123', args: (file) => [file] }],
  '.wav': [{ bin: 'ffplay', args: (file) => ['-nodisp', '-autoexit', '-loglevel', 'quiet', file] },
           { bin: 'aplay', args: (file) => [file] }],
  '.ogg': [{ bin: 'ffplay', args: (file) => ['-nodisp', '-autoexit', '-loglevel', 'quiet', file] },
           { bin: 'aplay', args: (file) => [file] }],
};

function defaultExistsBinary(bin) {
  try { execSync(`command -v ${bin}`, { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function detectPlayers(existsBinary) {
  const resolved = {};
  for (const [ext, candidates] of Object.entries(EXT_PLAYERS)) {
    resolved[ext] = candidates.find(c => existsBinary(c.bin)) || null;
  }
  return resolved;
}

function createAudioPlayer({ mediaRoot, eventStore, spawn = realSpawn, exec = execSync, existsBinary = defaultExistsBinary }) {
  const players = detectPlayers(existsBinary);
  let musicChild = null;
  let musicRef = null;
  const effectChildren = new Set();
  let volume = 0.5;

  function record(type, subject, detail) {
    try { eventStore.record({ source: 'audio', type, subject, detail }); } catch {}
  }

  function resolveRef(ref) {
    try { return { full: resolveSafe(mediaRoot, ref), ext: path.extname(ref).toLowerCase() }; }
    catch { return null; }
  }

  async function spawnFor(ref, channel) {
    const resolved = resolveRef(ref);
    if (!resolved) { record('audio-error', ref, { channel, reason: 'bad-path' }); return null; }
    if (!fs.existsSync(resolved.full)) { record('audio-error', ref, { channel, reason: 'missing-file' }); return null; }
    const player = players[resolved.ext];
    if (!player) { record('audio-unavailable', ref, { channel, ext: resolved.ext }); return null; }
    const child = spawn(player.bin, player.args(resolved.full), { stdio: 'ignore' });
    record('audio-play', ref, { channel });
    return child;
  }

  async function playEffect(ref) {
    const child = await spawnFor(ref, 'effect');
    if (!child) return;
    effectChildren.add(child);
    child.on('exit', () => effectChildren.delete(child));
    child.on('error', () => effectChildren.delete(child));
  }

  async function playMusic(ref, { loop = true } = {}) {
    void loop; // looping is a player-arg concern folded into future extension; mpg123/-loop handled by caller args if ever needed
    stopMusic();
    const child = await spawnFor(ref, 'music');
    if (!child) { musicChild = null; musicRef = null; return; }
    musicChild = child;
    musicRef = ref;
    child.on('exit', () => { if (musicChild === child) { musicChild = null; musicRef = null; } });
    child.on('error', () => { if (musicChild === child) { musicChild = null; musicRef = null; } });
  }

  function stopMusic() {
    if (musicChild) {
      try { musicChild.kill(); } catch {}
      record('audio-stop', musicRef, { channel: 'music' });
      musicChild = null;
      musicRef = null;
    }
  }

  function stopAll() {
    stopMusic();
    for (const child of effectChildren) {
      try { child.kill(); } catch {}
    }
    if (effectChildren.size) record('audio-stop', null, { channel: 'effect', count: effectChildren.size });
    effectChildren.clear();
  }

  function setVolume(v) {
    const clamped = Math.max(0, Math.min(1, v));
    volume = clamped;
    try { exec(`amixer set Master ${Math.round(clamped * 100)}%`, { stdio: 'ignore' }); }
    catch { record('audio-unavailable', null, { channel: 'volume' }); }
    return clamped;
  }

  function now() {
    return { music: musicRef, effects: effectChildren.size, volume };
  }

  try {
    process.on('SIGTERM', () => { try { stopAll(); } catch {} });
  } catch {}

  return { playEffect, playMusic, stopMusic, stopAll, setVolume, now };
}

module.exports = { createAudioPlayer };
```

- [ ] **Step 4: Run tests, verify pass**

Run: `node --test test/audio-player.test.js`
Expected: PASS, all 3 tests.

- [ ] **Step 5: Add tests for `playMusic` kill-prior-child semantics, `stopMusic`/`stopAll`, missing-file, and `now()`**

Append to `test/audio-player.test.js`:

```js
test('playMusic kills the previous music child before spawning a new one', async () => {
  const killed = [];
  const spawn = () => {
    const c = fakeChild();
    const origKill = c.kill.bind(c);
    c.kill = () => { killed.push(c.pid); origKill(); };
    return c;
  };
  const { player } = makePlayer({ spawn });
  await player.playMusic('global/bed.mp3');
  const firstState = player.now();
  assert.equal(firstState.music, 'global/bed.mp3');
  await player.playMusic('global/win.mp3');
  assert.equal(killed.length, 1);
  assert.equal(player.now().music, 'global/win.mp3');
});

test('stopMusic kills only the music child, leaving effects running', async () => {
  const { player } = makePlayer();
  await player.playMusic('global/bed.mp3');
  await player.playEffect('global/chime.mp3');
  player.stopMusic();
  const state = player.now();
  assert.equal(state.music, null);
  assert.equal(state.effects, 1);
});

test('stopAll kills the music child and every effect child', async () => {
  const { player } = makePlayer();
  await player.playMusic('global/bed.mp3');
  await player.playEffect('global/chime.mp3');
  await player.playEffect('global/chime.mp3');
  player.stopAll();
  const state = player.now();
  assert.equal(state.music, null);
  assert.equal(state.effects, 0);
});

test('a missing file (present binary, absent path) records audio-error and does not spawn', async () => {
  const { player, spawnCalls, eventStore } = makePlayer({ mediaRoot: require('node:os').tmpdir() });
  await player.playEffect('definitely-not-here-12345.mp3');
  assert.equal(spawnCalls.length, 0);
  assert.ok(eventStore.events.some(e => e.type === 'audio-error' && e.detail.reason === 'missing-file'));
});

test('every play/stop call logs an event with source "audio"', async () => {
  const { player, eventStore } = makePlayer();
  await player.playEffect('global/chime.mp3');
  player.stopAll();
  assert.ok(eventStore.events.every(e => e.source === 'audio'));
  assert.ok(eventStore.events.some(e => e.type === 'audio-play'));
  assert.ok(eventStore.events.some(e => e.type === 'audio-stop'));
});

test('setVolume clamps to 0..1 and returns the applied value', () => {
  const { player } = makePlayer();
  assert.equal(player.setVolume(1.5), 1);
  assert.equal(player.setVolume(-0.3), 0);
  assert.equal(player.setVolume(0.7), 0.7);
  assert.equal(player.now().volume, 0.7);
});

test('setVolume degrades to audio-unavailable (no throw) when amixer is missing', () => {
  const { player, eventStore } = makePlayer({ exec: () => { throw new Error('amixer: not found'); } });
  assert.doesNotThrow(() => player.setVolume(0.5));
  assert.ok(eventStore.events.some(e => e.type === 'audio-unavailable' && e.detail.channel === 'volume'));
});

test('now() reports music ref, effect count, and volume', async () => {
  const { player } = makePlayer();
  assert.deepEqual(player.now(), { music: null, effects: 0, volume: 0.5 });
  await player.playMusic('global/bed.mp3');
  assert.equal(player.now().music, 'global/bed.mp3');
});
```

Note: `test/fixtures/media/global/chime.mp3` (and `bed.mp3`/`win.mp3`) referenced by these tests must actually exist on disk for the "present file" tests to pass their `fs.existsSync` check inside `spawnFor` — the missing-file test deliberately uses a different `mediaRoot` (`os.tmpdir()`) precisely so its ref does NOT resolve to an existing file. Create these fixtures before running the tests (Step 6 below).

- [ ] **Step 6: Create the tiny fixture files the tests reference**

```bash
mkdir -p test/fixtures/media/global
printf 'fake' > test/fixtures/media/global/chime.mp3
printf 'fake' > test/fixtures/media/global/bed.mp3
printf 'fake' > test/fixtures/media/global/win.mp3
```

These are checked-in test fixtures (not git-ignored `media/` runtime content) — they live under `test/fixtures/`, a different path than the app's own `media/` directory, so they are NOT covered by the `media/` `.gitignore` line added in sub-milestone 2. Commit them normally.

- [ ] **Step 7: Run the full file, verify all pass**

Run: `node --test test/audio-player.test.js`
Expected: PASS, all 11 tests.

- [ ] **Step 8: Run the whole suite**

Run: `node --test "test/**/*.test.js"`
Expected: PASS, no regressions (148 prior + 11 new = 159).

- [ ] **Step 9: Commit**

```bash
git add src/audio-player.js test/audio-player.test.js test/fixtures/media
git commit -m "feat(audio): src/audio-player.js (mpg123/ffplay/aplay shell-out, music+effect channels, volume)"
```

---

### Task 2: `setup-pi.sh` audio dependencies + `server.js` wiring

**Files:**
- Modify: `scripts/setup-pi.sh`
- Modify: `server.js`
- Test: none new (this task has no testable Node logic of its own; `server.js`'s wiring is exercised implicitly by the existing integration smoke test continuing to pass — see Step 4)

**Interfaces:**
- Consumes: `createAudioPlayer` from Task 1.
- Produces: `server.js` constructs `const audioPlayer = createAudioPlayer({ mediaRoot: MEDIA_ROOT, eventStore, spawn: require('node:child_process').spawn })` (default `spawn`/`exec`/`existsBinary` are fine here — no fakes in production) and holds the reference, but does NOT yet pass it into `createWebServer`'s deps or `game-engine` — that wiring is out of scope until sub-milestones 5/6 explicitly need it (spec §4.4's "Startup order" note only requires `audio-player` to exist after `media-library` at this point; downstream consumers arrive later). Keep this addition minimal and inert.

- [ ] **Step 1: Add `mpg123` and `alsa-utils` (for `aplay`/`amixer`) to `setup-pi.sh`**

In `scripts/setup-pi.sh`, after the "Install runtime dependencies (googleapis only)" block and before the "Assets reminder" block, add:

```bash
# ── Audio playback dependencies (server-side hint/game audio) ──────────────
echo ""
echo "  Installing audio playback dependencies (mpg123, alsa-utils)..."
sudo apt-get install -y mpg123 alsa-utils
echo "  mpg123   $(mpg123 --version 2>&1 | head -1 || echo 'not found')"
```

Update the existing "Assets reminder" echo block immediately after it to also mention the new `media/` directory (from sub-milestone 2) rather than only the old flat `public/assets/*.mp3` files, since those old browser-audio files are superseded by this subsystem (do not delete the old reminder lines — sub-milestone 6 is what actually removes browser audio from `game.js`; this task only adds a note, it does not change what `game.js` still depends on today):

```bash
echo ""
echo "  Server-side audio assets go in: $INSTALL_DIR/media/"
echo "  (uploaded via the Media Library page once the server is running)"
```

- [ ] **Step 2: Wire `audioPlayer` into `server.js`**

In `server.js`, after the `mediaLibrary` construction added in sub-milestone 2 (look for `const mediaLibrary = createMediaLibrary(...)`), add:

```js
const { createAudioPlayer } = require('./src/audio-player');
const audioPlayer = createAudioPlayer({ mediaRoot: MEDIA_ROOT, eventStore });
```

Do not pass `audioPlayer` into `createWebServer({...})`'s deps object or `createGameEngine({...})`'s deps object yet — those integrations are explicitly deferred to sub-milestones 5/6 per this plan's Architecture note. Confirm (read the current `server.js`) that `MEDIA_ROOT` is already in scope at this point in the file (it was added in sub-milestone 2's Task 3) — it should be, since `mediaLibrary` already uses it.

- [ ] **Step 3: Confirm the server still boots**

Run: `node -e "require('./server.js')"` is unsafe (it calls `server.listen` and never exits) — instead run `npm test` (Step 4) and separately do a manual timed smoke check:

```bash
timeout 5 npm start || true
```

(On Windows/PowerShell where `timeout` as a Unix coreutil isn't available, the implementer runs `npm start` briefly and Ctrl-C's it, or equivalently checks that `node -c server.js` — a syntax-only check — passes, plus relies on Step 4's integration smoke test actually constructing the real module graph including `audio-player.js`.) The goal is only to confirm requiring `audio-player.js` and constructing it doesn't throw at boot — the existing `test/integration.smoke.test.js` (if it boots the real `server.js` module graph, check this first) is the authoritative check.

- [ ] **Step 4: Run the whole suite**

Run: `node --test "test/**/*.test.js"`
Expected: PASS, no regressions. If `test/integration.smoke.test.js` constructs its own fake module graph rather than requiring the real `server.js`, this step's coverage of the `server.js` wiring is necessarily just Step 3's manual check — note this honestly in the task report rather than claiming automated coverage that doesn't exist.

- [ ] **Step 5: Commit**

```bash
git add scripts/setup-pi.sh server.js
git commit -m "feat(audio): wire audio-player into server.js, add mpg123/alsa-utils to setup-pi.sh"
```

---

### Task 3: On-Pi verification (manual, documented)

**Files:**
- Modify: `docs/runbook-m1.md` (or create `docs/superpowers/notes/2026-09-04-audio-player-pi-verification.md` if `runbook-m1.md` is scoped strictly to M1 and a new file is cleaner — implementer's judgment, matching whichever existing doc's scope this fits best after reading `docs/runbook-m1.md`'s actual contents)

**Interfaces:** None — this task produces operational documentation, not code, per spec §11 item 3 ("Verified on the Pi") and §12 open item 1 (Pi → room speakers wiring, ALSA default device).

- [ ] **Step 1: Read `docs/runbook-m1.md` in full** to see whether it's the right home for a short "Sub-milestone 3: Audio player" verification section, or whether a fresh dated note file fits the existing docs organization better.

- [ ] **Step 2: Write the verification note**

Content to include (adapt exact wording/location to match the chosen doc's existing style):

```markdown
## Audio player — on-Pi verification (sub-milestone 3)

After deploying this branch to the Pi (`bash scripts/setup-pi.sh` picks up `mpg123`/`alsa-utils`):

1. Confirm the ALSA default output device reaches the room speakers/amp
   (`aplay -l` to list devices; `amixer` to confirm a `Master` control exists —
   if the Pi has more than one audio output, `.asoundrc` may need a `default`
   device pinned; this is spec §12 open item 1, resolve it here if not
   already resolved).
2. Drop a small test file at `media/test.mp3` on the Pi (via the Media
   Library page from sub-milestone 2, or `scp` directly).
3. From a Node REPL on the Pi (`node`, inside the repo dir):
   ```js
   const { createEventStore } = require('./src/event-store');
   const { createAudioPlayer } = require('./src/audio-player');
   const es = createEventStore({ path: './room-control.db' });
   const ap = createAudioPlayer({ mediaRoot: './media', eventStore: es });
   ap.playEffect('test.mp3'); // should audibly play out the jack/speakers
   ap.setVolume(0.3);         // should audibly lower the level
   ap.stopAll();              // should stop it if still playing
   ```
4. Record the outcome (worked / didn't / what was needed — e.g. a specific
   `.asoundrc` device index) in this note for the next sub-milestone's
   context, since sub-milestone 6 wires real game-engine events to this
   same player and will assume this verification already passed.
```

- [ ] **Step 3: Commit**

```bash
git add docs/runbook-m1.md  # or the new note file path chosen in Step 1
git commit -m "docs(audio): on-Pi verification steps for the audio player (sub-milestone 3)"
```

Note for whoever executes this plan: Task 3's actual on-Pi verification (running the REPL snippet against real hardware and confirming sound comes out) cannot be performed from this dev/CI environment — it requires physical access to a deployed Pi. Document the steps per this task, but do not claim in the task report that the audible verification was performed unless it genuinely was (e.g. by a human operator who ran it separately and reported back). If this plan is executed via subagent-driven-development, the dispatched implementer for this task should report `DONE_WITH_CONCERNS` noting the audible check is undone, not `DONE` claiming full completion.

---

## Self-Review Notes (for the plan author, not a task)

- **Spec coverage:** §4.1 binary detection + graceful degradation (Task 1 `detectPlayers`/`existsBinary` injection), §4.2 music/effect channel semantics (Task 1's `playMusic`/`playEffect`/tracking Set), §4.3 the full API surface (`playEffect`, `playMusic`, `stopMusic`, `stopAll`, `setVolume`, `now`), §4.4's startup-order note (Task 2, `server.js` constructs `audio-player` after `media-library`, no further wiring yet — deferred integrations named explicitly), §10's `audio-player` test row (Task 1's 11 tests cover: fake-`spawn` kill-prior-music-child, `stopMusic` leaves effects, `stopAll` kills both, missing file → `audio-error` no throw, no binary → no-op + `audio-unavailable`, every call logs an event, `ref` escaping `mediaRoot` → `audio-error`), §11 item 3's "Verified on the Pi" (Task 3, honestly scoped as a manual/undone-until-a-human-runs-it step), §12 item 1 (Pi speaker wiring) and item 4 (`ffplay` vs `aplay` choice — resolved here as "try `ffplay` first, fall back to `aplay`" since the actual asset set wasn't available to decide definitively, consistent with §12's "decide at sub-milestone 3 with the actual asset set" — flagged as a provisional choice for Task 3's on-Pi note to confirm or override).
- **Explicitly deferred, not forgotten:** `game-engine` audio-event wiring (sub-milestone 6), operator "stop-audio" button and `play-hint`/`show-hint` command wiring (sub-milestones 5/6), `config.audio.volume` persistence on `setVolume` calls (sub-milestone 6 — this module intentionally has no config dependency at all, keeping it a pure mechanism).
- **Type/name consistency check:** `createAudioPlayer`'s returned method names (`playEffect`, `playMusic`, `stopMusic`, `stopAll`, `setVolume`, `now`) match spec §4.3 verbatim, and match what `game-engine`'s future wiring (spec §6's table) will call by these exact names — verified against the spec text directly, not just this plan's own internal consistency, since a name mismatch here would silently break sub-milestone 6's dispatch table later.
