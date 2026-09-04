const fs = require('node:fs');
const { netAdjustmentSeconds } = require('./session-tracker');

function pad(n) { return String(n).padStart(2, '0'); }

function formatDuration(ms) {
  const t = Math.floor(ms / 1000);
  return pad(Math.floor(t / 3600)) + ':' + pad(Math.floor((t % 3600) / 60)) + ':' + pad(t % 60);
}

function formatNetAdjustment(session) {
  const netSec = netAdjustmentSeconds(session);
  const sign = netSec < 0 ? '-' : '+';
  const abs = Math.abs(netSec);
  return sign + pad(Math.floor(abs / 60)) + ':' + pad(abs % 60);
}

function buildSessionRow(session) {
  const start = new Date(session.startTime);
  const end = session.endTime ? new Date(session.endTime) : null;
  return [
    start.toLocaleDateString(),                                        // Date
    start.toLocaleTimeString(),                                        // Start Time
    session.room || '',                                               // Room
    session.operator || '',                                           // Operator
    session.teamName || '',                                           // Team Name
    session.newPlayers || 0,                                          // New Players
    session.experiencedPlayers || 0,                                  // Experienced Players
    end ? end.toLocaleTimeString() : '',                              // End Time
    session.duration != null ? formatDuration(session.duration) : '', // Duration
    session.status || '',                                             // Status
    session.adjustments.length,                                       // # Time Adjustments
    formatNetAdjustment(session),                                     // Net Time Adjusted
    session.hints.length,                                             // Hint Count
    session.notes || '',                                              // Notes
  ];
}

function buildHintRow(hintRecord, session) {
  const at = new Date(hintRecord.time);
  return [
    at.toLocaleDateString(),
    at.toLocaleTimeString(),
    hintRecord.text,
    new Date(session.startTime).toLocaleTimeString(),
  ];
}

// Rows for the "Hotkeys" reference tab: A=Group, B=Hint, C=Hotkey (one row per hint).
function buildHotkeysRows(hintGroups) {
  const rows = [];
  (hintGroups || []).forEach(g => {
    (g.hints || []).forEach(h => {
      if (h && h.text) rows.push([g.name || '', h.text, h.key || '']);
    });
  });
  return rows;
}

// Rows for the "Hotkeys" reference tab, sourced from the new steps/hints model:
// A=Group(step name), B=Hint(label for audio / text for text, falling back to
// mediaRef when no label is set), C=Hotkey. Steps with no hints contribute nothing.
function buildHotkeysRowsFromSteps(steps) {
  const rows = [];
  (steps || []).forEach(step => {
    (step.hints || []).forEach(h => {
      if (!h) return;
      const hintText = h.type === 'audio' ? (h.label || h.mediaRef || '') : (h.text || '');
      if (!hintText) return;
      rows.push([step.name || '', hintText, h.key || '']);
    });
  });
  return rows;
}

function parseRowIndexFromUpdatedRange(r) {
  const m = r.match(/![A-Z]+(\d+):/);
  if (!m) throw new Error('Could not parse row index from range: ' + r);
  return parseInt(m[1], 10);
}

function createSheets({ credentialsPath, config, eventStore, gameStore, googleFactory }) {
  let api = null;
  if (googleFactory) {
    api = googleFactory();
  } else if (fs.existsSync(credentialsPath)) {
    const { google } = require('googleapis');
    const auth = new google.auth.GoogleAuth({
      keyFile: credentialsPath, scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    api = google.sheets({ version: 'v4', auth });
  }

  const logErr = (op, e) => {
    try {
      eventStore.record({ source: 'sheets', type: 'sheets-error', detail: { op, message: e.message } });
    } catch {}
  };
  const guard = (op, fn) => async (...args) => {
    if (!api) return;
    try { return await fn(...args); } catch (e) { logErr(op, e); }
  };

  const cfg = () => (config.current().sheets || {});

  const onGameStart = guard('onGameStart', async (gameId, session) => {
    const c = cfg();
    if (!c.sessionsSpreadsheetId || !c.sessionsTabName) return;
    const res = await api.spreadsheets.values.append({
      spreadsheetId: c.sessionsSpreadsheetId, range: c.sessionsTabName + '!A1',
      valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [buildSessionRow(session)] },
    });
    const rowIndex = parseRowIndexFromUpdatedRange(res.data.updates.updatedRange);
    gameStore.update(gameId, { sheets_row: rowIndex });
  });

  const onSessionSync = guard('onSessionSync', async (gameId, session) => {
    const c = cfg();
    const row = gameStore.get(gameId)?.sheets_row;
    if (!c.sessionsSpreadsheetId || !c.sessionsTabName || !row) return;
    const values = buildSessionRow(session);
    const endCol = String.fromCharCode(65 + values.length - 1);
    await api.spreadsheets.values.update({
      spreadsheetId: c.sessionsSpreadsheetId,
      range: `${c.sessionsTabName}!A${row}:${endCol}${row}`,
      valueInputOption: 'USER_ENTERED', requestBody: { values: [values] },
    });
  });

  const onHint = guard('onHint', async (gameId, session, hintRecord) => {
    const c = cfg();
    if (!c.hintsSpreadsheetId || !c.hintsTabName) return;
    await api.spreadsheets.values.append({
      spreadsheetId: c.hintsSpreadsheetId, range: c.hintsTabName + '!A1',
      valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [buildHintRow(hintRecord, session)] },
    });
  });

  const readOperatorsGuarded = guard('readOperators', async () => {
    const c = config.current();
    const s = c.sheets || {};
    if (!s.operatorsSpreadsheetId) return [];
    const tab = s.operatorsTabName || 'Drop Down options';
    const col = (s.operatorsColumn || 'B').toUpperCase().replace(/[^A-Z]/g, '') || 'B';
    const startRow = Math.max(1, parseInt(s.operatorsStartRow, 10) || 2);
    const range = `${tab}!${col}${startRow}:${col}`;
    const res = await api.spreadsheets.values.get({
      spreadsheetId: s.operatorsSpreadsheetId, range,
    });
    return (res.data.values || []).map(r => r[0]).filter(Boolean);
  });
  const readOperators = async (...args) => (await readOperatorsGuarded(...args)) ?? [];

  // Read the Hotkeys tab back: [{ group, hint, key }] for rows with a hint.
  // Header row (row 1) is skipped.
  const readHotkeysGuarded = guard('readHotkeys', async () => {
    const c = cfg();
    if (!c.hintsSpreadsheetId) return [];
    const tab = c.hotkeysTabName || 'Hotkeys';
    const res = await api.spreadsheets.values.get({
      spreadsheetId: c.hintsSpreadsheetId, range: `${tab}!A2:C`,
    });
    return (res.data.values || [])
      .map(r => ({
        group: (r[0] || '').trim(),
        hint: (r[1] || '').trim(),
        key: (r[2] || '').trim(),
      }))
      .filter(x => x.hint);
  });
  const readHotkeys = async (...args) => (await readHotkeysGuarded(...args)) ?? [];

  // List the tab (sheet) titles in a spreadsheet, for the config dropdowns.
  const listTabsGuarded = guard('listTabs', async (spreadsheetId) => {
    if (!spreadsheetId) return [];
    const res = await api.spreadsheets.get({
      spreadsheetId, fields: 'sheets.properties.title',
    });
    return (res.data.sheets || [])
      .map(s => s.properties && s.properties.title)
      .filter(Boolean);
  });
  const listTabs = async (id) => (await listTabsGuarded(id)) ?? [];

  // Rewrite the Hotkeys reference tab from the current hint config.
  // Row 1 is the header; one row per configured hint.
  // Create the tab only if it's genuinely missing. Returns true if we just
  // created it (so the caller can allow for Sheets' brief propagation lag).
  async function ensureTab(spreadsheetId, title) {
    let existing = [];
    try {
      const meta = await api.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
      existing = (meta.data.sheets || []).map(s => s.properties && s.properties.title);
    } catch { /* fall through and just try to add */ }
    if (existing.includes(title)) return false;
    try {
      await api.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [{ addSheet: { properties: { title } } }] },
      });
      return true;
    } catch (e) {
      if (/already exists/i.test(e.message || '')) return false;
      throw e;
    }
  }

  async function withRetry(fn, tries = 4) {
    for (let i = 0; ; i++) {
      try { return await fn(); }
      catch (e) {
        if (i >= tries - 1 || !/unable to parse range|not found/i.test(e.message || '')) throw e;
        await new Promise(r => setTimeout(r, 400 * (i + 1)));
      }
    }
  }

  const syncHotkeysTab = guard('syncHotkeysTab', async () => {
    const c = cfg();
    if (!c.hintsSpreadsheetId) return;
    const tab = c.hotkeysTabName || 'Hotkeys';
    const rows = buildHotkeysRows(config.current().hintGroups);
    await ensureTab(c.hintsSpreadsheetId, tab);
    await withRetry(() => api.spreadsheets.values.clear({
      spreadsheetId: c.hintsSpreadsheetId, range: `${tab}!A:C`,
    }));
    await withRetry(() => api.spreadsheets.values.update({
      spreadsheetId: c.hintsSpreadsheetId, range: `${tab}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['Group', 'Hint', 'Hotkey'], ...rows] },
    }));
  });

  return {
    enabled: api !== null,
    onGameStart, onSessionSync, onHint, readOperators, readHotkeys, listTabs, syncHotkeysTab,
    buildSessionRow, buildHintRow, buildHotkeysRows, buildHotkeysRowsFromSteps, formatDuration, formatNetAdjustment,
  };
}

module.exports = {
  createSheets, buildSessionRow, buildHintRow, buildHotkeysRows, buildHotkeysRowsFromSteps,
  formatDuration, formatNetAdjustment, parseRowIndexFromUpdatedRange,
};
