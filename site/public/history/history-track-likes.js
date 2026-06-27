(() => {
  const baseVisibleKeys=visibleKeys;
  const baseLabelsFor=labelsFor;
  const baseDisplayCell=displayCell;
  const baseLoad=load;

  visibleKeys=(mode)=>mode==='tracks'?[...baseVisibleKeys(mode),'like_count']:baseVisibleKeys(mode);
  labelsFor=(mode)=>mode==='tracks'?{...baseLabelsFor(mode),like_count:'いいね数'}:baseLabelsFor(mode);
  displayCell=function(key,row,mode){
    if(mode==='tracks'&&key==='like_count'){
      if(row?._daily_total)return '—';
      const value=Number(row?.like_count);
      return Number.isFinite(value)?`${value.toLocaleString('ja-JP')}件`:'—';
    }
    return baseDisplayCell(key,row,mode);
  };

  const canon=value=>String(value||'').normalize('NFKC').toLocaleLowerCase('ja-JP').replace(/[\s\u3000]+/g,'').replace(/[‐‑‒–—―ー−-]/g,'-');
  function identityKeys(row){
    const keys=[];
    for(const value of row?.source_ids||[])if(value)keys.push(`id:${String(value)}`);
    for(const key of ['spotify_id','apple_music_id','isrc','stationhead_track_id','queue_track_id'])if(row?.[key])keys.push(`id:${String(row[key])}`);
    if(row?.title)keys.push(`name:${canon(row.title)}|artist:${canon(row.artist)}`);
    if(row?.title)keys.push(`name:${canon(row.title)}`);
    return keys;
  }



  load=async function(options={}){
    if(currentMode!=='tracks')return baseLoad(options);
    await baseLoad(options);
    const from=$('#from').value,to=$('#to').value;
    try{
      const response=await fetch(`/api/track-likes?${new URLSearchParams({from,to})}`);
      const data=await response.json();
      if(!response.ok||!data.ok)return;
      const map=new Map();
      const rows=[...(data.rows||[])].sort((a,b)=>Number(a.observed_at||0)-Number(b.observed_at||0));
      for(const row of rows)for(const key of identityKeys(row))map.set(`${row.play_date}|${key}`,row.like_count);
      current=current.map(row=>{
        let like=null;
        for(const key of identityKeys(row)){const value=map.get(`${row.play_date}|${key}`);if(value!=null){like=value;break;}}
        return {...row,like_count:like};
      });
      const tableRows=withDailyTotals(current);
      renderTable(tableRows,'tracks',false);
      $('#tbody').querySelectorAll('tr').forEach((row,index)=>{if(tableRows[index]?._daily_total)row.classList.add('daily-total-row');});
    }catch(error){console.error('track likes load failed',error);}
  };
})();
