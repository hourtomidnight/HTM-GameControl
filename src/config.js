const fs = require('node:fs');
const { validateConfig } = require('./config-schema');

function createConfig({ path, db, now = () => Date.now() }) {
  let cache = {};

  function load() {
    try { cache = JSON.parse(fs.readFileSync(path, 'utf8')); }
    catch { cache = {}; }
    return cache;
  }

  function save(obj) {
    const { ok, errors } = validateConfig(obj);
    if (!ok) return { ok, errors };
    fs.writeFileSync(path, JSON.stringify(obj, null, 2));
    try { db.prepare('INSERT INTO config_history (ts, json) VALUES (?, ?)')
            .run(now(), JSON.stringify(obj)); } catch {}
    cache = obj;
    return { ok: true, errors: [] };
  }

  return { load, save, current: () => cache };
}

module.exports = { createConfig, validateConfig };
