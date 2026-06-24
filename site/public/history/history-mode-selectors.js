(() => {
  const baseSetMode = setMode;
  const baseLoad = load;
  let resolvingLatestTrackDate = false;
  let trackRangeMode = 'day';

  const rangePresets=$('#rangePresets'), fromWrap=$('#fromWrap'), toWrap=$('#toWrap');
  const trackControls=$('#trackControls'), trackDate=$('#trackDate'), trackWeek=$('#trackWeek');
  const rankingScopeTabs=$('#rankingScopeTabs'), rankingWeekFocus=$('#rankingWeekFocus'), rankingWeek=$('#rankingWeek');
  const loadButton=$('#load');
  const todayUtc=()=>new Date().toISOString().slice(0,10);

  function mondayOf(value){
    const date=new Date(`${value||todayUtc()}T00:00:00Z`); const day=date.getUTCDay(); date.setUTCDate(date.getUTCDate()-((day+6)%7)); return date.toISOString().slice(0,10);
  }
  function sundayOfMonday(value){const date=new Date(`${mondayOf(value)}T00:00:00Z`);date.setUTCDate(date.getUTCDate()+6);return date.toISOString().slice(0,10);}
  function setStandardControlsVisible(visible){rangePresets.hidden=!visible;fromWrap.hidden=!visible;toWrap.hidden=!visible;}

  async function resolveLatestTrackDate(){
    if(trackDate.value||resolvingLatestTrackDate)return trackDate.value;
    resolvingLatestTrackDate=true;
    try{const response=await fetch('/api/track-history?latest=1');const data=await response.json();trackDate.value=data?.latest_date||todayUtc();trackWeek.value=mondayOf(trackDate.value);return trackDate.value;}
    finally{resolvingLatestTrackDate=false;}
  }
  function selectedRankingScope(){return rankingScopeTabs.querySelector('button.active')?.dataset.scope||'featured';}
  function syncRankingScope(scope){rankingScopeTabs.querySelectorAll('button').forEach((b)=>b.classList.toggle('active',b.dataset.scope===scope));$('#rankingScope').value=scope;$('#host').value='';}
  shouldShowRankingChart=()=>true;

  setMode=function(mode){
    baseSetMode(mode);
    const tracks=mode==='tracks',ranking=mode==='ranking',broadcasts=mode==='broadcasts';
    setStandardControlsVisible(!(tracks||ranking||broadcasts));
    trackControls.hidden=!tracks; rankingScopeTabs.hidden=!ranking; rankingWeekFocus.hidden=!ranking; loadButton.hidden=tracks||ranking||broadcasts;
    $('#rankingScopeWrap').hidden=true;$('#hostWrap').hidden=true;
    if(ranking){syncRankingScope(selectedRankingScope());if(!rankingWeek.value)rankingWeek.value=mondayOf(todayUtc());}
  };

  load=async function(options={}){
    if(currentMode==='tracks'){
      await resolveLatestTrackDate();
      if(trackRangeMode==='week'){trackWeek.value=mondayOf(trackWeek.value||trackDate.value);$('#from').value=trackWeek.value;$('#to').value=sundayOfMonday(trackWeek.value);}
      else{$('#from').value=trackDate.value;$('#to').value=trackDate.value;}
    }else if(currentMode==='ranking'){$('#from').value='2024-05-01';$('#to').value=todayUtc();syncRankingScope(selectedRankingScope());}
    else if(currentMode==='broadcasts'){$('#from').value='2024-05-01';$('#to').value=todayUtc();}
    return baseLoad(options);
  };

  trackDate.addEventListener('change',()=>{trackRangeMode='day';nextCursor=null;load();});
  trackWeek.addEventListener('change',()=>{trackRangeMode='week';trackWeek.value=mondayOf(trackWeek.value);nextCursor=null;load();});
  rankingScopeTabs.querySelectorAll('button').forEach((button)=>button.addEventListener('click',()=>{syncRankingScope(button.dataset.scope);nextCursor=null;load();}));
  rankingWeek.addEventListener('change',()=>{
    rankingWeek.value=mondayOf(rankingWeek.value);
    if(currentMode!=='ranking'||!current.length)return;
    const weeks=[...new Set(current.map((row)=>row.ranking_date).filter(Boolean))].sort();
    const index=weeks.indexOf(rankingWeek.value); if(index>=0){selectedChartIndex=index;drawRanking(current,index);}
  });
})();