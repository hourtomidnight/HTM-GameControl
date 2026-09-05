// Config page "Board" tab — pure editor rendering + collect/normalize.
//
// renderBoardEditor / renderAudioEventsCard return HTML strings.
// collectBoardConfig / collectAudioEvents take a plain JS object (the browser
// reads the editor DOM into it) and return a normalized, schema-valid config
// fragment with deterministic ids assigned. All four are PURE — no document, no
// window (outside the export guard), no fetch. Same dual-export-guard + esc()
// convention as public/board.js / public/media.js.
//
// Id scheme mirrors src/config-migrate.js: sections `sec_<n>`, steps `step_<n>`,
// hints `<stepId>_h<n>`. Existing ids are preserved; id-less rows (freshly added
// in the editor) get the lowest free counter for their kind. Output MUST pass
// src/config-schema.js's validateConfig.

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// The six global audio cues, in display order. `midShow` alone carries
// `atSecondsRemaining`. Must match src/config-schema.js + game-engine.js.
const AUDIO_EVENT_NAMES = ['start', 'loop', 'midShow', 'win', 'lose', 'clueChime'];
const DEFAULT_MID_SHOW_SECONDS = 120;
const DEFAULT_VOLUME = 0.4;

function isNonEmptyStr(v) { return typeof v === 'string' && v.trim() !== ''; }

// ---------------------------------------------------------------------------
// collectBoardConfig
// ---------------------------------------------------------------------------

function allocCounterId(prefix, usedSet) {
  let n = 1;
  while (usedSet.has(prefix + '_' + n)) n++;
  const id = prefix + '_' + n;
  usedSet.add(id);
  return id;
}

// Two-pass id resolution: preserved ids always win, id-less rows fill the gaps.
function resolveIds(items, getRawId, prefix) {
  const used = new Set();
  const ids = new Array(items.length);
  items.forEach((it, i) => {
    const raw = getRawId(it);
    if (isNonEmptyStr(raw) && !used.has(raw)) { used.add(raw); ids[i] = raw; }
  });
  items.forEach((it, i) => { if (!ids[i]) ids[i] = allocCounterId(prefix, used); });
  return { ids, used };
}

function prepHint(h) {
  h = h || {};
  const type = h.type === 'audio' ? 'audio' : 'text';
  if (type === 'text') {
    const text = String(h.text == null ? '' : h.text);
    if (text.trim() === '') return null;
    return { raw: h, type, text };
  }
  const mediaRef = String(h.mediaRef == null ? '' : h.mediaRef);
  if (mediaRef.trim() === '') return null;
  return { raw: h, type, mediaRef };
}

function buildHint(ph, id) {
  const h = ph.raw;
  const out = { id, type: ph.type };
  if (ph.type === 'text') {
    out.text = ph.text;
  } else {
    out.mediaRef = ph.mediaRef;
    for (const k of ['label', 'color', 'icon']) {
      const v = String(h[k] == null ? '' : h[k]).trim();
      if (v) out[k] = v;
    }
  }
  const key = String(h.key == null ? '' : h.key).trim();
  if (key) out.key = key;
  out.countsAsClue = (h.countsAsClue === undefined || h.countsAsClue === null)
    ? true
    : !!h.countsAsClue;
  return out;
}

// collectBoardConfig(state) -> { sections, steps, progress: { flags } }
// state = { sections: [{ id?, name, note, order }],
//           steps: [{ id?, name, sectionId, order, hints: [...] }],
//           flags: string[] }
function collectBoardConfig(state) {
  state = state || {};

  // --- sections: drop empty-name, renumber, resolve ids ---------------------
  const keptSections = (state.sections || [])
    .filter((s) => s && String(s.name == null ? '' : s.name).trim() !== '');
  const { ids: secIds, used: secUsed } = resolveIds(keptSections, (s) => s.id, 'sec');
  const sectionsOut = keptSections.map((s, i) => {
    const o = { id: secIds[i], name: String(s.name == null ? '' : s.name).trim(), order: i + 1 };
    const note = String(s.note == null ? '' : s.note).trim();
    if (note !== '') o.note = note;
    return o;
  });

  // --- steps: prep hints, drop empty steps, renumber, resolve ids ----------
  const prepared = (state.steps || []).map((st) => {
    st = st || {};
    const name = String(st.name == null ? '' : st.name).trim();
    const hints = (st.hints || []).map(prepHint).filter(Boolean);
    return { st, name, hints };
  });
  const keptSteps = prepared.filter((p) => p.name !== '' || p.hints.length > 0);
  const { ids: stepIds } = resolveIds(keptSteps, (p) => p.st.id, 'step');

  const globalHintIds = new Set();
  const stepsOut = keptSteps.map((p, i) => {
    const id = stepIds[i];
    const sectionId = (isNonEmptyStr(p.st.sectionId) && secUsed.has(p.st.sectionId))
      ? p.st.sectionId
      : null;

    // hint ids: preserved win (unless globally taken), then `<stepId>_h<n>`.
    const hUsed = new Set();
    const hIds = new Array(p.hints.length);
    p.hints.forEach((ph, j) => {
      const raw = ph.raw.id;
      if (isNonEmptyStr(raw) && !hUsed.has(raw) && !globalHintIds.has(raw)) {
        hUsed.add(raw); hIds[j] = raw;
      }
    });
    p.hints.forEach((ph, j) => {
      if (hIds[j]) return;
      let n = 1;
      while (hUsed.has(id + '_h' + n) || globalHintIds.has(id + '_h' + n)) n++;
      hIds[j] = id + '_h' + n;
      hUsed.add(hIds[j]);
    });
    hIds.forEach((x) => globalHintIds.add(x));

    return {
      id,
      name: p.name,
      order: i + 1,
      sectionId,
      hints: p.hints.map((ph, j) => buildHint(ph, hIds[j])),
    };
  });

  // --- flags: trimmed, non-empty, order preserved, duplicates kept --------
  const flags = (state.flags || [])
    .map((f) => String(f == null ? '' : f).trim())
    .filter((f) => f !== '');

  return { sections: sectionsOut, steps: stepsOut, progress: { flags } };
}

// ---------------------------------------------------------------------------
// collectAudioEvents
// ---------------------------------------------------------------------------

function toPositiveInt(v, fallback) {
  const n = Math.floor(Number(v));
  return (Number.isInteger(n) && n > 0) ? n : fallback;
}

// collectAudioEvents(state) -> { volume, events }
// state = { volume: number, events: { <name>: { file, enabled, atSecondsRemaining? } } }
function collectAudioEvents(state) {
  state = state || {};
  const rawVol = Number(state.volume);
  const volume = Number.isFinite(rawVol) ? Math.min(1, Math.max(0, rawVol)) : DEFAULT_VOLUME;

  const srcEvents = state.events || {};
  const events = {};
  for (const name of AUDIO_EVENT_NAMES) {
    const src = srcEvents[name] || {};
    const ev = {
      file: String(src.file == null ? '' : src.file).trim(),
      enabled: !!src.enabled,
    };
    if (name === 'midShow') {
      ev.atSecondsRemaining = toPositiveInt(src.atSecondsRemaining, DEFAULT_MID_SHOW_SECONDS);
    }
    events[name] = ev;
  }
  return { volume, events };
}

// ---------------------------------------------------------------------------
// renderBoardEditor
// ---------------------------------------------------------------------------

function sectionSelect(sections, selectedId) {
  const opts = ['<option value=""' + (selectedId ? '' : ' selected') + '>— Ungrouped —</option>'];
  for (const s of sections) {
    const sel = s.id === selectedId ? ' selected' : '';
    opts.push('<option value="' + esc(s.id) + '"' + sel + '>' + esc(s.name) + '</option>');
  }
  return opts.join('');
}

function renderHintRow(hint) {
  hint = hint || {};
  const type = hint.type === 'audio' ? 'audio' : 'text';
  const idAttr = hint.id ? ' data-id="' + esc(hint.id) + '"' : '';
  const counts = hint.countsAsClue === false ? '' : ' checked';
  return '<div class="cb-hint" data-role="hint"' + idAttr + '>' +
    '<select data-field="type">' +
      '<option value="text"' + (type === 'text' ? ' selected' : '') + '>Text</option>' +
      '<option value="audio"' + (type === 'audio' ? ' selected' : '') + '>Audio</option>' +
    '</select>' +
    '<input type="text" data-field="text" placeholder="Hint text" value="' + esc(hint.text || '') + '"/>' +
    '<button type="button" data-action="pick-media">Pick media…</button>' +
    '<span class="cb-mediaref" data-field="mediaRef">' + esc(hint.mediaRef || '') + '</span>' +
    '<input type="text" data-field="label" placeholder="label" value="' + esc(hint.label || '') + '"/>' +
    '<input type="text" data-field="color" placeholder="color" value="' + esc(hint.color || '') + '"/>' +
    '<input type="text" data-field="icon" placeholder="icon" value="' + esc(hint.icon || '') + '"/>' +
    '<input type="text" data-field="key" placeholder="key" value="' + esc(hint.key || '') + '"/>' +
    '<label><input type="checkbox" data-field="countsAsClue"' + counts + '/> counts as clue</label>' +
    '<button type="button" data-action="hint-up">▲</button>' +
    '<button type="button" data-action="hint-down">▼</button>' +
    '<button type="button" data-action="hint-delete">✕</button>' +
    '</div>';
}

function renderStepRow(step, sections) {
  step = step || {};
  const idAttr = step.id ? ' data-id="' + esc(step.id) + '"' : '';
  const hints = (step.hints || []).map(renderHintRow).join('');
  return '<div class="cb-step" data-role="step"' + idAttr + '>' +
    '<input type="text" data-field="name" placeholder="Step name" value="' + esc(step.name || '') + '"/>' +
    '<select data-field="sectionId">' + sectionSelect(sections, step.sectionId || '') + '</select>' +
    '<button type="button" data-action="step-up">▲</button>' +
    '<button type="button" data-action="step-down">▼</button>' +
    '<button type="button" data-action="step-delete">✕</button>' +
    '<div class="cb-hints">' + hints + '</div>' +
    '<button type="button" data-action="add-hint">+ Add Hint</button>' +
    '</div>';
}

function renderSectionBlock(section, steps, sections) {
  section = section || {};
  const idAttr = section.id ? ' data-id="' + esc(section.id) + '"' : '';
  const own = steps.filter((s) => s.sectionId === section.id).map((s) => renderStepRow(s, sections)).join('');
  return '<div class="cb-section" data-role="section"' + idAttr + '>' +
    '<input type="text" data-field="name" placeholder="Section name" value="' + esc(section.name || '') + '"/>' +
    '<textarea data-field="note" placeholder="Note">' + esc(section.note || '') + '</textarea>' +
    '<button type="button" data-action="section-up">▲</button>' +
    '<button type="button" data-action="section-down">▼</button>' +
    '<button type="button" data-action="section-delete">✕</button>' +
    '<div class="cb-steps">' + own + '</div>' +
    '</div>';
}

function renderFlags(flags) {
  const rows = (flags || []).map((f) =>
    '<div class="cb-flag" data-role="flag">' +
      '<input type="text" data-field="value" value="' + esc(f) + '"/>' +
      '<button type="button" data-action="flag-delete">✕</button>' +
    '</div>').join('');
  return '<div class="cb-flags" data-role="flags">' +
    '<h4>Flags</h4>' + rows +
    '<button type="button" data-action="add-flag">+ Add Flag</button>' +
    '</div>';
}

// renderBoardEditor(config) -> HTML string for the Board tab editor body.
function renderBoardEditor(config) {
  config = config || {};
  const sections = (config.sections || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const steps = config.steps || [];
  const flags = (config.progress && config.progress.flags) || [];

  const sectionBlocks = sections.map((sec) => renderSectionBlock(sec, steps, sections)).join('');
  const ungroupedSteps = steps.filter((s) => s.sectionId == null);
  const ungroupedBlock =
    '<div class="cb-section cb-ungrouped" data-role="ungrouped">' +
      '<h4>Ungrouped</h4>' +
      '<div class="cb-steps">' + ungroupedSteps.map((s) => renderStepRow(s, sections)).join('') + '</div>' +
    '</div>';

  const emptyHint = (!sections.length && !ungroupedSteps.length)
    ? '<p class="hint-note" data-role="empty-state">No sections or steps yet. Use “+ Add Section” or “+ Add Step” to start.</p>'
    : '';

  return '<div class="cb-editor" data-role="board-editor">' +
    emptyHint +
    sectionBlocks +
    ungroupedBlock +
    renderFlags(flags) +
    '<div class="cb-actions">' +
      '<button type="button" data-action="add-section">+ Add Section</button>' +
      '<button type="button" data-action="add-step">+ Add Step (ungrouped)</button>' +
      '<button type="button" data-action="import-checklist" disabled title="Coming in the next release">Import checklist</button>' +
    '</div>' +
    '</div>';
}

// ---------------------------------------------------------------------------
// renderAudioEventsCard
// ---------------------------------------------------------------------------

function renderAudioEventRow(name, ev) {
  ev = ev || {};
  const checked = ev.enabled ? ' checked' : '';
  const midShow = name === 'midShow'
    ? '<label>at <input type="number" min="1" data-field="atSecondsRemaining" value="' +
        esc(ev.atSecondsRemaining != null ? ev.atSecondsRemaining : DEFAULT_MID_SHOW_SECONDS) +
        '"/> seconds remaining</label>'
    : '';
  return '<div class="cb-audio-event" data-role="audio-event" data-name="' + esc(name) + '">' +
    '<span class="cb-audio-name">' + esc(name) + '</span>' +
    '<label><input type="checkbox" data-field="enabled"' + checked + '/> enabled</label>' +
    '<span class="cb-audio-file" data-field="file">' + esc(ev.file || '') + '</span>' +
    '<button type="button" data-action="pick-media">Pick media…</button>' +
    midShow +
    '</div>';
}

// renderAudioEventsCard(config) -> HTML string for the Audio Events card.
function renderAudioEventsCard(config) {
  config = config || {};
  const events = (config.audio && config.audio.events) || {};
  const rows = AUDIO_EVENT_NAMES.map((name) => renderAudioEventRow(name, events[name])).join('');
  return '<div class="cb-audio-events" data-role="audio-events">' +
    '<h4>Audio Events</h4>' + rows +
    '</div>';
}

// ---------------------------------------------------------------------------

const API = { renderBoardEditor, renderAudioEventsCard, collectBoardConfig, collectAudioEvents, AUDIO_EVENT_NAMES };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = API;
} else {
  window.ConfigBoard = API;
}
