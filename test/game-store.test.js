const { test } = require('node:test');
const assert = require('node:assert');
const { createEventStore } = require('../src/event-store');
const { createGameStore } = require('../src/game-store');

function freshDb() { return createEventStore({ path: ':memory:' }).db; }

test('create returns id and get round-trips', () => {
  const gs = createGameStore(freshDb());
  const { id } = gs.create({ started_ts: 111, room: 'Bank', operator: 'Sam',
    team_name: 'T', new_players: 2, exp_players: 1, notes: '' });
  const row = gs.get(id);
  assert.strictEqual(row.room, 'Bank');
  assert.strictEqual(row.started_ts, 111);
  assert.strictEqual(row.hint_count, 0);
});

test('update applies known keys and ignores unknown', () => {
  const gs = createGameStore(freshDb());
  const { id } = gs.create({ started_ts: 1 });
  gs.update(id, { status: 'Escaped', ended_ts: 999, hint_count: 3, bogus: 'x' });
  const row = gs.get(id);
  assert.strictEqual(row.status, 'Escaped');
  assert.strictEqual(row.ended_ts, 999);
  assert.strictEqual(row.hint_count, 3);
});

test('recent orders by started_ts desc', () => {
  const gs = createGameStore(freshDb());
  gs.create({ started_ts: 10 });
  gs.create({ started_ts: 30 });
  gs.create({ started_ts: 20 });
  assert.deepStrictEqual(gs.recent().map(r => r.started_ts), [30, 20, 10]);
});
