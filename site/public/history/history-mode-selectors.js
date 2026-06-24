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

  function syncRankingScope(){
    const select=$('#rankingScope');
    if(select)select.value='featured';
    const host=$('#host');
    if(host)host.value='';
  }

  shouldShowRankingChart=()=>true;

  setMode=function(mode){
    baseSetMode(mode);
    const tracks=mode==='tracks';
    const ranking=mode==='ranking';
    const broadcasts=mode==='broadcasts';
    controls.hidden=ranking||broadcasts;
    controls.classList.toggle('track-mode',tracks);
    setStandardControlsVisible(!(tracks||ranking||broadcasts));
    trackControls.hidden=!tracks;
    if(rankingScopeTabs)rankingScopeTabs.hidden=true;
    loadButton.hidden=tracks||ranking||broadcasts;
    $('#rankingScopeWrap').hidden=true;
    $('#hostWrap').hidden=true;
    if(ranking)syncRankingScope();
  };

  load=async function(options={}){
    if(currentMode==='tracks'){
      await resolveLatestTrackDate();
      if(trackWeekMode.checked){$('#from').value=mondayOf(trackDate.value);$('#to').value=sundayOf(trackDate.value);}
      else{$('#from').value=trackDate.value;$('#to').value=trackDate.value;}
    }else if(currentMode==='ranking'){
      $('#from').value='2024-05-01';
      $('#to').value=todayUtc();
      syncRankingScope();
    }else if(currentMode==='broadcasts'){
      $('#from').value='2024-05-01';
      $('#to').value=todayUtc();
    }
    return baseLoad(options);
  };

  trackDate.addEventListener('change',()=>{nextCursor=null;load();});
  trackWeekMode.addEventListener('change',()=>{nextCursor=null;load();});
})();
