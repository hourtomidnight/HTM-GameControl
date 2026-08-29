'use strict';

// Read-only Modbus TCP driver: one socket per PLC, exponential-backoff reconnect,
// interval polling of contiguous register groups, change-only emit.

const nodeNet = require('node:net');
const { encodeReadRequest, decodeResponse } = require('../modbus-codec');

const BACKOFF_MIN = 500;
const BACKOFF_MAX = 5000;
const DEFAULT_POLL_MS = 100;

function createModbusDriver({ plcs = [], netFactory = nodeNet, scheduler = {}, onEvent = () => {} } = {}) {
  const S = {
    setInterval: scheduler.setInterval || setInterval,
    clearInterval: scheduler.clearInterval || clearInterval,
    setTimeout: scheduler.setTimeout || setTimeout,
    clearTimeout: scheduler.clearTimeout || clearTimeout,
  };

  const plcById = new Map(plcs.map((p) => [p.id, p]));
  const groups = new Map(); // plcId -> [{ fn, register, pin }]
  const last = new Map();    // pin -> raw
  const conns = new Map();   // plcId -> conn state
  let emitFn = null;

  function init(defs) {
    for (const { pin, sig } of defs || []) {
      const a = sig.address;
      if (!groups.has(a.plc)) groups.set(a.plc, []);
      groups.get(a.plc).push({ fn: a.fn, register: a.register, pin, unit: a.unit ?? 1 });
    }
  }

  function readAll() {
    const out = [];
    for (const [, defs] of groups) {
      for (const d of defs) {
        if (last.has(d.pin)) out.push({ pin: d.pin, raw: last.get(d.pin) });
      }
    }
    return out;
  }

  function connect(plcId) {
    const plc = plcById.get(plcId);
    if (!plc) return;
    let c = conns.get(plcId);
    if (!c) {
      c = { sock: null, connected: false, txId: 0, backoff: BACKOFF_MIN, pending: [], reconnectT: null, errored: false };
      conns.set(plcId, c);
    }
    c.pending = [];

    const sock = netFactory.connect(plc.port || 502, plc.host, () => {
      c.connected = true;
      c.backoff = BACKOFF_MIN;
      c.errored = false;
      onEvent({ type: 'driver-up', plc: plcId });
    });
    c.sock = sock;
    if (sock.setNoDelay) sock.setNoDelay();

    sock.on('data', (buf) => handleData(plcId, buf));
    sock.on('error', () => { /* 'close' drives reconnect */ });
    sock.on('close', () => {
      if (c.closedHandled) return;
      c.closedHandled = true;
      c.connected = false;
      c.pending = [];
      if (!c.errored) {
        c.errored = true;
        onEvent({ type: 'driver-error', plc: plcId, message: 'disconnected' });
      }
      const delay = c.backoff;
      c.backoff = Math.min(c.backoff * 2, BACKOFF_MAX);
      c.reconnectT = S.setTimeout(() => {
        c.reconnectT = null;
        c.closedHandled = false;
        connect(plcId);
      }, delay);
    });
    c.closedHandled = false;
  }

  function handleData(plcId, buf) {
    const c = conns.get(plcId);
    if (!c) return;
    let out;
    try {
      out = decodeResponse(buf);
    } catch (e) {
      onEvent({ type: 'driver-error', plc: plcId, message: e.message });
      return;
    }
    const idx = c.pending.findIndex((p) => p.txId === out.txId);
    if (idx === -1) {
      onEvent({ type: 'driver-error', plc: plcId, message: 'unmatched response txId ' + out.txId });
      return;
    }
    const [req] = c.pending.splice(idx, 1);
    out.data.forEach((val, i) => {
      const g = req.groupDefs[i];
      if (!g) return;
      const raw = (out.fn === 'coil' || out.fn === 'discrete') ? !!val : val;
      if (last.get(g.pin) !== raw) {
        last.set(g.pin, raw);
        if (emitFn) emitFn({ pin: g.pin, raw, ts: Date.now() });
      }
    });
  }

  function pollPlc(plcId) {
    const c = conns.get(plcId);
    if (!c || !c.connected || !c.sock) return;
    const defs = groups.get(plcId) || [];
    const byFn = new Map();
    for (const d of defs) {
      if (!byFn.has(d.fn)) byFn.set(d.fn, []);
      byFn.get(d.fn).push(d);
    }
    // Evict pending entries never answered on previous ticks so the queue
    // cannot grow unbounded after a lost frame.
    while (c.pending.length > byFn.size) c.pending.shift();
    for (const [fn, listRaw] of byFn) {
      const list = listRaw.slice().sort((a, b) => a.register - b.register);
      const start = list[0].register;
      const qty = list[list.length - 1].register - start + 1;
      const unit = list[0].unit ?? 1;
      c.txId = (c.txId + 1) & 0xffff;
      let frame;
      try {
        frame = encodeReadRequest({ txId: c.txId, unit, fn, address: start, quantity: qty });
      } catch (e) {
        onEvent({ type: 'driver-error', plc: plcId, message: e.message });
        continue;
      }
      const groupDefs = [];
      for (let r = start; r < start + qty; r++) {
        groupDefs.push(list.find((x) => x.register === r) || null);
      }
      c.pending.push({ txId: c.txId, groupDefs });
      try {
        c.sock.write(frame);
      } catch (e) {
        onEvent({ type: 'driver-error', plc: plcId, message: e.message });
      }
    }
  }

  function startPolling(emit) {
    emitFn = emit;
    for (const plcId of groups.keys()) {
      connect(plcId);
      const plc = plcById.get(plcId);
      const c = conns.get(plcId);
      if (!c) continue;
      c.timer = S.setInterval(() => pollPlc(plcId), (plc && plc.pollMs) || DEFAULT_POLL_MS);
    }
  }

  function write() {
    throw new Error('modbus write not supported in M1');
  }

  function stop() {
    for (const c of conns.values()) {
      if (c.timer) S.clearInterval(c.timer);
      if (c.reconnectT) S.clearTimeout(c.reconnectT);
      c.closedHandled = true; // suppress reconnect scheduling from destroy()
      try {
        if (c.sock) c.sock.destroy();
      } catch { /* ignore */ }
    }
    conns.clear();
  }

  return { init, readAll, write, startPolling, stop };
}

module.exports = { createModbusDriver };
