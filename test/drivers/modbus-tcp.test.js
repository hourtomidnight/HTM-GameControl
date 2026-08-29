'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { createModbusDriver } = require('../../src/drivers/modbus-tcp');

// Clean fake socket + fake net factory.
// responder(reqBuf) -> Buffer response frame (or null for no reply).
function fakeNet(responder) {
  return {
    connect(port, host, cb) {
      const listeners = {};
      const sock = {
        on(ev, fn) { (listeners[ev] ||= []).push(fn); return sock; },
        write(buf) {
          const resp = responder(buf);
          if (resp) process.nextTick(() => (listeners.data || []).forEach((f) => f(resp)));
          return true;
        },
        destroy() { (listeners.close || []).forEach((f) => f()); return sock; },
        setNoDelay() { return sock; },
      };
      process.nextTick(cb);
      return sock;
    },
  };
}

// Build a codec-correct read-holding-registers response for a single u16 value.
function holdingResponse(reqBuf, value) {
  const txId = reqBuf.readUInt16BE(0);
  const body = Buffer.alloc(2);
  body.writeUInt16BE(value, 0);
  const pdu = Buffer.concat([Buffer.from([0x03, 0x02]), body]); // fn=3, byteCount=2
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
    setInterval: (fn) => { const t = { fn, kind: 'i' }; intervals.add(t); return t; },
    clearInterval: (t) => intervals.delete(t),
    setTimeout: (fn) => { const t = { fn, kind: 't' }; timeouts.add(t); return t; },
    clearTimeout: (t) => timeouts.delete(t),
  };
}

const settle = () => new Promise((r) => setImmediate(r));

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
  d.init([{ pin: 'plc1:holding:0:', sig: { address: { plc: 'plc1', unit: 1, fn: 'holding', register: 0 } } }]);
  d.startPolling((e) => emitted.push(e));

  await settle(); // let connect callback run
  for (const t of scheduler.intervals) t.fn();
  await settle();
  for (const t of scheduler.intervals) t.fn(); // same value -> no second emit
  await settle();
  regVal = 99;
  for (const t of scheduler.intervals) t.fn();
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
    netFactory: fakeNet(() => null),
    scheduler: fakeScheduler(),
  });
  assert.throws(() => d.write('x', 1), /not supported/);
});

test('readAll is empty until first successful poll, then reflects last raw', async () => {
  let regVal = 7;
  const net = fakeNet((reqBuf) => holdingResponse(reqBuf, regVal));
  const scheduler = fakeScheduler();
  const d = createModbusDriver({
    plcs: [{ id: 'plc1', host: 'h', port: 502, pollMs: 10 }],
    netFactory: net,
    scheduler,
  });
  d.init([{ pin: 'plc1:holding:0:', sig: { address: { plc: 'plc1', unit: 1, fn: 'holding', register: 0 } } }]);
  d.startPolling(() => {});
  assert.deepStrictEqual(d.readAll(), []);
  await settle();
  for (const t of scheduler.intervals) t.fn();
  await settle();
  assert.deepStrictEqual(d.readAll(), [{ pin: 'plc1:holding:0:', raw: 7 }]);
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
  d.init([{ pin: 'plc1:holding:0:', sig: { address: { plc: 'plc1', unit: 1, fn: 'holding', register: 0 } } }]);
  d.startPolling(() => {});
  await settle();
  assert.strictEqual(events.filter((e) => e.type === 'driver-up').length, 1);

  // drop the connection
  for (const c of d._conns().values()) c.sock.destroy();
  await settle();
  assert.strictEqual(events.filter((e) => e.type === 'driver-error').length, 1);
  assert.strictEqual(scheduler.timeouts.size, 1);

  // polls skipped while disconnected
  for (const t of scheduler.intervals) t.fn();
  await settle();

  // fire the reconnect timer
  for (const t of scheduler.timeouts) t.fn();
  await settle();
  assert.strictEqual(events.filter((e) => e.type === 'driver-up').length, 2);
  d.stop();
});
