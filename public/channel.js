// Network channel — same API as BroadcastChannel but uses SSE + HTTP POST
// so it works across different browsers and devices on the same network.
(function () {
  class NetworkChannel {
    constructor() {
      this._listeners = [];
      this._connect();
    }

    _connect() {
      this._es = new EventSource('/events');
      this._es.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          this._listeners.forEach(fn => { try { fn({ data }); } catch(err) {} });
        } catch(err) {}
      };
      this._es.onerror = () => {
        // EventSource auto-reconnects; no action needed
      };
    }

    postMessage(msg) {
      fetch('/cmd', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(msg),
      }).catch(() => {});
    }

    addEventListener(type, fn) {
      if (type === 'message') this._listeners.push(fn);
    }

    removeEventListener(type, fn) {
      if (type === 'message') this._listeners = this._listeners.filter(f => f !== fn);
    }
  }

  window.channel = new NetworkChannel();
})();
