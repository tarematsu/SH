import { mkdir, rm, writeFile } from 'node:fs/promises';

// One-off migration script: point this at your own Google Sheets via TRACK_LIKE_HISTORY_SHEETS, e.g.:
//   TRACK_LIKE_HISTORY_SHEETS='[{"id":"XXX","gid":"0"}]'
const sheets = JSON.parse(process.env.TRACK_LIKE_HISTORY_SHEETS || 'null');
if (!sheets) {
  throw new Error('Set TRACK_LIKE_HISTORY_SHEETS to a JSON array of {id, gid} Google Sheets sources.');
}
const CHUNK_SIZE = 2000;
const OUTPUT_DIR = 'database/track-like-history-import';

function parseCsv(text) {
  const rows=[]; let row=[]; let cell=''; let quoted=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){
      if(c==='"'&&text[i+1]==='"'){cell+='"';i++;}
      else if(c==='"')quoted=false;
      else cell+=c;
    }else if(c==='"')quoted=true;
    else if(c===','){row.push(cell);cell='';}
    else if(c==='\n'){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';}
    else cell+=c;
  }
  if(cell||row.length){row.push(cell);rows.push(row);}
  return rows;
}

const norm=v=>String(v??'').normalize('NFKC').trim();
const canon=v=>norm(v).toLocaleLowerCase('ja-JP').replace(/[\s\u3000]+/g,'').replace(/[‐‑‒–—―ー−-]/g,'-');
const number=v=>{const n=Number(norm(v).replace(/,/g,''));return Number.isFinite(n)?n:null;};
function jstMillis(value){
  const s=norm(value).replace(/\//g,'-');
  const m=s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if(!m)return null;
  return Date.UTC(+m[1],+m[2]-1,+m[3],+(m[4]||0)-9,+(m[5]||0),+(m[6]||0));
}
const quote=v=>`'${String(v??'').replace(/'/g,"''")}'`;
const rawRecords=[];

for(const sheet of sheets){
  const url=`https://docs.google.com/spreadsheets/d/${sheet.id}/export?format=csv&gid=${sheet.gid}`;
  const response=await fetch(url);
  if(!response.ok)throw new Error(`download failed ${response.status}: ${sheet.id}`);
  const rows=parseCsv(await response.text());
  const headerIndex=rows.findIndex(r=>r.some(c=>/取得日時|日時/.test(norm(c)))&&r.some(c=>/曲名/.test(norm(c)))&&r.some(c=>/いいね|bite/i.test(norm(c))));
  if(headerIndex<0)throw new Error(`header not found: ${sheet.id}`);
  const headers=rows[headerIndex].map(norm);
  const find=re=>headers.findIndex(h=>re.test(h));
  const dateCol=find(/取得日時|日時/),titleCol=find(/^曲名$/),artistCol=find(/歌手名|アーティスト/),likeCol=find(/いいね|bite/i);
  for(let i=headerIndex+1;i<rows.length;i++){
    const r=rows[i];
    const observedAt=jstMillis(r[dateCol]);
    const title=norm(r[titleCol]);
    const artist=artistCol>=0?norm(r[artistCol]):'';
    const likeCount=number(r[likeCol]);
    if(observedAt==null||!title||likeCount==null)continue;
    rawRecords.push({observedAt,title,artist:artist||null,likeCount,sheetId:sheet.id,gid:sheet.gid,row:i+1,raw:r});
  }
}

const artistsByTitle=new Map();
for(const record of rawRecords){
  if(!record.artist)continue;
  const key=canon(record.title);
  if(!artistsByTitle.has(key))artistsByTitle.set(key,new Set());
  artistsByTitle.get(key).add(record.artist);
}
for(const record of rawRecords){
  if(record.artist)continue;
  const candidates=artistsByTitle.get(canon(record.title));
  if(candidates?.size===1)record.artist=[...candidates][0];
}

rawRecords.sort((a,b)=>
  canon(a.title).localeCompare(canon(b.title),'ja')
  || canon(a.artist).localeCompare(canon(b.artist),'ja')
  || a.observedAt-b.observedAt
  || a.sheetId.localeCompare(b.sheetId)
  || a.row-b.row
);

const records=[];
const lastByTrack=new Map();
const exactSeen=new Set();
for(const record of rawRecords){
  const trackKey=`${canon(record.title)}|${canon(record.artist)}`;
  const exactKey=`${trackKey}|${record.observedAt}|${record.likeCount}`;
  if(exactSeen.has(exactKey))continue;
  exactSeen.add(exactKey);
  const previous=lastByTrack.get(trackKey);
  if(previous?.likeCount===record.likeCount)continue;
  records.push(record);
  lastByTrack.set(trackKey,record);
}

records.sort((a,b)=>a.observedAt-b.observedAt||a.title.localeCompare(b.title,'ja')||String(a.artist||'').localeCompare(String(b.artist||''),'ja'));
const statements=records.map(r=>`INSERT INTO sh_track_like_history (observed_at,track_title,artist,like_count,source_sheet_id,source_gid,source_row,raw_json) VALUES (${r.observedAt},${quote(r.title)},${r.artist?quote(r.artist):'NULL'},${r.likeCount},${quote(r.sheetId)},${quote(r.gid)},${r.row},${quote(JSON.stringify(r.raw))}) ON CONFLICT(source_sheet_id,source_gid,source_row) DO UPDATE SET observed_at=excluded.observed_at,track_title=excluded.track_title,artist=excluded.artist,like_count=excluded.like_count,raw_json=excluded.raw_json;`);

await rm(OUTPUT_DIR,{recursive:true,force:true});
await mkdir(OUTPUT_DIR,{recursive:true});
const files=[];
for(let offset=0;offset<statements.length;offset+=CHUNK_SIZE){
  const index=files.length+1;
  const name=`part-${String(index).padStart(4,'0')}.sql`;
  await writeFile(`${OUTPUT_DIR}/${name}`,statements.slice(offset,offset+CHUNK_SIZE).join('\n'),'utf8');
  files.push(name);
}
await writeFile(`${OUTPUT_DIR}/manifest.json`,JSON.stringify({source_rows:rawRecords.length,change_rows:records.length,removed_rows:rawRecords.length-records.length,chunk_size:CHUNK_SIZE,files},null,2),'utf8');
console.log(`Read ${rawRecords.length} rows; kept ${records.length} changes; removed ${rawRecords.length-records.length} unchanged/duplicate rows; generated ${files.length} files.`);
