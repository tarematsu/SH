(() => {
  const baseDraw = draw;
  const baseSetMode = setMode;
  const METRICS = [
    ['listener_avg','平均同接'],['listener_min','最小同接'],['listener_max','最大同接'],
    ['stream_growth','再生数増加'],['member_start','メンバー開始'],['member_end','メンバー終了'],
    ['member_growth','メンバー増加'],['likes_max','最大いいね'],['distinct_tracks','曲数'],
  ];
  const COLORS = ['#f6c7d9','#9c7bf4','#7ee787','#ffb86b','#7ad7ff','#ffd866','#ff7eb6','#b4f8c8','#a0c4ff'];

  function drawSummary(rows, selectedIndex = null) {
    const { ctx, width, height } = prepareCanvas();
    const sorted = [...rows].sort((a,b)=>(dateTimestamp(rowDate(a))||0)-(dateTimestamp(rowDate(b))||0));
    const sampled = sampleRows(sorted);
    const dates = sampled.map(rowDate);
    const activeMetrics = METRICS.filter(([key]) => sampled.some((row) => finiteNumber(row[key]) != null));
    if (!sampled.length || !activeMetrics.length) return drawEmpty(ctx,width,height);
    const area={left:42,right:18,top:18,bottom:42}; area.width=Math.max(1,width-area.left-area.right); area.height=Math.max(1,height-area.top-area.bottom);
    drawGrid(ctx,width,height,area); const xs=makeXPositions(dates,area); drawDateAxis(ctx,dates,xs,width,height,area);
    const series=activeMetrics.map(([key,label],index)=>{
      const values=sampled.map((row)=>finiteNumber(row[key])); const valid=values.filter((v)=>v!=null); const min=Math.min(...valid); const max=Math.max(...valid); const range=max-min||1;
      ctx.strokeStyle=COLORS[index%COLORS.length]; ctx.lineWidth=1.8; ctx.beginPath(); let open=false;
      values.forEach((value,i)=>{ if(value==null){open=false;return;} const y=area.top+area.height-(value-min)/range*area.height; const gap=i>0&&isTemporalGap(dates[i-1],dates[i],currentMode); if(!open||gap)ctx.moveTo(xs[i],y);else ctx.lineTo(xs[i],y);open=true; }); ctx.stroke();
      return {key,label,color:COLORS[index%COLORS.length],values};
    });
    const selected=Number.isInteger(selectedIndex)&&sampled[selectedIndex]?selectedIndex:null; if(selected!=null) drawSelection(ctx,xs[selected],area);
    chartState={type:'multi-summary',rows:sampled,dates,xPositions:xs,series,selectedIndex:selected}; setChartRange(dates);
    $('#chartLegend').innerHTML=series.map((s)=>`<span><i style="background:${s.color}"></i>${escapeHtml(s.label)}</span>`).join('');
    if(selected!=null){const row=sampled[selected];$('#chartDetail').innerHTML=`<time>${escapeHtml(formatDate(dates[selected]))}</time><div class="chart-detail-values">${series.map((s)=>`<div><i style="background:${s.color}"></i><strong>${escapeHtml(s.label)}</strong><span>${fmt(row[s.key])}</span></div>`).join('')}</div>`;}
  }

  draw = function drawAllMetrics(rows, metric, selected) {
    if (['daily','weekly','monthly'].includes(currentMode)) return drawSummary(rows, selected);
    return baseDraw(rows, metric, selected);
  };

  setMode = function setModeAllMetrics(mode) {
    baseSetMode(mode);
    if (['daily','weekly','monthly'].includes(mode)) {
      $('#metric').hidden = true; $('#metric').disabled = true;
      $('#chartTitle').textContent = '全指標の推移';
      $('#chartFoot').textContent = '総再生数は除外。各指標は個別スケールで推移を比較します。';
    }
  };

  const basePointer = handleChartPointer;
  handleChartPointer = function handleMultiPointer(event) {
    if (chartState?.type !== 'multi-summary') return basePointer(event);
    const rect=$('#chart').getBoundingClientRect(); const x=(event.touches?.[0]?.clientX??event.clientX)-rect.left; const index=nearestIndex(chartState.xPositions,x); if(index==null)return; selectedChartIndex=index; drawSummary(current,index);
  };
})();