const { test } = require('node:test');
const assert = require('node:assert');
const { renderModel } = require('../public/game.js');

test('running state formats mm:ss and running class', () => {
  const m = renderModel({ phase: 'running', currentMin: 5, currentSec: 3,
    clockForward: false, timerRunning: true, gameLocked: false, activeHints: [] });
  assert.strictEqual(m.bigText, '05:03');
  assert.strictEqual(m.cssClass, 'running');
  assert.strictEqual(m.statusText, 'RUNNING');
});

test('locked state shows LOCKED and escaped class', () => {
  const m = renderModel({ phase: 'escaped', currentMin: 0, currentSec: 0,
    clockForward: true, timerRunning: false, gameLocked: true, activeHints: [] });
  assert.strictEqual(m.cssClass, 'escaped');
  assert.match(m.statusText, /LOCKED/);
});

test('clue text is the first active hint', () => {
  const m = renderModel({ phase: 'running', currentMin: 1, currentSec: 0,
    clockForward: false, timerRunning: true, gameLocked: false, activeHints: ['look up', 'x'] });
  assert.strictEqual(m.clue, 'look up');
});
