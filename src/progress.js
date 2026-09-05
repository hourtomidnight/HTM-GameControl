function createProgress({ eventStore, now = () => Date.now() }) {
  let gameId = null;
  let startedTs = null;
  let steps = {};
  let flags = {};

  function record(type, subject, extra = {}) {
    try {
      eventStore.record({ source: 'progress', type, subject, game_id: gameId, ...extra });
    } catch {}
  }

  function startGame(newGameId, newStartedTs) {
    gameId = newGameId;
    startedTs = newStartedTs;
    steps = {};
    flags = {};
    record('progress-reset', undefined);
  }

  function ensureStep(stepId) {
    if (!steps[stepId]) steps[stepId] = { clueGivenAt: null, solvedAt: null };
    return steps[stepId];
  }

  function markGiven(stepId) {
    const step = ensureStep(stepId);
    if (step.clueGivenAt != null) return; // idempotent no-op
    step.clueGivenAt = now();
    record('hint-given', stepId);
  }

  function solveStep(stepId, on) {
    const step = ensureStep(stepId);
    if (on) {
      const solvedAt = now();
      step.solvedAt = solvedAt;
      const detail = { elapsedMs: solvedAt - startedTs };
      if (step.clueGivenAt != null) detail.clueToSolveMs = solvedAt - step.clueGivenAt;
      record('step-solved', stepId, { detail });
    } else {
      step.solvedAt = null;
      record('step-unsolved', stepId);
    }
  }

  function setFlag(name, on) {
    flags[name] = on ? now() : null;
    record('flag-set', name, { value: on });
  }

  function snapshot() {
    const stepsCopy = {};
    for (const [id, v] of Object.entries(steps)) stepsCopy[id] = { ...v };
    return { steps: stepsCopy, flags: { ...flags } };
  }

  return { startGame, markGiven, solveStep, setFlag, snapshot };
}

module.exports = { createProgress };
