const fs = require('node:fs');

const GAME_KEYS = ['timerMinutes', 'volume', 'logoPath', 'introMediaPath', 'hintCycleSeconds', 'startStopKey'];
const SHEET_KEYS = ['sessionsSpreadsheetId', 'sessionsTabName', 'hintsSpreadsheetId',
  'hintsTabName', 'hotkeysTabName', 'operatorsSpreadsheetId'];
const DROP = ['gameScreenIndex'];

function migrate(old = {}) {
  const out = { roomName: old.roomName || '', game: {}, sheets: {},
    hintGroups: old.hintGroups || [], plcs: [], signals: [], rules: [], profiles: [], sequences: [] };
  for (const k of GAME_KEYS) if (old[k] !== undefined) out.game[k] = old[k];
  if (old.eventRetentionDays !== undefined) out.game.eventRetentionDays = old.eventRetentionDays;
  else out.game.eventRetentionDays = null;
  for (const k of SHEET_KEYS) if (old[k] !== undefined) out.sheets[k] = old[k];
  return out;
}

if (require.main === module) {
  const [src, dest = './config.json'] = process.argv.slice(2);
  if (!src) { console.error('usage: node scripts/migrate-config.js <old.json> [new.json]'); process.exit(1); }
  const old = JSON.parse(fs.readFileSync(src, 'utf8'));
  const out = migrate(old);
  fs.writeFileSync(dest, JSON.stringify(out, null, 2));
  const dropped = DROP.filter(k => k in old);
  console.log(`Wrote ${dest}. game keys: ${Object.keys(out.game).join(', ')}. ` +
    `sheets keys: ${Object.keys(out.sheets).join(', ')}.` +
    (dropped.length ? ` Dropped: ${dropped.join(', ')}.` : ''));
}

module.exports = { migrate };
