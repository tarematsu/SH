import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// One-off migration script: point this at your own Google Sheets export URLs via
// HISTORY_IMPORT_SHEETS, e.g.:
//   HISTORY_IMPORT_SHEETS='[{"id":"sheet_a","url":"https://docs.google.com/spreadsheets/d/XXX/export?format=csv&gid=0"}]'
const SOURCES = JSON.parse(process.env.HISTORY_IMPORT_SHEETS || 'null');
if (!SOURCES) {
  throw new Error('Set HISTORY_IMPORT_SHEETS to a JSON array of {id, url} Google Sheets CSV export sources.');
}

const OUT_DIR = path.resolve('database/history-import-parts');
const OUT_MANIFEST = path.resolve('database/history-import-manifest.json');
const OUT_REPORT = path.resolve('database/history-import-report.json');
const NOW = Date.now();
const MIN_DATE = Date.parse('2024-01-01T00:00:00+09:00');

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row); }
  return rows;
}

function normHeader(v) { return String(v || '').replace(/[\s　]/g, '').toLowerCase(); }
function cleanText(v) { const s = String(v ?? '').trim(); return s || null; }
function number(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[,，\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}
function integer(v) { const n = number(v); return n == null ? null : Math.round(n); }
function parseJstDate(v) {
  const s = String(v || '').trim();
  const m = s.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  const [, y, mo, d, h = '0', mi = '0', sec = '0'] = m;
  const ts = Date.UTC(+y, +mo - 1, +d, +h - 9, +mi, +sec);
  if (!Number.isFinite(ts) || ts < MIN_DATE || ts > NOW + 86_400_000) return null;
  return ts;
}
function jstString(ts) {
  const d = new Date(ts + 9 * 3_600_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}:${String(d.getUTCSeconds()).padStart(2,'0')}`;
}
function sql(v) {
  if (v == null) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  const hex = Buffer.from(String(v), 'utf8').toString('hex');
  return `CAST(X'${hex}' AS TEXT)`;
}
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex').slice(0, 32); }

const aliases = {
  observed: ['取得日時','日時','date','timestamp'], listener: ['同接','リスナー','listener'],
  streams: ['総再生数','再生数','stream','streams'], track: ['曲名','track','title'],
  artist: ['歌手名','アーティスト','artist'], likes: ['いいね','likes'],
  velocity: ['コメント勢い','コメント速度','velocity'], host: ['ホスト','host'],
  members: ['メンバー','総メンバー','members'],
};
function findIndex(headers, keys) {
  const normalized = headers.map(normHeader);
  return normalized.findIndex((h) => keys.some((k) => h.includes(normHeader(k))));
}

function normalizeSource(sourceId, rows, report) {
  const headerIndex = rows.findIndex((r) => r.some((c) => normHeader(c) === '取得日時'));
  if (headerIndex < 0) throw new Error(`${sourceId}: header not found`);
  const headers = rows[headerIndex];
  const idx = Object.fromEntries(Object.entries(aliases).map(([k, v]) => [k, findIndex(headers, v)]));
  const known = new Set(Object.values(idx).filter((x) => x >= 0));
  const out = [];
  for (let i = headerIndex + 1; i < rows.length; i += 1) {
    report.source_rows += 1;
    const r = rows[i];
    if (!r.some((c) => String(c).trim())) { report.skipped.blank += 1; continue; }
    const observedAt = idx.observed >= 0 ? parseJstDate(r[idx.observed]) : null;
    if (!observedAt) { report.skipped.bad_timestamp += 1; continue; }
    const extras = r.filter((v, n) => !known.has(n) && cleanText(v)).map(cleanText);
    let listener = idx.listener >= 0 ? integer(r[idx.listener]) : null;
    let streams = idx.streams >= 0 ? integer(r[idx.streams]) : null;
    let members = idx.members >= 0 ? integer(r[idx.members]) : null;
    let likes = idx.likes >= 0 ? integer(r[idx.likes]) : null;
    let velocity = idx.velocity >= 0 ? number(r[idx.velocity]) : null;
    const track = idx.track >= 0 ? cleanText(r[idx.track]) : null;
    const artist = idx.artist >= 0 ? cleanText(r[idx.artist]) : null;
    const host = idx.host >= 0 ? cleanText(r[idx.host]) : null;
    const note = extras.join(' / ') || null;
    const flags = [];
    let score = 1;
    if (listener != null && (listener < 0 || listener > 100000)) { flags.push('invalid_listener'); listener = null; score -= .35; }
    if (streams != null && streams < 0) { flags.push('invalid_stream_count'); streams = null; score -= .35; }
    if (members != null && (members < 0 || members > 10000000)) { flags.push('invalid_member_count'); members = null; score -= .35; }
    if (likes != null && likes < 0) { flags.push('invalid_likes'); likes = null; score -= .15; }
    if (velocity != null && velocity < 0) { flags.push('invalid_comment_velocity'); velocity = null; score -= .15; }
    if (note?.includes('Xポスト')) { flags.push('manual_x_source'); score -= .2; }
    if (streams === 0 && note?.includes('Xポスト')) { flags.push('zero_stream_unknown'); streams = null; score -= .05; }
    const meaningful = [listener, streams, members, likes, velocity, track, artist, host].some((v) => v != null);
    if (!meaningful) { report.skipped.no_data += 1; continue; }
    if ([listener, streams, members].every((v) => v == null)) { flags.push('context_only'); score = Math.min(score, .45); }
    if (host && [listener, streams, members, track, artist].every((v) => v == null)) flags.push('host_only');
    out.push({ source_id: sourceId, source_row: i + 1, observed_at: observedAt, observed_jst: jstString(observedAt), listener_count: listener, total_stream_count: streams, track_title: track, artist_name: artist, likes, comment_velocity: velocity, host_handle: host, total_member_count: members, source_note: note, quality_score: Math.max(0, Math.min(1, score)), quality_flags: flags, raw: r });
  }
  return out;
}

function richness(r) { return ['listener_count','total_stream_count','track_title','artist_name','likes','comment_velocity','host_handle','total_member_count'].reduce((n,k)=>n+(r[k]!=null),0) + r.quality_score; }
function mergeRows(rows, report) {
  const byTime = new Map();
  for (const r of rows) {
    const key = String(r.observed_at);
    const prev = byTime.get(key);
    if (!prev) { byTime.set(key, r); continue; }
    report.duplicate_rows += 1;
    const primary = richness(r) > richness(prev) ? r : prev;
    const secondary = primary === r ? prev : r;
    for (const k of ['listener_count','total_stream_count','track_title','artist_name','likes','comment_velocity','host_handle','total_member_count','source_note']) if (primary[k] == null && secondary[k] != null) primary[k] = secondary[k];
    primary.quality_flags = [...new Set([...primary.quality_flags, ...secondary.quality_flags, 'merged_duplicate'])];
    primary.quality_score = Math.max(primary.quality_score, secondary.quality_score);
    byTime.set(key, primary);
  }
  const sorted = [...byTime.values()].sort((a,b)=>a.observed_at-b.observed_at);
  let prevStream = null;
  for (const r of sorted) {
    if (r.total_stream_count != null && prevStream != null && r.total_stream_count < prevStream - Math.max(1000, prevStream * .01)) {
      r.quality_flags.push('stream_counter_reset_or_unrelated');
      r.quality_score = Math.min(r.quality_score, .55);
    }
    if (r.total_stream_count != null) prevStream = r.total_stream_count;
    r.quality_flags = [...new Set(r.quality_flags)];
    r.canonical_key = hash(JSON.stringify([r.observed_at,r.listener_count,r.total_stream_count,r.total_member_count,r.track_title,r.host_handle]));
  }
  return sorted;
}

function periodKey(ts, mode) {
  const d = new Date(ts + 9*3_600_000);
  const y=d.getUTCFullYear(), m=d.getUTCMonth()+1, day=d.getUTCDate();
  if (mode==='daily') return `${y}-${String(m).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  if (mode==='monthly') return `${y}-${String(m).padStart(2,'0')}`;
  const date = new Date(Date.UTC(y,m-1,day));
  const dow=(date.getUTCDay()+6)%7; date.setUTCDate(date.getUTCDate()-dow);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,'0')}-${String(date.getUTCDate()).padStart(2,'0')}`;
}
function summarize(rows, mode) {
  const groups = new Map();
  for (const r of rows) { const k=periodKey(r.observed_at,mode); if(!groups.has(k))groups.set(k,[]); groups.get(k).push(r); }
  return [...groups.entries()].map(([key, rs])=>{
    rs.sort((a,b)=>a.observed_at-b.observed_at);
    const reliable=rs.filter(r=>r.quality_score>=.6);
    const listeners=reliable.map(r=>r.listener_count).filter(v=>v!=null);
    const streams=reliable.filter(r=>r.total_stream_count!=null && !r.quality_flags.includes('stream_counter_reset_or_unrelated'));
    const members=reliable.filter(r=>r.total_member_count!=null);
    const hosts=new Map(); for(const r of reliable) if(r.host_handle)hosts.set(r.host_handle,(hosts.get(r.host_handle)||0)+1);
    const primaryHost=[...hosts].sort((a,b)=>b[1]-a[1])[0]?.[0]||null;
    const flags=[];
    let streamGrowth=null; if(streams.length>=2){streamGrowth=streams.at(-1).total_stream_count-streams[0].total_stream_count;if(streamGrowth<0){streamGrowth=null;flags.push('stream_reset_in_period');}}
    let memberGrowth=null; if(members.length>=2){memberGrowth=members.at(-1).total_member_count-members[0].total_member_count;if(memberGrowth<0)flags.push('member_decrease');}
    if(reliable.length<Math.max(1,rs.length*.5))flags.push('low_reliable_coverage');
    return { period_key:key, period_start:rs[0].observed_at, period_end:rs.at(-1).observed_at, sample_count:rs.length, reliable_sample_count:reliable.length, listener_avg:listeners.length?listeners.reduce((a,b)=>a+b,0)/listeners.length:null, listener_min:listeners.length?listeners.reduce((min,v)=>v<min?v:min,listeners[0]):null, listener_max:listeners.length?listeners.reduce((max,v)=>v>max?v:max,listeners[0]):null, stream_start:streams[0]?.total_stream_count??null, stream_end:streams.at(-1)?.total_stream_count??null, stream_growth:streamGrowth, member_start:members[0]?.total_member_count??null, member_end:members.at(-1)?.total_member_count??null, member_growth:memberGrowth, likes_max:(()=>{const values=reliable.map(r=>r.likes).filter(v=>v!=null);return values.length?values.reduce((max,v)=>v>max?v:max,values[0]):null;})(), distinct_tracks:new Set(reliable.map(r=>r.track_title).filter(Boolean)).size, primary_host:primaryHost, quality_score:rs.reduce((a,r)=>a+r.quality_score,0)/rs.length, quality_flags:flags };
  });
}

async function main() {
  const report={generated_at:new Date().toISOString(),source_rows:0,accepted_rows:0,duplicate_rows:0,warning_rows:0,skipped:{blank:0,bad_timestamp:0,no_data:0},sources:[]};
  let rows=[];
  for(const source of SOURCES){
    const res=await fetch(source.url,{headers:{'user-agent':'Mozilla/5.0'}});
    if(!res.ok) throw new Error(`${source.id}: HTTP ${res.status}`);
    const text=await res.text();
    const parsed=parseCsv(text);
    const normalized=normalizeSource(source.id,parsed,report);
    for (const row of normalized) rows.push(row);
    report.sources.push({id:source.id,downloaded_rows:parsed.length,normalized_rows:normalized.length});
  }
  rows=mergeRows(rows,report); report.accepted_rows=rows.length; report.warning_rows=rows.filter(r=>r.quality_flags.length).length;
  const daily=summarize(rows,'daily'), weekly=summarize(rows,'weekly'), monthly=summarize(rows,'monthly');
  const statements=['DELETE FROM sh_legacy_snapshots;','DELETE FROM sh_daily_summary;','DELETE FROM sh_weekly_summary;','DELETE FROM sh_monthly_summary;'];
  for(const r of rows) statements.push(`INSERT OR REPLACE INTO sh_legacy_snapshots (canonical_key,source_id,source_row,observed_at,observed_jst,listener_count,total_stream_count,track_title,artist_name,likes,comment_velocity,host_handle,total_member_count,source_note,quality_score,quality_flags,raw_json,imported_at) VALUES (${sql(r.canonical_key)},${sql(r.source_id)},${r.source_row},${r.observed_at},${sql(r.observed_jst)},${sql(r.listener_count)},${sql(r.total_stream_count)},${sql(r.track_title)},${sql(r.artist_name)},${sql(r.likes)},${sql(r.comment_velocity)},${sql(r.host_handle)},${sql(r.total_member_count)},${sql(r.source_note)},${r.quality_score},${sql(JSON.stringify(r.quality_flags))},${sql(JSON.stringify(r.raw))},${NOW});`);
  for(const [table,data] of [['sh_daily_summary',daily],['sh_weekly_summary',weekly],['sh_monthly_summary',monthly]]) for(const r of data) statements.push(`INSERT OR REPLACE INTO ${table} (period_key,period_start,period_end,sample_count,reliable_sample_count,listener_avg,listener_min,listener_max,stream_start,stream_end,stream_growth,member_start,member_end,member_growth,likes_max,distinct_tracks,primary_host,quality_score,quality_flags,updated_at) VALUES (${sql(r.period_key)},${r.period_start},${r.period_end},${r.sample_count},${r.reliable_sample_count},${sql(r.listener_avg)},${sql(r.listener_min)},${sql(r.listener_max)},${sql(r.stream_start)},${sql(r.stream_end)},${sql(r.stream_growth)},${sql(r.member_start)},${sql(r.member_end)},${sql(r.member_growth)},${sql(r.likes_max)},${r.distinct_tracks},${sql(r.primary_host)},${r.quality_score},${sql(JSON.stringify(r.quality_flags))},${NOW});`);
  report.daily_periods=daily.length; report.weekly_periods=weekly.length; report.monthly_periods=monthly.length;
  report.skipped_rows=Object.values(report.skipped).reduce((a,b)=>a+b,0);
  statements.push(`INSERT INTO sh_history_import_runs (imported_at,source_count,source_rows,accepted_rows,skipped_rows,duplicate_rows,warning_rows,report_json) VALUES (${NOW},${SOURCES.length},${report.source_rows},${report.accepted_rows},${report.skipped_rows},${report.duplicate_rows},${report.warning_rows},${sql(JSON.stringify(report))});`);

  const CHUNK_SIZE = 20000;
  await fs.rm(OUT_DIR,{recursive:true,force:true});
  await fs.mkdir(OUT_DIR,{recursive:true});
  const files=[];
  for(let i=0;i<statements.length;i+=CHUNK_SIZE){
    const part=String(files.length+1).padStart(3,'0');
    const filename=`history-import-part-${part}.sql`;
    const filepath=path.join(OUT_DIR,filename);
    await fs.writeFile(filepath,statements.slice(i,i+CHUNK_SIZE).join('\n')+'\n','utf8');
    files.push({filename,statements:Math.min(CHUNK_SIZE,statements.length-i)});
  }
  const manifest={generated_at:new Date().toISOString(),chunk_size:CHUNK_SIZE,total_statements:statements.length,files};
  await fs.writeFile(OUT_MANIFEST,JSON.stringify(manifest,null,2),'utf8');
  await fs.writeFile(OUT_REPORT,JSON.stringify(report,null,2),'utf8');
  console.log(`OK accepted=${report.accepted_rows} skipped=${report.skipped_rows} duplicates=${report.duplicate_rows} warnings=${report.warning_rows}`);
  console.log(`SQL parts: ${OUT_DIR}`); console.log(`Manifest: ${OUT_MANIFEST}`); console.log(`Report: ${OUT_REPORT}`);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
