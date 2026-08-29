# HTM Room Control — Design Spec

**Date:** 2026-08-28
**Status:** Approved for planning
**Target hardware:** Raspberry Pi at `192.168.0.125` (first room; template for subsequent rooms)
**Supersedes:** scattered discussion across prior chats. This is the single official design.

---

## 1. Purpose & vision

One Node process per room Pi that consolidates, into a single system with one event
timeline:

- the **game clock** (timer + session state machine),
- the **operator console**,
- the **physical control panel** (panel LEDs + pushbuttons / override buttons — replacing the
  existing dumb-logic / Arduino-based panel),
- **prop I/O** (open/close returns from props, whether wired directly or brought in over Modbus),
- **room-reset execution + validation**,
- a **rules engine** for combinational / latched room logic,
- and the **data-logging spine** that records everything for post-game analysis.

Google Sheets remains the system of record for **game/session data** (a human-facing mirror and
report). A **local SQLite database** on the Pi is authoritative for everything else — signal
history, rule firings, sequence steps, validation results, config audit.

Intranet integration is **edges-only**: a launcher link on the intranet, shared Google Sheets,
and a small HTTP API this Pi exposes. No shared code. This repo stays independent — it is **not**
merged into the `htm-escape-tracker` intranet monorepo.

### Relationship to `HTM-Control-Basic`

The existing `HTM-Control-Basic` app is migrated into this new project, not submoduled. Its
game-clock, operator console, hint system, and Sheets logging are the starting point for M1.
Once M1 reaches feature parity on the Pi, `HTM-Control-Basic` is archived.

**Load-bearing migration fact:** in `HTM-Control-Basic` the authoritative timer + game state
machine lives in the **browser** (`game.js`). This design moves it **server-side** into the Node
process; `game.html` becomes a display-only client. Everything else (rules, event logging,
validation, reset) depends on the engine running regardless of whether a browser is open.

---

## 2. Repository & runtime

- **New canonical repo:** `hourtomidnight/htm-room-control`. Its own repo; edges-only intranet
  integration.
- **Runtime:** Node.js 22 LTS on Raspberry Pi OS Bookworm (64-bit). Single Node process.
- **Supervision:** systemd unit `htm-room-control` (replaces pm2 — matches how the intranet Pi
  already runs services and needs no global npm). `nginx` fronts it at `/room-control/` on port
  4000, reusing the existing `nginx-htm.conf` include block.
- **Display:** headless server + a second systemd unit running
  `chromium --kiosk http://localhost:4000/game.html` on the attached room screen.
- **Removed:** Electron (`main.js`), `electron-builder`, and the Windows / macOS build targets.

### Dependency posture — "built-ins first, one native dep where it earns it"

| Need | Choice | Rationale |
|---|---|---|
| Local DB | `node:sqlite` (built-in, Node 22) | No native build, no npm |
| Modbus TCP | Own implementation, ~150 LOC over `node:net` | Simple protocol; full control; zero deps |
| HTTP / SSE | `node:http` | Already proven in `HTM-Control-Basic` |
| Google Sheets | `googleapis` (npm) | Unchanged from today; isolated in `sheets.js`; degrades gracefully |
| GPIO + I²C expanders | `node-libgpiod` **or** libgpiod CLI shell-out — decided at M2 with hardware in hand | One native dep at most, isolated behind the driver interface so it is swappable |

### Config & secret files (git-ignored, runtime only)

- `config.json` — full configuration (see §8)
- `google-credentials.json` — service-account key; absent → Sheets logging disabled, game still runs
- `room-control.db` — SQLite event store

---

## 3. Process architecture & module boundaries

Single Node process. Modules with narrow, injected dependencies.

```
                    ┌─────────────┐
   HTTP/SSE  ◄─────►│    web      │  static files, /events SSE, REST API
                    └──────┬──────┘
                           │ commands / state reads
                    ┌──────▼──────┐
                    │ game-engine │  authoritative timer + session state machine
                    └──────┬──────┘
                           │ emits transitions as events + internal signals
        ┌──────────────────┼───────────────────┐
        │                  │                   │
 ┌──────▼──────┐    ┌──────▼──────┐     ┌──────▼──────┐
 │ signal-bus  │◄──►│ rules-engine│     │  sheets     │  game/session/hint rows → Google
 └──┬───┬───┬──┘    └─────────────┘     └─────────────┘
    │   │   │  reads inputs / writes outputs via drivers
 ┌──▼┐ ┌▼──┐ ┌▼─────┐
 │gpio│ │mb │ │intern│   drivers: gpio(+expanders), modbus-tcp, internal
 └────┘ └───┘ └──────┘
        │
 ┌──────▼───────┐
 │ event-store  │  every event from every module → SQLite (append-only)
 └──────────────┘
```

### Module contracts

- **`event-store`** — `record(event)` where
  `event = {ts, source, type, subject, value, game_id, detail}`. Append-only. `query(filter)` for
  the timeline UI. Depends on nothing.
- **`signal-bus`** — holds current value of every named signal; `get(name)`, `set(name, value)`
  (routes to owning driver), `on('change', …)`. Loads signal/bank map from config, instantiates
  drivers, emits every change to `event-store` and `rules-engine`. Knows nothing about game rules.
- **`drivers/*`** — each implements `init`, `readAll`, `write`, `startPolling(emit)`, `stop`
  (see §4). `gpio` handles SoC pins and I²C expander banks. `modbus-tcp` polls PLC registers.
  `internal` is a virtual driver the game-engine pushes state into.
- **`game-engine`** — owns the timer loop + `session-tracker` state machine (migrated from
  `game.js`). Inputs: commands (`start`, `pause`, `escaped`, `reset`, `adjust`, `show-hint`,
  `dismiss-hint`, `hide-clue`, `vol`, `force-start`) from web or rules. Outputs: `state`
  snapshots to SSE, transitions to `event-store`, mirror signals into the `internal` driver. No
  DOM, no browser timers.
- **`rules-engine`** — pure `evaluate(rules, snapshot) → actions[]`. Loads rules from config
  (see §5).
- **`web`** — static serving + `/events` SSE + REST. Translates HTTP into game-engine commands /
  config writes / event-store queries. Never touches drivers directly.
- **`sheets`** — migrated near-as-is from `HTM-Control-Basic`. Called by game-engine on session
  start / finalize / hint and by the `sheetsWrite` rule action. Missing creds → warn + no-op.
- **`config-schema`** — hand-rolled validator (no npm), used on every `POST /config` and at
  startup (see §8).

### Startup order & failure semantics

Order: `event-store` → `signal-bus` (+drivers) → `game-engine` → `rules-engine` → `web`.

A driver that fails to init logs, records a `driver-error` event, and the process continues — a
dead Modbus link must never stop the clock (same principle as Sheets today). A **config-schema
failure at startup refuses to start** with a clear message: there is no safe default for a wrong
pin map.

### Testability

Every module is constructed with dependencies passed in (an `event-store` handle, a fake driver,
an in-memory SQLite). `node --test` drives game-engine and rules-engine with no hardware.

---

## 4. Signal layer & driver interface

### A signal (config `signals[]`)

```json
{
  "name": "start_button",
  "direction": "in",
  "type": "bool",
  "driver": "gpio",
  "address": { "bank": "soc", "pin": 17 },
  "invert": true,
  "debounceMs": 25,
  "pollMs": 100,
  "initial": false
}
```

- `direction`: `in | out | in-out`
- `type`: `bool | int | float`
- `invert` — normalize active-low so logical `true` = the meaningful state ("pressed", "open")
- `debounceMs` — inputs only
- `pollMs` — Modbus / expander read cadence; omit for interrupt-capable SoC pins
- `initial` — outputs: value driven on startup

**Modbus address form:**
`{ "plc": "plc1", "unit": 1, "fn": "holding", "register": 40001, "bit": null }`
(`plc` references a `config.plcs[]` id; `unit` is the Modbus slave/unit id on that connection;
`fn`: `coil | discrete | input | holding`; `bit` optional for packed status words)

**Expander bank address form:** `{ "bank": "mcp0", "pin": 5 }`, with banks declared once (config
`banks[]`):

```json
{ "id": "mcp0", "kind": "mcp23017", "i2c": "/dev/i2c-1", "addr": "0x20" }
```

Direct Pi header pins are the special case `bank: "soc"`. Expander banks are first-class from M2
(room 1 ≈ 20 points, room 2 ≈ 50 → the Pi header runs out).

### `signal-bus` responsibilities

- Parse `signals[]` + `banks[]`; construct one driver instance per driver kind; hand each driver
  its pin list.
- Keep `values: Map<name, {value, ts, quality}>` where `quality ∈ {ok, stale, error}` (a signal
  whose driver's last poll failed → `stale`, then `error`).
- `get(name) → {value, ts, quality}`.
- `set(name, value)` — validate direction is `out`/`in-out`, route to driver `write`,
  optimistically update, record a `signal-set` event.
- Subscribe to each driver's `change` emissions → normalize (`invert`, debounce, type-coerce) →
  on real change: update map, `record()` a `signal-change` event, emit `change` to rules-engine.
- Expose the full snapshot for rules evaluation and the web UI live panel.

### Driver interface (implemented by every driver, exactly)

```
init(pinDefs)      → validate addresses, open bus/socket, set outputs to `initial`
readAll()          → [{pin, raw}]           (poll + initial sync)
write(pin, value)  → drive an output; throw on failure
startPolling(emit) → begin cadence; call emit({pin, raw, ts}) on any change
stop()             → release resources
```

- **`gpio` driver** — one instance managing SoC pins *and* every declared expander bank. SoC
  pins use edge interrupts where the lib supports it, else poll at `pollMs`. Expander banks are
  read a whole register per `pollMs` tick and diffed. Isolates the `node-libgpiod`-vs-CLI choice.
- **`modbus-tcp` driver** — one persistent socket per PLC (`config.plcs[]`), auto-reconnect with
  backoff, configured registers grouped into batched reads per `pollMs`, diffed, emitted. Writes
  use function 5 / 6 / 16. Our ~150-LOC implementation over `node:net`.
- **`internal` driver** — no hardware. `write` stores the value; `game-engine` calls
  `signalBus.set('phase', …)` etc. so rules treat game state uniformly with physical inputs.

### Failure semantics

- `write` throwing → `signal-set` event with `error`, surfaced to operator UI, no crash.
- A poll cycle throwing → that driver's signals go `stale` → `error`, retry continues,
  rules-engine sees `quality` and can be authored to ignore non-`ok` signals.

---

## 5. Game engine, rules engine, validation & reset

### 5.1 Game engine (server-side)

`session-tracker.js` logic is preserved (`createSession`, `applyAdjustment`, `applyHint`,
`updateField`, `finalizeSession`, `gameLocked`) but now persists to the `games` table instead of
living only in memory. The timer loop, start/stop/escaped/reset transitions, hint cycling
*state*, intro-sequence *state*, and volume move from `game.js` into the engine. `game.html`
renders `state` snapshots and plays audio on engine `audio` events.

Commands (identical entry point for operator and rules): `start`, `pause`, `resume`, `escaped`,
`reset`, `adjust {add-min|sub-min|add-sec|sub-sec}`, `show-hint {text}`, `dismiss-hint {text}`,
`hide-clue`, `vol {up|down}`, `force-start`.

All existing guards apply to both callers: `gameLocked` blocks start until reset; no double-start;
the §5.3 start-gate.

### 5.2 Rules engine

Pure: `evaluate(rules, snapshot) → actions[]`. `snapshot` = every signal's `{value, quality}`
plus game state (`phase`, `timerRunning`, `gameLocked`, `elapsedMs`, `remainingMs`, `hintCount`).
Evaluated on every signal change, every game-engine transition, and a 1 Hz tick (time-based
conditions). Actions are executed by a thin dispatcher, never by the engine.

**Rule form (config `rules[]`):**

```json
{
  "id": "solve-1-lights-led",
  "when": { "all": [
    { "signal": "prop_1_open", "is": true },
    { "signal": "prop_2_open", "is": true },
    { "state": "phase", "is": "running" }
  ]},
  "do":   [ { "action": "setSignal", "target": "led_1", "value": true } ],
  "else": [ { "action": "setSignal", "target": "led_1", "value": false } ],
  "mode": "edge"
}
```

- **Conditions:** `all` / `any` / `not` nesting; leaf = `{signal|state, is|gt|lt|changed|held}`.
  `held: {to: true, forMs: 500}` for sustained states. `quality` defaults to requiring `ok`;
  `allowStale: true` opts out.
- **`mode`:** `edge` (fire `do` once on false→true, `else` once on true→false) or `level`
  (re-assert every eval — LED mirrors). Per-rule latch state lives in the engine, not config.
- **Actions:**
  - `setSignal {target, value}` → signal-bus
  - `logPoint {subject, value}` → event-store
  - `sheetsWrite {column, value|"@now"}` → current game's row
  - `gameCommand {command, args}` → game-engine (same entry point as operator)
  - `runSequence {id}` → sequence runner (§5.4)
  - `notify {text}` → operator-UI toast
  - Every executed action is itself recorded as an event carrying the triggering `rule.id`.

**Safety:**

- Evaluation is synchronous and side-effect-free; the dispatcher runs actions sequentially,
  catching per-action (one failure doesn't abort the rest).
- **Loop guard:** cascades (a rule action changing a signal that re-triggers evaluation) are
  capped at 20 iterations per originating change; a `rule-loop-truncated` event is recorded.
- Rules validated on config save (unknown signal/action/state name → reject the save, keep the
  running ruleset).
- Global `rulesEnabled` flag (operator-togglable) freezes all rule actions except LED `level`
  mirrors — for maintenance.

### 5.3 Expected-state profiles & validation

Config `profiles[]`:

```json
{
  "id": "ready-to-start",
  "checks": [
    { "signal": "prop_1_open", "is": false },
    { "signal": "prop_2_open", "is": false },
    { "signal": "maglock",     "is": true  },
    { "signal": "plc_link",    "is": "ok", "check": "quality" }
  ]
}
```

`validate(profileId) → { pass, failures: [{signal, expected, actual, quality}] }`. Pure, runs
against the live snapshot.

Uses:

- **Start gate:** game-engine runs `validate("ready-to-start")` before honoring any start
  (operator or rule). Fail → start refused, `validation-failed` event with the failure list,
  operator UI shows which props are wrong, `led_ready` goes off. Operator may **force-start**
  (`start-forced` event with failures attached).
- **Panel READY light:** a `level`-mode rule mirrors `validate("ready-to-start").pass →
  led_ready`.
- **Post-reset check:** the reset sequence ends with `validate("post-reset")`.
- **Ad-hoc:** operator "Check Room" button runs a chosen profile, shows + records the result.

### 5.4 Room-reset sequences

Config `sequences[]`:

```json
{
  "id": "full-reset",
  "steps": [
    { "op": "setSignal", "target": "reset_relay", "value": true },
    { "op": "wait", "ms": 800 },
    { "op": "setSignal", "target": "reset_relay", "value": false },
    { "op": "waitFor", "signal": "prop_1_open", "is": false, "timeoutMs": 5000 },
    { "op": "setSignal", "target": "maglock", "value": true },
    { "op": "validate", "profile": "post-reset" }
  ],
  "onTimeout": "abort"
}
```

- **Sequence runner:** one sequence at a time per Pi, cancellable. Each step → `sequence-step`
  event; end → `sequence-complete` / `sequence-failed` with the validation result.
- **Triggers:** operator button, rule `runSequence` action, or `POST /api/sequence/full-reset`
  from the intranet launcher.
- `waitFor` timeout + `onTimeout: "abort"` → stop, leave signals as-is, report the failing
  step / signal. No partial silent success.
- **Guard:** refuse to run a reset while `phase === "running"` unless `force: true` in the
  request (logged).

**Intranet integration:** the existing `roomreset` page stays as the centralized launcher — a
button per room calling that room Pi's `/api/sequence/full-reset` and showing the returned
result. No shared code.

---

## 6. Event store & Sheets split

### Local SQLite (`room-control.db`) — append-only spine

Written via `node:sqlite`, WAL mode, single writer (the Node process).

```sql
CREATE TABLE events (
  id        INTEGER PRIMARY KEY,
  ts        INTEGER NOT NULL,          -- epoch ms, server clock
  source    TEXT NOT NULL,             -- operator | signal | game-engine | rules | sequence | modbus | driver | sheets
  type      TEXT NOT NULL,             -- signal-change | start | escaped | rule-fired | sequence-step | validation-failed | ...
  subject   TEXT,                      -- signal name / rule id / profile id / sequence step
  value     TEXT,                      -- JSON-encoded scalar or small object
  game_id   INTEGER,                   -- FK games.id, null if no active game
  detail    TEXT                       -- JSON: failure lists, rule trigger, prev value, quality, ...
);
CREATE INDEX ix_events_ts   ON events(ts);
CREATE INDEX ix_events_game ON events(game_id);
CREATE INDEX ix_events_type ON events(type);

CREATE TABLE games (
  id            INTEGER PRIMARY KEY,
  started_ts    INTEGER NOT NULL,
  ended_ts      INTEGER,
  status        TEXT,                  -- Escaped | Reset-Lost | Aborted
  room          TEXT,
  operator      TEXT,
  team_name     TEXT,
  new_players   INTEGER,
  exp_players   INTEGER,
  notes         TEXT,
  adjustments   INTEGER DEFAULT 0,
  net_adjust_s  INTEGER DEFAULT 0,
  hint_count    INTEGER DEFAULT 0,
  sheets_row    INTEGER                -- row index in the Sessions tab, for in-place update
);

CREATE TABLE config_history (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, json TEXT NOT NULL
);
```

- `game-engine` owns `games`; `session-tracker` logic persists here instead of memory-only.
- **Retention:** events kept indefinitely by default. Config knob `eventRetentionDays` (nullable)
  drives a nightly prune. Nothing auto-deleted without an explicit setting.
- **Timeline UI** (M4) reads via `/api/events?game_id=…&from=…&type=…`.

### Local DB vs Google Sheets

| Data | Local SQLite | Google Sheets |
|---|---|---|
| Every signal edge, rule firing, sequence step, validation result, driver error | authoritative | — |
| Game/session summary row | `games` | Sessions tab (mirror, as today) |
| Individual hints (text + time) | events | Hints tab (as today) |
| Rule-driven cell writes (`sheetsWrite`) | event | target cell in current game's row |
| Hotkeys / operators dropdown | — | read/synced, as today |

**Rule:** Sheets is a mirror and a human-facing report, **never read back as program state**.
Every Sheets call stays wrapped so a failure degrades to "local only" and emits a `sheets-error`
event. `sheets.js` migrates almost as-is; the `game_id ↔ sheets_row` mapping moves from the
in-memory `sessionRowIndex` into the `games` table.

---

## 7. Web UI & API surface

Static pages, SSE-driven, no framework (matches today).

| Page | Audience | Change from `HTM-Control-Basic` |
|---|---|---|
| `game.html` | Kiosk display on the room screen | **Display-only.** Deletes its state machine, timer loop, key handling. Renders `state` snapshots from SSE. Keeps splash / logo / intro-media / hint-cycle rendering. Audio playback stays client-side, triggered by engine `audio` events. |
| `operator.html` | Operator console | Same controls; adds validation status + failures, force-start, "Check Room", reset-sequence button + live step progress, `rulesEnabled` toggle, live signal panel (name, value, quality). |
| `config.html` | Setup | Existing timer / volume / media / hint-group sections **plus** editors for signals, banks, PLCs, rules, profiles, sequences. Schema-validated on save. |
| `panel.html` *(optional, M2)* | Pre-wiring aid | Pure signal view mirroring the physical panel. |
| `timeline.html` *(M4)* | Post-game review | Queries `/api/events`. |
| `index.html` / `home-page-card.html` | Landing + intranet card | Point at new routes. |

### REST / SSE API

```
GET  /events                     SSE: state snapshots, signal changes, sequence progress, toasts
POST /cmd                        game-engine commands (start,pause,resume,escaped,reset,adjust,
                                 show-hint,dismiss-hint,hide-clue,vol,force-start)
GET  /config                     current config JSON
POST /config                     validate + persist + config_history row + hot-reload affected modules
GET  /api/signals                full snapshot [{name,value,quality,direction,ts}]
POST /api/signals/:name          manual output override (operator) — logged 'signal-set' source 'operator'
GET  /api/validate/:profileId    run a profile now → {pass,failures}
POST /api/sequence/:id           run a sequence ({force?:bool}) → final result   (intranet launcher)
POST /api/sequence/:id/cancel    cancel running sequence
GET  /api/events                 timeline query (game_id, from, to, type, source, limit)
GET  /api/games?limit=           recent games
GET  /api/operators              operators dropdown (Sheets passthrough, as today)
POST /api/rules/enabled          {enabled:bool}
GET  /healthz                    process + driver + sheets + db status (systemd / intranet monitor)
```

### Hot-reload on `POST /config`

- signal / bank / PLC changes → rebuild signal-bus (drivers restart, outputs re-init to
  `initial`)
- rule / profile / sequence changes → swap the in-memory set
- timer / media / hint changes → broadcast `config-updated`
- a rebuild failure rolls back to the previous config and returns the error

### Auth

None on the LAN (same as today). The nginx `/room-control/` prefix is the only exposure.
`/healthz` and `/api/sequence/*` are the intranet's integration points. **LAN-trust assumption —
revisit if the network boundary changes.**

---

## 8. Config model

Single `config.json`, hot-reloaded, every save snapshotted to `config_history`.

```jsonc
{
  "roomName": "Bank Heist",
  "game":   { "timerMinutes": 60, "volume": 0.4, "logoPath": "", "introMediaPath": "",
              "hintCycleSeconds": 5, "startStopKey": "", "eventRetentionDays": null },
  "hintGroups": [ { "name": "...", "hints": [ { "key": "F1", "text": "..." } ] } ],
  "sheets": { "sessionsSpreadsheetId": "", "sessionsTabName": "",
              "hintsSpreadsheetId": "", "hintsTabName": "", "hotkeysTabName": "",
              "operatorsSpreadsheetId": "" },
  "banks":   [ { "id": "mcp0", "kind": "mcp23017", "i2c": "/dev/i2c-1", "addr": "0x20" } ],
  "plcs":    [ { "id": "plc1", "host": "192.168.0.50", "port": 502, "pollMs": 100 } ],
  "signals": [ /* §4 shape */ ],
  "rules":   [ /* §5.2 shape */ ],
  "profiles":[ /* §5.3 shape */ ],
  "sequences":[ /* §5.4 shape */ ]
}
```

### `config-schema.js` (hand-rolled, no npm)

Checks types and cross-references:

- every `rule.when` `signal` / `state` exists
- every `action.target` is an `out` / `in-out` signal
- every `runSequence` / `validate` id exists
- no duplicate signal names
- expander `addr` unique per i2c bus
- every signal's `bank` exists in `banks[]`; every Modbus signal's implied PLC context is declared

Returns `{ok, errors[]}`. Used on every `POST /config` and once at startup. **Startup failure →
refuse to start** with a clear message.

### Migration

- One-time `migrate-config.js` reads an old `HTM-Control-Basic/config.json` and emits the new
  nested shape (`game.*`, `sheets.*`, `hintGroups` unchanged). Documented in the M1 runbook.
- Backwards field-compat: `game.*` fields also accepted at top level on read (logged as
  deprecated) so a half-migrated file still boots.

---

## 9. Milestones

| Milestone | Delivers | Done when |
|---|---|---|
| **M1** | New repo; server-side `game-engine` + `session-tracker` persistence; `event-store`; `web` with migrated display-only `game.html` + `operator.html`; `sheets` migrated; `internal` driver; `modbus-tcp` **read-only stub** wired to `signal-bus` + `event-store` (no rules); systemd + kiosk units; config migration. | On the Pi at `192.168.0.125`: a full game runs end-to-end (start → hints → adjust → escaped → reset); Sessions + Hints tabs update exactly as the old app; every operator action + engine transition is in `events`; a pointed-at PLC's register changes appear as `signal-change` events. `HTM-Control-Basic` can be archived. |
| **M2** | `signal-bus` full; `gpio` driver (SoC + expander banks); rules-engine (`edge`/`level`, `all/any/not`, `setSignal`/`logPoint`/`notify`); operator signal panel + `rulesEnabled`; `panel.html`. | 20 physical points on room 1 read/write correctly; a rule lights a panel LED from prop inputs; an override button drives an output; all logged. |
| **M3** | `modbus-tcp` writes; `held` / `sheetsWrite` / `gameCommand` / `runSequence` actions + loop guard; expected-state profiles + start gate + force-start; sequence runner + room reset; intranet launcher endpoint. | PLC-driven props ingested; `ready-to-start` gates start; `full-reset` runs from operator and from intranet, ends with `post-reset` validation, fully logged. |
| **M4** | `timeline.html` + `/api/events` query UI; `/healthz` intranet monitor tie-in; clone-to-room-2 packaging (config template, expanders scaled to 50). | Operator can review any past game's timeline; room 2 stood up from the runbook. |

---

## 10. Testing strategy (`node --test`, no hardware)

- **`session-tracker` + `game-engine`** — pure state-machine tests: every transition, guard
  (`gameLocked`, double-start, start-gate), adjustment math, hint counting. Migrated + expanded
  from today's tests.
- **`rules-engine`** — table-driven `(rules, snapshot) → expected actions`; edge vs level
  latching; cascade loop guard; quality gating.
- **`config-schema`** — valid case + every rejection case (dangling ref, dup name, bad pin,
  missing bank).
- **`modbus-tcp`** — frame encode/decode against known-good byte fixtures; reconnect/backoff
  with a fake socket.
- **`signal-bus`** — with a fake driver: invert / debounce / type-coerce normalization, quality
  transitions, change-event emission.
- **`sequence-runner`** — with a fake signal-bus: step ordering, `waitFor` timeout → abort,
  cancel, final validation.
- **`event-store`** — in-memory SQLite: write/query round-trips, `game_id` association.
- **`sheets`** — mocked `googleapis`: row-build parity with today, and the degrade-to-no-op path.
- **Integration smoke** — boot the process with all-fake drivers + in-memory DB, POST a game
  through `/cmd`, assert SSE snapshots + `events` rows.

---

## 11. Open items (resolve during planning / early milestones)

1. **GPIO library choice** (`node-libgpiod` vs libgpiod CLI shell-out) — decide at M2 with
   hardware in hand. Isolated behind the driver interface either way.
2. **Expander part number** — MCP23017 assumed; confirm against panel LED current draw and the
   button count for room 2.
3. **Modbus register map** for the first room's PLC — needed before M1's read-only stub can show
   meaningful `signal-change` events; a placeholder map is fine for M1.
4. **Kiosk browser** — confirm `chromium --kiosk` on Bookworm vs a lighter option (e.g. `cog` /
   `wpe`) for the room screen.
5. **Repo home** — confirm `hourtomidnight/htm-room-control` as the name and that this local tree
   (`…\HTM\GameControl`) becomes its working copy (currently not a git checkout).
