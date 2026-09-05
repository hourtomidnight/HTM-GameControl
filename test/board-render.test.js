const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderBoard, isSectionComplete, commandForBoardAction } = require('../public/board.js');

function cfg() {
  return {
    sections: [{ id: 'sec_desk', name: 'Desk', order: 1, note: '' }],
    steps: [
      { id: 'step_1', name: 'Briefcase', order: 1, sectionId: 'sec_desk', hints: [
        { id: 'h1', type: 'text', text: 'Look under the desk', key: 'F1', countsAsClue: true },
        { id: 'h2', type: 'audio', mediaRef: 'a.mp3', label: 'Clue 2', color: '#4a8aff', icon: '🎧', key: 'F2' },
      ]},
      { id: 'step_2', name: 'Pendant', order: 1, sectionId: null, hints: [] },
    ],
    progress: { flags: ['Translation given'] },
  };
}

test('isSectionComplete is true only when every step in that section is solved', () => {
  const steps = cfg().steps;
  assert.equal(isSectionComplete('sec_desk', steps, {}), false);
  assert.equal(isSectionComplete('sec_desk', steps, { step_1: { solvedAt: 123 } }), true);
});

test('isSectionComplete is false for a section with no matching steps', () => {
  assert.equal(isSectionComplete('sec_empty', [], {}), false);
});

test('renderBoard shows section name, step name, hint text, and key badge', () => {
  const html = renderBoard(cfg(), { steps: {}, flags: {} });
  assert.match(html, /Desk/);
  assert.match(html, /Briefcase/);
  assert.match(html, /Look under the desk/);
  assert.match(html, /F1/);
});

test('renderBoard shows an audio hint pad with its label and the 🎧 icon', () => {
  const html = renderBoard(cfg(), { steps: {}, flags: {} });
  assert.match(html, /Clue 2/);
  assert.match(html, /🎧/);
});

test('a step with no sectionId renders under an Ungrouped bucket', () => {
  const html = renderBoard(cfg(), { steps: {}, flags: {} });
  assert.match(html, /Ungrouped/);
  assert.match(html, /Pendant/);
});

test('a solved step collapses to a one-liner by default (auto-collapse)', () => {
  const html = renderBoard(cfg(), { steps: { step_1: { clueGivenAt: null, solvedAt: 999 } }, flags: {} });
  // The full hint text should not be visible in a collapsed solved step's default render.
  assert.doesNotMatch(html, /Look under the desk/);
});

test('an explicit uiState override re-expands a solved step', () => {
  const html = renderBoard(
    cfg(),
    { steps: { step_1: { clueGivenAt: null, solvedAt: 999 } }, flags: {} },
    { collapsedSteps: { step_1: false } }
  );
  assert.match(html, /Look under the desk/);
});

test('a section auto-collapses when every one of its steps is solved', () => {
  const html = renderBoard(
    { sections: cfg().sections, steps: [cfg().steps[0]], progress: { flags: [] } },
    { steps: { step_1: { solvedAt: 999 } }, flags: {} }
  );
  // Section body content (the step name) should not render when auto-collapsed.
  assert.doesNotMatch(html, /Briefcase/);
});

test('renderBoard renders a flags row from config.progress.flags', () => {
  const html = renderBoard(cfg(), { steps: {}, flags: {} });
  assert.match(html, /Translation given/);
});

test('a keyless hint pad still renders (fully clickable, no badge text)', () => {
  const noKeyCfg = cfg();
  delete noKeyCfg.steps[0].hints[0].key;
  const html = renderBoard(noKeyCfg, { steps: {}, flags: {} });
  assert.match(html, /Look under the desk/);
});

test('commandForBoardAction maps toggle-solved to a solve-step command', () => {
  const c = commandForBoardAction('toggle-solved', { stepId: 'step_1', on: 'true' });
  assert.deepEqual(c, { type: 'solve-step', stepId: 'step_1', on: true });
});

test('commandForBoardAction maps set-flag to a set-flag command', () => {
  const c = commandForBoardAction('set-flag', { name: 'Translation given', on: 'false' });
  assert.deepEqual(c, { type: 'set-flag', name: 'Translation given', on: false });
});

test('commandForBoardAction maps play-hint and stop-audio', () => {
  assert.deepEqual(
    commandForBoardAction('play-hint', { stepId: 'step_1', hintId: 'h2' }),
    { type: 'play-hint', stepId: 'step_1', hintId: 'h2' }
  );
  assert.deepEqual(commandForBoardAction('stop-audio', {}), { type: 'stop-audio' });
});

test('commandForBoardAction returns null for an unrecognized action', () => {
  assert.equal(commandForBoardAction('bogus', {}), null);
});
