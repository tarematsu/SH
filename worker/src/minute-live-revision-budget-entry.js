const RETRY_60_SECONDS = Object.freeze({ delaySeconds: 60 });

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function invalidMessage(message) {
  return Object.assign(new Error(message), { code: 'MINUTE_DERIVE_INVALID_TRIGGER' });
}

export function liveRevisionMaterializationEnabled(env = {}) {
  const value = env?.LIVE_REVISION_MATERIALIZATION_ENABLED;
  if (value == null || value === '') return true;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

export function budgetedLiveRevisionMessage(body) {
  const revisionId = integer(body?.revision?.revision_id);
  return body?.message_type === 'minute-fact-derive-stage'
    && Number(body?.message_version) === 1
    && body?.stage === 'revision-materialize'
    && body?.revision?.sparse === true
    && body?.revision?.rebuild !== true
    && revisionId != null
    && revisionId > 0;
}

async function closePartialRevision(env, body, dependencies = {}) {
  const revisionId = integer(body?.revision?.revision_id);
  const db = env?.MINUTE_DB;
  if (!db?.prepare) throw new Error('minute live revision MINUTE_DB binding is missing');
  const now = (dependencies.now || Date.now)();
  const result = await db.prepare(`UPDATE sh_queue_revisions SET
      source_visible_count=COALESCE(materialized_item_count,0),
      status='complete',
      coverage_complete=CASE
        WHEN COALESCE(materialized_item_count,0)>=COALESCE(item_count,0) THEN 1 ELSE 0 END,
      last_materialized_at=?
    WHERE id=?
      AND (status!='complete'
        OR COALESCE(source_visible_count,-1)!=COALESCE(materialized_item_count,0))`)
    .bind(now, revisionId)
    .run();
  return Number(result?.meta?.changes || 0) > 0;
}

export async function processBudgetedLiveRevisionBatch(batch, env, dependencies = {}) {
  const messages = batch?.messages;
  if (!messages?.length) return;
  for (const message of messages) {
    try {
      if (!budgetedLiveRevisionMessage(message?.body)) {
        throw invalidMessage('unsupported budgeted live revision message');
      }
      await closePartialRevision(env, message.body, dependencies);
      message.ack();
    } catch (error) {
      console.error(JSON.stringify({
        event: 'minute_live_revision_budget_failed',
        error: String(error?.message || error).slice(0, 800),
      }));
      if (error?.code === 'MINUTE_DERIVE_INVALID_TRIGGER') message.ack();
      else message.retry(RETRY_60_SECONDS);
    }
  }
}

export default {
  queue: processBudgetedLiveRevisionBatch,
};
