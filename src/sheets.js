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
    if (!c.sheets?.operatorsSpreadsheetId) return [];
    const res = await api.spreadsheets.values.get({
      spreadsheetId: c.sheets.operatorsSpreadsheetId, range: 'Drop Down options!B2:B',
    });
    return (res.data.values || []).map(r => r[0]).filter(Boolean);
  });
  const readOperators = async (...args) => (await readOperatorsGuarded(...args)) ?? [];

  return {
    onGameStart, onSessionSync, onHint, readOperators,
    buildSessionRow, buildHintRow, formatDuration, formatNetAdjustment,
  };
}

module.exports = {
  createSheets, buildSessionRow, buildHintRow,
  formatDuration, formatNetAdjustment, parseRowIndexFromUpdatedRange,
};
