const { test } = require('node:test');
const assert = require('node:assert');
const { createInternalDriver } = require('../../src/drivers/internal');

test('write then readAll round-trips', () => {
  const d = createInternalDriver();
  d.init([]);
  d.write('lamp', true);
  assert.deepStrictEqual(d.readAll(), [{ pin: 'lamp', raw: true }]);
});

test('push forwards to the polling emit callback', () => {
  const d = createInternalDriver();
  const seen = [];
  d.startPolling(e => seen.push(e));
  d.push('x', 7);
  assert.deepStrictEqual(seen, [{ pin: 'x', raw: 7, ts: seen[0].ts }]);
});
