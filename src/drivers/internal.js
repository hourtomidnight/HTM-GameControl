function createInternalDriver() {
  const state = new Map();
  let emit = null;

  return {
    init() {},
    readAll() {
      return [...state].map(([pin, raw]) => ({ pin, raw }));
    },
    write(pin, value) {
      state.set(pin, value);
    },
    startPolling(fn) {
      emit = fn;
    },
    stop() {
      emit = null;
    },
    push(pin, raw) {
      state.set(pin, raw);
      if (emit) emit({ pin, raw, ts: Date.now() });
    },
  };
}

module.exports = { createInternalDriver };
