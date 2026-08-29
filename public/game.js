// Display-only game client.
// The server is authoritative for all game state (Task 5 game-engine). This
// script owns NO state and NEVER computes the timer — it renders whatever the
// latest SSE `state` snapshot says.
//
// Snapshot shape (from /events):
//   { type:'state', phase, currentMin, currentSec, clockForward, timerRunning,
//     gameLocked, onSplash, clueCount, volume, startMinutes, activeHints:[], gameId }
//   phase ∈ { waiting, running, escaped }   (paused = phase:'running' + timerRunning:false)

function pad(n) { return n < 10 ? '0' + n : '' + n; }

// ── Pure render mapper (unit-tested, DOM-free) ───────────────────────────────
function renderModel(s) {
  const bigText = (s.clockForward ? '− ' : '') + pad(s.currentMin) + ':' + pad(s.currentSec);

  let cssClass = 'paused';
  if (s.gameLocked) cssClass = 'escaped';
  else if (s.clockForward) cssClass = 'negative';
  else if (s.timerRunning) cssClass = 'running';

  let statusText = 'WAITING';
  if (s.gameLocked) statusText = 'LOCKED — RESET TO PLAY AGAIN';
  else if (s.phase === 'running' && s.timerRunning) statusText = 'RUNNING';
  else if (s.phase === 'running' && !s.timerRunning) statusText = 'PAUSED';

  const clue = (s.activeHints && s.activeHints[0]) || '';

  return { bigText, statusText, cssClass, clue };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { renderModel };
} else {
  // ── Browser: subscribe to SSE `state` snapshots and paint the DOM ──────────
  let prev = null;

  // DOM
  const splashEl     = document.getElementById('splash');
  const splashTextEl = document.getElementById('splash-text');
  const logoEl       = document.getElementById('logo');
  const timerEl      = document.getElementById('timer-display');
  const negativeEl   = document.getElementById('negative-symbol');
  const clueBoxEl    = document.getElementById('clue-box');
  const clueCountEl  = document.getElementById('clue-counter');
  const volumeBarEl  = document.getElementById('volume-bar');
  const statusEl     = document.getElementById('status');

  // Audio (play/stop only — driven by prev-vs-current snapshot)
  function makeAudio(file) { const a = new Audio('assets/' + file); a.preload = 'auto'; return a; }
  const timerMusic  = makeAudio('TimerMusic.mp3');
  const finaleMusic = makeAudio('FinaleMusic.mp3');
  const clueSound   = makeAudio('ClueSound.mp3');
  timerMusic.loop = true;

  function applyVolume(v) {
    const vol = Math.max(0, Math.min(1, v == null ? 0.4 : v));
    timerMusic.volume = finaleMusic.volume = clueSound.volume = vol;
    if (volumeBarEl) volumeBarEl.textContent = 'Vol: ' + Math.round(vol * 100) + '%';
  }

  // Config is server-owned; we only need the logo path for display.
  fetch('/config').then(r => r.ok ? r.json() : {}).then(cfg => {
    const g = cfg.game || {};
    if (logoEl) logoEl.src = g.logoPath || '';
    HINT_CYCLE_MS = g.hintCycleSeconds ? g.hintCycleSeconds * 1000 : 5000;
    restartHintCycle();
  }).catch(() => {});

  // ── Hint-cycle DISPLAY (driven entirely by state.activeHints) ─────────────
  let activeHints   = [];
  let hintCycleIdx  = 0;
  let hintCycleTimer = null;
  let HINT_CYCLE_MS = 5000;

  function renderCurrentHint() {
    if (activeHints.length === 0) { clueBoxEl.textContent = ''; return; }
    if (hintCycleIdx >= activeHints.length) hintCycleIdx = 0;
    clueBoxEl.textContent = activeHints[hintCycleIdx];
  }
  function fadeToNextHint() {
    clueBoxEl.classList.add('fading');
    setTimeout(() => {
      hintCycleIdx = (hintCycleIdx + 1) % activeHints.length;
      renderCurrentHint();
      clueBoxEl.classList.remove('fading');
    }, 420);
  }
  function restartHintCycle() {
    if (hintCycleTimer) { clearInterval(hintCycleTimer); hintCycleTimer = null; }
    if (activeHints.length > 1) hintCycleTimer = setInterval(fadeToNextHint, HINT_CYCLE_MS);
  }
  function syncHints(next) {
    const changed = next.length !== activeHints.length ||
      next.some((t, i) => t !== activeHints[i]);
    if (!changed) return;
    activeHints = next.slice();
    if (hintCycleIdx >= activeHints.length) hintCycleIdx = 0;
    renderCurrentHint();
    restartHintCycle();
  }

  // ── Audio transitions ────────────────────────────────────────────────────
  function handleAudio(before, after) {
    const running = after.phase === 'running' && after.timerRunning && !after.onSplash;
    if (running) { timerMusic.play().catch(() => {}); }
    else { timerMusic.pause(); }

    if (after.phase === 'escaped' && (!before || before.phase !== 'escaped')) {
      finaleMusic.currentTime = 0; finaleMusic.play().catch(() => {});
    }
    if (after.phase !== 'escaped') { finaleMusic.pause(); finaleMusic.currentTime = 0; }

    const had = before && before.activeHints ? before.activeHints.length : 0;
    const now = after.activeHints ? after.activeHints.length : 0;
    if (now > had) { clueSound.currentTime = 0; clueSound.play().catch(() => {}); }
  }

  // ── Paint ────────────────────────────────────────────────────────────────
  function paint(s) {
    const m = renderModel(s);

    timerEl.textContent = m.bigText;
    negativeEl.style.opacity = s.clockForward ? '1' : '0';
    statusEl.textContent = m.statusText;
    document.body.className = m.cssClass;

    clueCountEl.textContent = 'Clues: ' + (s.clueCount || 0);
    applyVolume(s.volume);

    // Splash / logo
    const showSplash = s.onSplash || s.phase === 'waiting' || s.gameLocked;
    if (showSplash) {
      splashEl.classList.remove('hidden');
      logoEl.classList.remove('visible');
      if (s.gameLocked) {
        splashTextEl.classList.remove('dim');
        splashTextEl.textContent = 'You Escaped!';
      } else {
        splashTextEl.classList.add('dim');
        splashTextEl.textContent = 'Please wait until you are instructed to begin.';
      }
    } else {
      splashEl.classList.add('hidden');
      logoEl.classList.add('visible');
    }

    syncHints(s.activeHints || []);
    handleAudio(prev, s);
    prev = s;
  }

  channel.addEventListener('message', (e) => {
    const s = e.data;
    if (!s || s.type !== 'state') return;
    paint(s);
  });

  // Ask the server for the current snapshot on load.
  setTimeout(() => channel.postMessage({ type: 'request-state' }), 300);
}
