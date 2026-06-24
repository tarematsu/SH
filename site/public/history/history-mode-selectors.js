(() => {
  const baseSetMode=setMode;
  const baseLoad=load;
  let resolvingLatestTrackDate=false;

  const controls=$('#historyControls');
  const rangePresets=$('#rangePresets');
  const fromWrap=$('#fromWrap');
  const toWrap=$('#toWrap');
  const trackControls=$('#trackControls');
  const trackDate=$('#trackDate');
  const trackWeekMode=$('#trackWeekMode');
  const rankingScopeTabs=$('#rankingScopeTabs');
  const rankingWeekMenu=$('#rankingWeekMenu');
  const rankingWeekCurrent=$('#rankingWeekCurrent');
  const rankingWeekList=$('#rankingWeekList');
  const loadButton=$('#load');
  const todayUtc=()=>new Date().toISOString().slice(0,10);

  function mondayOf(value){
    const date=new Date(`${value||todayUtc()}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate()-((date.getUTCDay()+6)%7));
    return date.toISOString().slice(0,10);
  }
  function sundayOf(value){
    const date=new Date(`${mondayOf(value)}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate()+6);
    return date.toISOString().slice(0,10);
  }
  function displayDate(value){return String(value||'').replaceAll('-','/');}
  function setStandardControlsVisible(visible){rangePresets.hidden=!visible;fromWrap.hidden=!visible;toWrap.hidden=!visible;}

  async function resolveLatestTrackDate(){
    if(trackDate.value||resolvingLatestTrackDate)return trackDate.value;
    resolvingLatestTrackDate=true;
    try{
      const response=await fetch('/api/track-history?latest=1');
      const data=await response.json();
      trackDate.value=data?.latest_date||todayUtc();
      return trackDate.value;
    }finally{resolvingLatestTrackDate=false;}
  }

  function selectedRankingScope(){return rankingScopeTabs.querySelector('button.active')?.dataset.scope||'featured';}
  function syncRankingScope(scope){
    rankingScopeTabs.querySelectorAll('button').forEach((button)=>button.classList.toggle('active',button.dataset.scope===scope));
    $('#rankingScope').value=scope;
    $('#host').value='';
  }

  function focusRankingWeek(week){
    const weeks=[...new Set(current.map((row)=>row.ranking_date).filter(Boolean))].sort();
    const index=weeks.indexOf(week);
    if(index<0)return;
    selectedChartIndex=index;
    rankingWeekCurrent.textContent=displayDate(week);
    rankingWeekList.querySelectorAll('button').forEach((button)=>button.classList.toggle('active',button.dataset.week===week));
    drawRanking(current,index);
  }

  function buildRankingWeekMenu(){
    if(currentMode!=='ranking')return;
    const weeks=[...new Set(current.map((row)=>row.ranking_date).filter(Boolean))].sort().reverse();
    rankingWeekList.innerHTML=weeks.map((week)=>`<button type="button" data-week="${week}">${displayDate(week)}</button>`).join('');
    rankingWeekList.querySelectorAll('button').forEach((button)=>button.addEventListener('click',()=>{
      focusRankingWeek(button.dataset.week);
      rankingWeekMenu.open=false;
    }));
    if(weeks.length)focusRankingWeek(weeks[0]);
    else rankingWeekCurrent.textContent='週データなし';
  }

  shouldShowRankingChart=()=>true;

  setMode=function(mode){
    baseSetMode(mode);
    const tracks=mode==='tracks';
    const ranking=mode==='ranking';
    const broadcasts=mode==='broadcasts';
    controls.hidden=broadcasts;
    setStandardControlsVisible(!(tracks||ranking||broadcasts));
    trackControls.hidden=!tracks;
    rankingScopeTabs.hidden=!ranking;
    rankingWeekMenu.hidden=!ranking;
    loadButton.hidden=tracks||ranking||broadcasts;
    $('#rankingScopeWrap').hidden=true;
    $('#hostWrap').hidden=true;
    if(ranking)syncRankingScope(selectedRankingScope());
  };

  load=async function(options={}){
    if(currentMode==='tracks'){
      await resolveLatestTrackDate();
      if(trackWeekMode.checked){$('#from').value=mondayOf(trackDate.value);$('#to').value=sundayOf(trackDate.value);}
      else{$('#from').value=trackDate.value;$('#to').value=trackDate.value;}
    }else if(currentMode==='ranking'){
      $('#from').value='2024-05-01';
      $('#to').value=todayUtc();
      syncRankingScope(selectedRankingScope());
    }else if(currentMode==='broadcasts'){
      $('#from').value='2024-05-01';
      $('#to').value=todayUtc();
    }
    const result=await baseLoad(options);
    if(currentMode==='ranking'&&!options.append)buildRankingWeekMenu();
    return result;
  };

  trackDate.addEventListener('change',()=>{nextCursor=null;load();});
  trackWeekMode.addEventListener('change',()=>{nextCursor=null;load();});
  rankingScopeTabs.querySelectorAll('button').forEach((button)=>button.addEventListener('click',()=>{
    syncRankingScope(button.dataset.scope);
    nextCursor=null;
    load();
  }));
})();