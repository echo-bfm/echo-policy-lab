// Opt-in startup measurement. The fragment stays in this tab; no telemetry is sent.
const mode=new URLSearchParams(location.search).get('startup-test');
if(mode){
  const target=document.getElementById('loading')??document.getElementById('startup');
  let completed=false;
  const report=()=>{
    if(completed||!target)return;
    const ready=Number(target.dataset.readyMs??target.dataset.startupMs);
    if(!Number.isFinite(ready)||ready<=0)return;
    const timing=JSON.parse(target.dataset.workerTiming??'{}'),assets=timing.assets??{};
    const result={mode,readyMs:Math.round(ready),workerMs:Math.round(timing.totalMs??0),cacheHits:assets.cacheHits??0,cacheMisses:assets.cacheMisses??0,cacheWriteFailures:assets.cacheWriteFailures??0};
    completed=true;observer.disconnect();
    history.replaceState(null,'',location.pathname+location.search+'#startup-result='+encodeURIComponent(JSON.stringify(result)));
  };
  const observer=new MutationObserver(report);
  if(target)observer.observe(target,{attributes:true,attributeFilter:['data-ready-ms','data-startup-ms','data-worker-timing']});
  report();
}
