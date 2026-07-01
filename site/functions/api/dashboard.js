import { onRequestGet as legacyDashboard, hostScopeFromSnapshot, linearRegressionPrediction, linearRegressionPredictionFromAggregate, HISTORY_24H_SQL, PREDICTION_24H_SQL } from './dashboard-legacy.mjs';
export { hostScopeFromSnapshot, linearRegressionPrediction, linearRegressionPredictionFromAggregate, HISTORY_24H_SQL, PREDICTION_24H_SQL };
const cache={value:null,expiresAt:0,pending:null};
const normalize=(value)=>String(value||'').replace(/\s+/g,' ').trim();
const targetSql=normalize(PREDICTION_24H_SQL);
export async function cachedPrediction(statement,now=Date.now()){
  if(cache.value&&cache.expiresAt>now)return cache.value;
  if(!cache.pending)cache.pending=Promise.resolve(statement.first()).then((value)=>{cache.value=value;cache.expiresAt=Date.now()+60000;return value;}).finally(()=>{cache.pending=null;});
  return cache.pending;
}
export function resetPredictionCache(){cache.value=null;cache.expiresAt=0;cache.pending=null;}
function proxyStatement(statement,useCache){return new Proxy(statement,{get(target,property){if(useCache&&property==='first')return()=>cachedPrediction(target);const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;}});}
function proxyDatabase(db){return new Proxy(db,{get(target,property){if(property==='prepare')return(sql)=>proxyStatement(target.prepare(sql),normalize(sql)===targetSql);const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;}});}
export async function onRequestGet(context){if(!context.env?.DB)return legacyDashboard(context);return legacyDashboard({...context,env:{...context.env,DB:proxyDatabase(context.env.DB)}});}
