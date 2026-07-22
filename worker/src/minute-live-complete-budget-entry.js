const RETRY_60_SECONDS = Object.freeze({ delaySeconds: 60 });

export const COMPLETE_LIVE_MINUTE_FACT_JOB_SQL = `UPDATE sh_minute_fact_jobs SET
    status='done',lease_until=NULL,processed_at=?,last_error=NULL,
    payload_json=CASE WHEN EXISTS (
      SELECT 1 FROM sh_queue_revisions revisions
      WHERE revisions.source_job_id=sh_minute_fact_jobs.id
        AND (revisions.status<>'complete'
          OR COALESCE(revisions.materialized_item_count,0)
            <COALESCE(revisions.source_visible_count,revisions.item_count,0))
    ) THEN payload_json ELSE '{}' END,
    updated_at=?
  WHERE id=? AND status='processing'`;

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function invalidMessage(message) {
  return Object.assign(new Error(message), { code: 'MINUTE_DERIVE_INVALID_TRIGGER' });
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

export async function completeBudgetedLiveJob(env, body, dependencies = {}) {
  if (!budgetedLiveCompleteMessage(body)) {
    throw invalidMessage('unsupported budgeted live completion message');
  }
  const jobId = integer(body.job.id);
  const now = (dependencies.now || Date.now)();
  if (dependencies.complete) return dependencies.complete(env, jobId, now);
  const db = env?.MINUTE_DB;
  if (!db?.prepare) throw new Error('minute live completion MINUTE_DB binding is missing');
  return db.prepare(COMPLETE_LIVE_MINUTE_FACT_JOB_SQL)
    .bind(now, now, jobId)
    .run();
}

export async function processBudgetedLiveCompleteBatch(batch, env, dependencies = {}) {
  for (const message of batch?.messages || []) {
    try {
      await completeBudgetedLiveJob(env, message.body, dependencies);
      message.ack();
    } catch (error) {
      console.error(JSON.stringify({
        event: 'minute_live_complete_budget_failed',
        error: String(error?.message || error).slice(0, 800),
      }));
      if (error?.code === 'MINUTE_DERIVE_INVALID_TRIGGER') message.ack();
      else message.retry(RETRY_60_SECONDS);
    }
  }
}

export default {
  queue: processBudgetedLiveCompleteBatch,
};
