// Start physics and model loading while the independent renderer graph downloads.
// Retain critical events and only the latest transient updates before UI handoff.
const query=new URLSearchParams(location.search),levels=[.3,2];
const level=(name,fallback)=>levels.includes(Number(query.get(name)))?Number(query.get(name)):fallback;
const config={mu:level('mu',.3),contextMu:level('context',.3)};
if(query.get('motion'))config.motionId=query.get('motion');
const probeMode=query.get('startup-test'),workerURL=new URL('./worker-v9.js?v=20261113-recovery',import.meta.url);
if(probeMode){workerURL.searchParams.set('startup-test',probeMode);import('./startup-diagnostics.js').catch(()=>{});}
let worker=null,attached=false,failure=null,sequence=0;
const events=new Map();
function showFailure(error){
  if(failure)return;
  failure=error;worker?.terminate();
  const text=String(error),get=id=>document.getElementById(id),startup=get('startup'),loader=get('loader');
  if(startup){startup.hidden=false;startup.classList.add('failed');}
  if(loader){loader.hidden=false;loader.classList.add('failed');}
  for(const id of ['loading-spinner','startup-progress','startup-percent']){const element=get(id);if(element)element.hidden=true;}
  for(const [id,value] of [['loader-title','Unable to load experiment'],['startup-title','Unable to load experiment'],['loading-text',text],['status',text]]){const element=get(id);if(element)element.textContent=value;}
  document.querySelectorAll('button,select,input').forEach(element=>element.disabled=element.id!=='retry-loading');
  const retry=get('retry-loading');if(retry){retry.hidden=false;retry.disabled=false;retry.onclick=()=>location.reload();}
}
function buffer(type,event){
  const message=event.data,transient=type==='message'&&['state','status','load-progress'].includes(message.type);
  const key=transient?(message.type==='load-progress'?`progress:${message.asset}`:message.type):`event:${sequence++}`;
  // Move a replaced update to its latest arrival position. Critical events keep
  // their order and transferred scene buffers are never copied or discarded.
  events.delete(key);events.set(key,[type,event]);
}
window.echoStartup={get worker(){return worker;},get error(){return failure;},config,startedAt:performance.now(),fail:showFailure,attach(onMessage,onError){
  if(attached)return;
  attached=true;
  if(worker){worker.onmessage=onMessage;worker.onerror=onError;}
  for(const [type,event] of events.values()) (type==='message'?onMessage:onError)(event);
  events.clear();
}};
try{
  worker=new Worker(workerURL,{type:'module'});
  worker.onmessage=event=>{if(event.data.type==='error')showFailure(event.data.message);buffer('message',event);};
  worker.onerror=event=>{event.preventDefault();showFailure(event.message||'Simulation worker failed');buffer('error',event);};
  worker.postMessage({type:'init',config});
}catch(error){showFailure(error);}
if(!failure)import('./lab-v9.js?v=20261113-recovery').catch(showFailure);
