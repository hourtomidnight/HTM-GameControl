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

  // Rewrite the Hotkeys reference tab from the current hint config.
  // Row 1 is the header; one row per configured hint.
  const syncHotkeysTab = guard('syncHotkeysTab', async () => {
    const c = cfg();
    if (!c.hintsSpreadsheetId || !c.hotkeysTabName) return;
    const rows = buildHotkeysRows(config.current().hintGroups);
    await api.spreadsheets.values.clear({
      spreadsheetId: c.hintsSpreadsheetId, range: `${c.hotkeysTabName}!A:C`,
    });
    await api.spreadsheets.values.update({
      spreadsheetId: c.hintsSpreadsheetId, range: `${c.hotkeysTabName}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['Group', 'Hint', 'Hotkey'], ...rows] },
    });
  });

  return {
    enabled: api !== null,
    onGameStart, onSessionSync, onHint, readOperators, syncHotkeysTab,
    buildSessionRow, buildHintRow, buildHotkeysRows, formatDuration, formatNetAdjustment,
  };
}

module.exports = {
  createSheets, buildSessionRow, buildHintRow, buildHotkeysRows,
  formatDuration, formatNetAdjustment, parseRowIndexFromUpdatedRange,
};
