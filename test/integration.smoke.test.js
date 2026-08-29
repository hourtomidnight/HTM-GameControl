const { test } = require('node:test');
const assert = require('node:assert');
const { createEventStore } = require('../src/event-store');
const { createGameStore } = require('../src/game-store');
const { createSignalBus } = require('../src/signal-bus');
const { createInternalDriver } = require('../src/drivers/internal');
const { createGameEngine } = require('../src/game-engine');

test('a full game writes engine events + a finalized game row', () => {
  const es = createEventStore({ path: ':memory:' });
  const gs = createGameStore(es.db);
  const signals = [
    { name: 'phase', direction: 'in-out', type: 'string', driver: 'internal', address: { pin: 'phase' } },
    { name: 'timer_running', direction: 'in-out', type: 'bool', driver: 'internal', address: { pin: 'timer_running' } },
    { name: 'game_locked', direction: 'in-out', type: 'bool', driver: 'internal', address: { pin: 'game_locked' } },
  ];
  const bus = createSignalBus({ eventStore: es, drivers: { internal: createInternalDriver() }, signals });
  bus.start();
  let t = 0;
  const engine = createGameEngine({ eventStore: es, gameStore: gs, signalBus: bus,
    now: () => (t += 1000), setInterval: () => 0, clearInterval: () => {} });

  engine.command({ type: 'update-field', field: 'operator', value: 'Sam' });
  engine.command({ type: 'start' });
  const gameId = engine.getState().gameId;
  engine.command({ type: 'add-min' });
  engine.command({ type: 'show-hint', text: 'try the safe' });
  engine.command({ type: 'escaped' });

  const row = gs.get(gameId);
  assert.strictEqual(row.operator, 'Sam');
  assert.strictEqual(row.status, 'Escaped');
  assert.strictEqual(row.hint_count, 1);
  assert.strictEqual(row.adjustments, 1);
  assert.ok(es.query({ type: 'start', game_id: gameId }).length === 1);
  assert.ok(es.query({ type: 'show-hint', game_id: gameId }).length === 1);
  assert.ok(es.query({ type: 'escaped', game_id: gameId }).length === 1);
  assert.strictEqual(bus.get('game_locked').value, true);
});
