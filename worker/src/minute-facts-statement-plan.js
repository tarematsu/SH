import {
  minuteFactContextDeleteStatement,
  minuteFactContextUpsertStatement,
  minuteFactStatement,
  totalMemberDailyStatement,
} from './minute-facts-normalize.js';

function contextPresent(fact) {
  return fact.queue_revision_id != null
    || Number(fact.queue_available || 0) !== 0
    || fact.queue_position != null
    || fact.broadcast_session_id == null;
}

export function minuteFactStatements(db, fact) {
  return [
    minuteFactStatement(db, fact),
    totalMemberDailyStatement(db, fact),
    contextPresent(fact)
      ? minuteFactContextUpsertStatement(db, fact)
      : minuteFactContextDeleteStatement(db, fact),
  ];
}
