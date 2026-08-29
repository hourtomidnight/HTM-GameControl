function createSession({ startTime, room, operator = '', teamName = '', newPlayers = 0, experiencedPlayers = 0 }) {
  return {
    startTime, room, operator, teamName, newPlayers, experiencedPlayers,
    notes: '', adjustments: [], hints: [], endTime: null, duration: null, status: null,
  };
}

function applyAdjustment(session, type, time) {
  session.adjustments.push({ type, time });
  return session;
}

function applyHint(session, text, time) {
  const record = { text, time };
  session.hints.push(record);
  return record;
}

const EDITABLE_FIELDS = ['teamName', 'operator', 'newPlayers', 'experiencedPlayers', 'notes'];

function updateField(session, field, value) {
  if (!EDITABLE_FIELDS.includes(field)) throw new Error('Unknown session field: ' + field);
  session[field] = value;
  return session;
}

function finalizeSession(session, endTime, status) {
  session.endTime = endTime;
  session.duration = endTime - session.startTime;
  session.status = status;
  return session;
}

const ADJ_SEC = { 'add-min': 60, 'sub-min': -60, 'add-sec': 1, 'sub-sec': -1 };
function netAdjustmentSeconds(session) {
  return session.adjustments.reduce((sum, a) => sum + (ADJ_SEC[a.type] || 0), 0);
}

module.exports = {
  createSession, applyAdjustment, applyHint, updateField, finalizeSession,
  netAdjustmentSeconds, ADJ_SEC,
};
