const st = require('./session-tracker');

const EDITABLE = ['teamName', 'operator', 'newPlayers', 'experiencedPlayers', 'notes'];
const ADJ = { 'add-min': [1, 0], 'sub-min': [-1, 0], 'add-sec': [0, 1], 'sub-sec': [0, -1] };

function createGameEngine(deps) {
  const {
    eventStore, gameStore,
    now = () => Date.now(),
    setInterval: setIv = setInterval, clearInterval: clearIv = clearInterval,
    sheets = null, signalBus = null,
  } = deps;

  let startMinutes = 60;
  let s = blankState();
  let session = null;
  let gameId = null;
  let pendingFields = {};
  let timer = null;
  const listeners = [];

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

  function getState() { return { ...s, activeHints: s.activeHints.slice() }; }

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
      record(type, { _source: msg._source }); emit(); return;
    }

    if ((type === 'start' || type === 'force-start') && s.phase === 'waiting' && !s.gameLocked) {
      const startTime = now();
      session = st.createSession({ startTime, room: s.room || '', ...pendingFields });
      let g;
      try {
        g = gameStore.create({
          started_ts: startTime, room: session.room, operator: session.operator,
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
      startTimer();
      record(type, { _source: msg._source });
      if (sheets) safeSheets(() => sheets.onGameStart(gameId, session));
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
      const [dMin, dSec] = ADJ[type];
      adjustClock(dMin, dSec);
      if (session) {
        st.applyAdjustment(session, type, now());
        syncGameRow({ adjustments: session.adjustments.length,
                      net_adjust_s: st.netAdjustmentSeconds(session) });
      }
      record(type, { _source: msg._source });
      if (sheets && gameId != null) safeSheets(() => sheets.onSessionSync(gameId, session));
      emit();
      return;
    }

    if (type === 'show-hint') {
      if (!session) return;
      const rec = st.applyHint(session, msg.text || '', now());
      if (!s.activeHints.includes(rec.text)) s.activeHints.push(rec.text);
      s.clueCount++;
      syncGameRow({ hint_count: session.hints.length });
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
      emit();
      return;
    }

    if (type === 'reset') {
      if (session) {
        st.finalizeSession(session, now(), 'Reset-Lost');
        syncGameRow({ ended_ts: session.endTime, status: 'Reset-Lost' });
        if (sheets && gameId != null) safeSheets(() => sheets.onSessionSync(gameId, session));
      }
      stopTimer();
      session = null; gameId = null; pendingFields = {};
      s = blankState();
      record(type, { _source: msg._source });
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
