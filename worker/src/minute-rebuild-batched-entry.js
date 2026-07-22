import { withBackfillCursorSeek } from './backfill-cursor-seek.js';
import { historicalRebuildEnabled } from './historical-rebuild-policy.js';
import { processMinuteRebuildStage } from './minute-rebuild-entry.js';
import {
  processMinuteMaintenanceGate,
  processMinuteMaintenanceRun,
  processMinuteMaintenanceSync,
} from './minute-rebuild-maintenance-entry.js';

const RETRY_60_SECONDS = Object.freeze({ delaySeconds: 60 });
const EMPTY_DEPENDENCIES = Object.freeze({});

function maintenanceStage(body) {
  if (body?.message_type !== 'minute-rebuild-stage' || Number(body?.message_version) !== 1) return null;
  if (['maintenance-gate', 'maintenance-run', 'maintenance-sync'].includes(body.stage)) {
    return body.stage;
  }
  return null;
}

function historicalStage(body) {
  return body?.message_type === 'minute-rebuild-stage'
    && ['gap-scan', 'gap-commit', 'backfill', 'backfill-prepare', 'backfill-commit']
      .includes(String(body?.stage || ''));
}

function syncMaintenance(body, stage) {
  return stage === 'maintenance-sync'
    || (stage === 'maintenance-run' && body?.maintenance_task === 'sync');
}

async function processOneMinuteRebuildMessage(message, env, dependencies = EMPTY_DEPENDENCIES) {
  const stage = maintenanceStage(message?.body);
  try {
    if (!historicalRebuildEnabled(env) && historicalStage(message?.body)) {
      console.log(JSON.stringify({
        event: 'minute_rebuild_stage_skipped',
        stage: message.body.stage,
        reason: 'historical-rebuild-disabled-for-d1-budget',
      }));
    } else if (stage) {
      const run = stage === 'maintenance-gate'
        ? dependencies.processMinuteMaintenanceGate || processMinuteMaintenanceGate
        : syncMaintenance(message.body, stage)
          ? dependencies.processMinuteMaintenanceSync || processMinuteMaintenanceSync
          : dependencies.processMinuteMaintenanceRun || processMinuteMaintenanceRun;
      const result = await run(env, message.body, dependencies.maintenance || EMPTY_DEPENDENCIES);
      console.log(JSON.stringify({
        event: 'minute_maintenance_gate_completed',
        stage: result?.stage,
        task: result?.task,
        run_id: result?.run_id,
        pending: result?.pending === true,
        skipped: result?.skipped === true,
        reason: result?.reason,
        requeued: result?.requeued === true,
        attempt: result?.attempt,
        dispatched_stage: result?.dispatched_stage,
        historical_backfill_due: result?.historical_backfill_due,
        payloads_cleared: result?.payload_cleanup?.cleared,
      }));
    } else {
      const run = dependencies.processMinuteRebuildStage || processMinuteRebuildStage;
      const result = await run(
        withBackfillCursorSeek(env),
        message.body,
        dependencies.rebuild || EMPTY_DEPENDENCIES,
      );
      console.log(JSON.stringify({ event: 'minute_rebuild_stage_completed', ...result }));
    }
    message.ack();
  } catch (error) {
    console.error(JSON.stringify({
      event: stage ? 'minute_maintenance_gate_failed' : 'minute_rebuild_stage_failed',
      error: String(error?.message || error).slice(0, 800),
    }));
    message.retry(RETRY_60_SECONDS);
  }
}

export async function processMinuteRebuildBatch(batch, env, _ctx, dependencies = EMPTY_DEPENDENCIES) {
  const messages = batch?.messages;
  if (!messages?.length) return;
  for (const message of messages) {
    await processOneMinuteRebuildMessage(message, env, dependencies);
  }
}

export {
  historicalStage,
  maintenanceStage,
  processOneMinuteRebuildMessage,
  syncMaintenance,
};

export default {
  queue: processMinuteRebuildBatch,
};
