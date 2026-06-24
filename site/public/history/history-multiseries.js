(() => {
  const baseDraw=draw,baseSetMode=setMode;
  const METRICS=[
    ['listener_avg','平均同接',1,2.6],
    ['stream_growth','再生数増加',1,2.6],
    ['listener_min','最小同接',0.38,1.2],
    ['listener_max','最大同接',0.38,1.2],
    ['member_growth','メンバー増加',0.38,1.2]
  ];
  const COLORS=['#f6c7d9','#9c7bf4','#7ee787','#ffb86b','#7ad7ff'];
  function drawSummary(rows,selectedIndex=null){
    const {ctx,width,height}=prepareCanvas();const sorted=[...rows].sort((a,b)=>(dateTimestamp(rowDate(a))||0)-(dateTimestamp(rowDate(b))||0));const sampled=sampleRows(sorted);const dates=sampled.map(rowDate);const active=METRICS.filter(([k])=>sampled.some(r=>finiteNumber(r[k])!=null));
    if(!sampled.length||!active.length)return drawEmpty(ctx,width,height);
    const area={left:42,right:18,top:18,bottom:42};area.width=Math.max(1,width-area.left-area.right);area.height=Math.max(1,height-area.top-area.bottom);drawGrid(ctx,width,height,area);const xs=makeXPositions(dates,area);drawDateAxis(ctx,dates,xs,width,height,area);
    const series=active.map(([key,label,alpha,lineWidth],i)=>{const values=sampled.map(r=>finiteNumber(r[key]));const valid=values.filter(v=>v!=null);const min=Math.min(...valid),max=Math.max(...valid),range=max-min||1;ctx.save();ctx.globalAlpha=alpha;ctx.strokeStyle=COLORS[i%COLORS.length];ctx.lineWidth=lineWidth;ctx.beginPath();let open=false;values.forEach((v,n)=>{if(v==null){open=false;return;}const y=area.top+area.height-(v-min)/range*area.height;const gap=n>0&&isTemporalGap(dates[n-1],dates[n],currentMode);if(!open||gap)ctx.moveTo(xs[n],y);else ctx.lineTo(xs[n],y);open=true;});ctx.stroke();ctx.restore();return{key,label,color:COLORS[i%COLORS.length],alpha};});
    const selected=Number.isInteger(selectedIndex)&&sampled[selectedIndex]?selectedIndex:null;if(selected!=null)drawSelection(ctx,xs[selected],area);chartState={type:'multi-summary',rows:sampled,dates,xPositions:xs,series,selectedIndex:selected};setChartRange(dates);$('#chartLegend').innerHTML=series.map(s=>`<span style="opacity:${s.alpha}"><i style="background:${s.color}"></i>${escapeHtml(s.label)}</span>`).join('');
    if(selected!=null){const row=sampled[selected];$('#chartDetail').innerHTML=`<time>${escapeHtml(formatDate(dates[selected]))}</time><div class="chart-detail-values">${series.map(s=>`<div style="opacity:${s.alpha}"><i style="background:${s.color}"></i><strong>${escapeHtml(s.label)}</strong><span>${fmt(row[s.key])}</span></div>`).join('')}</div>`;}
  }
  draw=function(rows,metric,selected){return ['daily','weekly','monthly'].includes(currentMode)?drawSummary(rows,selected):baseDraw(rows,metric,selected);};
  setMode=function(mode){baseSetMode(mode);if(['daily','weekly','monthly'].includes(mode)){$('#metric').hidden=true;$('#metric').disabled=true;$('#chartTitle').textContent='主要指標の推移';$('#chartFoot').textContent='平均同接と再生数増加を強調表示。各指標は個別スケールです。';}};
  function selectPoint(event){if(chartState?.type!=='multi-summary')return;event.stopImmediatePropagation();const rect=$('#chart').getBoundingClientRect();const x=(event.touches?.[0]?.clientX??event.clientX)-rect.left;const index=nearestIndex(chartState.xPositions,x);if(index==null)return;selectedChartIndex=index;drawSummary(current,index);}
  $('#chart').addEventListener('click',selectPoint,true);$('#chart').addEventListener('touchstart',selectPoint,{capture:true,passive:true});
  setTimeout(()=>{if(['daily','weekly','monthly'].includes(currentMode)&&current.length){$('#metric').hidden=true;$('#metric').disabled=true;$('#chartTitle').textContent='主要指標の推移';drawSummary(current);}},0);
})();