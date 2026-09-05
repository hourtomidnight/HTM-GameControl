# Hints & Audio Sub-milestone 5: Operator Board — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the operator console's flat hint-groups panel with a progress board rendered from `config.sections`/`config.steps` and the SSE `state.{steps,flags}` payload (both already wired by sub-milestone 4): a Solved toggle per step that collapses/expands it, an auto-collapsing section header with a solved count, a click-to-flag row, and a Stop Audio button — laid out per spec §7.1's ASCII mockup.

**Architecture:** `public/board.js` is a new pure module following the SAME pattern as `public/operator.js`'s `commandFor` and `public/media.js`'s `renderFileList`: exported functions with zero DOM/fetch access, unit-tested under `node --test`. `renderBoard(config, state, uiState)` returns an HTML string (the plan's own scope ruling below explains why, over a plain-object `renderModel`-style return). `public/operator.html`/`public/operator.js` gain the thin browser-side bind pass — one delegated click listener reading `data-*` attributes off the rendered markup, translating them to `/cmd` payloads via a second pure helper, `commandForBoardAction`.

**Tech Stack:** No new dependency. Browser-side `localStorage` for collapse-state persistence (matching the existing column-divider position, which the codebase already persists the same way — read `public/operator.html`'s existing `col-divider` drag logic in `operator.js`/inline script before writing the new persistence code, to match its exact `localStorage` key-naming and read/write style).

**Spec:** `docs/superpowers/specs/2026-08-30-hints-and-audio-design.md`, §7 (Operator console) and its testing row in §10 (`renderBoard`). This plan implements build-order item 5 from §11 ("Operator board — `renderBoard`, panel replacement, Solved toggle + collapse, flags row, stop-audio button").

## Global Constraints

- No new npm dependency; pure functions in `public/board.js`, DOM/fetch wiring confined to `public/operator.html`'s script (or a browser-only branch of `board.js`, matching whichever convention `public/media.js` actually used — read it first).
- **Scope ruling (decided here, since a real conflict exists between spec §11's build order and §7.4's command semantics — recorded for the final review to verify against, not a gap):** this sub-milestone builds the board's RENDERING and CLICK-DISPATCH only. Two consequences follow directly from sub-milestone 4's own scope ruling (that `play-hint`/`stop-audio` command handling needs `audioPlayer` composed into `game-engine`, deferred to sub-milestone 6):
  1. An audio hint pad's click posts `{ type:'play-hint', stepId, hintId }` and the Stop Audio button posts `{ type:'stop-audio' }` — both land on `game-engine.command(msg)`, which has no matching branch for either type yet, so both are silent no-ops today (verified by a test in Task 2, since `command()`'s dispatch chain has no default/catch-all case and simply returns `undefined` for an unrecognized type without side effects or a crash — this is already how the codebase treats any unrecognized command, not a new risk introduced here).
  2. The Ctrl-click "silent clue" override and per-hint `countsAsClue:false` clue-counter suppression (spec §7.2) require `game-engine` to consult `config.steps` at command time to know a hint's `countsAsClue` value — `game-engine` does not currently take a `config` dependency at all. Wiring that in is entangled with sub-milestone 6's "Global audio events" work (the same pass that gives `game-engine` its `audioPlayer`/`config` awareness for hint-triggered chimes). This plan's text hint pads use the already-existing (sub-milestone 4) `show-hint` command exactly as it stands today — unconditional `clueCount++`, no `countsAsClue` awareness yet. This is a known, accepted interim behavior, not silently dropped: it is called out explicitly in this plan and must be re-verified as resolved when sub-milestone 6 lands.
  - **Cost if this ruling is wrong:** none of the deferred behavior is currently reachable by any existing caller (there is no board UI before this plan), so nothing regresses — the worst case is that an operator's audio hint clicks and Stop Audio clicks visually flash but do nothing, and every hint (regardless of a future `countsAsClue:false` setting) increments the clue counter, until sub-milestone 6 ships. Both are cosmetic/UX gaps, not data-loss or crash risks.
- `renderBoard`'s output-form ruling (spec §12 item 3 left this open, "leaning HTML string + a thin bind pass, matching how `renderModel` is structured"): this plan rules **HTML string**, matching `public/media.js`'s `renderFileList` convention (already shipped in this exact codebase, sub-milestone 2) — not `public/game.js`'s `renderModel`, which returns a plain data object bound field-by-field. A nested sections→steps→hints tree with collapse state is a better fit for one HTML-string render + `innerHTML` replacement + one delegated click listener than a field-by-field DOM diff, and it keeps this plan consistent with the one nested-structure precedent this codebase already has.
- Section auto-collapse ("collapses when 3/3", spec §7.2) is computed BY `renderBoard` from `state.steps` (a section is complete when every step with that `sectionId` has a non-null `solvedAt` — same derivation rule spec §5.1 assigns to "the UI"), but MANUAL collapse/expand always overrides the computed default — `uiState.collapsedSections`/`uiState.collapsedSteps` (explicit per-id booleans set by a user click) take precedence over the auto-computed "complete → collapsed" default. This mirrors the ASCII mockup's "▸ Book Puzzle ✓ (solved → collapsed one-liner, still expandable)".
- Hint pads: background `hint.color` (fallback to a theme color already used elsewhere in `operator.html`'s CSS — read it first, pick the existing accent color rather than inventing a new one), a `key` badge (reusing the existing `.hint-key-badge`/`.no-key` CSS classes already defined for the old flat panel — do not invent new class names for the same visual role), a type icon (🎧 for `type:'audio'`, none/blank for `type:'text'`), `label` (for audio) or `text` (for text) as the pad's main content. Keyless pads remain fully clickable (matching the old panel's existing keyless-pad behavior).
- Flags row: one checkbox per `config.progress.flags[]` string, posting `{ type:'set-flag', name, on }` on toggle.
- The old flat hint-groups panel (`#hints-list`, `buildHints()`, `.hint-group`/`.hint-group-header`/`.hint-group-body` DOM construction in `public/operator.js`) is REPLACED, not kept alongside the new board — `hintGroups` is still the on-disk fallback per sub-milestone 1's migration (untouched), but the operator UI now renders exclusively from `config.sections`/`config.steps`. A config with only legacy `hintGroups` and no `steps` yet will show an empty board until migration/config-editing catches up — this is acceptable because sub-milestone 1's `config.js` `load()` already migrates `hintGroups` → `steps` automatically at every boot (see `src/config-migrate.js`), so by the time this UI ships, any config the server has ever loaded once already has `steps` populated.

---

### Task 1: `public/board.js` — pure `renderBoard` + `commandForBoardAction`

**Files:**
- Create: `public/board.js`
- Test: `test/board-render.test.js`

**Interfaces:**
- Consumes: nothing from earlier sub-milestones directly (pure function of plain data) — but its INPUT SHAPES must match what `config.sections`/`config.steps` (sub-milestone 1) and SSE `state.steps`/`state.flags` (sub-milestone 4) actually look like. Read `src/config-schema.js`'s validation rules and `src/progress.js`'s `snapshot()` shape before writing this, to confirm the exact field names (`section.id/name/order/note`, `step.id/name/order/sectionId/hints[]`, `hint.id/type/text/mediaRef/label/color/icon/key/countsAsClue`, `state.steps[stepId] = {clueGivenAt, solvedAt}`, `state.flags[name] = tsOrNull`).
- Produces: from `public/board.js` (dual export guard — copy whichever exact pattern `public/operator.js`/`public/media.js` uses, read one of them first):
  - `renderBoard(config, state, uiState = {}) → string` — full HTML for the board container's `innerHTML`, including the flags row at the bottom. `uiState = { collapsedSections: { [id]: bool }, collapsedSteps: { [id]: bool } }` — an explicit `true`/`false` entry overrides the auto-computed default; an absent entry uses the auto-computed default (sections: collapsed when complete; steps: collapsed when solved).
  - `isSectionComplete(sectionId, steps, stateSteps) → bool` — exported separately so it's independently testable: every `step` in `steps` with `step.sectionId === sectionId` has `stateSteps[step.id]?.solvedAt != null`. A section with zero matching steps is NOT "complete" (return `false` — an empty section shouldn't render as solved).
  - `commandForBoardAction(action, dataset) → object|null` — pure mapping from a clicked element's `data-action` value plus its `dataset` (a plain object, e.g. `{ stepId, hintId, name }`) to a `/cmd` payload: `'show-hint'` → `{ type:'show-hint', text, stepId, hintId }` (the `text` value itself must be read from the hint's own `text` field by the CALLER before invoking this — `commandForBoardAction` takes it as part of `dataset.text` for a text hint, since this function has no access to `config` to look it up itself; document this clearly since it's a slightly awkward but necessary consequence of keeping the function pure), `'play-hint'` → `{ type:'play-hint', stepId, hintId }`, `'toggle-solved'` → `{ type:'solve-step', stepId, on: dataset.on === 'true' }`, `'set-flag'` → `{ type:'set-flag', name, on: dataset.on === 'true' }`, `'stop-audio'` → `{ type:'stop-audio' }`. An unrecognized `action` returns `null` (matching `operator.js`'s existing `commandFor`'s `null`-on-miss convention).

- [ ] **Step 1: Read `src/config-schema.js`, `src/progress.js`, and either `public/operator.js` or `public/media.js`'s export-guard pattern**, to confirm every field name and the dual-export style before writing any test or implementation code.

- [ ] **Step 2: Write the failing tests**

Create `test/board-render.test.js` (the implementer fills in exact field names per Step 1's findings — the shapes below are illustrative of the required BEHAVIOR, not a verbatim final API to copy blindly if Step 1 turns up a naming mismatch against the real `config-schema.js`/`progress.js`):

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderBoard, isSectionComplete, commandForBoardAction } = require('../public/board.js');

function cfg() {
  return {
    sections: [{ id: 'sec_desk', name: 'Desk', order: 1, note: '' }],
    steps: [
      { id: 'step_1', name: 'Briefcase', order: 1, sectionId: 'sec_desk', hints: [
        { id: 'h1', type: 'text', text: 'Look under the desk', key: 'F1', countsAsClue: true },
        { id: 'h2', type: 'audio', mediaRef: 'a.mp3', label: 'Clue 2', color: '#4a8aff', icon: '🎧', key: 'F2' },
      ]},
      { id: 'step_2', name: 'Pendant', order: 1, sectionId: null, hints: [] },
    ],
    progress: { flags: ['Translation given'] },
  };
}

test('isSectionComplete is true only when every step in that section is solved', () => {
  const steps = cfg().steps;
  assert.equal(isSectionComplete('sec_desk', steps, {}), false);
  assert.equal(isSectionComplete('sec_desk', steps, { step_1: { solvedAt: 123 } }), true);
});

test('isSectionComplete is false for a section with no matching steps', () => {
  assert.equal(isSectionComplete('sec_empty', [], {}), false);
});

test('renderBoard shows section name, step name, hint text, and key badge', () => {
  const html = renderBoard(cfg(), { steps: {}, flags: {} });
  assert.match(html, /Desk/);
  assert.match(html, /Briefcase/);
  assert.match(html, /Look under the desk/);
  assert.match(html, /F1/);
});

test('renderBoard shows an audio hint pad with its label and the 🎧 icon', () => {
  const html = renderBoard(cfg(), { steps: {}, flags: {} });
  assert.match(html, /Clue 2/);
  assert.match(html, /🎧/);
});

test('a step with no sectionId renders under an Ungrouped bucket', () => {
  const html = renderBoard(cfg(), { steps: {}, flags: {} });
  assert.match(html, /Ungrouped/);
  assert.match(html, /Pendant/);
});

test('a solved step collapses to a one-liner by default (auto-collapse)', () => {
  const html = renderBoard(cfg(), { steps: { step_1: { clueGivenAt: null, solvedAt: 999 } }, flags: {} });
  // The full hint text should not be visible in a collapsed solved step's default render.
  assert.doesNotMatch(html, /Look under the desk/);
});

test('an explicit uiState override re-expands a solved step', () => {
  const html = renderBoard(
    cfg(),
    { steps: { step_1: { clueGivenAt: null, solvedAt: 999 } }, flags: {} },
    { collapsedSteps: { step_1: false } }
  );
  assert.match(html, /Look under the desk/);
});

test('a section auto-collapses when every one of its steps is solved', () => {
  const html = renderBoard(
    { sections: cfg().sections, steps: [cfg().steps[0]], progress: { flags: [] } },
    { steps: { step_1: { solvedAt: 999 } }, flags: {} }
  );
  // Section body content (the step name) should not render when auto-collapsed.
  assert.doesNotMatch(html, /Briefcase/);
});

test('renderBoard renders a flags row from config.progress.flags', () => {
  const html = renderBoard(cfg(), { steps: {}, flags: {} });
  assert.match(html, /Translation given/);
});

test('a keyless hint pad still renders (fully clickable, no badge text)', () => {
  const noKeyCfg = cfg();
  delete noKeyCfg.steps[0].hints[0].key;
  const html = renderBoard(noKeyCfg, { steps: {}, flags: {} });
  assert.match(html, /Look under the desk/);
});

test('commandForBoardAction maps toggle-solved to a solve-step command', () => {
  const c = commandForBoardAction('toggle-solved', { stepId: 'step_1', on: 'true' });
  assert.deepEqual(c, { type: 'solve-step', stepId: 'step_1', on: true });
});

test('commandForBoardAction maps set-flag to a set-flag command', () => {
  const c = commandForBoardAction('set-flag', { name: 'Translation given', on: 'false' });
  assert.deepEqual(c, { type: 'set-flag', name: 'Translation given', on: false });
});

test('commandForBoardAction maps play-hint and stop-audio', () => {
  assert.deepEqual(
    commandForBoardAction('play-hint', { stepId: 'step_1', hintId: 'h2' }),
    { type: 'play-hint', stepId: 'step_1', hintId: 'h2' }
  );
  assert.deepEqual(commandForBoardAction('stop-audio', {}), { type: 'stop-audio' });
});

test('commandForBoardAction returns null for an unrecognized action', () => {
  assert.equal(commandForBoardAction('bogus', {}), null);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `node --test test/board-render.test.js`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `public/board.js`**

Structure (the implementer fills in exact CSS class names/markup to match `operator.html`'s existing visual conventions found in Step 1 — this is illustrative of the logic, not final markup):

```js
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function isSectionComplete(sectionId, steps, stateSteps) {
  const matching = (steps || []).filter(s => s.sectionId === sectionId);
  if (!matching.length) return false;
  return matching.every(s => (stateSteps[s.id] && stateSteps[s.id].solvedAt != null));
}

function renderHintPad(stepId, hint) {
  const isAudio = hint.type === 'audio';
  const action = isAudio ? 'play-hint' : 'show-hint';
  const label = isAudio ? (hint.label || hint.mediaRef || '') : (hint.text || '');
  const bg = hint.color ? `style="background:${esc(hint.color)}"` : '';
  const keyBadge = hint.key
    ? `<span class="hint-key-badge">${esc(hint.key)}</span>`
    : `<span class="hint-key-badge no-key">—</span>`;
  const icon = isAudio ? '🎧 ' : '';
  return `<button class="hint-btn" data-action="${action}" data-step-id="${esc(stepId)}" data-hint-id="${esc(hint.id)}" data-text="${esc(hint.text || '')}" ${bg}>
    ${keyBadge}<span class="hint-text">${icon}${esc(label)}</span>
  </button>`;
}

function renderStep(step, stateSteps, uiState) {
  const solved = !!(stateSteps[step.id] && stateSteps[step.id].solvedAt != null);
  const explicit = uiState.collapsedSteps && (step.id in uiState.collapsedSteps) ? uiState.collapsedSteps[step.id] : null;
  const collapsed = explicit != null ? explicit : solved;
  const hintsHtml = (step.hints || []).map(h => renderHintPad(step.id, h)).join('');
  return `<div class="board-step${collapsed ? ' collapsed' : ''}" data-step-id="${esc(step.id)}">
    <div class="board-step-hdr">
      <span>${collapsed ? '▸' : '▾'} ${esc(step.name)}${solved ? ' ✓' : ''}</span>
      <button class="btn-solve" data-action="toggle-solved" data-step-id="${esc(step.id)}" data-on="${!solved}">
        ${solved ? 'Unsolve' : 'Solved'}
      </button>
    </div>
    <div class="board-step-body">${hintsHtml}</div>
  </div>`;
}

function renderSection(section, sectionSteps, stateSteps, uiState) {
  const complete = isSectionComplete(section.id, sectionSteps, stateSteps);
  const solvedCount = sectionSteps.filter(s => stateSteps[s.id] && stateSteps[s.id].solvedAt != null).length;
  const explicit = uiState.collapsedSections && (section.id in uiState.collapsedSections) ? uiState.collapsedSections[section.id] : null;
  const collapsed = explicit != null ? explicit : complete;
  const body = collapsed ? '' : sectionSteps.map(s => renderStep(s, stateSteps, uiState)).join('');
  return `<div class="board-section${collapsed ? ' collapsed' : ''}">
    <div class="board-section-hdr" data-action="toggle-section" data-section-id="${esc(section.id)}" data-on="${!collapsed}">
      <span>${esc(section.name)}</span><span>${solvedCount}/${sectionSteps.length}</span>
    </div>
    <div class="board-section-body">${body}</div>
  </div>`;
}

function renderFlags(config, state) {
  const flags = (config.progress && config.progress.flags) || [];
  if (!flags.length) return '';
  const rows = flags.map(name => {
    const on = !!(state.flags && state.flags[name]);
    return `<label class="board-flag"><input type="checkbox" data-action="set-flag" data-name="${esc(name)}" data-on="${!on}" ${on ? 'checked' : ''}/> ${esc(name)}</label>`;
  }).join('');
  return `<div class="board-flags">${rows}</div>`;
}

function renderBoard(config, state, uiState = {}) {
  const sections = config.sections || [];
  const steps = config.steps || [];
  const stateSteps = state.steps || {};
  const bySection = sections.map(sec => renderSection(sec, steps.filter(s => s.sectionId === sec.id), stateSteps, uiState)).join('');
  const ungrouped = steps.filter(s => !s.sectionId);
  const ungroupedHtml = ungrouped.length
    ? `<div class="board-section"><div class="board-section-hdr"><span>Ungrouped</span></div><div class="board-section-body">${ungrouped.map(s => renderStep(s, stateSteps, uiState)).join('')}</div></div>`
    : '';
  return bySection + ungroupedHtml + renderFlags(config, state);
}

function commandForBoardAction(action, dataset = {}) {
  const on = (v) => v === 'true' || v === true;
  switch (action) {
    case 'show-hint': return { type: 'show-hint', text: dataset.text, stepId: dataset.stepId, hintId: dataset.hintId };
    case 'play-hint': return { type: 'play-hint', stepId: dataset.stepId, hintId: dataset.hintId };
    case 'toggle-solved': return { type: 'solve-step', stepId: dataset.stepId, on: on(dataset.on) };
    case 'set-flag': return { type: 'set-flag', name: dataset.name, on: on(dataset.on) };
    case 'stop-audio': return { type: 'stop-audio' };
    default: return null;
  }
}

const exportsObj = { renderBoard, isSectionComplete, commandForBoardAction };
if (typeof module !== 'undefined' && module.exports) module.exports = exportsObj;
if (typeof window !== 'undefined') window.BoardUI = exportsObj;
```

(Adjust the export-guard block to match whatever exact pattern Step 1 found in the real `operator.js`/`media.js` — this is illustrative.)

- [ ] **Step 5: Run tests, fix, verify pass**

Run: `node --test test/board-render.test.js`
Expected: PASS, all 14 tests.

- [ ] **Step 6: Run the whole suite**

Run: `node --test "test/**/*.test.js"`
Expected: PASS, no regressions.

- [ ] **Step 7: Commit**

```bash
git add public/board.js test/board-render.test.js
git commit -m "feat(board): public/board.js — pure renderBoard + commandForBoardAction"
```

---

### Task 2: Wire the board into the operator console

**Files:**
- Modify: `public/operator.html`
- Modify: `public/operator.js`
- Test: `test/operator-cmd.test.js` (extend — it's currently tiny per this plan's context: 10 lines; read it before extending) and/or `test/game-engine.test.js` (for the "unrecognized command types are safe no-ops" verification)

**Interfaces:**
- Consumes: `renderBoard`, `commandForBoardAction` from Task 1 (`public/board.js`). The existing SSE `channel` message handler already receives `state.steps`/`state.flags` (sub-milestone 4) and the existing `fetchAndCacheConfig()`/`loadConfig()` helpers already fetch/cache `config.sections`/`config.steps` (no server-side change needed — `GET /config` already returns the full config object per sub-milestone 1).
- Produces: the operator console's hints panel replaced by the board; a "Stop Audio" button added to the timer bar/ctrl-section area (per spec §7.2, "new, in the timer bar"); collapse state persisted to `localStorage`.

- [ ] **Step 1: Read `public/operator.html`'s existing `#hints-panel`/`#hints-list` markup, the timer-bar/`ctrl-section` area, and the existing `col-divider` drag-persistence code in `operator.js` (for the exact localStorage key-naming convention)** before writing any new markup or script — this task replaces one panel and adds one button, matching the surrounding visual style exactly rather than introducing new CSS patterns.

- [ ] **Step 2: Write the failing tests**

Add to `test/operator-cmd.test.js` (read its current 10 lines first — this is illustrative of what to add, adapt to match its actual existing style):

```js
const { commandForBoardAction } = require('../public/board.js');

test('board actions produce the expected /cmd payloads', () => {
  assert.deepEqual(
    commandForBoardAction('toggle-solved', { stepId: 's1', on: 'true' }),
    { type: 'solve-step', stepId: 's1', on: true }
  );
});
```

(This may already be fully covered by Task 1's own test file — if so, skip duplicating and instead add ONE integration-flavored test here confirming `operator.js`'s module still exports `commandFor` unchanged, i.e. this task did not accidentally touch the existing pure map — read the existing file first to decide which is actually missing coverage.)

Add to `test/game-engine.test.js` (verifying this plan's central scope-ruling claim — that `play-hint`/`stop-audio` are safe no-ops today):

```js
test('unrecognized command types (play-hint, stop-audio) are silent no-ops, not crashes', () => {
  const { engine } = mk();
  engine.command({ type: 'start' });
  const before = engine.getState();
  assert.doesNotThrow(() => engine.command({ type: 'play-hint', stepId: 'x', hintId: 'y' }));
  assert.doesNotThrow(() => engine.command({ type: 'stop-audio' }));
  assert.deepEqual(engine.getState(), before); // no state change from either
});
```

- [ ] **Step 3: Run to verify failure/pass-as-expected**

Run: `node --test test/operator-cmd.test.js test/game-engine.test.js`
Expected: the `game-engine.test.js` no-op test should already PASS today (this sub-milestone hasn't touched `game-engine.js`) — it exists to LOCK IN the current safe behavior as a regression guard, not to drive new implementation. The `operator-cmd.test.js` addition should also pass immediately once Task 1 is committed (it exercises Task 1's already-implemented function). If either fails, treat it as a signal that this plan's scope ruling about safe no-ops was WRONG and stop to re-assess before proceeding (this would mean `game-engine.command()` has some catch-all behavior this plan didn't account for).

- [ ] **Step 4: Replace the hints panel markup in `public/operator.html`**

Replace the `<!-- Hints panel -->` block's inner content (currently `<div id="hints-list">...</div>`) with a board container, e.g. `<div id="board-root"></div>`, keeping the outer `#hints-panel` wrapper and its `.panel-hdr` (update the header text from "Hints — click to display on game screen" to something reflecting the new board, e.g. "Progress Board" — match the existing `.panel-hdr` styling, just change the text). Add a "Stop Audio" button near the existing Volume/`ctrl-section` controls (per spec §7.2's "new, in the timer bar"), matching the existing button markup style (e.g. similar to `.btn-hide-clue`) with `id="btn-stop-audio"`.

Add the new CSS classes `board-section`, `board-section-hdr`, `board-section-body`, `board-step`, `board-step-hdr`, `board-step-body`, `board-flags`, `board-flag`, `.collapsed` variants — deriving their visual treatment from the EXISTING `.hint-group`/`.hint-group-header`/`.hint-group-body`/`.collapsed` rules already in the file (read them, adapt rather than invent from scratch) plus a new `.btn-solve` button style consistent with the existing `.btn-vol`/`.btn-hide-clue` button styles.

- [ ] **Step 5: Wire the board in `public/operator.js`**

Remove `buildHints()` and its DOM-construction logic (the old `.hint-group` builder) and the `hintsList`/`window.addEventListener('storage', ...)` reload-on-config-change wiring tied to it — replace with:

```js
const { renderBoard, commandForBoardAction } = require('./board.js'); // adjust require/global-access per the real export-guard pattern from Task 1

const boardRoot = document.getElementById('board-root');
let uiState = loadUiState(); // { collapsedSections: {}, collapsedSteps: {} } from localStorage

function loadUiState() {
  try { return JSON.parse(localStorage.getItem('htm-board-ui') || '{}'); } catch (e) { return {}; }
}
function saveUiState() {
  try { localStorage.setItem('htm-board-ui', JSON.stringify(uiState)); } catch (e) {}
}

function renderBoardNow() {
  const cfg = loadConfig();
  boardRoot.innerHTML = renderBoard(cfg, currentState, uiState);
}

boardRoot.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  if (action === 'toggle-section') {
    uiState.collapsedSections = uiState.collapsedSections || {};
    uiState.collapsedSections[el.dataset.sectionId] = el.dataset.on !== 'true'; // clicked header toggles current collapsed state
    saveUiState();
    renderBoardNow();
    return;
  }
  const c = commandForBoardAction(action, el.dataset);
  if (!c) return;
  if (action === 'toggle-solved') {
    uiState.collapsedSteps = uiState.collapsedSteps || {};
    // let the next state push re-render naturally; solved-state collapse is server-driven
  }
  cmd(c.type, c);
});

// also handle the checkbox 'change' event for flags (checkboxes don't reliably fire 'click' the same way across browsers for this purpose — verify against the existing codebase's convention for other checkboxes/inputs, if any, before deciding change vs click)
boardRoot.addEventListener('change', (e) => {
  const el = e.target.closest('[data-action="set-flag"]');
  if (!el) return;
  const c = commandForBoardAction('set-flag', { name: el.dataset.name, on: String(el.checked) });
  cmd(c.type, c);
});
```

(This is illustrative wiring logic — the implementer adapts exact variable names/require-vs-global-access to match `operator.js`'s real module style from Task 1, and resolves the noted open question about click-vs-change event choice for the flag checkboxes by checking how the codebase handles other checkbox inputs, if any exist, or making a reasonable default choice and documenting it.)

Re-render the board on every SSE `state` message (in the existing `channel.addEventListener('message', ...)` handler, after `currentState = data;`, call `renderBoardNow()`), and on initial config load (replace the old `buildHints()` call in `fetchAndCacheConfig().then(() => buildHints())` with `renderBoardNow()`).

Wire the Stop Audio button:

```js
const stopAudioBtn = document.getElementById('btn-stop-audio');
if (stopAudioBtn) stopAudioBtn.addEventListener('click', () => cmd('stop-audio'));
```

- [ ] **Step 6: Run the whole suite**

Run: `node --test "test/**/*.test.js"`
Expected: PASS, no regressions.

- [ ] **Step 7: Manual smoke check**

Run: `npm start`, open `http://localhost:4000/operator.html`, confirm: the board renders (sections/steps/hints from whatever `config.steps` currently holds — likely migrated from `hintGroups` per sub-milestone 1, so section-less "Ungrouped" steps are the expected common case until someone edits the Board tab in sub-milestone 7), clicking a text hint pad shows it on the game screen (existing `show-hint` behavior) and marks the step's clue-given state (reflected as the step no longer being freshly "ungiven" — verify via the next state push), toggling Solved collapses/expands correctly, section headers show an accurate `n/n` count, the flags row (if any `config.progress.flags` exist) toggles, and the Stop Audio button is clickable without error (it will visibly do nothing yet — that's the documented, ruled-on interim state). No automated browser test exists in this repo's suite for `.html` pages — this manual check is the closest available verification and should be reported honestly (performed or not) rather than assumed.

- [ ] **Step 8: Commit**

```bash
git add public/operator.html public/operator.js test/operator-cmd.test.js test/game-engine.test.js
git commit -m "feat(board): wire operator board into operator.html/js, replacing the flat hint panel"
```

---

## Self-Review Notes (for the plan author, not a task)

- **Spec coverage:** §7.1's layout (sections, Ungrouped bucket, flags row) and §7.2's behavior (hint pad rendering incl. color/key/icon/label, Solved toggle + collapse, section auto-collapse at n/n with manual override, Stop Audio button, keyless pads clickable) are Task 1 (`renderBoard`) + Task 2 (wiring); §7.3's "pure `renderBoard(config, state) → DOM/HTML string`... same pattern as `renderModel`/`commandFor`" is satisfied by Task 1's pure, dependency-free function plus the HTML-string ruling documented in Global Constraints; §10's `renderBoard` test row (solved step collapses; section header count; audio pad shows 🎧; keyless pad keeps a click handler; Ungrouped bucket; flags row) is Task 1's test list verbatim.
- **Explicitly deferred, not forgotten (both are Global-Constraints-documented rulings, not silent gaps):** `play-hint`/`stop-audio` command HANDLING in `game-engine` (sub-milestone 6); Ctrl-click silent-clue override and `countsAsClue`-aware clue-counter suppression (sub-milestone 6, needs `config` wired into `game-engine`); the "active-hints list / Dismiss All / clue counter... unchanged behaviour" portion of spec §7.2 requires NO change in this plan (it already works via the pre-existing `show-hint`/`dismiss-hint` commands, untouched here).
- **Type/name consistency check:** `renderBoard`'s consumed field names (`section.id/name/order/note`, `step.id/name/sectionId/hints`, `hint.id/type/text/mediaRef/label/color/icon/key`) and the emitted command shapes (`solve-step{stepId,on}`, `set-flag{name,on}`, `play-hint{stepId,hintId}`, `stop-audio{}`) are checked directly against `src/config-schema.js` and `src/game-engine.js`'s actual command dispatch (sub-milestone 4) rather than assumed from spec prose alone — Task 1's Step 1 explicitly mandates reading those two files first, since a naming mismatch here would silently produce a board that renders nothing or sends commands `game-engine` doesn't recognize by name (as opposed to the DELIBERATELY unrecognized `play-hint`/`stop-audio`, which this plan verifies are still routed correctly, just not yet acted upon).
