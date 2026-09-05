// Operator console client.
//
// The button -> engine-command mapping is a PURE function `commandFor(id)` so it
// can be unit-tested under Node with no DOM. Everything else runs only in the
// browser branch below.

const COMMisc = {
  'btn-start': 'start', 'btn-escaped': 'escaped', 'btn-reset': 'reset',
  'add-min': 'add-min', 'sub-min': 'sub-min', 'add-sec': 'add-sec', 'sub-sec': 'sub-sec',
  'vol-up': 'vol-up', 'vol-down': 'vol-down', 'btn-hide-clue': 'hide-clue',
};

function commandFor(id) { return COMMisc[id] ? { type: COMMisc[id] } : null; }

// The board's generic [data-action] click-delegate must NOT also dispatch for
// actions that already have their own dedicated DOM event listener — doing so
// would send a duplicate command per user interaction. Currently only
// 'set-flag' (handled exclusively via the flag checkbox's 'change' listener)
// falls into this category. Kept as a pure, exported function so the
// exclusion can be unit-tested without a DOM.
function isGenericDispatchExcluded(action) { return action === 'set-flag'; }

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { commandFor, isGenericDispatchExcluded };
} else {
  // ── channel is defined by channel.js (SSE + HTTP POST, works cross-device) ──
  const post = (msg) => {
    if (!msg) return;
    fetch('/cmd', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg),
    }).catch(() => {});
  };
  function cmd(type, extra) { post(Object.assign({ type }, extra)); }

  // ── DOM ───────────────────────────────────────────────────────────────────
  const bigTimer    = document.getElementById('big-timer');
  const statusBadge = document.getElementById('status-badge');
  const volDisplay  = document.getElementById('vol-display');
  const clueCountEl = document.getElementById('clue-count-display');
  const boardRoot   = document.getElementById('board-root');
  const pauseBtn    = document.getElementById('btn-pause');

  // ── Session info fields (debounced live-sync to Sheets) ───────────────────
  let debounceTimers = {};
  function debouncedUpdateField(field, value) {
    clearTimeout(debounceTimers[field]);
    debounceTimers[field] = setTimeout(() => cmd('update-field', { field, value }), 5000);
  }

  document.getElementById('team-name-input').addEventListener('input', (e) => {
    debouncedUpdateField('teamName', e.target.value);
  });
  document.getElementById('operator-select').addEventListener('change', (e) => {
    cmd('update-field', { field: 'operator', value: e.target.value }); // immediate, not debounced — infrequent, deliberate action
  });
  document.getElementById('new-players-input').addEventListener('input', (e) => {
    debouncedUpdateField('newPlayers', parseInt(e.target.value) || 0);
  });
  document.getElementById('experienced-players-input').addEventListener('input', (e) => {
    debouncedUpdateField('experiencedPlayers', parseInt(e.target.value) || 0);
  });
  document.getElementById('notes-input').addEventListener('input', (e) => {
    debouncedUpdateField('notes', e.target.value);
  });

  async function loadOperators() {
    try {
      const r = await fetch('/api/operators');
      const { operators } = await r.json();
      const select = document.getElementById('operator-select');
      operators.forEach(name => {
        const opt = document.createElement('option');
        opt.value = name; opt.textContent = name;
        select.appendChild(opt);
      });
    } catch (e) {}
  }
  loadOperators();

  // ── Timer / volume / hide-clue buttons via the pure map ───────────────────
  Object.keys(COMMisc).forEach((id) => {
    const b = document.getElementById(id);
    if (b) b.addEventListener('click', () => post(commandFor(id)));
  });

  // Pause / Resume — toggles on live state, so it isn't in the pure map.
  if (pauseBtn) {
    pauseBtn.addEventListener('click', () => cmd(currentState.timerRunning ? 'pause' : 'resume'));
  }

  const cfgBtn = document.getElementById('btn-cfg');
  if (cfgBtn) cfgBtn.addEventListener('click', () => {
    window.open('/config.html', 'config', 'width=960,height=900,resizable=yes');
  });

  const mediaBtn = document.getElementById('btn-media');
  if (mediaBtn) mediaBtn.addEventListener('click', () => {
    window.open('/media.html', 'media', 'width=960,height=900,resizable=yes');
  });

  // ── Single-screen Pi: just (re)open the game screen ───────────────────────
  const reopenBtn = document.getElementById('btn-reopen-game');
  if (reopenBtn) reopenBtn.addEventListener('click', () => {
    window.open('/game.html', 'htm-game-screen');
  });

  // ── Config cache (for hint groups) ───────────────────────────────────────
  function loadConfig() {
    try { return JSON.parse(sessionStorage.getItem('htm-config') || localStorage.getItem('htm-config')) || {}; } catch(e) { return {}; }
  }
  async function fetchAndCacheConfig() {
    try {
      const r = await fetch('/config');
      if (r.ok) {
        const cfg = await r.json();
        const json = JSON.stringify(cfg);
        sessionStorage.setItem('htm-config', json);
        localStorage.setItem('htm-config', json);
        return cfg;
      }
    } catch(e) {}
    return loadConfig();
  }

  // ── State mirror ─────────────────────────────────────────────────────────
  let currentState = { currentMin:60, currentSec:0, clockForward:false,
    timerRunning:false, phase:'waiting', onSplash:true, clueCount:0, volume:0.4 };

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  channel.addEventListener('message', (e) => {
    const data = e.data;
    if (!data || data.type !== 'state') return;
    currentState = data;

    bigTimer.textContent = (data.clockForward ? '− ' : '') + pad(data.currentMin) + ':' + pad(data.currentSec);
    bigTimer.className = '';
    if (data.gameLocked)            bigTimer.classList.add('escaped');
    else if (data.clockForward)     bigTimer.classList.add('negative');
    else if (data.timerRunning)     bigTimer.classList.add('running');
    else                            bigTimer.classList.add('paused');

    let st = 'WAITING';
    if (data.gameLocked)                                st = 'LOCKED — RESET TO PLAY AGAIN';
    else if (data.phase === 'running' && data.timerRunning)  st = 'RUNNING';
    else if (data.phase === 'running' && !data.timerRunning) st = 'PAUSED';
    statusBadge.textContent = st;

    // Disable Start/Resume when locked
    const locked = !!data.gameLocked;
    document.getElementById('btn-start').disabled = locked;
    if (pauseBtn) {
      pauseBtn.disabled = locked;
      pauseBtn.textContent = data.timerRunning ? '⏸ Pause' : '▶ Resume';
    }

    volDisplay.textContent = Math.round((data.volume || 0) * 100) + '%';
    clueCountEl.textContent = data.clueCount || 0;

    buildActiveHints(data.activeHints || []);
    renderBoardNow();
  });

  function buildActiveHints(hints) {
    const list = document.getElementById('active-hints-list');
    list.innerHTML = '';
    if (!hints.length) {
      list.innerHTML = '<div id="no-active-hints">None</div>';
      return;
    }
    hints.forEach(text => {
      const row = document.createElement('div');
      row.className = 'active-hint-row';

      const textEl = document.createElement('div');
      textEl.className = 'active-hint-text';
      textEl.textContent = text;

      const btn = document.createElement('button');
      btn.className = 'btn-dismiss-hint';
      btn.textContent = 'Dismiss';
      btn.addEventListener('click', () => cmd('dismiss-hint', { text }));

      row.appendChild(textEl);
      row.appendChild(btn);
      list.appendChild(row);
    });
  }

  // ── Progress board (public/board.js — global export, loaded via <script>) ──
  const { renderBoard, commandForBoardAction } = window.BoardUI;

  const UI_STATE_KEY = 'htm-op-board-ui'; // follows the 'htm-op-*' convention used by col-divider/notes persistence
  function loadUiState() {
    try { return JSON.parse(localStorage.getItem(UI_STATE_KEY) || '{}'); } catch (e) { return {}; }
  }
  function saveUiState() {
    try { localStorage.setItem(UI_STATE_KEY, JSON.stringify(uiState)); } catch (e) {}
  }
  let uiState = loadUiState();

  function renderBoardNow() {
    const cfg = loadConfig();
    boardRoot.innerHTML = renderBoard(cfg, currentState, uiState);
  }

  boardRoot.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;

    if (action === 'toggle-section') {
      // board.js renders the section header's data-on as `!bodyShown` (i.e. the
      // section's CURRENT collapsed-ness) — after a toggle, the new collapsed
      // value equals the section's current shown-ness, i.e. `data-on !== 'true'`.
      uiState.collapsedSections = uiState.collapsedSections || {};
      uiState.collapsedSections[el.dataset.sectionId] = el.dataset.on !== 'true';
      saveUiState();
      renderBoardNow();
      return;
    }
    if (action === 'toggle-step') {
      // board.js renders the step header's data-on as `!collapsed` (i.e. whether
      // the step is currently OPEN) — after a toggle, the new collapsed value
      // equals that same current-open flag, i.e. `data-on === 'true'`.
      uiState.collapsedSteps = uiState.collapsedSteps || {};
      uiState.collapsedSteps[el.dataset.stepId] = el.dataset.on === 'true';
      saveUiState();
      renderBoardNow();
      return;
    }
    // The flag checkbox itself carries data-action="set-flag" and is handled
    // exclusively by the dedicated 'change' listener below — falling through to
    // the generic dispatch here would send a second, duplicate set-flag command
    // per toggle (double-writing the append-only event store / Sheets mirror).
    if (isGenericDispatchExcluded(action)) return;

    const c = commandForBoardAction(action, el.dataset);
    if (!c) return;
    cmd(c.type, c);
  });

  // Flag checkboxes: 'change' is the semantically correct event for a checkbox
  // (fires once the checked state has actually settled) — the codebase has no
  // pre-existing checkbox wiring to follow, so this is the default choice.
  boardRoot.addEventListener('change', (e) => {
    const el = e.target.closest('[data-action="set-flag"]');
    if (!el) return;
    const c = commandForBoardAction('set-flag', { name: el.dataset.name, on: String(el.checked) });
    if (c) cmd(c.type, c);
  });

  const stopAudioBtn = document.getElementById('btn-stop-audio');
  if (stopAudioBtn) stopAudioBtn.addEventListener('click', () => cmd('stop-audio'));

  // Initial load — fetch from server so all devices share the same config
  fetchAndCacheConfig().then(() => renderBoardNow());

  // Ask the server for the current snapshot on load.
  setTimeout(() => cmd('request-state'), 300);
}
