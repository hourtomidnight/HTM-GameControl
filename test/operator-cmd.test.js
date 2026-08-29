const { test } = require('node:test');
const assert = require('node:assert');
const { commandFor } = require('../public/operator.js');

test('maps button ids to engine commands', () => {
  assert.deepStrictEqual(commandFor('btn-start'), { type: 'start' });
  assert.deepStrictEqual(commandFor('btn-escaped'), { type: 'escaped' });
  assert.deepStrictEqual(commandFor('add-min'), { type: 'add-min' });
  assert.strictEqual(commandFor('nonsense'), null);
});
