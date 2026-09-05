const { test } = require('node:test');
const assert = require('node:assert');
const { commandFor, isGenericDispatchExcluded } = require('../public/operator.js');
const { commandForBoardAction } = require('../public/board.js');

test('maps button ids to engine commands', () => {
  assert.deepStrictEqual(commandFor('btn-start'), { type: 'start' });
  assert.deepStrictEqual(commandFor('btn-escaped'), { type: 'escaped' });
  assert.deepStrictEqual(commandFor('add-min'), { type: 'add-min' });
  assert.strictEqual(commandFor('nonsense'), null);
});

// Task 2 wires public/board.js's commandForBoardAction into operator.js's click
// handler; this integration-flavored check confirms wiring the board did NOT
// accidentally touch or replace operator.js's existing pure `commandFor` map
// (the old flat timer/volume/hide-clue buttons must keep working unchanged).
test('operator.js still exports the original commandFor map, untouched by the board wiring', () => {
  assert.strictEqual(typeof commandFor, 'function');
  assert.deepStrictEqual(commandFor('vol-up'), { type: 'vol-up' });
  assert.deepStrictEqual(commandFor('btn-hide-clue'), { type: 'hide-clue' });
});

// Regression: the flag checkbox rendered by board.js's renderFlags carries
// data-action="set-flag" on itself, so operator.js's generic [data-action]
// click-delegate would otherwise ALSO match it and dispatch a second,
// duplicate set-flag command alongside the dedicated 'change' listener that
// exists specifically to handle checkbox toggles. This proves the exclusion
// that prevents the double-dispatch, without requiring a DOM/browser.
test('the generic click-delegate excludes set-flag (handled solely by the change listener)', () => {
  assert.strictEqual(isGenericDispatchExcluded('set-flag'), true);
  // Sanity: other board actions must NOT be excluded, or they'd silently stop working.
  assert.strictEqual(isGenericDispatchExcluded('toggle-solved'), false);
  assert.strictEqual(isGenericDispatchExcluded('show-hint'), false);
  assert.strictEqual(isGenericDispatchExcluded('play-hint'), false);
  assert.strictEqual(isGenericDispatchExcluded('stop-audio'), false);
});

test('board actions produce the expected /cmd payloads', () => {
  assert.deepEqual(
    commandForBoardAction('toggle-solved', { stepId: 's1', on: 'true' }),
    { type: 'solve-step', stepId: 's1', on: true }
  );
  assert.deepEqual(
    commandForBoardAction('set-flag', { name: 'power', on: 'false' }),
    { type: 'set-flag', name: 'power', on: false }
  );
});
