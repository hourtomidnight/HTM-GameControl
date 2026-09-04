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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { commandFor };
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
  const hintsList   = document.getElementById('hints-list');
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

  // ── Build grouped hints from config ─────────────────────────────────────
  function buildHints() {
    const cfg = loadConfig();
    const groups = cfg.hintGroups || [];
    hintsList.innerHTML = '';

    if (!groups.length || groups.every(g => !g.hints || g.hints.length === 0)) {
      hintsList.innerHTML = '<div id="no-hints-msg">No hints configured. Open ⚙ Config to add hint groups.</div>';
      return;
    }

    groups.forEach((group, gi) => {
      if (!group.hints || group.hints.length === 0) return;

      const groupEl = document.createElement('div');
      groupEl.className = 'hint-group';

      // Collapsible header
      const hdr = document.createElement('div');
      hdr.className = 'hint-group-header';
      hdr.innerHTML = '<span>' + (group.name || 'Group ' + (gi + 1)) + '</span>' +
                      '<span class="toggle-icon">▾</span>';
      hdr.addEventListener('click', () => {
        const body = groupEl.querySelector('.hint-group-body');
        const icon = hdr.querySelector('.toggle-icon');
        body.classList.toggle('collapsed');
        icon.textContent = body.classList.contains('collapsed') ? '▸' : '▾';
      });

      const body = document.createElement('div');
      body.className = 'hint-group-body';

      group.hints.forEach((hint, hi) => {
        const btn = document.createElement('button');
        btn.className = 'hint-btn';

        const badge = document.createElement('span');
        badge.className = 'hint-key-badge' + (hint.key ? '' : ' no-key');
        badge.textContent = hint.key || '—';

        const textEl = document.createElement('span');
        textEl.className = 'hint-text';
        textEl.textContent = hint.text;

        btn.appendChild(badge);
        btn.appendChild(textEl);

        btn.addEventListener('click', () => {
          cmd('show-hint', { text: hint.text });
          // Flash the button
          btn.style.background = '#2a2a80';
          setTimeout(() => btn.style.background = '', 300);
        });

        body.appendChild(btn);
      });

      groupEl.appendChild(hdr);
      groupEl.appendChild(body);
      hintsList.appendChild(groupEl);
    });
  }

  // Reload hints when config changes (storage event fires in same-browser tabs)
  window.addEventListener('storage', (e) => {
    if (e.key === 'htm-config') buildHints();
  });

  // Initial load — fetch from server so all devices share the same config
  fetchAndCacheConfig().then(() => buildHints());

  // Ask the server for the current snapshot on load.
  setTimeout(() => cmd('request-state'), 300);
}
