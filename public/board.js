// Operator progress board — pure rendering + command mapping.
//
// renderBoard/isSectionComplete/commandForBoardAction are PURE functions (no DOM,
// no fetch) so they can be unit-tested under Node. Any browser-only wiring for
// this page belongs in the DOM branch below, following the same dual-export
// guard pattern as public/media.js and public/operator.js.

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// A section is "complete" only if it has at least one step and every step
// belonging to it (step.sectionId === sectionId) has a non-null solvedAt in
// stateSteps. An empty section (zero matching steps) is never complete.
function isSectionComplete(sectionId, steps, stateSteps) {
  stateSteps = stateSteps || {};
  const matching = (steps || []).filter((s) => s.sectionId === sectionId);
  if (!matching.length) return false;
  return matching.every((s) => stateSteps[s.id] && stateSteps[s.id].solvedAt != null);
}

function renderHintPad(stepId, hint) {
  const isAudio = hint.type === 'audio';
  const action = isAudio ? 'play-hint' : 'show-hint';
  const label = isAudio ? (hint.label || hint.mediaRef || '') : (hint.text || '');
  const bg = hint.color ? ` style="background:${esc(hint.color)}"` : '';
  const keyBadge = hint.key
    ? `<span class="hint-key-badge">${esc(hint.key)}</span>`
    : `<span class="hint-key-badge no-key">&mdash;</span>`;
  const icon = isAudio ? '🎧 ' : '';
  return `<button class="hint-btn" data-action="${action}" data-step-id="${esc(stepId)}" data-hint-id="${esc(hint.id)}" data-text="${esc(hint.text || '')}"${bg}>
    ${keyBadge}<span class="hint-text">${icon}${esc(label)}</span>
  </button>`;
}

function renderStep(step, stateSteps, uiState) {
  const solved = !!(stateSteps[step.id] && stateSteps[step.id].solvedAt != null);
  const collapsedSteps = uiState.collapsedSteps || {};
  const explicit = Object.prototype.hasOwnProperty.call(collapsedSteps, step.id)
    ? collapsedSteps[step.id]
    : null;
  const collapsed = explicit != null ? explicit : solved;
  const hintsHtml = (step.hints || []).map((h) => renderHintPad(step.id, h)).join('');
  return `<div class="board-step${collapsed ? ' collapsed' : ''}" data-step-id="${esc(step.id)}">
    <div class="board-step-hdr" data-action="toggle-step" data-step-id="${esc(step.id)}" data-on="${!collapsed}">
      <span>${collapsed ? '▸' : '▾'} ${esc(step.name)}${solved ? ' ✓' : ''}</span>
      <button class="btn-solve" data-action="toggle-solved" data-step-id="${esc(step.id)}" data-on="${!solved}">
        ${solved ? 'Unsolve' : 'Solved'}
      </button>
    </div>
    <div class="board-step-body">${collapsed ? '' : hintsHtml}</div>
  </div>`;
}

function renderSection(section, sectionSteps, stateSteps, uiState) {
  const complete = isSectionComplete(section.id, sectionSteps, stateSteps);
  const solvedCount = sectionSteps.filter((s) => stateSteps[s.id] && stateSteps[s.id].solvedAt != null).length;
  const collapsedSections = uiState.collapsedSections || {};
  const collapsedSteps = uiState.collapsedSteps || {};
  const explicit = Object.prototype.hasOwnProperty.call(collapsedSections, section.id)
    ? collapsedSections[section.id]
    : null;
  const collapsed = explicit != null ? explicit : complete;
  // Precedence rule: an explicit per-step force-open (uiState.collapsedSteps[id]
  // === false) always bubbles up and forces the section body open, even over an
  // EXPLICIT section-level force-closed (uiState.collapsedSections[id] === true),
  // not just the auto-computed default. Rationale: the step-level override is the
  // more specific, more recent user action in the UI's mental model (the operator
  // clicked to reveal this one step), and UI conventions elsewhere (e.g.
  // search-expands-collapsed-parents) favor "make the thing I asked for visible"
  // over honoring a broader, older "keep this whole section closed" instruction.
  const forcingStepIds = stepsForcingSectionOpen(sectionSteps, collapsedSteps);
  const hasForcedOpenStep = forcingStepIds.length > 0;
  // `bodyShown` is the single source of truth for "is the body actually
  // rendered" — the header's arrow/.collapsed class/data-on MUST be derived
  // from this same value (not from `collapsed` alone), so the header never
  // desyncs from what's actually visible when bubble-up fires.
  const bodyShown = !collapsed || hasForcedOpenStep;
  const body = bodyShown ? sectionSteps.map((s) => renderStep(s, stateSteps, uiState)).join('') : '';
  // data-forcing-steps carries the ids of steps whose explicit force-open is
  // the ONLY reason bodyShown is true while the section's own collapsed value
  // is true (i.e. bubble-up in effect). operator.js's toggle-section handler
  // uses this to know which collapsedSteps overrides to clear when the
  // operator clicks a bubbled-up-open header, so "close this section" actually
  // closes it instead of being a no-op. Empty when not applicable.
  const forcingAttr = collapsed && hasForcedOpenStep ? ` data-forcing-steps="${esc(forcingStepIds.join(','))}"` : '';
  return `<div class="board-section${bodyShown ? '' : ' collapsed'}">
    <div class="board-section-hdr" data-action="toggle-section" data-section-id="${esc(section.id)}" data-on="${bodyShown}"${forcingAttr}>
      <span>${bodyShown ? '▾' : '▸'} ${esc(section.name)}</span><span>${solvedCount}/${sectionSteps.length}</span>
    </div>
    <div class="board-section-body">${body}</div>
  </div>`;
}

// stepsForcingSectionOpen(sectionSteps, collapsedSteps) -> array of step ids
// (in sectionSteps order) that carry an explicit force-open override
// (collapsedSteps[id] === false). These are the steps "bubbling" a section's
// body open per the precedence rule above. Pure + exported so operator.js can
// compute the same set for its own logic if needed, and so it's unit-testable.
function stepsForcingSectionOpen(sectionSteps, collapsedSteps) {
  collapsedSteps = collapsedSteps || {};
  return (sectionSteps || [])
    .filter((s) => Object.prototype.hasOwnProperty.call(collapsedSteps, s.id) && collapsedSteps[s.id] === false)
    .map((s) => s.id);
}

function renderUngrouped(ungroupedSteps, stateSteps, uiState) {
  if (!ungroupedSteps.length) return '';
  const body = ungroupedSteps.map((s) => renderStep(s, stateSteps, uiState)).join('');
  return `<div class="board-section board-section-ungrouped">
    <div class="board-section-hdr"><span>Ungrouped</span></div>
    <div class="board-section-body">${body}</div>
  </div>`;
}

function renderFlags(config, state) {
  const flags = (config.progress && config.progress.flags) || [];
  if (!flags.length) return '';
  const rows = flags.map((name) => {
    const ts = state.flags && state.flags[name];
    const on = ts != null;
    return `<label class="board-flag"><input type="checkbox" data-action="set-flag" data-name="${esc(name)}" data-on="${!on}" ${on ? 'checked' : ''}/> ${esc(name)}</label>`;
  }).join('');
  return `<div class="board-flags">${rows}</div>`;
}

// renderBoard(config, state, uiState) -> HTML string for the board container's
// innerHTML (sections in config order, an "Ungrouped" bucket for steps with no
// sectionId, and a flags row at the bottom).
//
// uiState = { collapsedSections: { [sectionId]: bool }, collapsedSteps: { [stepId]: bool } }
// An explicit true/false entry always overrides the auto-computed default
// (section complete -> collapsed; step solved -> collapsed); an absent entry
// falls back to the auto-computed value.
function renderBoard(config, state, uiState = {}) {
  config = config || {};
  state = state || {};
  // Sorted by `order` per the config schema's ordering field; covered by the
  // "renders sections in order regardless of config array order" test below.
  const sections = (config.sections || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const steps = config.steps || [];
  const stateSteps = state.steps || {};

  const sectionsHtml = sections
    .map((sec) => renderSection(sec, steps.filter((s) => s.sectionId === sec.id), stateSteps, uiState))
    .join('');
  const ungrouped = steps.filter((s) => s.sectionId == null);
  const ungroupedHtml = renderUngrouped(ungrouped, stateSteps, uiState);
  const flagsHtml = renderFlags(config, state);

  if (!sectionsHtml && !ungroupedHtml && !flagsHtml) {
    return '<div id="no-hints-msg">No steps configured yet. Open ⚙ Config to add sections/steps.</div>';
  }

  return sectionsHtml + ungroupedHtml + flagsHtml;
}

// commandForBoardAction(action, dataset) -> plain /cmd payload object, or null
// for an unrecognized action (mirroring operator.js's commandFor null-on-miss
// convention). Never throws on a missing/malformed dataset.
//
// Note on 'show-hint': this function has no access to `config`, so it cannot
// look up a text hint's `text` field itself. The caller is responsible for
// reading the hint's text out of config and placing it into dataset.text
// (e.g. via the hint button's own data-text attribute, as rendered by
// renderHintPad above) before invoking this function.
function commandForBoardAction(action, dataset) {
  dataset = dataset && typeof dataset === 'object' ? dataset : {};
  const on = (v) => v === 'true' || v === true;
  switch (action) {
    case 'show-hint':
      return { type: 'show-hint', text: dataset.text, stepId: dataset.stepId, hintId: dataset.hintId };
    case 'play-hint':
      return { type: 'play-hint', stepId: dataset.stepId, hintId: dataset.hintId };
    case 'toggle-solved':
      return { type: 'solve-step', stepId: dataset.stepId, on: on(dataset.on) };
    case 'set-flag':
      return { type: 'set-flag', name: dataset.name, on: on(dataset.on) };
    case 'stop-audio':
      return { type: 'stop-audio' };
    default:
      return null;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { renderBoard, isSectionComplete, commandForBoardAction, stepsForcingSectionOpen };
} else {
  // Browser: expose as a global for operator.js (loaded via its own <script> tag).
  window.BoardUI = { renderBoard, isSectionComplete, commandForBoardAction, stepsForcingSectionOpen };
}
