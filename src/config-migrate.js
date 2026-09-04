// src/config-migrate.js
// Pure conversion of the old flat `hintGroups` config shape into the new
// sections/steps/progress/audio shape. No fs, no db — config.js wires the
// write-back. See docs/superpowers/specs/2026-08-30-hints-and-audio-design.md §2.3.

function defaultAudio(existingVolume) {
  return {
    volume: existingVolume != null ? existingVolume : 0.4,
    events: {
      start:     { file: '', enabled: false },
      loop:      { file: '', enabled: false },
      midShow:   { file: '', enabled: false, atSecondsRemaining: 120 },
      win:       { file: '', enabled: false },
      lose:      { file: '', enabled: false },
      clueChime: { file: '', enabled: false },
    },
  };
}

function migrateHintGroupsToSteps(cfg) {
  if (!cfg || typeof cfg !== 'object') return { cfg: {}, migrated: false };
  if (cfg.steps !== undefined || cfg.hintGroups === undefined) {
    return { cfg, migrated: false };
  }

  const groups = Array.isArray(cfg.hintGroups) ? cfg.hintGroups : [];
  const steps = groups.map((g, i) => {
    const stepId = 'step_' + (i + 1);
    const hints = (g.hints || []).map((h, j) => ({
      id: stepId + '_h' + (j + 1),
      type: 'text',
      text: h.text || '',
      key: h.key || '',
      countsAsClue: true,
    }));
    return {
      id: stepId,
      name: g.name || ('Group ' + (i + 1)),
      order: i + 1,
      sectionId: null,
      hints,
    };
  });

  const migrated = {
    ...cfg,
    sections: cfg.sections || [],
    steps,
    progress: cfg.progress || { flags: [] },
    audio: cfg.audio || defaultAudio(cfg.game && cfg.game.volume),
  };

  return { cfg: migrated, migrated: true };
}

module.exports = { migrateHintGroupsToSteps };
