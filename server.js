const path = require('node:path');
const { createEventStore } = require('./src/event-store');
const { createGameStore } = require('./src/game-store');
const { createConfig, validateConfig } = require('./src/config');
const { createSignalBus } = require('./src/signal-bus');
const { createInternalDriver } = require('./src/drivers/internal');
const { createModbusDriver } = require('./src/drivers/modbus-tcp');
const { createGameEngine } = require('./src/game-engine');
const { createSheets } = require('./src/sheets');
const { createMediaLibrary } = require('./src/media-library');
const { createWebServer } = require('./src/web');

const PORT = 4000;
const DIR = __dirname;
const DB_PATH = path.join(DIR, 'room-control.db');
const CONFIG_PATH = path.join(DIR, 'config.json');
const CREDS_PATH = path.join(DIR, 'google-credentials.json');

const eventStore = createEventStore({ path: DB_PATH });
const gameStore = createGameStore(eventStore.db);

const config = createConfig({ path: CONFIG_PATH, db: eventStore.db });
const cfg = config.load();
const check = validateConfig(cfg);
if (!check.ok) {
  console.error('Invalid config.json — refusing to start:');
  for (const e of check.errors) console.error('  - ' + e);
  process.exit(1);
}

const INTERNAL_SIGNALS = [
  { name: 'phase', direction: 'in-out', type: 'string', driver: 'internal', address: { pin: 'phase' } },
  { name: 'timer_running', direction: 'in-out', type: 'bool', driver: 'internal', address: { pin: 'timer_running' } },
  { name: 'game_locked', direction: 'in-out', type: 'bool', driver: 'internal', address: { pin: 'game_locked' } },
];
const signals = [...INTERNAL_SIGNALS, ...(cfg.signals || [])];

const drivers = {
  internal: createInternalDriver(),
  modbus: createModbusDriver({
    plcs: cfg.plcs || [],
    onEvent: (e) => {
      try {
        eventStore.record({
          source: 'driver',
          type: e.type,
          subject: e.plc,
          detail: { message: e.message },
        });
      } catch {}
    },
  }),
};

const signalBus = createSignalBus({ eventStore, drivers, signals });
signalBus.start();

const MEDIA_ROOT = path.join(DIR, 'media');
const mediaLibrary = createMediaLibrary({ db: eventStore.db, root: MEDIA_ROOT, steps: () => config.current().steps || [] });

const sheets = createSheets({ credentialsPath: CREDS_PATH, config, eventStore, gameStore });

const engine = createGameEngine({ eventStore, gameStore, sheets, signalBus, roomName: cfg.roomName || '' });
engine.setStartMinutes((cfg.game && cfg.game.timerMinutes) || 60);

const { server } = createWebServer({
  engine,
  config,
  sheets,
  signalBus,
  eventStore,
  gameStore,
  mediaLibrary,
  mediaRoot: MEDIA_ROOT,
  publicDir: path.join(DIR, 'public'),
  port: PORT,
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('htm-room-control on http://0.0.0.0:' + PORT + '/operator.html');
});
