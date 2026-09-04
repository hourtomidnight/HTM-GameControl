const fs = require('node:fs');
const { validateConfig } = require('./config-schema');
const { migrateHintGroupsToSteps } = require('./config-migrate');

function createConfig({ path, db, now = () => Date.now() }) {
  let cache = {};

  function load() {
    try { cache = JSON.parse(fs.readFileSync(path, 'utf8')); }
    catch { cache = {}; }

    const { cfg: migratedCfg, migrated } = migrateHintGroupsToSteps(cache);
    cache = migratedCfg;

    if (migrated) {
      try {
        if (validateConfig(cache).ok) {
          fs.writeFileSync(path, JSON.stringify(cache, null, 2));
          db.prepare('INSERT INTO config_history (ts, json) VALUES (?, ?)')
            .run(now(), JSON.stringify(cache));
        }
        // else: leave hintGroups on disk unchanged so a future correct
        // migration attempt can still run; the in-memory migrated cache is
        // still returned below, and the caller's own validateConfig() will
        // surface the error.
      } catch { /* best-effort — the in-memory migrated cache is still returned */ }
    }

    return cache;
  }

  function save(obj) {
    const { ok, errors } = validateConfig(obj);
    if (!ok) return { ok, errors };
    try {
      fs.writeFileSync(path, JSON.stringify(obj, null, 2));
    } catch (e) {
      return { ok: false, errors: ['could not write config: ' + e.message] };
    }
    try { db.prepare('INSERT INTO config_history (ts, json) VALUES (?, ?)')
            .run(now(), JSON.stringify(obj)); } catch {}
    cache = obj;
    return { ok: true, errors: [] };
  }

  return { load, save, current: () => cache };
}

module.exports = { createConfig, validateConfig };
