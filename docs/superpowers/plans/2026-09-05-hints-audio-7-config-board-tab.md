# Hints & Audio Sub-milestone 7: Config Board Tab + Audio Events Card + Media Picker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the operator a real editor for the sub-milestone-1 data model: a "Board" config tab (replacing "Hint Groups") with a Sections → Steps → Hints three-level editor plus a Flags list, an "Audio Events" card for the six global cues, and a media-picker that reuses the existing `media.html?pick=1` modal to attach `mediaRef`/event files. Save writes `config.sections` / `config.steps` / `config.progress` / `config.audio` through the existing merge-`POST /config`. Re-point the Google Sheets "Hotkeys" mirror at `steps` now that the UI owns them.

**Architecture:** `public/config-board.js` is a new pure module (same convention as `public/board.js` / `public/media.js`): `renderBoardEditor` / `renderAudioEventsCard` return HTML strings, `collectBoardConfig` / `collectAudioEvents` take a plain JS object (the browser reads the DOM into it) and return a normalized config fragment with deterministic ids assigned. `public/config.html`'s script does the DOM read + wiring. The picker is `window.open('media.html?pick=1')` + a `message` listener (sub-milestone 2 already built `media.html`'s inert `?pick=1` sender). `src/sheets.js`'s `syncHotkeysTab` switches from the (now-legacy) `buildHotkeysRows(hintGroups)` to `buildHotkeysRowsFromSteps(steps)` — the helper that sub-milestone 1 landed unused for exactly this moment.

**Tech Stack:** No new dependency. Browser: plain DOM + `window.open`/`postMessage`. `config-schema.js` (sub-milestone 1) already validates `sections`/`steps`/`progress`/`audio`; the server's `ALLOWED_TOP_LEVEL` (sub-milestone 1) already permits them; `game-engine` (sub-milestone 6) already consumes `config.audio.events`/`.steps`. So the backend is ready — this is almost entirely the editor UI plus one small `sheets.js` re-point.

**Spec:** `docs/superpowers/specs/2026-08-30-hints-and-audio-design.md`, §8 (Config page) — §8.1 Board tab, §8.2 Media Library page (the page exists; this wires it as a picker), §8.3 Audio Events card, §8.4 Sheets tab help line. Also §2.2 (field rules / id generation) and §2.3 (`hintGroups` left untouched as a one-release fallback). Build-order item 7 from §11.

## Global Constraints

- No new npm dependency.
- **`hintGroups` is NOT touched.** Spec §2.3: "left in the file untouched for one release as a fallback." The Board tab writes `sections`/`steps`/`progress`/`audio`; it must NOT write, delete, or overwrite `hintGroups`. In `config.html`'s save handler, this means: remove the `merged.hintGroups = readGroupsFromDOM()` line entirely (so the existing `merged = { ...base }` spread carries the on-disk `hintGroups` through unchanged) and add the new `merged.sections` / `merged.steps` / `merged.progress` / `merged.audio` assignments.
- **Deterministic id generation** (spec §2.2 / §2.5): ids are stable app-generated strings. `collectBoardConfig` assigns an id to any section/step/hint that arrives WITHOUT one (a newly-added editor row), and PRESERVES an existing id (an edited row that was loaded from config). Use the same scheme sub-milestone 1's migration used — read `src/config-migrate.js` to match it exactly: sections `sec_<slug-or-counter>`, steps `step_<n>` / `step_<slug>`, hints `<stepId>_h<n>`. Ids must stay unique within their kind across the whole collection (the schema enforces this — `collectBoardConfig` must produce config that passes `validateConfig`, or the merge-POST is rejected and the save silently fails).
- **`config.steps` hint shape** (spec §2.1/§2.2, validated by `config-schema.js`): `{ id, type: 'text'|'audio', text? (required non-empty for text), mediaRef? (required non-empty for audio), label?, color?, icon?, key?, countsAsClue? (default true) }`. A `step` is `{ id, name, order, sectionId (null/omitted = ungrouped), hints[] }`. A `section` is `{ id, name, order, note? }`. `progress` is `{ flags: string[] }`. `audio` is `{ volume: 0..1, events: { <name>: { file, enabled, atSecondsRemaining? } } }`.
- **`audio.events` names** (exactly these six, in this display order): `start`, `loop`, `midShow`, `win`, `lose`, `clueChime`. `midShow` alone also carries `atSecondsRemaining` (a positive number, required by the schema only when `midShow.enabled` — so the editor must always emit a number there when the checkbox is on).
- **The media picker** reuses the EXISTING `public/media.html` in `?pick=1` mode (sub-milestone 2). That mode already `postMessage`s `{ type: 'media-picked', path }` to `window.opener` and closes itself — do NOT modify `media.html`. `config.html` opens it with `window.open('media.html?pick=1', 'mediapick', 'width=900,height=800')`, tracks WHICH field requested the pick (the audio-hint `mediaRef` input, or one of the six event `file` inputs), and on the `message` event writes `e.data.path` into that field (validate `e.data && e.data.type === 'media-picked' && typeof e.data.path === 'string'` before using it; ignore messages that don't match — a `message` listener receives cross-origin junk).
- **"Import checklist" button** (spec §8.1) is PRESENT in the Board tab UI but its click handler is a stub: disabled/greyed with a `title="Coming in the next release"` (the real Doc-import flow is sub-milestone 8). Do not wire `/api/checklist/preview` — that endpoint doesn't exist yet.
- **`sheets.js` re-point:** `syncHotkeysTab` currently does `const rows = buildHotkeysRows(config.current().hintGroups);`. Change to `const rows = buildHotkeysRowsFromSteps(config.current().steps);` (the helper already exists and is exported — sub-milestone 1). The `Group | Hint | Hotkey` column contract is unchanged (spec §2.3: "Group" = step name, one row per hint, audio hints show their `label`). Update the corresponding test in `test/sheets.test.js` (the one that currently asserts `syncHotkeysTab` sources from `hintGroups`) to assert it now sources from `steps`.
- Existing `config.html` behavior that must NOT regress: the General/Sheets/Hotkeys/Reference tabs, the tab-switching JS, the `currentCfg` merge-preserve pattern (keys the page doesn't own — `plcs`, `signals`, etc. — survive a save), the volume slider display, the Sheets tab-picker dropdowns.

---

### Task 1: `public/config-board.js` — pure editor render + collect

**Files:**
- Create: `public/config-board.js`
- Test: `test/config-board.test.js`

**Interfaces:**
- Consumes: nothing at runtime (pure). Its output SHAPES must match `src/config-schema.js`'s validation and `src/config-migrate.js`'s id scheme — read both first.
- Produces: from `public/config-board.js` (dual export guard — copy `public/board.js`'s exact pattern):
  - `renderBoardEditor(config) → string` — HTML for the Board tab's editor body: a block per section (name input, note textarea, ▲▼ reorder + delete controls, a nested list of its steps), an "Ungrouped" block for steps with no `sectionId`, each step showing a name input + a section-`<select>` (to move it) + ▲▼/delete + a nested hint list, each hint row showing a Text|Audio type toggle, a text input (text hints) OR a media-picker button + chosen-`mediaRef` display + `label`/`color`/`icon` inputs (audio hints), a `key` capture, a "counts as clue" checkbox, and ▲▼/delete. Plus a "Flags" editable string list, an "+ Add Section" / "+ Add Step (ungrouped)" button, and the stubbed "Import checklist" button. Every editable element carries `data-*` attributes so a generic DOM-read can reconstruct the nested structure (e.g. `data-role="section"|"step"|"hint"|"flag"`, `data-field="name"|"note"|"text"|"mediaRef"|...`, and existing items carry `data-id="<their id>"`).
  - `renderAudioEventsCard(config) → string` — HTML for the Audio Events card: the six event rows (`start`/`loop`/`midShow`/`win`/`lose`/`clueChime`), each with an `enabled` checkbox + a file display + a media-picker button; `midShow` additionally an "at N seconds remaining" number input. Plus the existing volume slider is understood to live elsewhere (General tab) — this card is events only; `collectAudioEvents` still returns `volume` passed through from the input object so the caller has one place to assemble `config.audio`.
  - `collectBoardConfig(state) → { sections, steps, progress }` — `state` is a plain object the browser builds by walking the editor DOM: `{ sections: [{ id?, name, note, order }], steps: [{ id?, name, sectionId (id-or-null), order, hints: [{ id?, type, text, mediaRef, label, color, icon, key, countsAsClue }] }], flags: string[] }`. Returns config-shaped `{ sections, steps, progress: { flags } }` with: ids assigned to id-less items and preserved otherwise; `order` renumbered 1..n by array position within each scope; empty-name sections dropped; steps with an empty name AND no hints dropped; hints with no usable content dropped (text hint with blank `text`, audio hint with blank `mediaRef`); `sectionId` set to `null` when it doesn't resolve to a kept section's id; `countsAsClue` defaulting to `true` when absent; audio-hint presentation fields (`label`/`color`/`icon`) omitted when blank. The result MUST pass `validateConfig` (globally-unique ids, resolvable `sectionId`s, `text`⇒non-empty text, `audio`⇒non-empty `mediaRef`).
  - `collectAudioEvents(state) → { volume, events }` — `state` is `{ volume: number (0..1), events: { <name>: { file, enabled, atSecondsRemaining? } } }`. Returns `{ volume: clamped 0..1, events: {...} }` with each of the six event names present; `file` trimmed; `enabled` coerced to bool; `midShow.atSecondsRemaining` coerced to a positive integer (default e.g. 120 when enabled but unset — never emit `enabled:true` without a valid number, or the schema rejects it); an event with `enabled:false` may still carry its `file` (so toggling back on doesn't lose the path).

- [ ] **Step 1: Read `src/config-schema.js` (the `sections`/`steps`/`hints`/`progress`/`audio` validation), `src/config-migrate.js` (the id scheme + the drop-empty-hint filter), and `public/board.js` (the dual-export guard + `esc()` helper convention).** Match all three.

- [ ] **Step 2: Write the failing tests**

Create `test/config-board.test.js`. Cover at minimum:
- `collectBoardConfig` assigns ids to id-less items, preserves existing ids, and the output passes `require('../src/config-schema.js').validateConfig` (import it and assert `.ok`).
- Deterministic ids: the same input `state` twice → identical ids both times.
- `order` renumbered 1..n by position; a step moved to a different `sectionId` lands in that section; an unresolvable `sectionId` → `null` (ungrouped).
- Drop rules: empty-name section dropped; blank-text text-hint dropped; blank-`mediaRef` audio-hint dropped; a step with no name and no surviving hints dropped.
- `countsAsClue` defaults to `true`; audio-hint blank `label`/`color`/`icon` omitted from output.
- `progress.flags` = the trimmed non-empty flag strings, in order, deduped-or-not (pick one and test it — spec doesn't require dedupe, so keep duplicates but drop blanks).
- `collectAudioEvents`: all six names present; `midShow.enabled` true ⇒ `atSecondsRemaining` is a positive integer (default applied when unset); `volume` clamped; a disabled event keeps its `file`.
- `renderBoardEditor(config)` output: contains each section name, step name, hint text, an audio hint's picker button + `mediaRef`, the flags, `data-role`/`data-id` attributes on existing items, and the stubbed (disabled) Import button. `renderBoardEditor({})` (empty config) renders the add-section/add-step buttons and an empty-state hint, not a crash.
- `renderAudioEventsCard(config)`: the six rows, `midShow`'s number input, each row's picker button; reflects `enabled`/`file` from config.

- [ ] **Step 3: Run to verify failure**

Run: `node --test test/config-board.test.js`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `public/config-board.js`**

Follow `public/board.js`'s structure (an `esc()` helper, small `render*` sub-functions composed into the exported ones, a dual-export guard exposing `window.ConfigBoard = {...}` in the browser and `module.exports` in Node). Keep `collectBoardConfig`/`collectAudioEvents` PURE — no DOM, no `document`. The id-assignment helper mirrors `config-migrate.js`'s scheme (read it in Step 1). Emit `data-*` attributes rich enough that `config.html`'s DOM-read (Task 2) can rebuild the `state` object without guessing.

- [ ] **Step 5: Run tests, fix, verify pass**

Run: `node --test test/config-board.test.js` → PASS.

- [ ] **Step 6: Run the whole suite**

Run: `node --test "test/**/*.test.js"` → PASS, no regressions.

- [ ] **Step 7: Commit**

```bash
git add public/config-board.js test/config-board.test.js
git commit -m "feat(config): public/config-board.js — pure Board/Audio-Events editor render + collect"
```

---

### Task 2: `public/config.html` — Board tab, Audio Events card, media picker wiring

**Files:**
- Modify: `public/config.html`
- Test: none new that's automatable (config.html has no DOM test harness, consistent with the rest of this codebase's `.html` pages — the pure logic is in Task 1's `config-board.js` with its own tests). The regression guard is the full suite still passing + a manual smoke check.

**Interfaces:**
- Consumes: `renderBoardEditor` / `renderAudioEventsCard` / `collectBoardConfig` / `collectAudioEvents` from Task 1 (loaded via a `<script src="config-board.js">` tag added BEFORE the inline script, exposing `window.ConfigBoard` — mirror how sub-milestone 5 added `<script src="board.js">` to `operator.html`).
- Produces: the "Hint Groups" tab renamed to "Board" and its body swapped to the new editor; an "Audio Events" card added (to the General tab, near the volume slider, or its own `.card` — implementer's call, match the page's existing `.card`/`.tab-panel` structure); the save handler writing `sections`/`steps`/`progress`/`audio` instead of `hintGroups`; the media-picker modal wired; the §8.4 Sheets help line added.

- [ ] **Step 1: Read `public/config.html` end to end** — the tab markup (`#config-tabs`, `data-tab`/`data-panel`), the `hints` panel (`#groups-container`, `#btn-add-group`, `#btn-import-hotkeys`), `makeGroupCard`/`makeHintRow`/`readGroupsFromDOM`, `populateForm`, the `save-btn` handler, `currentCfg`, `fetchConfig`/`saveConfig`, and the volume slider wiring. Note the exact `.card` / `.field` / `.hint-note` class conventions and the tab-panel show/hide mechanism.

- [ ] **Step 2: Add the `<script src="config-board.js">` tag** before the inline `<script>` (so `window.ConfigBoard` exists when the inline script runs).

- [ ] **Step 3: Rename the tab and swap the panel body**

- `#config-tabs`: change `<button class="tab-btn" data-tab="hints">Hint Groups</button>` → `data-tab="board">Board`.
- The `<div class="tab-panel" data-panel="hints">` → `data-panel="board">`, and replace its inner card content (the "Hint Groups & Hints" heading, the `#groups-container`, the add/import buttons) with a container the inline script fills via `ConfigBoard.renderBoardEditor(currentCfg)`. Keep it inside a `.card` matching the page style. Rewrite the help text to describe Sections/Steps/Hints instead of Groups.
- Remove `makeGroupCard` / `makeHintRow` / `readGroupsFromDOM` and their event wiring (`#btn-add-group`, `#btn-import-hotkeys`, the group-container logic) — they're superseded. (Keep `makeKeyCapture` / `formatKey` — the new hint rows reuse key capture.)

- [ ] **Step 4: Wire the Board editor's interactivity**

After `renderBoardEditor` fills the container: a delegated listener on the container handles add-section / add-step / add-hint / delete / reorder (▲▼) / type-toggle (Text↔Audio) clicks by mutating a working copy of the editor `state` and re-rendering (simplest and matches how sub-milestone 5's board re-renders wholesale), OR by direct DOM manipulation of the rendered rows — implementer's call, but the wholesale-re-render approach is less bug-prone for nested reorder. On any of these, and on the media-pick callback, keep an in-memory `boardState` object in sync. `populateForm` seeds `boardState` from `currentCfg` and calls `renderBoardEditor`.

- [ ] **Step 5: Add the Audio Events card + wire it**

Render `ConfigBoard.renderAudioEventsCard(currentCfg)` into a new `.card` on the General tab. Wire its six media-picker buttons and the `midShow` number input into an in-memory `audioState`. The existing volume slider (`#volume`) continues to own `config.audio.volume` (it currently writes `merged.game.volume` — ALSO write `merged.audio.volume` now; keep `game.volume` too for backward-compat this release, matching the `hintGroups` fallback philosophy — or, if `game.volume` is unused post-sub-milestone-6, note that and drop it. Check `src/game-engine.js` / `src/config-schema.js` for whether `game.volume` still matters; sub-milestone 6 made `game-engine` read `config.audio.volume` for restore-on-boot, so `audio.volume` is now the source of truth — keep writing `game.volume` too for one release unless the reviewer disagrees).

- [ ] **Step 6: Media picker modal**

A single helper: `openMediaPicker(onPick)` → `window.open('media.html?pick=1', 'mediapick', 'width=900,height=800')` and stash `onPick`. One top-level `window.addEventListener('message', e => { if (!e.data || e.data.type !== 'media-picked' || typeof e.data.path !== 'string') return; if (pendingPick) { pendingPick(e.data.path); pendingPick = null; } })`. Each picker button (audio-hint `mediaRef`, and the six event `file`s) calls `openMediaPicker(path => { /* write path into boardState/audioState + re-render */ })`.

- [ ] **Step 7: Update the save handler**

In the `save-btn` click handler: remove `merged.hintGroups = readGroupsFromDOM();`. Add:

```js
const board = ConfigBoard.collectBoardConfig(readBoardStateFromDOM()); // or from the in-memory boardState
merged.sections = board.sections;
merged.steps    = board.steps;
merged.progress = { ...(base.progress || {}), ...board.progress };
const audioEv   = ConfigBoard.collectAudioEvents(readAudioStateFromDOM());
merged.audio    = { ...(base.audio || {}), volume: parseInt(volSlider.value)/100, events: audioEv.events };
```

(Do NOT set `merged.hintGroups` at all — the `{ ...base }` spread preserves the on-disk value.)

- [ ] **Step 8: §8.4 Sheets tab help line**

Add one line to the Sheets tab's "what data goes where" help block: per-step clue-given / solved times log to the local event store (and mirror to the Hotkeys / a checklist tab if configured). Match the surrounding `<p>`/`.hint-note` style.

- [ ] **Step 9: Manual smoke check**

`npm start`; open `http://localhost:4000/config.html`:
- Board tab renders (from whatever `config.steps` holds — likely migrated ungrouped steps).
- Add a section, add a step under it, add a text hint and an audio hint; click the audio hint's media picker → `media.html?pick=1` opens → pick a file (upload a small `.mp3` first if the library is empty) → the modal closes and the path lands in the field.
- Add a flag. Save. Reload the page → the sections/steps/hints/flags/audio-events all round-trip.
- General tab: the Audio Events card shows six rows; toggle `start` on, pick a file, set `midShow` to 90s, Save, reload → persisted.
- Confirm the General/Sheets/Hotkeys/Reference tabs still work and a Save doesn't wipe `plcs`/`signals` (check the saved `config.json` on disk still has them).

Report honestly whether this was performed (non-interactive environments can't).

- [ ] **Step 10: Run the whole suite + commit**

Run: `node --test "test/**/*.test.js"` → PASS.

```bash
git add public/config.html
git commit -m "feat(config): Board tab + Audio Events card + media picker, save writes sections/steps/progress/audio"
```

---

### Task 3: Re-point `sheets.js` Hotkeys mirror at `steps`

**Files:**
- Modify: `src/sheets.js`
- Test: `test/sheets.test.js` (update the existing `syncHotkeysTab` source test)

**Interfaces:**
- Consumes: `buildHotkeysRowsFromSteps(steps)` — already exists and is exported from `src/sheets.js` (sub-milestone 1 landed it unused for exactly this).
- Produces: `syncHotkeysTab` reads `config.current().steps` instead of `config.current().hintGroups`. No signature change.

- [ ] **Step 1: Read `src/sheets.js`'s `syncHotkeysTab` and `buildHotkeysRowsFromSteps`**, and the `test/sheets.test.js` test currently named something like `'syncHotkeysTab sources its rows from config.hintGroups, not steps'` (sub-milestone 1's fix-wave renamed it to that).

- [ ] **Step 2: Change the one line**

In `syncHotkeysTab`: `const rows = buildHotkeysRows(config.current().hintGroups);` → `const rows = buildHotkeysRowsFromSteps(config.current().steps);`

- [ ] **Step 3: Update the test**

Flip the sub-milestone-1 test to assert `syncHotkeysTab` now sources from `config.steps` (a fake config with `steps` populated and `hintGroups` populated with DIFFERENT content → assert the rows written match the `steps` content, not the `hintGroups` content). Keep `buildHotkeysRows` and its own tests (still exported, now genuinely legacy — a comment noting it's kept for the one-release `hintGroups` fallback is fine).

- [ ] **Step 4: Run the whole suite**

Run: `node --test "test/**/*.test.js"` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sheets.js test/sheets.test.js
git commit -m "feat(sheets): syncHotkeysTab now mirrors config.steps (config UI owns steps)"
```

---

## Self-Review Notes (for the plan author, not a task)

- **Spec coverage:** §8.1's Board tab (Sections/Steps/Hints editor + Flags list + stubbed Import button) is Task 1 (`renderBoardEditor`/`collectBoardConfig`) + Task 2 (wiring); §8.2's "reused as a modal by the Board tab (`?pick=1`)" is Task 2 Step 6 (the page itself already exists from sub-milestone 2 — unchanged); §8.3's Audio Events card is Task 1 (`renderAudioEventsCard`/`collectAudioEvents`) + Task 2 Step 5; §8.4's help line is Task 2 Step 8; §2.3's "`hintGroups` untouched" is the top Global Constraint; the `steps`-sourced Hotkeys mirror (§2.3) is Task 3.
- **Clears deferrals:** sub-milestone 1's "`buildHotkeysRowsFromSteps` landed unused for a future sub-milestone once the config UI edits `steps`" — that sub-milestone is this one (Task 3). Sub-milestone 5's Ruling F (cross-level collapse precedence in the *operator* board) is display-only and does NOT apply to this editor — no interaction.
- **Not in scope:** the checklist importer (`src/checklist-import.js`, `/api/checklist/preview`, the real Import flow) — that's sub-milestone 8; the Import button here is a visible stub only. `game.volume` cleanup — flagged as a "keep for one release" judgment call for the reviewer, not resolved here.
- **Type/name consistency:** `collectBoardConfig`'s output must pass `src/config-schema.js`'s `validateConfig` (Task 1 Step 2 asserts this directly); the id scheme must match `src/config-migrate.js` (Task 1 Step 1 mandates reading it); the six `audio.events` names must match `game-engine.js`'s `audioEvents()` lookups (sub-milestone 6) and `config-schema.js`'s validation exactly — a name typo here produces an editor that writes events `game-engine` never reads.
