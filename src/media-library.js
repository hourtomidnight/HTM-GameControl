const fs = require('node:fs');
const path = require('node:path');

const ALLOWED_EXT = new Set(['.mp3', '.wav', '.ogg']);

function resolveSafe(root, relPath) {
  const str = String(relPath || '');
  if (path.isAbsolute(str)) {
    const e = new Error('path escapes media root: ' + relPath);
    e.code = 'bad-path';
    throw e;
  }
  const clean = str.replace(/^[/\\]+/, '');
  const resolved = path.resolve(root, clean);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    const e = new Error('path escapes media root: ' + relPath);
    e.code = 'bad-path';
    throw e;
  }
  return resolved;
}

function toPosix(relFromRoot) {
  return relFromRoot.split(path.sep).join('/');
}

function walk(root, dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) { walk(root, full, out); continue; }
    const ext = path.extname(ent.name).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) continue;
    out.push(toPosix(path.relative(root, full)));
  }
}

function createMediaLibrary({ db, root, steps }) {
  fs.mkdirSync(root, { recursive: true });

  const getRow = db.prepare('SELECT * FROM media WHERE path = ?');
  const upsertRow = db.prepare(`
    INSERT INTO media (path, title, tags, kind, bytes, added_ts)
    VALUES (?, ?, ?, 'audio', ?, ?)
    ON CONFLICT(path) DO UPDATE SET bytes = excluded.bytes
  `);
  const upsertMeta = db.prepare(`
    INSERT INTO media (path, title, tags, kind, bytes, added_ts)
    VALUES (?, ?, ?, 'audio', 0, ?)
    ON CONFLICT(path) DO UPDATE SET title = excluded.title, tags = excluded.tags
  `);
  const deleteRow = db.prepare('DELETE FROM media WHERE path = ?');
  const renameRow = db.prepare('UPDATE media SET path = ? WHERE path = ?');
  const allRows = db.prepare('SELECT * FROM media');

  function list() {
    const onDisk = [];
    walk(root, root, onDisk);
    const rows = new Map(allRows.all().map(r => [r.path, r]));
    const out = [];
    for (const p of onDisk) {
      const row = rows.get(p);
      const full = path.join(root, ...p.split('/'));
      const bytes = row ? row.bytes : fs.statSync(full).size;
      out.push({
        path: p,
        title: (row && row.title) || path.basename(p),
        tags: (row && row.tags) || '',
        kind: (row && row.kind) || 'audio',
        bytes,
        addedTs: row ? row.added_ts : null,
        missing: false,
      });
      rows.delete(p);
    }
    for (const row of rows.values()) {
      out.push({
        path: row.path, title: row.title || path.basename(row.path), tags: row.tags,
        kind: row.kind, bytes: row.bytes, addedTs: row.added_ts, missing: true,
      });
    }
    out.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return out;
  }

  function save(relPath, buffer) {
    const ext = path.extname(relPath).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      const e = new Error('disallowed extension: ' + ext);
      e.code = 'bad-ext';
      throw e;
    }
    const full = resolveSafe(root, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, buffer);
    const p = toPosix(path.relative(root, full));
    upsertRow.run(p, '', '', buffer.length, Date.now());
    return { path: p, bytes: buffer.length };
  }

  function setMeta(relPath, { title = '', tags = '' } = {}) {
    const full = resolveSafe(root, relPath);
    if (!fs.existsSync(full)) {
      const e = new Error('not found: ' + relPath);
      e.code = 'not-found';
      throw e;
    }
    const p = toPosix(path.relative(root, full));
    upsertMeta.run(p, title, tags, Date.now());
    return { path: p, title, tags };
  }

  function move(from, to) {
    const fullFrom = resolveSafe(root, from);
    const fullTo = resolveSafe(root, to);
    if (!fs.existsSync(fullFrom)) { const e = new Error('not found: ' + from); e.code = 'not-found'; throw e; }
    if (fs.existsSync(fullTo)) { const e = new Error('already exists: ' + to); e.code = 'exists'; throw e; }
    fs.mkdirSync(path.dirname(fullTo), { recursive: true });
    fs.renameSync(fullFrom, fullTo);
    const pFrom = toPosix(path.relative(root, fullFrom));
    const pTo = toPosix(path.relative(root, fullTo));
    if (getRow.get(pFrom)) renameRow.run(pTo, pFrom);
    let refsChanged = 0;
    for (const step of (steps() || [])) {
      for (const h of (step.hints || [])) {
        if (h && h.type === 'audio' && h.mediaRef === pFrom) { h.mediaRef = pTo; refsChanged++; }
      }
    }
    return { path: pTo, refsChanged };
  }

  function remove(relPath) {
    const full = resolveSafe(root, relPath);
    const p = toPosix(path.relative(root, full));
    const inUse = [];
    for (const step of (steps() || [])) {
      for (const h of (step.hints || [])) {
        if (h && h.type === 'audio' && h.mediaRef === p) inUse.push(step.id);
      }
    }
    if (inUse.length) { const e = new Error('in use'); e.code = 'in-use'; e.inUse = inUse; throw e; }
    try { fs.unlinkSync(full); } catch {}
    deleteRow.run(p);
    return { path: p };
  }

  function usage() {
    const rows = allRows.all();
    const onDisk = [];
    walk(root, root, onDisk);
    let bytes = 0;
    for (const p of onDisk) {
      try { bytes += fs.statSync(path.join(root, ...p.split('/'))).size; } catch {}
    }
    let freeBytes = null;
    try {
      if (typeof fs.statfsSync === 'function') {
        const s = fs.statfsSync(root);
        freeBytes = s.bavail * s.bsize;
      }
    } catch { freeBytes = null; }
    return { bytes, count: onDisk.length, freeBytes };
  }

  return { list, save, setMeta, move, remove, usage };
}

module.exports = { createMediaLibrary, resolveSafe };
