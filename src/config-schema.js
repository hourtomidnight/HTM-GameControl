function isStr(v) { return typeof v === 'string'; }
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function isInt(v) { return Number.isInteger(v); }

const ALLOWED_TOP_LEVEL = new Set([
  'roomName', 'game', 'sheets', 'hintGroups', 'banks',
  'plcs', 'signals', 'rules', 'profiles', 'sequences',
  'sections', 'steps', 'progress', 'audio',
]);

const HINT_TYPES = ['text', 'audio'];

function validateSectionsStepsProgressAudio(cfg, errors) {
  const sectionIds = new Set();
  if (cfg.sections !== undefined) {
    if (!Array.isArray(cfg.sections)) errors.push('sections must be an array');
    else cfg.sections.forEach((s, i) => {
      if (!isStr(s.id)) errors.push(`sections[${i}].id must be a string`);
      else {
        if (sectionIds.has(s.id)) errors.push(`duplicate section id: ${s.id}`);
        sectionIds.add(s.id);
      }
      if (!isStr(s.name)) errors.push(`sections[${i}].name must be a string`);
      if (!isNum(s.order)) errors.push(`sections[${i}].order must be a number`);
      if (s.note !== undefined && !isStr(s.note)) errors.push(`sections[${i}].note must be a string`);
    });
  }

  const hintIds = new Set();
  if (cfg.steps !== undefined) {
    if (!Array.isArray(cfg.steps)) errors.push('steps must be an array');
    else {
      const stepIds = new Set();
      cfg.steps.forEach((st, i) => {
        if (!isStr(st.id)) errors.push(`steps[${i}].id must be a string`);
        else {
          if (stepIds.has(st.id)) errors.push(`duplicate step id: ${st.id}`);
          stepIds.add(st.id);
        }
        if (!isStr(st.name)) errors.push(`steps[${i}].name must be a string`);
        if (!isNum(st.order)) errors.push(`steps[${i}].order must be a number`);
        if (st.sectionId !== undefined && st.sectionId !== null) {
          if (!isStr(st.sectionId)) errors.push(`steps[${i}].sectionId must be a string`);
          else if (!sectionIds.has(st.sectionId)) errors.push(`steps[${i}] references unknown section: ${st.sectionId}`);
        }
        if (st.hints !== undefined) {
          if (!Array.isArray(st.hints)) { errors.push(`steps[${i}].hints must be an array`); return; }
          st.hints.forEach((h, j) => {
            if (!isStr(h.id)) errors.push(`steps[${i}].hints[${j}].id must be a string`);
            else {
              if (hintIds.has(h.id)) errors.push(`duplicate hint id: ${h.id}`);
              hintIds.add(h.id);
            }
            if (!HINT_TYPES.includes(h.type)) errors.push(`steps[${i}].hints[${j}].type invalid (must be text or audio)`);
            if (h.type === 'text' && (!isStr(h.text) || h.text.trim() === ''))
              errors.push(`steps[${i}].hints[${j}].text must be a non-empty string`);
            if (h.type === 'audio' && (!isStr(h.mediaRef) || h.mediaRef.trim() === ''))
              errors.push(`steps[${i}].hints[${j}].mediaRef must be a non-empty string`);
            for (const k of ['label', 'color', 'icon', 'key'])
              if (h[k] !== undefined && !isStr(h[k])) errors.push(`steps[${i}].hints[${j}].${k} must be a string`);
            if (h.countsAsClue !== undefined && typeof h.countsAsClue !== 'boolean')
              errors.push(`steps[${i}].hints[${j}].countsAsClue must be a boolean`);
          });
        }
      });
    }
  }

  if (cfg.progress !== undefined) {
    if (typeof cfg.progress !== 'object' || cfg.progress === null) errors.push('progress must be an object');
    else if (cfg.progress.flags !== undefined) {
      if (!Array.isArray(cfg.progress.flags)) errors.push('progress.flags must be an array');
      else cfg.progress.flags.forEach((f, i) => { if (!isStr(f)) errors.push(`progress.flags[${i}] must be a string`); });
    }
  }

  if (cfg.audio !== undefined) {
    if (typeof cfg.audio !== 'object' || cfg.audio === null) errors.push('audio must be an object');
    else {
      if (cfg.audio.volume !== undefined && !isNum(cfg.audio.volume)) errors.push('audio.volume must be a number');
      if (cfg.audio.events !== undefined) {
        if (typeof cfg.audio.events !== 'object' || cfg.audio.events === null) errors.push('audio.events must be an object');
        else for (const [name, ev] of Object.entries(cfg.audio.events)) {
          if (typeof ev !== 'object' || ev === null) { errors.push(`audio.events.${name} must be an object`); continue; }
          if (ev.file !== undefined && !isStr(ev.file)) errors.push(`audio.events.${name}.file must be a string`);
          if (ev.enabled !== undefined && typeof ev.enabled !== 'boolean') errors.push(`audio.events.${name}.enabled must be a boolean`);
          if (name === 'midShow' && ev.enabled) {
            if (!isNum(ev.atSecondsRemaining) || ev.atSecondsRemaining <= 0)
              errors.push('audio.events.midShow.atSecondsRemaining must be a positive number when enabled');
          }
        }
      }
    }
  }
}

function validateConfig(cfg = {}) {
  const errors = [];

  for (const k of Object.keys(cfg || {})) {
    if (!ALLOWED_TOP_LEVEL.has(k)) errors.push('unknown top-level key: ' + k);
  }

  const g = cfg.game;
  if (g !== undefined) {
    if (typeof g !== 'object' || g === null) errors.push('game must be an object');
    else {
      if (g.timerMinutes !== undefined && !isNum(g.timerMinutes)) errors.push('game.timerMinutes must be a number');
      if (g.volume !== undefined && !isNum(g.volume)) errors.push('game.volume must be a number');
      if (g.hintCycleSeconds !== undefined && !isNum(g.hintCycleSeconds)) errors.push('game.hintCycleSeconds must be a number');
      if (g.eventRetentionDays !== undefined && g.eventRetentionDays !== null && !isInt(g.eventRetentionDays))
        errors.push('game.eventRetentionDays must be an integer or null');
      for (const k of ['logoPath', 'introMediaPath', 'startStopKey'])
        if (g[k] !== undefined && !isStr(g[k])) errors.push(`game.${k} must be a string`);
    }
  }

  if (cfg.sheets !== undefined) {
    if (typeof cfg.sheets !== 'object' || cfg.sheets === null) errors.push('sheets must be an object');
    else for (const [k, v] of Object.entries(cfg.sheets))
      if (!isStr(v)) errors.push(`sheets.${k} must be a string`);
  }

  if (cfg.hintGroups !== undefined) {
    if (!Array.isArray(cfg.hintGroups)) errors.push('hintGroups must be an array');
    else cfg.hintGroups.forEach((grp, i) => {
      if (typeof grp !== 'object' || grp === null) { errors.push(`hintGroups[${i}] must be an object`); return; }
      if (grp.name !== undefined && !isStr(grp.name)) errors.push(`hintGroups[${i}].name must be a string`);
      if (grp.hints !== undefined) {
        if (!Array.isArray(grp.hints)) errors.push(`hintGroups[${i}].hints must be an array`);
        else grp.hints.forEach((h, j) => {
          if (h.text !== undefined && !isStr(h.text)) errors.push(`hintGroups[${i}].hints[${j}].text must be a string`);
          if (h.key !== undefined && !isStr(h.key)) errors.push(`hintGroups[${i}].hints[${j}].key must be a string`);
        });
      }
    });
  }

  const plcIds = new Set();
  if (cfg.plcs !== undefined) {
    if (!Array.isArray(cfg.plcs)) errors.push('plcs must be an array');
    else cfg.plcs.forEach((p, i) => {
      if (!isStr(p.id)) errors.push(`plcs[${i}].id must be a string`);
      else { if (plcIds.has(p.id)) errors.push(`duplicate plc id: ${p.id}`); plcIds.add(p.id); }
      if (!isStr(p.host)) errors.push(`plcs[${i}].host must be a string`);
      if (p.port !== undefined && !isInt(p.port)) errors.push(`plcs[${i}].port must be an integer`);
      if (p.pollMs !== undefined && !isInt(p.pollMs)) errors.push(`plcs[${i}].pollMs must be an integer`);
    });
  }

  if (cfg.signals !== undefined) {
    if (!Array.isArray(cfg.signals)) errors.push('signals must be an array');
    else {
      const names = new Set();
      cfg.signals.forEach((sig, i) => {
        if (!isStr(sig.name)) { errors.push(`signals[${i}].name must be a string`); return; }
        if (names.has(sig.name)) errors.push(`duplicate signal name: ${sig.name}`);
        names.add(sig.name);
        if (!['in', 'out', 'in-out'].includes(sig.direction)) errors.push(`signals[${i}].direction invalid`);
        if (!['bool', 'int', 'float', 'string'].includes(sig.type)) errors.push(`signals[${i}].type invalid`);
        if (!['internal', 'modbus', 'gpio'].includes(sig.driver)) errors.push(`signals[${i}].driver invalid`);
        if (sig.driver === 'modbus') {
          const a = sig.address || {};
          if (!isStr(a.plc)) errors.push(`signals[${i}].address.plc must be a string`);
          else if (!plcIds.has(a.plc)) errors.push(`signals[${i}] references unknown plc: ${a.plc}`);
          if (!['coil', 'discrete', 'input', 'holding'].includes(a.fn)) errors.push(`signals[${i}].address.fn invalid`);
          if (!isInt(a.register)) errors.push(`signals[${i}].address.register must be an integer`);
        }
      });
    }
  }

  validateSectionsStepsProgressAudio(cfg, errors);

  return { ok: errors.length === 0, errors };
}

module.exports = { validateConfig };
