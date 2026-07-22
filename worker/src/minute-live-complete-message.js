function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

export function budgetedLiveCompleteMessage(body) {
  const jobId = integer(body?.job?.id);
  return body?.message_type === 'minute-fact-derive-stage'
    && Number(body?.message_version) === 1
    && body?.stage === 'complete'
    && jobId != null
    && jobId > 0
    && String(body?.job?.job_kind || 'live') !== 'rebuild';
}
