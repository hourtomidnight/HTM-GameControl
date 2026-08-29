const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY,
  ts      INTEGER NOT NULL,
  source  TEXT NOT NULL,
  type    TEXT NOT NULL,
  subject TEXT,
  value   TEXT,
  game_id INTEGER,
  detail  TEXT
);
CREATE INDEX IF NOT EXISTS ix_events_ts   ON events(ts);
CREATE INDEX IF NOT EXISTS ix_events_game ON events(game_id);
CREATE INDEX IF NOT EXISTS ix_events_type ON events(type);

CREATE TABLE IF NOT EXISTS games (
  id           INTEGER PRIMARY KEY,
  started_ts   INTEGER NOT NULL,
  ended_ts     INTEGER,
  status       TEXT,
  room         TEXT,
  operator     TEXT,
  team_name    TEXT,
  new_players  INTEGER,
  exp_players  INTEGER,
  notes        TEXT,
  adjustments  INTEGER DEFAULT 0,
  net_adjust_s INTEGER DEFAULT 0,
  hint_count   INTEGER DEFAULT 0,
  sheets_row   INTEGER
);

CREATE TABLE IF NOT EXISTS config_history (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, json TEXT NOT NULL
);
`;

function encode(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

function decode(s) {
  if (s === null || s === undefined) return s;
  try { return JSON.parse(s); } catch { return s; }
}

function createEventStore({ path }) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);

  const insert = db.prepare(
    `INSERT INTO events (ts, source, type, subject, value, game_id, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  function record({ ts, source, type, subject = null, value, game_id = null, detail }) {
    if (!source || !type) throw new Error('event requires source and type');
    const r = insert.run(
      ts ?? Date.now(), source, type, subject,
      encode(value), game_id, encode(detail)
    );
    return { id: Number(r.lastInsertRowid) };
  }

  function query({ game_id, from, to, type, source, limit } = {}) {
    const where = [];
    const args = [];
    if (game_id !== undefined) { where.push('game_id = ?'); args.push(game_id); }
    if (from !== undefined)    { where.push('ts >= ?');     args.push(from); }
    if (to !== undefined)      { where.push('ts <= ?');     args.push(to); }
    if (type !== undefined)    { where.push('type = ?');    args.push(type); }
    if (source !== undefined)  { where.push('source = ?');  args.push(source); }
    let sql = 'SELECT * FROM events';
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY ts ASC, id ASC';
    if (limit !== undefined) { sql += ' LIMIT ?'; args.push(limit); }
    return db.prepare(sql).all(...args).map(row => ({
      ...row, value: decode(row.value), detail: decode(row.detail),
    }));
  }

  return { db, record, query, close: () => db.close() };
}

module.exports = { createEventStore };
