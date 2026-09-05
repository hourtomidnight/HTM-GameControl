const { test } = require('node:test');
const assert = require('node:assert');
const { commandFor } = require('../public/operator.js');
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
