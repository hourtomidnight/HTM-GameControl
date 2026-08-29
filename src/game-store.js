const COLUMNS = new Set([
  'started_ts', 'ended_ts', 'status', 'room', 'operator', 'team_name',
  'new_players', 'exp_players', 'notes', 'adjustments', 'net_adjust_s',
  'hint_count', 'sheets_row',
]);

function createGameStore(db) {
  function create(fields = {}) {
    const keys = Object.keys(fields).filter(k => COLUMNS.has(k));
    if (!keys.includes('started_ts')) throw new Error('game requires started_ts');
    const sql = `INSERT INTO games (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
    const r = db.prepare(sql).run(...keys.map(k => fields[k]));
    return { id: Number(r.lastInsertRowid) };
  }

  function update(id, patch = {}) {
    const keys = Object.keys(patch).filter(k => COLUMNS.has(k));
    if (!keys.length) return;
    const sql = `UPDATE games SET ${keys.map(k => k + ' = ?').join(', ')} WHERE id = ?`;
    db.prepare(sql).run(...keys.map(k => patch[k]), id);
  }

  const get = (id) => db.prepare('SELECT * FROM games WHERE id = ?').get(id);
  const recent = (limit = 20) =>
    db.prepare('SELECT * FROM games ORDER BY started_ts DESC LIMIT ?').all(limit);

  return { create, update, get, recent };
}

module.exports = { createGameStore };
