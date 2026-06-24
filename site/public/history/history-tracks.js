(() => {
  const TRACK_LABELS={play_date:'日付',title:'曲名',artist:'アーティスト',play_count:'再生回数',daily_share:'その日の割合',first_played_at:'最初の再生',last_played_at:'最後の再生'};
  MODE_HELP.tracks=['再生曲','UTC基準で、選択した日または月曜日始まりの週の再生曲を表示します。'];
  const baseSetMode=setMode,baseVisibleKeys=visibleKeys,baseLabelsFor=labelsFor,baseDisplayCell=displayCell,baseUpdateSummary=updateSummary,baseDraw=draw,baseLoad=load;
  const TRACK_CACHE_MS=10*60*1000;

  function withDailyTotals(rows){const totals=new Map();for(const row of rows)totals.set(row.play_date,(totals.get(row.play_date)||0)+(finiteNumber(row.play_count)||0));const result=[];let previousDate=null;for(const row of rows){const total=totals.get(row.play_date)||0;if(row.play_date!==previousDate){result.push({_daily_total:true,play_date:row.play_date,title:'この日の延べ曲数',artist:'—',play_count:total,daily_share:100,first_played_at:null,last_played_at:null});previousDate=row.play_date;}result.push({...row,daily_share:total>0?(finiteNumber(row.play_count)||0)/total*100:0});}return result;}
  function cacheKey(from,to){return `track-history:v5:${from}:${to}`;}
  function readCache(key){try{const value=JSON.parse(sessionStorage.getItem(key));return value&&Date.now()-value.at<TRACK_CACHE_MS?value.data:null;}catch{return null;}}
  function writeCache(key,data){try{sessionStorage.setItem(key,JSON.stringify({at:Date.now(),data}));}catch{}}

  setMode=function(mode){baseSetMode(mode);if(mode!=='tracks')return;$('#metric').hidden=true;$('#metric').disabled=true;$('#chartPanel').hidden=true;$('#tableTitle').textContent='再生曲（UTC）';$('#rankingWeeklyPanel').hidden=true;};
  visibleKeys=(mode)=>mode==='tracks'?Object.keys(TRACK_LABELS):baseVisibleKeys(mode);
  labelsFor=(mode)=>mode==='tracks'?TRACK_LABELS:baseLabelsFor(mode);
  displayCell=function(key,row,mode){if(mode!=='tracks')return baseDisplayCell(key,row,mode);if(key==='play_date')return formatDate(row[key]);if(key==='first_played_at'||key==='last_played_at')return row._daily_total?'—':formatDate(row[key],true);if(key==='play_count')return `${fmt(row[key])}回`;if(key==='daily_share'){const value=finiteNumber(row[key]);return value==null?'—':`${value.toLocaleString('ja-JP',{maximumFractionDigits:1})}%`;}const value=row[key];return value==null||value===''?'—':String(value);};
  updateSummary=function(rows,mode){if(mode!=='tracks')return baseUpdateSummary(rows,mode);const days=new Set(rows.map(r=>r.play_date).filter(Boolean)),tracks=new Set(rows.map(r=>r.track_key).filter(Boolean));const total=rows.reduce((s,r)=>s+(finiteNumber(r.play_count)||0),0),max=rows.reduce((m,r)=>Math.max(m,finiteNumber(r.play_count)||0),0);$('#periodLabel').textContent='日数';$('#maxLabel').textContent='総再生回数';$('#streamLabel').textContent='曲数';$('#memberLabel').textContent='1曲の最多';$('#periods').textContent=fmt(days.size);$('#maxListener').textContent=fmt(total);$('#streamGrowth').textContent=fmt(tracks.size);$('#memberGrowth').textContent=max?`${fmt(max)}回`:'—';};
  draw=function(rows,metric,selected){if(currentMode==='tracks'){ $('#chartPanel').hidden=true; return;}return baseDraw(rows,metric,selected);};

  load=async function(options={}){
    if(currentMode!=='tracks')return baseLoad(options);if(loading)return;loading=true;selectedChartIndex=null;nextCursor=null;const from=$('#from').value,to=$('#to').value,key=cacheKey(from,to);$('#notice').textContent='読み込み中…';
    try{let data=readCache(key);if(!data){const params=new URLSearchParams({from,to,limit:'2000',v:'5'});const response=await fetch(`/api/track-history?${params}`);data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||`HTTP ${response.status}`);writeCache(key,data);}current=data.rows||[];updateSummary(current,'tracks');const tableRows=withDailyTotals(current);renderTable(tableRows,'tracks',false);$('#tbody').querySelectorAll('tr').forEach((row,index)=>{if(tableRows[index]?._daily_total)row.classList.add('daily-total-row');});$('#more').hidden=true;$('#chartPanel').hidden=true;$('#rankingWeeklyPanel').hidden=true;if(data.setup_required)$('#notice').textContent='再生曲データの保存テーブルがまだありません。';else $('#notice').textContent=`${formatDate(from)}〜${formatDate(to)}：${fmt(current.length)}件を表示（UTC）${data.truncated?'（表示上限）':''}`;}
    catch(error){$('#notice').textContent=`API error: ${error.message}`;}finally{loading=false;}
  };
})();