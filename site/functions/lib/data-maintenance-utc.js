import { backfillLegacySamples } from './data-maintenance-legacy-backfill.js';
import { rollupDailyUtc, rollupFromDailyUtc } from './data-maintenance-rollup-utc.js';
import { previousUtcDay, utcMonthlyRange, utcWeeklyRange } from './utc-periods.js';

const HOUR_MS=3_600_000;
const CLAIM_MS=15*60_000;
const STATE_ID='rollup-retention-v1';
const runtimeState=new WeakMap();
const changes=(result)=>Number(result?.meta?.changes??result?.changes??0);

export async function runDataMaintenance(db,now=Date.now()){
  if(!db)return {skipped:true,reason:'missing-db'};
  const cached=runtimeState.get(db);
  if(cached?.nextCheckAt>now)return {skipped:true,reason:'memory-cadence'};
  runtimeState.set(db,{nextCheckAt:now+HOUR_MS});
  let claimAt=null;
  try{
    const state=await db.prepare(`SELECT last_rollup_key,last_cleanup_at,legacy_backfill_id,updated_at FROM sh_data_maintenance_state WHERE id=?`).bind(STATE_ID).first();
    const previousRun=Number(state?.updated_at||0);
    if(previousRun>0&&now-previousRun<HOUR_MS){
      const nextCheckAt=previousRun+HOUR_MS;
      runtimeState.set(db,{nextCheckAt});
      return {skipped:true,reason:'persistent-cadence',nextCheckAt};
    }
    claimAt=now-HOUR_MS+CLAIM_MS;
    const claim=await db.prepare(`INSERT INTO sh_data_maintenance_state(id,last_rollup_key,last_cleanup_at,legacy_backfill_id,updated_at)
      VALUES(?,NULL,0,0,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at
      WHERE sh_data_maintenance_state.updated_at=?`).bind(STATE_ID,claimAt,previousRun).run();
    if(changes(claim)<1){
      const latest=await db.prepare(`SELECT updated_at FROM sh_data_maintenance_state WHERE id=?`).bind(STATE_ID).first();
      const latestAt=Number(latest?.updated_at||0);
      const nextCheckAt=latestAt>0?latestAt+HOUR_MS:now+CLAIM_MS;
      runtimeState.set(db,{nextCheckAt});
      return {skipped:true,reason:'maintenance-claimed',nextCheckAt};
    }
    runtimeState.set(db,{nextCheckAt:claimAt+HOUR_MS});
    const period=previousUtcDay(now);
    let lastRollupKey=state?.last_rollup_key||null;
    const lastCleanupAt=Number(state?.last_cleanup_at||0);
    let legacyBackfillId=Number(state?.legacy_backfill_id||0);
    let rolledUp=false;
    if(lastRollupKey!==period.key){
      const dailyWritten=await rollupDailyUtc(db,period,now);
      if(dailyWritten){
        await rollupFromDailyUtc(db,'sh_weekly_summary',utcWeeklyRange(period.key),now);
        await rollupFromDailyUtc(db,'sh_monthly_summary',utcMonthlyRange(period.key),now);
        lastRollupKey=period.key;
        rolledUp=true;
      }
    }
    const legacyBackfill=await backfillLegacySamples(db,legacyBackfillId);
    legacyBackfillId=legacyBackfill.lastLegacyId;
    await db.prepare(`INSERT INTO sh_data_maintenance_state(id,last_rollup_key,last_cleanup_at,legacy_backfill_id,updated_at)
      VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      last_rollup_key=CASE
        WHEN sh_data_maintenance_state.last_rollup_key IS NULL THEN excluded.last_rollup_key
        WHEN excluded.last_rollup_key IS NULL THEN sh_data_maintenance_state.last_rollup_key
        WHEN excluded.last_rollup_key>sh_data_maintenance_state.last_rollup_key THEN excluded.last_rollup_key
        ELSE sh_data_maintenance_state.last_rollup_key END,
      last_cleanup_at=MAX(sh_data_maintenance_state.last_cleanup_at,excluded.last_cleanup_at),
      legacy_backfill_id=MAX(sh_data_maintenance_state.legacy_backfill_id,excluded.legacy_backfill_id),
      updated_at=MAX(sh_data_maintenance_state.updated_at,excluded.updated_at)`)
      .bind(STATE_ID,lastRollupKey,lastCleanupAt,legacyBackfillId,now).run();
    runtimeState.set(db,{nextCheckAt:now+HOUR_MS});
    return {skipped:false,rolledUp,cleaned:false,periodKey:period.key,periodTimezone:'UTC',legacyBackfill};
  }catch(error){
    if(claimAt==null)runtimeState.delete(db);else runtimeState.set(db,{nextCheckAt:claimAt+HOUR_MS});
    throw error;
  }
}

export async function runDataMaintenanceSafely(db,now=Date.now()){
  try{return await runDataMaintenance(db,now);}
  catch(error){
    console.error('D1 data maintenance failed',error);
    return {skipped:true,reason:'maintenance-error',error:error?.message||String(error)};
  }
}

export function resetDataMaintenanceRuntimeState(db){if(db)runtimeState.delete(db);}
