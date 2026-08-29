const { EventEmitter } = require('node:events');

function coerce(type, v) {
  if (type === 'bool') return !!v;
  if (type === 'int') return Math.trunc(Number(v));
  if (type === 'float') return Number(v);
  return v; // string / unknown: pass-through
}

function pinKey(sig) {
  const a = sig.address || {};
  if (sig.driver === 'modbus') {
    return `${a.plc}:${a.fn}:${a.register}:${a.bit ?? ''}`;
  }
  return String(a.pin);
}

function createSignalBus({ eventStore, drivers, signals }) {
  const emitter = new EventEmitter();
  const byName = new Map();     // name -> sig def
  const values = new Map();     // name -> { value, ts, quality }
  const pinIndex = new Map();   // driverName -> Map(pinKey -> name)

  for (const sig of signals) {
    byName.set(sig.name, sig);
    const pk = pinKey(sig);
    if (!pinIndex.has(sig.driver)) pinIndex.set(sig.driver, new Map());
    pinIndex.get(sig.driver).set(pk, sig.name);
    values.set(sig.name, { value: null, ts: 0, quality: 'stale' });
  }

  function normalize(sig, raw) {
    let v = raw;
    if (sig.type === 'bool' && sig.invert) v = !v;
    return coerce(sig.type, v);
  }

  function ingest(driverName, pin, raw, ts) {
    const name = pinIndex.get(driverName)?.get(String(pin));
    if (!name) return;
    const sig = byName.get(name);
    const value = normalize(sig, raw);
    const cur = values.get(name);
    if (cur && cur.value === value && cur.quality === 'ok') return;
    const prev = cur ? cur.value : undefined;
    const stamp = ts || Date.now();
    values.set(name, { value, ts: stamp, quality: 'ok' });
    try {
      eventStore.record({ source: 'signal', type: 'signal-change', subject: name, value, detail: { prev } });
    } catch { /* best effort */ }
    emitter.emit('change', { name, value, prev, quality: 'ok', ts: stamp });
  }

  function start() {
    for (const [dName, drv] of Object.entries(drivers)) {
      const defs = signals
        .filter(s => s.driver === dName)
        .map(s => ({ pin: pinKey(s), sig: s }));
      try {
        drv.init(defs);
      } catch (e) {
        try {
          eventStore.record({ source: 'driver', type: 'driver-error', subject: dName, detail: { message: e.message } });
        } catch { /* best effort */ }
        continue;
      }
      try {
        for (const { pin, raw } of drv.readAll() || []) ingest(dName, pin, raw, Date.now());
      } catch { /* best effort */ }
      try {
        drv.startPolling((chg) => ingest(dName, chg.pin, chg.raw, chg.ts));
      } catch { /* best effort */ }
    }
  }

  function get(name) { return values.get(name); }

  function snapshot() {
    const o = {};
    for (const [n, v] of values) o[n] = { value: v.value, quality: v.quality };
    return o;
  }

  function set(name, value) {
    const sig = byName.get(name);
    if (!sig) throw new Error('unknown signal: ' + name);
    if (sig.direction === 'in') throw new Error('signal not writable: ' + name);
    const drv = drivers[sig.driver];
    const v = coerce(sig.type, value);
    try {
      drv.write(pinKey(sig), v);
      values.set(name, { value: v, ts: Date.now(), quality: 'ok' });
      eventStore.record({ source: 'signal', type: 'signal-set', subject: name, value: v });
    } catch (e) {
      const cur = values.get(name) || {};
      values.set(name, { value: cur.value ?? null, ts: Date.now(), quality: 'error' });
      try {
        eventStore.record({ source: 'signal', type: 'signal-set', subject: name, value: v, detail: { error: e.message } });
      } catch { /* best effort */ }
    }
  }

  function stop() {
    for (const d of Object.values(drivers)) {
      try { d.stop(); } catch { /* best effort */ }
    }
  }

  return {
    start, get, set, snapshot, stop,
    on: (ev, fn) => emitter.on(ev, fn),
    off: (ev, fn) => emitter.off(ev, fn),
  };
}

module.exports = { createSignalBus, pinKey };
