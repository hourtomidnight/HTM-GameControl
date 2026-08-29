const { test } = require('node:test');
const assert = require('node:assert');
const { createEventStore } = require('../src/event-store');

test('record then query round-trips with parsed value', () => {
  const store = createEventStore({ path: ':memory:' });
  store.record({ ts: 1000, source: 'operator', type: 'start', value: { room: 'A' } });
  store.record({ ts: 2000, source: 'signal', type: 'signal-change', subject: 'x', value: true });
  const rows = store.query({});
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].ts, 1000);
  assert.deepStrictEqual(rows[0].value, { room: 'A' });
  assert.strictEqual(rows[1].value, true);
  store.close();
});

test('query filters by type and game_id and limit', () => {
  const store = createEventStore({ path: ':memory:' });
  for (let i = 0; i < 5; i++) store.record({ ts: i, source: 's', type: 'a', game_id: 7 });
  store.record({ ts: 99, source: 's', type: 'b', game_id: 7 });
  store.record({ ts: 100, source: 's', type: 'a', game_id: 8 });
  assert.strictEqual(store.query({ type: 'a', game_id: 7 }).length, 5);
  assert.strictEqual(store.query({ type: 'a', game_id: 7, limit: 2 }).length, 2);
  assert.strictEqual(store.query({ game_id: 8 }).length, 1);
  store.close();
});

test('ts defaults to now when omitted', () => {
  const store = createEventStore({ path: ':memory:' });
  const before = Date.now();
  store.record({ source: 's', type: 'a' });
  const row = store.query({})[0];
  assert.ok(row.ts >= before && row.ts <= Date.now() + 5);
  store.close();
});
