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

  function sampledGapThreshold(dates){
    const times=dates.map(dateTimestamp);
    const gaps=times.slice(1).map((time,index)=>time!=null&&times[index]!=null?time-times[index]:null).filter(value=>value>0).sort((a,b)=>a-b);
    const median=gaps.length?gaps[Math.floor(gaps.length/2)]:0;
    const base=currentMode==='daily'?1.5*86400000:currentMode==='monthly'?45*86400000:10*86400000;
    return Math.max(base,median*2.5);
  }

  function drawSummary(rows,selectedIndex=null){
    const {ctx,width,height}=prepareCanvas();
    const sorted=[...rows].sort((a,b)=>(dateTimestamp(rowDate(a))||0)-(dateTimestamp(rowDate(b))||0));
    const sampled=sampleRows(sorted);
    const dates=sampled.map(rowDate);
    const times=dates.map(dateTimestamp);
    const gapThreshold=sampledGapThreshold(dates);
    const active=METRICS.filter(([key])=>sampled.some(row=>finiteNumber(row[key])!=null));
    if(!sampled.length||!active.length)return drawEmpty(ctx,width,height);

    const area={left:42,right:18,top:18,bottom:42};
    area.width=Math.max(1,width-area.left-area.right);
    area.height=Math.max(1,height-area.top-area.bottom);
    drawGrid(ctx,width,height,area);
    const xs=makeXPositions(dates,area);
    drawDateAxis(ctx,dates,xs,width,height,area);

    const series=active.map(([key,label,alpha,lineWidth],i)=>{
      const values=sampled.map(row=>finiteNumber(row[key]));
      const valid=values.filter(value=>value!=null);
      const min=Math.min(...valid),max=Math.max(...valid),range=max-min||1;
      ctx.save();
      ctx.globalAlpha=alpha;
      ctx.strokeStyle=COLORS[i%COLORS.length];
      ctx.lineWidth=lineWidth;
      ctx.beginPath();
      let open=false;
      values.forEach((value,index)=>{
        if(value==null){open=false;return;}
        const y=area.top+area.height-(value-min)/range*area.height;
        const gap=index>0&&times[index]!=null&&times[index-1]!=null&&times[index]-times[index-1]>gapThreshold;
        if(!open||gap)ctx.moveTo(xs[index],y);else ctx.lineTo(xs[index],y);
        open=true;
      });
      ctx.stroke();
      ctx.restore();
      return{key,label,color:COLORS[i%COLORS.length],alpha};
    });

    const selected=Number.isInteger(selectedIndex)&&sampled[selectedIndex]?selectedIndex:null;
    if(selected!=null)drawSelection(ctx,xs[selected],area);
    chartState={type:'multi-summary',rows:sampled,dates,xPositions:xs,series,selectedIndex:selected};
    setChartRange(dates);
    $('#chartLegend').innerHTML=series.map(item=>`<span style="opacity:${item.alpha}"><i style="background:${item.color}"></i>${escapeHtml(item.label)}</span>`).join('');
    if(selected!=null){
      const row=sampled[selected];
      $('#chartDetail').innerHTML=`<time>${escapeHtml(formatDate(dates[selected]))}</time><div class="chart-detail-values">${series.map(item=>`<div style="opacity:${item.alpha}"><i style="background:${item.color}"></i><strong>${escapeHtml(item.label)}</strong><span>${fmt(row[item.key])}</span></div>`).join('')}</div>`;
    }
  }

  draw=function(rows,metric,selected){return ['daily','weekly','monthly'].includes(currentMode)?drawSummary(rows,selected):baseDraw(rows,metric,selected);};
  setMode=function(mode){baseSetMode(mode);if(['daily','weekly','monthly'].includes(mode)){$('#metric').hidden=true;$('#metric').disabled=true;$('#chartTitle').textContent='主要指標の推移';$('#chartFoot').textContent='平均同接と再生数増加を強調表示。各指標は個別スケールです。';}};
  function selectPoint(event){if(chartState?.type!=='multi-summary')return;event.stopImmediatePropagation();const rect=$('#chart').getBoundingClientRect();const x=(event.touches?.[0]?.clientX??event.clientX)-rect.left;const index=nearestIndex(chartState.xPositions,x);if(index==null)return;selectedChartIndex=index;drawSummary(current,index);}
  $('#chart').addEventListener('click',selectPoint,true);
  $('#chart').addEventListener('touchstart',selectPoint,{capture:true,passive:true});
  setTimeout(()=>{if(['daily','weekly','monthly'].includes(currentMode)&&current.length){$('#metric').hidden=true;$('#metric').disabled=true;$('#chartTitle').textContent='主要指標の推移';drawSummary(current);}},0);
})();
