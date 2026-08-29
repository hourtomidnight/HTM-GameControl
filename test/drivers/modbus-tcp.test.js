'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { createModbusDriver } = require('../../src/drivers/modbus-tcp');

// Clean fake net factory. Exposes every socket it creates on `.sockets`.
// Each socket: records outgoing frames on `.writes`; `responder(reqBuf)` may
// return a response frame (or array) auto-delivered next tick; tests can also
// hand-deliver with `sock.dispatch(frame)`.
function fakeNet(responder = () => null) {
  const net = {
    sockets: [],
    connect(port, host, cb) {
      const listeners = {};
      const sock = {
        writes: [],
        on(ev, fn) { (listeners[ev] ||= []).push(fn); return sock; },
        dispatch(frame) { (listeners.data || []).forEach((f) => f(frame)); },
        write(buf) {
          sock.writes.push(buf);
          const resp = responder(buf);
          if (resp) {
            const frames = Array.isArray(resp) ? resp : [resp];
            process.nextTick(() => frames.forEach((fr) => sock.dispatch(fr)));
          }
          return true;
        },
        destroy() { (listeners.close || []).forEach((f) => f()); return sock; },
        setNoDelay() { return sock; },
      };
      net.sockets.push(sock);
      process.nextTick(cb);
      return sock;
    },
  };
  return net;
}

// Codec-correct read-holding-registers response for a list of u16 values.
function holdingResponse(reqBuf, values) {
  const txId = reqBuf.readUInt16BE(0);
  const vals = Array.isArray(values) ? values : [values];
  const body = Buffer.alloc(vals.length * 2);
  vals.forEach((v, i) => body.writeUInt16BE(v & 0xffff, i * 2));
  return withMbap(txId, Buffer.concat([Buffer.from([0x03, vals.length * 2]), body]));
}

// Codec-correct read-coils response for a single bit value.
function coilResponse(txId, bit) {
  return withMbap(txId, Buffer.from([0x01, 0x01, bit ? 0x01 : 0x00]));
}

function withMbap(txId, pdu) {
  const mbap = Buffer.alloc(7);
  mbap.writeUInt16BE(txId, 0);
  mbap.writeUInt16BE(0, 2);
  mbap.writeUInt16BE(pdu.length + 1, 4);
  mbap.writeUInt8(1, 6);
  return Buffer.concat([mbap, pdu]);
}

function fakeScheduler() {
  const intervals = new Set();
  const timeouts = new Set();
  return {
    intervals,
    timeouts,
    setInterval: (fn) => { const t = { fn }; intervals.add(t); return t; },
    clearInterval: (t) => intervals.delete(t),
    setTimeout: (fn) => { const t = { fn }; timeouts.add(t); return t; },
    clearTimeout: (t) => timeouts.delete(t),
  };
}

const settle = () => new Promise((r) => setImmediate(r));
const fireIntervals = (s) => { for (const t of s.intervals) t.fn(); };

function def(pin, plc, fn, register, extra = {}) {
  return { pin, sig: { address: { plc, unit: 1, fn, register, ...extra } } };
}

test('poll decodes a register and emits only on change', async () => {
  let regVal = 42;
  const net = fakeNet((reqBuf) => holdingResponse(reqBuf, regVal));
  const scheduler = fakeScheduler();
  const emitted = [];

  const d = createModbusDriver({
    plcs: [{ id: 'plc1', host: 'h', port: 502, pollMs: 10 }],
    netFactory: net,
    scheduler,
  });
  d.init([def('plc1:holding:0:', 'plc1', 'holding', 0)]);
  d.startPolling((e) => emitted.push(e));

  await settle();
  fireIntervals(scheduler);
  await settle();
  fireIntervals(scheduler); // same value -> no second emit
  await settle();
  regVal = 99;
  fireIntervals(scheduler);
  await settle();

  assert.deepStrictEqual(emitted.map((e) => e.raw), [42, 99]);
  assert.strictEqual(emitted[0].pin, 'plc1:holding:0:');
  assert.ok(typeof emitted[1].ts === 'number');
  d.stop();
  assert.strictEqual(scheduler.intervals.size, 0);
});

test('write throws in M1', () => {
  const d = createModbusDriver({
    plcs: [],
    netFactory: fakeNet(),
    scheduler: fakeScheduler(),
  });
  assert.throws(() => d.write('x', 1), /not supported/);
});

test('readAll is empty until first successful poll, then reflects last raw', async () => {
  const net = fakeNet((reqBuf) => holdingResponse(reqBuf, 7));
  const scheduler = fakeScheduler();
  const d = createModbusDriver({
    plcs: [{ id: 'plc1', host: 'h', port: 502, pollMs: 10 }],
    netFactory: net,
    scheduler,
  });
  d.init([def('plc1:holding:0:', 'plc1', 'holding', 0)]);
  d.startPolling(() => {});
  assert.deepStrictEqual(d.readAll(), []);
  await settle();
  fireIntervals(scheduler);
  await settle();
  assert.deepStrictEqual(d.readAll(), [{ pin: 'plc1:holding:0:', raw: 7 }]);
  d.stop();
});

test('responses correlated by txId even when delivered out of order', async () => {
  const net = fakeNet(); // manual delivery
  const scheduler = fakeScheduler();
  const emitted = [];
  const d = createModbusDriver({
    plcs: [{ id: 'plc1', host: 'h', port: 502, pollMs: 10 }],
    netFactory: net,
    scheduler,
  });
  d.init([
    def('plc1:holding:0:', 'plc1', 'holding', 0),
    def('plc1:coil:0:', 'plc1', 'coil', 0),
  ]);
  d.startPolling((e) => emitted.push(e));
  await settle();

  const sock = net.sockets[0];
  fireIntervals(scheduler);
  await settle();

  // Two request frames this tick: holding first, coil second (insertion order).
  const [holdingReq, coilReq] = sock.writes.slice(-2);
  const holdingTx = holdingReq.readUInt16BE(0);
  const coilTx = coilReq.readUInt16BE(0);
  assert.notStrictEqual(holdingTx, coilTx);

  // Deliver in reverse order.
  sock.dispatch(coilResponse(coilTx, true));
  sock.dispatch(holdingResponse(holdingReq, 123));
  await settle();

  const byPin = Object.fromEntries(emitted.map((e) => [e.pin, e.raw]));
  assert.strictEqual(byPin['plc1:coil:0:'], true);
  assert.strictEqual(byPin['plc1:holding:0:'], 123);
  d.stop();
});

test('unknown txId response is ignored (driver-error, no emit); later correct response still maps', async () => {
  const events = [];
  const scheduler = fakeScheduler();
  const emitted = [];
  const net = fakeNet();
  const d = createModbusDriver({
    plcs: [{ id: 'plc1', host: 'h', port: 502, pollMs: 10 }],
    netFactory: net,
    scheduler,
    onEvent: (e) => events.push(e),
  });
  d.init([def('plc1:holding:0:', 'plc1', 'holding', 0)]);
  d.startPolling((e) => emitted.push(e));
  await settle();

  const sock = net.sockets[0];
  fireIntervals(scheduler);
  await settle();
  const req = sock.writes[sock.writes.length - 1];
  const realTx = req.readUInt16BE(0);

  // Bogus txId (realTx ^ 0x5A5A, still 16-bit)
  sock.dispatch(holdingResponse(Buffer.from([((realTx ^ 0x5A5A) >> 8) & 0xff, (realTx ^ 0x5A5A) & 0xff]), 555));
  await settle();
  assert.strictEqual(emitted.length, 0);
  assert.strictEqual(
    events.filter((e) => /unmatched response txId/.test(e.message || '')).length,
    1,
  );

  // Correct response for the real request still maps.
  sock.dispatch(holdingResponse(req, 77));
  await settle();
  assert.deepStrictEqual(emitted.map((e) => e.raw), [77]);
  d.stop();
});

test('reconnect: driver-error once per disconnect, backoff schedules reconnect, driver-up on reconnect', async () => {
  const events = [];
  const net = fakeNet((reqBuf) => holdingResponse(reqBuf, 1));
  const scheduler = fakeScheduler();
  const d = createModbusDriver({
    plcs: [{ id: 'plc1', host: 'h', port: 502, pollMs: 10 }],
    netFactory: net,
    scheduler,
    onEvent: (e) => events.push(e),
  });
  d.init([def('plc1:holding:0:', 'plc1', 'holding', 0)]);
  d.startPolling(() => {});
  await settle();
  assert.strictEqual(events.filter((e) => e.type === 'driver-up').length, 1);

  net.sockets[net.sockets.length - 1].destroy();
  await settle();
  assert.strictEqual(events.filter((e) => e.type === 'driver-error').length, 1);
  assert.strictEqual(scheduler.timeouts.size, 1);

  fireIntervals(scheduler); // polls skipped while disconnected
  await settle();

  for (const t of scheduler.timeouts) t.fn();
  await settle();
  assert.strictEqual(events.filter((e) => e.type === 'driver-up').length, 2);
  d.stop();
});
