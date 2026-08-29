# htm-room-control

Per-room control Pi for HTM escape rooms. One Node process: server-side game engine,
operator console, signal I/O (GPIO + Modbus TCP), rules engine, and an append-only
SQLite event store. Google Sheets mirrors game/session data only. Own repo — edges-only
intranet integration.

## Runtime
- Node 22 (built-in `node:sqlite`, `node:net`). `package.json` `engines` is `>=22`;
  the dev/CI machine is Node v24. Server code: built-ins only; the sole npm runtime
  dep is `googleapis`, isolated in `src/sheets.js`.
- `npm start` → http://localhost:4000/operator.html. `npm test` → `node --test`.
- On the Pi: systemd `htm-room-control` + `htm-room-control-kiosk`; nginx `/room-control/`.
  See `deploy/`, `scripts/setup-pi.sh`, `docs/runbook-m1.md`.

## Architecture
`server.js` wires: event-store → config → signal-bus(+drivers) → game-engine → web.
The web factory (`src/web.js`) does NOT listen; `server.js` calls
`server.listen(4000, '0.0.0.0', …)`. Startup refuses (exit 1) on an invalid `config.json`.
State authority is server-side (`src/game-engine.js`); `public/game.html` is display-only.
Every external call (Sheets, Modbus) is wrapped and degrades without stopping the clock.

## Status
M1 complete: clock/operator/hints migrated, event spine, Sheets mirror, read-only
Modbus poll. M2 (GPIO + expanders + rules), M3 (Modbus write + validation + reset),
M4 (timeline UI) are planned in `docs/superpowers/plans/`. Spec in `docs/superpowers/specs/`.

## Files not committed
`config.json`, `room-control.db*`, `google-credentials.json` are gitignored runtime files.

## Tests
`npm test` (node:test, in-memory SQLite, fake drivers). 79/79 passing at M1.
