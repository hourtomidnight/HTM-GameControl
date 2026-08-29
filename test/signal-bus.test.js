const { test } = require('node:test');
const assert = require('node:assert');
const { createEventStore } = require('../src/event-store');
const { createSignalBus } = require('../src/signal-bus');

function fakeDriver() {
  let emit = null;
  const state = {};
  return {
    inited: null,
    init(defs) { this.inited = defs; },
    readAll() { return Object.entries(state).map(([pin, raw]) => ({ pin, raw })); },
    write(pin, value) { state[pin] = value; },
    startPolling(fn) { emit = fn; },
    stop() {},
    _push(pin, raw) { state[pin] = raw; emit && emit({ pin, raw, ts: 1 }); },
    _fail() { this.write = () => { throw new Error('bus fault'); }; },
  };
}

const SIGNALS = [
  { name: 'phase', direction: 'in-out', type: 'int', driver: 'internal', address: { pin: 'phase' } },
  { name: 'lamp',  direction: 'out',    type: 'bool', driver: 'internal', address: { pin: 'lamp' } },
  { name: 'btn',   direction: 'in',     type: 'bool', driver: 'internal', address: { pin: 'btn' }, invert: true },
];

test('start seeds values and set() writes through and records', () => {
  const es = createEventStore({ path: ':memory:' });
  const d = fakeDriver();
  const bus = createSignalBus({ eventStore: es, drivers: { internal: d }, signals: SIGNALS });
  bus.start();
  assert.deepStrictEqual(d.inited.map(x => x.pin).sort(), ['btn', 'lamp', 'phase']);
  bus.set('lamp', true);
  assert.strictEqual(bus.get('lamp').value, true);
  assert.strictEqual(es.query({ type: 'signal-set' }).length, 1);
});

test('set() on an input signal throws', () => {
  const es = createEventStore({ path: ':memory:' });
  const bus = createSignalBus({ eventStore: es, drivers: { internal: fakeDriver() }, signals: SIGNALS });
  bus.start();
  assert.throws(() => bus.set('btn', true), /not writable/);
});

test('polling change is normalized (invert) and emitted + recorded', () => {
  const es = createEventStore({ path: ':memory:' });
  const d = fakeDriver();
  const bus = createSignalBus({ eventStore: es, drivers: { internal: d }, signals: SIGNALS });
  bus.start();
  const seen = [];
  bus.on('change', e => seen.push(e));
  d._push('btn', false);          // inverted => logical true
  assert.strictEqual(bus.get('btn').value, true);
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].name, 'btn');
  assert.strictEqual(es.query({ type: 'signal-change' }).length, 1);
});

test('a failing driver write marks quality error and does not throw', () => {
  const es = createEventStore({ path: ':memory:' });
  const d = fakeDriver(); d._fail();
  const bus = createSignalBus({ eventStore: es, drivers: { internal: d }, signals: SIGNALS });
  bus.start();
  bus.set('lamp', true);           // must not throw
  assert.strictEqual(bus.get('lamp').quality, 'error');
});
