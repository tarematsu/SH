export const DAY_MS = 86_400_000;

export function utcDayKey(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function utcDayStart(dayKey) {
  return Date.parse(`${dayKey}T00:00:00Z`);
}

export function previousUtcDay(now = Date.now()) {
  const end = utcDayStart(utcDayKey(now));
  const start = end - DAY_MS;
  return { key: utcDayKey(start), start, end };
}

export function utcWeeklyRange(dayKey) {
  const date = new Date(`${dayKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  const startKey = date.toISOString().slice(0, 10);
  date.setUTCDate(date.getUTCDate() + 7);
  return { key: startKey, startKey, endKey: date.toISOString().slice(0, 10) };
}

export function utcMonthlyRange(dayKey) {
  const [year, month] = dayKey.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return {
    key: dayKey.slice(0, 7),
    startKey: start.toISOString().slice(0, 10),
    endKey: end.toISOString().slice(0, 10),
  };
}
