# Hints & Audio — Design Spec

**Date:** 2026-08-30
**Status:** Approved for planning
**Project:** `HTM-GameControl` (the room-control Pi — one Node process). Sits on top of the shipped M1 + the `polish` branch.
**Supersedes:** the flat `hintGroups` model. Absorbs the "progress / session tracking" and "audio/media library" ideas into one subsystem.

---

## 1. Purpose & scope

Give the operator a **progress board** that mirrors the paper GM checklists, where hints collapse as the game is solved, and fold in the audio pieces from the `ADG` controller so hints can be **played in the room** and the game has proper start / loop / win / lose beds — all server-side.

### In scope

1. **Section → Step → Hint** structure (approach "B"). A section is an optional grouping; a step is the checkable unit (the "Solved" toggle); a hint has a `type` of `text` (renders on the game screen, as today) or `audio` (plays in the room).
2. **Media library** — a file manager for audio assets on the Pi: folders, upload, per-file title + tags, move/rename/delete, disk-usage. Ported in concept from ADG's `media.html` + `audio_metadata`.
3. **Server-side audio player** — a Node module shelling to `mpg123` (+ `aplay`/`ffplay` fallback): one-shot effects, a single looping music channel, independent stop-music / stop-all, ALSA volume. Port of ADG's `audio/player.rs`. Audio comes out the **Pi's audio jack → room speakers** (decision D2-a).
4. **Global game-audio events** — configurable files for `start`, background `loop`, `midShow`, `win`, `lose`, and the clue `chime`, fired by the `game-engine` on its existing transitions. Replaces the browser's `TimerMusic.mp3` / `FinaleMusic.mp3` / `ClueSound.mp3` (decision D2-a: `game.html` stops playing audio).
5. **Checklist importer** — paste a GM checklist Google Doc URL → parsed into `sections` / `steps` / `hints` for review and Save. One-time, offline-safe.

### Out of scope

ADG's `mode1`/`mode2` variants; the standalone soundboard page (it merges into the hint list); ADG's relay / TM1637 display / piezo buzzer effects; hardware I/O (that is the planned M2 `signal-bus`); ADG's Rust game engine (this project has its own); ADG presets. `video` hint type is reserved in the schema but not built.

### Decisions (locked in brainstorming)

- **D1-a:** `config.json` is authoritative for the section/step/hint structure. Edited on the config page. A one-time importer reads a GM Doc into it. Runs with Google unreachable.
- **D2-a:** all audio is server-side via `mpg123` out the Pi jack. The Pi is/will be wired to the room's speakers. Browser audio in `game.js` is removed.
- **Approach B:** first-class `sections[]` / `steps[]` config model, not a flat `hintGroups` extension.

---

## 2. Data model (config)

Three new top-level keys in `config.json`, plus an `audio` block. `hintGroups` is migrated away (see §2.3).

### 2.1 Shape

```jsonc
"sections": [
  { "id": "sec_desk",  "name": "Desk",         "order": 1, "note": "" },
  { "id": "sec_hutch", "name": "Locked Hutch", "order": 2, "note": "AVOID HINTS early" }
],

"steps": [
  {
    "id": "step_briefcase",
    "name": "Briefcase",
    "order": 1,
    "sectionId": "sec_desk",              // null / omitted = top-level (section-less room, e.g. Nibiru)
    "hints": [
      { "id": "h1", "type": "text",  "text": "Look at the calendar, use it with the phone message.",
        "key": "F1", "countsAsClue": true },
      { "id": "h2", "type": "audio", "mediaRef": "nibiru/briefcase_2.mp3", "label": "Briefcase clue 2",
        "color": "#4a8aff", "icon": "🎧", "key": "F2", "countsAsClue": true }
    ]
  }
],

"progress": {
  "flags": ["Translation given"]           // game-level checkboxes shown on the operator board
},

"audio": {
  "volume": 0.4,
  "events": {
    "start":     { "file": "global/start.mp3", "enabled": true },
    "loop":      { "file": "global/bed.mp3",   "enabled": true },
    "midShow":   { "file": "global/2min.mp3",  "enabled": false, "atSecondsRemaining": 120 },
    "win":       { "file": "global/win.mp3",   "enabled": true },
    "lose":      { "file": "global/lose.mp3",  "enabled": true },
    "clueChime": { "file": "global/chime.mp3", "enabled": true }
  }
}
```

### 2.2 Field rules

- **section**: `id` (string), `name` (string), `order` (number), `note` (string, optional — the GM directive). Zero sections is valid.
- **step**: `id`, `name`, `order`, `sectionId` (string, optional — must resolve to a section `id` when present), `hints[]`.
- **hint**: `id`, `type` (`"text"` | `"audio"`; `"video"` reserved, rejected by the schema for now). `type:"text"` requires a non-empty `text`. `type:"audio"` requires a `mediaRef` (path under `media/`, §3). Optional presentation: `label` (string), `color` (hex string), `icon` (string). Optional `key` (hotkey string). `countsAsClue` (bool, default `true`).
- **`progress.flags`**: array of strings (flag names).
- **`audio.volume`**: 0..1. **`audio.events.<name>`**: `{ file: string, enabled: bool }`; `midShow` also `{ atSecondsRemaining: number }`.
- **ids** are stable strings generated by the app (`sec_…` / `step_…` / `h…` + a short random or counter). Progress state, events, and the importer's re-import matching all key off them.

### 2.3 Migration

On config load: if `hintGroups` is present and `steps` is absent, convert once and write back:

- each `hintGroups[i]` → a `step` `{ id: <new>, name: group.name || "Group " + (i+1), order: i+1, sectionId: null, hints: [...] }`
- each `group.hints[j]` → `{ id: <new>, type: "text", text: hint.text, key: hint.key || "", countsAsClue: true }`
- `sections` → `[]`, `progress.flags` → `[]`, `audio` → the defaults above with `enabled:false` for every event (nothing plays until the operator points events at files).
- `hintGroups` is left in the file untouched for one release as a fallback; `config-schema` ignores it.

`config.current().hintGroups` consumers (the operator's old hint list, `sheets.syncHotkeysTab`, the "Import from Sheet" / Hotkeys-tab features) are replaced by the new board (§5) and are removed in the same change. The `Hotkeys` Google tab mirror is re-pointed at `steps`/`hints` (same `Group | Hint | Hotkey` columns, "Group" = step name, one row per hint; audio hints show their `label`).

### 2.4 `config-schema.js` additions

Validates, in `validateConfig`:
- `sections`, `steps` are arrays; `progress` is an object with `flags` an array of strings; `audio` matches the shape above.
- unique `id` across all sections; unique across all steps; unique across all hints (globally).
- every `step.sectionId`, when set, is a real section `id`.
- every hint: `type ∈ {text, audio}`; `text` ⇒ non-empty `text`; `audio` ⇒ non-empty `mediaRef`.
- `order` values are numbers.
- `audio.events.midShow.atSecondsRemaining` is a positive number when `midShow.enabled`.
- Unknown top-level keys still rejected (the M1 guard); `sections`, `steps`, `progress`, `audio` added to the allow-list. (Media has no config key — it lives in the DB + `media/` dir only.) `hintGroups` stays allow-listed through the fallback release.

---

## 3. Media library

### 3.1 Storage

Audio files on disk under `<repo>/media/` (git-ignored, like `config.json` and `room-control.db`). Subfolders allowed. `mediaRef` and `audio.events.*.file` values are paths **relative to `media/`** (e.g. `nibiru/briefcase_2.mp3`, `global/start.mp3`).

### 3.2 DB table (in `room-control.db`)

```sql
CREATE TABLE IF NOT EXISTS media (
  path     TEXT PRIMARY KEY,   -- relative to media/, e.g. "nibiru/briefcase_2.mp3"
  title    TEXT NOT NULL DEFAULT '',
  tags     TEXT NOT NULL DEFAULT '',
  kind     TEXT NOT NULL DEFAULT 'audio',
  bytes    INTEGER NOT NULL DEFAULT 0,
  added_ts INTEGER NOT NULL
);
```

The file on disk is the source of truth; a row is optional decoration. A file with no row lists with `title` falling back to the basename.

### 3.3 `src/media-library.js`

`createMediaLibrary({ db, root, steps })` where `steps` is a getter for the current `config.steps` (for the in-use check).

- `list()` → walk `root` recursively for `*.mp3|*.wav|*.ogg`, left-join the `media` table → `[{ path, title, tags, kind, bytes, addedTs, missing:false }]`. Rows whose file is gone → included with `missing:true`.
- `save(relPath, buffer)` → resolve against `root`, **reject if it escapes `root`**, create parent dirs, write file, upsert row (`bytes`, `added_ts`, `kind:'audio'`). Reject extensions outside the allow-list.
- `setMeta(relPath, { title, tags })` → upsert `title`/`tags`.
- `move(from, to)` → fs rename (both guarded), update `media.path`, and rewrite any `hint.mediaRef` / `audio.events.*.file` that pointed at `from` (returns the count changed; the caller persists config).
- `delete(relPath)` → refuse (throw `{ inUse: [stepId…] }`) if any hint `mediaRef` equals it; else `fs.unlink` + delete row.
- `usage()` → `{ bytes, count, freeBytes }` (`freeBytes` from `node:fs` `statfs`).

Pure `node:fs` / `node:path`; no new npm dep.

### 3.4 `src/web.js` routes

```
GET    /api/media                 → { files: list() }
POST   /api/media/upload          → multipart (field "file" + "folder"); ~50 MB cap; streamed to disk; → save()
POST   /api/media/meta            → { path, title, tags } → setMeta()
POST   /api/media/move            → { from, to } → move() ; then persist config if refs changed
DELETE /api/media?path=…          → delete(); 409 + { inUse } if referenced
GET    /api/media/usage           → usage()
```

All guarded: a bad path, missing file, or fs error → 4xx JSON, never a throw out of the handler.

### 3.5 Accepted formats

`.mp3`, `.wav`, `.ogg`. Anything else rejected on upload with a message.

---

## 4. Audio player

### 4.1 `src/audio-player.js`

`createAudioPlayer({ mediaRoot, eventStore, spawn })` — `spawn` defaults to `node:child_process.spawn`, injectable for tests.

**Binary detection at startup:** `mpg123` for `.mp3`; `ffplay` (from ffmpeg) or `aplay` for `.wav`/`.ogg`. If none found: the module still loads; every play call is a logged no-op that records an `audio-unavailable` event. `setup-pi.sh` gains `apt-get install -y mpg123 alsa-utils`.

### 4.2 Channels

| Channel | Purpose | Behaviour |
|---|---|---|
| **music** | background loop; `start`/`midShow`/`win`/`lose` beds | at most one child at a time; a new `playMusic` kills the current; `--loop -1` when `loop:true` |
| **effect** | hint audio, clue chime, one-shots | fire-and-forget; multiple children may overlap; all tracked so `stopAll` can kill them |

### 4.3 API

```
playEffect(ref, { gain? })       → resolve <ref> under mediaRoot (guarded); spawn player; register pid; resolve immediately
playMusic(ref, { loop = true })  → kill current music child; spawn new one
stopMusic()                      → kill music child only
stopAll()                        → kill music child + every effect child
setVolume(v /* 0..1 */)          → amixer set Master <v%>; store as default --gain for future spawns; return applied value
now()                            → { music: ref|null, effects: <int>, volume }
```

- Every call records an event: `{ source:'audio', type:'audio-play'|'audio-stop', subject: ref|null, detail:{ channel } }`.
- Missing file → `audio-error` event, resolves (no throw).
- `SIGTERM` / process shutdown → `stopAll()`.
- Volume is process-wide (one Pi, one card). Persisted to `config.audio.volume`; restored on boot; the operator's existing vol-up/vol-down buttons call `setVolume`.
- `ref` that escapes `mediaRoot` → `audio-error`, no spawn.

### 4.4 Wiring

`server.js` constructs `media-library` then `audio-player`, and passes `audio-player` to both `game-engine` (global events, §6) and `web` (the operator `play-hint` / `stop-audio` commands). Startup order: `event-store` → `config` → `media-library` → `audio-player` → `signal-bus` → `progress` → `game-engine` → `web`.

---

## 5. Progress tracking

### 5.1 `src/progress.js`

`createProgress({ eventStore })`. In-memory per-game state, composed by `game-engine`, reset each game.

```
steps:  { [stepId]: { clueGivenAt: <ts>|null, solvedAt: <ts>|null } }
flags:  { [flagName]: <ts>|null }
```

**API:**
- `startGame(gameId)` — clear state; record `{ type:'progress-reset', game_id }`.
- `markGiven(stepId)` — if `clueGivenAt` is null, set it; record `{ type:'hint-given', subject: stepId, game_id }`. Idempotent after first call.
- `solveStep(stepId, on)` — set/clear `solvedAt`. On → `{ type:'step-solved', subject: stepId, detail:{ elapsedMs, clueToSolveMs? }, game_id }` (`clueToSolveMs` only when a `clueGivenAt` exists). Off → `{ type:'step-unsolved', subject: stepId, game_id }`.
- `setFlag(name, on)` — set/clear; `{ type:'flag-set', subject: name, value: on, game_id }`.
- `snapshot()` — `{ steps, flags }`, merged into the SSE `state` payload.

Section completion is **derived** by the UI: a section is complete when every `step` with that `sectionId` has a non-null `solvedAt` in the snapshot. Not stored.

`elapsedMs` is measured from the game's `started_ts` (from the `games` row / game-engine state).

### 5.2 Data produced

Per game, in the `events` table with `game_id`: `progress-reset`, `hint-given` (per step, first hint), `step-solved` / `step-unsolved` (with `elapsedMs`, `clueToSolveMs`), `flag-set`. This yields exactly the paper checklist's columns — clue-given time, solved time, clue→solve duration — per step, and section durations by aggregation, queryable via `/api/events?game_id=…`.

---

## 6. Global audio events (game-engine)

`game-engine` gains an injected `audioPlayer` (optional; absent in most unit tests). All calls best-effort — a rejected promise or synchronous throw from `audioPlayer` is caught and never blocks the clock (same guard style as `sheets`).

| Game-engine transition | Audio action |
|---|---|
| `start` accepted | `playEffect(events.start.file)` if enabled, then `playMusic(events.loop.file)` if enabled |
| timer tick reaches `events.midShow.atSecondsRemaining` (once per game) | `playEffect(events.midShow.file)` if enabled |
| `escaped` (win) | `stopMusic()`; `playEffect(events.win.file)` if enabled |
| `reset` while `phase === 'running'` (lose) | `stopMusic()`; `playEffect(events.lose.file)` if enabled |
| `reset` to waiting (idle) | `stopAll()` |
| a hint is shown (`show-hint`) | `playEffect(events.clueChime.file)` if enabled — **skipped** when the hint is `type:'audio'` (the hint's own clip is the sound) |
| `vol-up` / `vol-down` | `audioPlayer.setVolume(newVol)`; persist `config.audio.volume` |

`public/game.js` / `public/game.html`: remove the `<audio>` elements, `makeAudio`, `playTimerMusic` / `playFinaleMusic` / `playClueSound` and their calls. The game screen becomes purely visual. `renderModel` and the SSE state rendering are unchanged otherwise.

---

## 7. Operator console

The hint panel is replaced by a **progress board** rendered from `config` + the SSE `state.{steps,flags}`.

### 7.1 Layout

```
┌─ Desk ─────────────────────────────  2/3 ─┐   section header + solved count; collapses when 3/3
│  ▾ Briefcase                    [ Solved ] │   step card: name + Solved toggle
│      [F1] Look at the calendar…            │   text hint pad
│      [F2] 🎧 Briefcase clue 2              │   audio hint pad
│  ▸ Book Puzzle  ✓               [ Solved ] │   solved → collapsed one-liner, still expandable
└───────────────────────────────────────────┘
┌─ Ungrouped ───────────────────────────────┐   steps with no sectionId
│  ▾ Pendant puzzle               [ Solved ] │
└───────────────────────────────────────────┘

Flags:  ☐ Translation given
```

### 7.2 Behaviour

- **Hint pad** — background `hint.color` (fallback theme colour), `key` badge, `label` or text, type icon (🎧 for audio). Click:
  - `text` → `POST /cmd { type:'show-hint', stepId, hintId }` → game screen renders it (as today) + clue chime + `markGiven(step)` + clue counter (unless `countsAsClue:false`).
  - `audio` → `POST /cmd { type:'play-hint', stepId, hintId }` → `audioPlayer.playEffect(hint.mediaRef)` + `markGiven(step)` + clue counter (unless `countsAsClue:false`). Nothing on the game screen.
  - Ctrl-click → force `countsAsClue:false` for that press (silent clue), matching the current game.js convention.
  - Flash the pad on click. Keyless pads are fully clickable.
- **Solved toggle** — `POST /cmd { type:'solve-step', stepId, on }`. On → card collapses to a ✓ one-liner (hints reachable by expanding). Off → re-expands. Any order (non-linear).
- **Section header** — auto-collapses at `n/n`; manual expand/collapse always available, persisted per browser (localStorage, like the column divider).
- **Flags row** — a checkbox per `config.progress.flags[]` → `POST /cmd { type:'set-flag', name, on }`.
- **Stop-audio button** — new, in the timer bar → `POST /cmd { type:'stop-audio' }` → `audioPlayer.stopAll()`.
- **Active-hints list / "Dismiss All" / clue counter** — unchanged behaviour; `countsAsClue:false` hints do not increment.

### 7.3 Code

`public/operator.js` keeps its `commandFor(id)` pure map (extended with the new command types). The board is a new **pure** `renderBoard(config, state) → DOMFragment` (or an HTML string) so it is unit-testable under `node --test` with no browser — same pattern as `renderModel` / `commandFor`. The browser branch calls `renderBoard` on `config-updated` and on each `state` snapshot.

### 7.4 New `/cmd` types (handled by `game-engine.command`)

`show-hint` (extended to take `stepId`/`hintId`), `play-hint`, `solve-step`, `set-flag`, `stop-audio`. Each records its event (source `operator`) and calls `progress` / `audioPlayer` as above. Existing guards apply (`gameLocked`, etc.); `solve-step` / `set-flag` are allowed only while a game is active.

---

## 8. Config page

### 8.1 "Board" tab (replaces "Hint Groups")

Three-level editor:

- **Sections** — add / reorder (▲▼) / delete; each: `name`, `note` textarea, collapsible body of its steps.
- **Steps** — inside a section or in an "Ungrouped" bucket; add / reorder / delete / move (a section `<select>` per step); each: `name`, then hints.
- **Hints** — per step; add / reorder / delete. Row:
  - **Type** toggle `Text | Audio`.
  - `Text` → text input + key-capture (as today).
  - `Audio` → **media picker** button (opens the Media Library modal, §8.2) showing the chosen `mediaRef` + ▶ preview; `label`; `color` swatch; `icon`; key-capture.
  - `Counts as clue` checkbox (default on).
- **Flags** — a simple editable string list → `config.progress.flags`.
- **Import checklist** button → §9 flow.

Save writes `sections` / `steps` / `progress.flags` through the existing merge-`POST /config`. Schema errors surface inline (as today).

### 8.2 Media Library page (`public/media.html`, new)

Linked from the top nav and reused as a modal by the Board tab (`?pick=1` mode returns a chosen path to the opener). Ported in spirit from ADG's `media.html`:

- **Upload** — drag-drop / file picker + folder field → `POST /api/media/upload`.
- **File list** — table: ▶ preview, `path`, inline-editable `title`, inline-editable `tags`, size, "used by N hints". Save → `POST /api/media/meta`.
- **Actions** — move (folder `<select>`), delete (blocked with the referencing-steps message when in use), rename folder.
- **Header** — disk-usage bar from `/api/media/usage`.

### 8.3 General tab — Audio Events card (new)

For each of `start / loop / midShow / win / lose / clueChime`: an `enabled` checkbox + a media picker; `midShow` also an "at N seconds remaining" number. Writes `config.audio.events`. The existing volume control now drives `audio-player` and persists to `config.audio.volume`.

### 8.4 Google Sheets tab

Unchanged fields. The "what data goes where" help gains a line: per-step clue-given / solved times log to the local event store (and, if the `Hotkeys` tab / a checklist tab is configured, mirror there).

---

## 9. Checklist importer

### 9.1 `src/checklist-import.js`

Pure `parseChecklist(text) → { sections, steps, flags, warnings }`. Input is a GM Doc exported to plain text via the Drive API (same service account already on the Pi; `drive.readonly` scope).

Heuristics, derived from the three real Docs (Assassins, Nibiru, Pharaoh's):
- **Header block** (Date / time / Group Size / G.M. / Clues Given / New/Exp Players) → skipped. A `☐ <name>` token in it → a **flag**.
- **A left-column bold line with no hint text following it** → a **section**. A trailing `(…)` like `(AVOID HINTS)` → the section `note`.
- **A milestone line** under a section → a **step**.
- **Indented / quoted lines after a step** → **text hints** on that step, in order. A leading enumerator (`N1`, `1`, `2`) is stripped; order is positional.
- A `Notes` / reference block → one step `Reference` with each line a hint, `countsAsClue:false`.

Returns `warnings[]` for ambiguous lines (`"line 34: couldn't classify — section or step?"`). **Never writes config.** All imported hints are `type:'text'` (Docs carry no audio); the operator switches types + attaches media afterward in the Board editor.

### 9.2 Re-import

Matching is by `section.name` + `step.name` (case-insensitive, trimmed). An unchanged item keeps its existing `id` (so progress history and audio assignments survive). New items get new ids. Items present in config but absent from the Doc are listed under "not in the imported checklist — delete manually?".

### 9.3 UI flow

Board tab → **Import checklist** → paste Doc URL → `GET /api/checklist/preview?url=…` (server fetches + parses) → shows counts (`+ 8 sections, + 41 steps, + 96 hints`) + `warnings` → **Load into editor** (populates the Board editor unsaved) → review → **Save**.

`/api/checklist/preview` is guarded: an unreachable Doc / permission error → 200 with `{ error: "…", sections:[], … }` so the UI shows a clean message.

---

## 10. Testing

`node --test`, no hardware, no Google, `spawn` and the Drive fetch faked.

| Unit | Coverage |
|---|---|
| `config-schema` | new section/step/hint/flag/audio rules; unique-id enforcement; `sectionId` resolution; `audio`⇒`mediaRef`, `text`⇒`text`; `hintGroups`→`steps` migration yields valid config |
| `progress` | `startGame` clears; `markGiven` first-only; `solveStep` on/off events with `elapsedMs` + `clueToSolveMs`; section-complete derivation from snapshot; `snapshot` shape |
| `media-library` | `list` joins fs + table, flags `missing`; `save` path-traversal guard + extension allow-list; `delete` refused with `{ inUse:[stepId…] }` when referenced; `move` rewrites refs; `setMeta` upsert; `usage` |
| `audio-player` | fake `spawn`: `playMusic` kills prior music child; `stopMusic` leaves effects; `stopAll` kills both; missing file → `audio-error`, no throw; no binary → no-op + `audio-unavailable`; every call logs an event; `ref` escaping `mediaRoot` → `audio-error` |
| `game-engine` | audio events fire on start/escaped/reset/midShow via a fake `audioPlayer` (assert the calls); clue chime skipped for `type:'audio'`; new `/cmd` types (`play-hint`, `solve-step`, `set-flag`, `stop-audio`) route to `progress`/`audioPlayer` and record events; guards hold |
| `checklist-import` | `parseChecklist` against fixtures cut from the three real Docs → expected section/step/hint counts, specific rows, `warnings` on ambiguous lines; re-import keeps ids by name-match |
| `renderBoard` | pure `(config, state) → DOM/HTML`: solved step collapses; section header count; audio pad shows 🎧; keyless pad keeps a click handler; Ungrouped bucket; flags row |
| `web` | `/api/media/*`, `/api/checklist/preview`, new `/cmd` types; guards (bad path → 4xx not 500; unreachable Doc → clean 200) |
| integration smoke | boot with fakes → import a Doc fixture → run a game: show a text hint (chime + `hint-given`), play an audio hint, solve two steps, `escaped` → assert `events` rows + section timing |

---

## 11. Build order (sub-milestones)

Each is independently shippable and green. 1–3 have no dependency on one another.

1. **Data model + migration** — `config-schema` changes; `hintGroups → steps`; retire the old hint-list / Hotkeys-tab-from-`hintGroups` code path (re-point the mirror at `steps`). No new behaviour. Ships green.
2. **Media library** — `src/media-library.js`, `media` table, `/api/media/*`, `public/media.html`. Standalone.
3. **Audio player** — `src/audio-player.js`, `setup-pi.sh` deps. Verified on the Pi (`playEffect` / `playMusic` / `stopAll` out the jack).
4. **Progress module** — `src/progress.js`, game-engine composition, SSE `state.{steps,flags}`, new `/cmd` types. No operator UI yet.
5. **Operator board** — `renderBoard`, panel replacement, Solved toggle + collapse, flags row, stop-audio button.
6. **Global audio events** — game-engine transitions → `audioPlayer`; strip `game.js` browser audio.
7. **Config Board tab** + Audio Events card + media-picker modal.
8. **Checklist importer** — `src/checklist-import.js`, `/api/checklist/preview`, Board-tab import flow, Drive-export read.

---

## 12. Open items (resolve during planning / early sub-milestones)

1. **Pi → room speakers wiring** — D2-a assumes the Pi's 3.5mm jack (or a USB/HDMI audio device) reaches the room amp. Confirm the physical path and the ALSA default device before sub-milestone 3; `setup-pi.sh` may need `amixer`/`.asoundrc` setup.
2. **Drive API scope + doc sharing** — the checklist Docs must be shared with `htm-tracker-service@hour-to-midnight-tracker.iam.gserviceaccount.com`; the project must have the **Google Drive API** enabled (prior notes say it is). Confirm before sub-milestone 8.
3. **`renderBoard` output form** — DOM fragment vs HTML string. Pick during sub-milestone 5 for testability; leaning HTML string + a thin bind pass, matching how `renderModel` is structured.
4. **`ffplay` vs `aplay` for `.ogg`/`.wav`** — decide at sub-milestone 3 with the actual asset set; `mpg123` covers `.mp3` which is the bulk.
5. **Old `hintGroups` removal release** — one release of fallback, then delete the migration + allow-list entry. Track it.
