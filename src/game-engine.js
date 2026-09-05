const st = require('./session-tracker');

const EDITABLE = ['teamName', 'operator', 'newPlayers', 'experiencedPlayers', 'notes'];
const ADJ = { 'add-min': [1, 0], 'sub-min': [-1, 0], 'add-sec': [0, 1], 'sub-sec': [0, -1] };

function createGameEngine(deps) {
  const {
    eventStore, gameStore,
    now = () => Date.now(),
    setInterval: setIv = setInterval, clearInterval: clearIv = clearInterval,
    sheets = null, signalBus = null, progress = null,
    audioPlayer = null, config = null,
    roomName = '',
  } = deps;

  let startMinutes = 60;
  let s = blankState();
  let session = null;
  let gameId = null;
  let pendingFields = {};
  let timer = null;
  let midShowFired = false;
  // Set when vol-up/vol-down mutates config.current().audio.volume in memory;
  // cleared after a successful config.save() on a lifecycle transition. Gates
  // safeConfigSave() so a byte-identical config is never rewritten (Ruling G).
  let volumeDirty = false;
  const listeners = [];

  // Restore-on-boot: seed volume from persisted config, push to the player.
  if (config) {
    reseedVolumeFromConfig();
  }
  if (audioPlayer) safeAudio(() => audioPlayer.setVolume(s.volume));

  function blankState() {
    return {
      type: 'state', phase: 'waiting',
      currentMin: startMinutes, currentSec: 0, clockForward: false,
      timerRunning: false, gameLocked: false, onSplash: true,
      clueCount: 0, volume: 0.4, startMinutes, activeHints: [], gameId: null,
    };
  }

  function emit() {
    s.gameId = gameId;
    for (const fn of listeners) { try { fn(getState()); } catch {} }
    if (signalBus) mirrorSignals();
  }

  function getState() {
    const base = { ...s, activeHints: s.activeHints.slice() };
    if (progress) {
      const snap = progress.snapshot();
      base.steps = snap.steps;
      base.flags = snap.flags;
    }
    return base;
  }

  function onState(fn) {
    listeners.push(fn);
    return () => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  function mirrorSignals() {
    try {
      signalBus.set('phase', s.phase);
      signalBus.set('timer_running', s.timerRunning);
      signalBus.set('game_locked', s.gameLocked);
    } catch {}
  }

  function record(type, extra = {}) {
    try {
      eventStore.record({ ts: now(), source: extra._source || 'operator', type,
        subject: extra.subject, value: extra.value, game_id: gameId, detail: extra.detail });
    } catch {}
  }

  function safeSheets(fn) {
    try {
      const p = fn();
      if (p && typeof p.then === 'function') p.catch(() => {});
    } catch {}
  }

  function safeAudio(fn) {
    try {
      const p = fn();
      if (p && typeof p.then === 'function') p.catch(() => {});
    } catch {}
  }

  function safeConfigSave() {
    if (!volumeDirty) return; // nothing changed since the last persist — skip the disk write
    try {
      const r = config.save(config.current());
      if (r && r.ok === false) {
        record('config-save-error', { _source: 'system', detail: { errors: r.errors } });
        return; // leave volumeDirty set so the next transition retries
      }
      volumeDirty = false;
    } catch (err) {
      record('config-save-error', { _source: 'system', detail: { error: String((err && err.message) || err) } });
    }
  }

  function audioEvents() {
    return (config && config.current().audio && config.current().audio.events) || {};
  }

  function findHint(stepId, hintId) {
    if (!config || !stepId || !hintId) return null;
    const steps = config.current().steps;
    if (!Array.isArray(steps)) return null;
    const step = steps.find(st => st && st.id === stepId);
    if (!step || !Array.isArray(step.hints)) return null;
    return step.hints.find(h => h && h.id === hintId) || null;
  }

  function reseedVolumeFromConfig() {
    if (!config) return;
    const audio = config.current().audio;
    const v = Number(audio && audio.volume);
    if (Number.isFinite(v)) s.volume = Math.max(0, Math.min(1, v));
  }

  function startTimer() {
    if (timer != null) return;
    timer = setIv(() => tickOnce(), 1000);
  }
  function stopTimer() { if (timer != null) { clearIv(timer); timer = null; } }

  function tickOnce() {
    if (!s.timerRunning) return;
    if (!s.clockForward) {
      s.currentSec--;
      if (s.currentSec < 0) { s.currentMin--; s.currentSec = 59; }
      if (s.currentMin < 0) { s.clockForward = true; s.currentMin = 0; s.currentSec = 0; }
    } else {
      s.currentSec++;
      if (s.currentSec >= 60) { s.currentMin++; s.currentSec = 0; }
    }
    if (audioPlayer && !midShowFired && !s.clockForward) {
      const mid = audioEvents().midShow;
      if (mid && mid.enabled && mid.file &&
          (s.currentMin * 60 + s.currentSec) <= mid.atSecondsRemaining) {
        safeAudio(() => audioPlayer.playEffect(mid.file));
        midShowFired = true;
      }
    }
    emit();
  }

  function syncGameRow(patch) {
    if (gameId == null) return;
    try { gameStore.update(gameId, patch); } catch {}
  }

  function command(msg) {
    const type = msg.type;

    if (type === 'update-field') {
      if (!EDITABLE.includes(msg.field)) return;
      if (!session) { pendingFields[msg.field] = msg.value; }
      else { st.updateField(session, msg.field, msg.value);
             syncGameRow(fieldPatch(msg.field, msg.value)); }
      record(type, { subject: msg.field, value: msg.value, _source: msg._source });
      return;
    }

    if (type === 'request-state') { emit(); return; }

    if (type === 'vol-up' || type === 'vol-down') {
      s.volume = Math.max(0, Math.min(1, s.volume + (type === 'vol-up' ? 0.01 : -0.01)));
      if (audioPlayer) safeAudio(() => audioPlayer.setVolume(s.volume));
      // Deliberate in-place mutation of the live config object: the volume delta is
      // kept in memory only. The disk save (config.save) is intentionally deferred to
      // lifecycle transitions (start/escaped/reset) so a volume click never writes
      // config_history (Ruling G).
      if (config && config.current().audio) { config.current().audio.volume = s.volume; volumeDirty = true; }
      record(type, { _source: msg._source }); emit(); return;
    }

    if ((type === 'start' || type === 'force-start') && s.phase === 'waiting' && !s.gameLocked) {
      const startTime = now();
      session = st.createSession({ startTime, room: roomName, ...pendingFields });
      let g;
      try {
        g = gameStore.create({
          started_ts: startTime, room: roomName, operator: session.operator,
          team_name: session.teamName, new_players: session.newPlayers,
          exp_players: session.experiencedPlayers, notes: session.notes,
        });
      } catch (err) {
        session = null;
        try {
          eventStore.record({ ts: now(), source: 'system', type: 'game-store-error',
            value: String(err && err.message || err) });
        } catch {}
        return; // stay at phase 'waiting' — do not half-start
      }
      pendingFields = {};
      gameId = g.id;
      s.phase = 'running'; s.timerRunning = true; s.onSplash = false;
      s.currentMin = startMinutes; s.currentSec = 0; s.clockForward = false;
      midShowFired = false;
      startTimer();
      if (progress) { try { progress.startGame(gameId, startTime); } catch {} }
      record(type, { _source: msg._source });
      if (sheets) safeSheets(() => sheets.onGameStart(gameId, session));
      if (audioPlayer) {
        const ev = audioEvents();
        if (ev.start && ev.start.enabled && ev.start.file) safeAudio(() => audioPlayer.playEffect(ev.start.file));
        if (ev.loop && ev.loop.enabled && ev.loop.file) safeAudio(() => audioPlayer.playMusic(ev.loop.file));
      }
      if (config) safeConfigSave();
      emit();
      return;
    }

    if (type === 'pause' && s.phase === 'running') {
      s.timerRunning = false; record(type, { _source: msg._source }); emit(); return;
    }
    if (type === 'resume' && !s.gameLocked && s.phase === 'running') {
      s.timerRunning = true; record(type, { _source: msg._source }); emit(); return;
    }

    if (ADJ[type]) {
      if (s.gameLocked || s.phase !== 'running') return;
      const [dMin, dSec] = ADJ[type];
      adjustClock(dMin, dSec);
      if (session) {
        st.applyAdjustment(session, type, now());
        syncGameRow({ adjustments: session.adjustments.length,
                      net_adjust_s: st.netAdjustmentSeconds(session) });
      }
      record(type, { _source: msg._source });
      if (sheets && gameId != null && session) safeSheets(() => sheets.onSessionSync(gameId, session));
      emit();
      return;
    }

    if (type === 'show-hint') {
      if (!session) return;
      const rec = st.applyHint(session, msg.text || '', now());
      if (!s.activeHints.includes(rec.text)) s.activeHints.push(rec.text);
      const shownHint = findHint(msg.stepId, msg.hintId);
      const hintCounts = shownHint ? (shownHint.countsAsClue !== false) : true;
      if (hintCounts && msg.noCount !== true) s.clueCount++;
      if (audioPlayer && (!shownHint || shownHint.type !== 'audio')) {
        const chime = audioEvents().clueChime;
        if (chime && chime.enabled && chime.file) safeAudio(() => audioPlayer.playEffect(chime.file));
      }
      syncGameRow({ hint_count: session.hints.length });
      if (progress && msg.stepId) { try { progress.markGiven(msg.stepId); } catch {} }
      record(type, { subject: 'hint', value: rec.text, _source: msg._source });
      if (sheets && gameId != null) safeSheets(() => sheets.onHint(gameId, session, rec));
      emit();
      return;
    }
    if (type === 'dismiss-hint') {
      s.activeHints = s.activeHints.filter(h => h !== msg.text);
      record(type, { subject: 'hint', value: msg.text, _source: msg._source }); emit(); return;
    }
    if (type === 'hide-clue') {
      s.activeHints = []; record(type, { _source: msg._source }); emit(); return;
    }

    if (type === 'solve-step') {
      if (!progress || s.phase !== 'running' || s.gameLocked) return;
      progress.solveStep(msg.stepId, !!msg.on);
      record(type, { subject: msg.stepId, value: !!msg.on, _source: msg._source });
      emit();
      return;
    }
    if (type === 'set-flag') {
      if (!progress || s.phase !== 'running' || s.gameLocked) return;
      progress.setFlag(msg.name, !!msg.on);
      record(type, { subject: msg.name, value: !!msg.on, _source: msg._source });
      emit();
      return;
    }

    if (type === 'play-hint') {
      if (s.phase !== 'running') return;
      if (!audioPlayer) return;
      const hint = findHint(msg.stepId, msg.hintId);
      if (hint && hint.mediaRef) safeAudio(() => audioPlayer.playEffect(hint.mediaRef));
      if (progress && msg.stepId) { try { progress.markGiven(msg.stepId); } catch {} }
      const counts = hint ? (hint.countsAsClue !== false) : true;
      if (counts && msg.noCount !== true) s.clueCount++;
      record('play-hint', { subject: msg.stepId, value: msg.hintId, _source: msg._source });
      emit();
      return;
    }

    if (type === 'stop-audio') {
      if (audioPlayer) safeAudio(() => audioPlayer.stopAll());
      record('stop-audio', { _source: msg._source });
      emit();
      return;
    }

    if (type === 'escaped') {
      if (session) {
        st.finalizeSession(session, now(), 'Escaped');
        syncGameRow({ ended_ts: session.endTime, status: 'Escaped' });
        if (sheets && gameId != null) safeSheets(() => sheets.onSessionSync(gameId, session));
      }
      s.phase = 'escaped'; s.timerRunning = false; s.gameLocked = true; s.onSplash = true;
      stopTimer();
      record(type, { _source: msg._source });
      session = null;
      if (audioPlayer) {
        const ev = audioEvents();
        safeAudio(() => audioPlayer.stopMusic());
        if (ev.win && ev.win.enabled && ev.win.file) safeAudio(() => audioPlayer.playEffect(ev.win.file));
      }
      if (config) safeConfigSave();
      emit();
      return;
    }

    if (type === 'reset') {
      const wasRunning = s.phase === 'running';
      if (session) {
        st.finalizeSession(session, now(), 'Reset-Lost');
        syncGameRow({ ended_ts: session.endTime, status: 'Reset-Lost' });
        if (sheets && gameId != null) safeSheets(() => sheets.onSessionSync(gameId, session));
      }
      stopTimer();
      session = null; gameId = null; pendingFields = {};
      if (audioPlayer) {
        const ev = audioEvents();
        if (wasRunning) {
          safeAudio(() => audioPlayer.stopMusic());
          if (ev.lose && ev.lose.enabled && ev.lose.file) safeAudio(() => audioPlayer.playEffect(ev.lose.file));
        } else {
          safeAudio(() => audioPlayer.stopAll());
        }
      }
      s = blankState();
      reseedVolumeFromConfig();
      midShowFired = false;
      if (progress) { try { progress.startGame(null, now()); } catch {} }
      record(type, { _source: msg._source });
      if (config) safeConfigSave();
      emit();
      return;
    }
  }

  function fieldPatch(field, value) {
    return ({
      teamName: { team_name: value }, operator: { operator: value },
      newPlayers: { new_players: value }, experiencedPlayers: { exp_players: value },
      notes: { notes: value },
    })[field] || {};
  }

  function adjustClock(dMin, dSec) {
    s.currentSec += dSec;
    if (s.currentSec >= 60) { s.currentMin++; s.currentSec -= 60; }
    if (s.currentSec < 0)   { s.currentMin--; s.currentSec += 60; }
    s.currentMin = Math.max(0, Math.min(999, s.currentMin + dMin));
  }

  function setStartMinutes(m) {
    startMinutes = m;
    if (s.phase === 'waiting') { s.startMinutes = m; s.currentMin = m; s.currentSec = 0; emit(); }
  }

  return { command, getState, onState, tickOnce, setStartMinutes };
}

module.exports = { createGameEngine };
