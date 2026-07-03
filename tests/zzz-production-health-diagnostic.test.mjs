import test from 'node:test';
import assert from 'node:assert/strict';

test('capture production collector health after recovery deployment', async () => {
  const checkedAt = Date.now();
  const response = await fetch('https://stationhead-monitor-collector.tarematsu.workers.dev/health', {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch {}

  const lastSuccessAt = Number(payload?.last_success_at || payload?.collector_last_success_at || 0);
  const ageMs = lastSuccessAt ? checkedAt - lastSuccessAt : null;
  assert.fail(JSON.stringify({
    diagnostic_only: true,
    http_status: response.status,
    checked_at: checkedAt,
    last_success_at: lastSuccessAt || null,
    age_ms: ageMs,
    payload,
    raw: payload ? null : text.slice(0, 2000),
  }));
});
