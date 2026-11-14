import {Viewer,colors,policyName} from './renderer.js?v=20261113-recovery';
import {summarize} from './metrics.js';
const $=id=>document.getElementById(id),startup=window.echoStartup,pending=new Map();
let worker=startup?.worker??null,constructionError=startup?.error??null;
if(!startup){try{worker=new Worker('./worker-v9.js?v=20261113-recovery',{type:'module'});}catch(error){constructionError=error;}}
const startedAt=performance.now(),assetProgress=new Map();let scenePrepared=Promise.resolve(),hasLoadPlan=false;
const setText=(id,text)=>{const el=$(id);if(el&&el.textContent!==text)el.textContent=text;};
function loadingProgress(){if(fatalError)return;const rows=[...assetProgress.values()],total=rows.reduce((n,a)=>n+a.total,0),loaded=rows.reduce((n,a)=>n+Math.min(a.loaded,a.total),0);if(!total)return;const percent=Math.min(100,Math.floor(loaded/total*100));$('startup-progress').value=percent;setText('startup-percent',percent===100?'Initializing…':`${percent}%`);setText('startup-title',percent===100?'Preparing controllers and context':'Loading experiment assets');}
const levels=[.3,2],query=new URLSearchParams(location.search),viewer=new Viewer($('render-surface'),$('panels'));
viewer.setFollow(true);
const selectedLevel=(key,fallback)=>levels.includes(Number(query.get(key)))?Number(query.get(key)):fallback;
let config={mu:selectedLevel('mu',.3),contextMu:selectedLevel('context',.3)},experiment,motion,ready=false,controllers=false,scene=false,preparing=false,mutating=false,fatalError=null,runRevision=0,selectionRevision=0,lastMetrics=0,state=null,result=null,lanes=['PRE','N'].map(label=>({label,trace:[],summary:summarize([])})),nextId=1;
if(query.get('motion'))config.motionId=query.get('motion');
const call=(type,extra={})=>new Promise((resolve,reject)=>{if(fatalError||!worker){reject(new Error(fatalError||'Simulation worker unavailable'));return;}const id=nextId++;pending.set(id,{resolve,reject});try{worker.postMessage({type,id,...extra});}catch(error){pending.delete(id);reject(error);}});
window.lab={ready:false,errors:[],call,get state(){return {config,ready,controllers,preparing,mutating,progress:state,result,lanes,motion};},get renderer(){return viewer.renderer?'WebGL2':'Canvas2D';},get rendering(){return {gpu:viewer.gpu,meshes:viewer.data?.geoms.length,drawMs:viewer.drawMs,frameIntervalMs:viewer.frameInterval,softwareRendering:viewer.softwareRendering,scissorEnabled:viewer.gl?.isEnabled(viewer.gl.SCISSOR_TEST)??null,camera:viewer.camera.position.toArray(),target:viewer.controls.target.toArray()};}};
function fail(e){
  if(fatalError)return;
  const text=String(e);fatalError=text;ready=false;controllers=false;preparing=false;mutating=false;window.lab.ready=false;window.lab.errors.push(text);worker?.terminate();startup?.fail(e);
  $('startup').hidden=false;$('startup').classList.add('failed');$('loader').hidden=false;$('loader').classList.add('failed');
  for(const id of ['loading-spinner','startup-progress','startup-percent']){const element=$(id);if(element)element.hidden=true;}
  setText('loader-title','Unable to load experiment');setText('startup-title','Unable to load experiment');setText('status',text);setText('loading-text',text);
  const retry=$('retry-loading');if(retry){retry.hidden=false;retry.onclick=()=>location.reload();}
  for(const request of pending.values())request.reject(new Error(text));pending.clear();enable();
}
function enable(){
  if(fatalError){document.querySelectorAll('button,select,input').forEach(element=>element.disabled=element.id!=='retry-loading');return;}
  const running=state?.mode==='running',locked=running||mutating;
  $('run').disabled=!ready||preparing||locked||state?.mode!=='standing'||state?.paused||state?.steps<3;
  $('reset').disabled=!scene||mutating;
  $('motion').disabled=!ready||locked;
  document.querySelectorAll('[data-mu],[data-context]').forEach(b=>b.disabled=!ready||locked);
  $('pause').disabled=!controllers||mutating||!['standing','running'].includes(state?.mode);
  $('timeline').disabled=!result||locked;
}
function setup(){
  document.querySelectorAll('[data-mu]').forEach(b=>{const active=Number(b.dataset.mu)===config.mu;b.classList.toggle('selected',active);b.setAttribute('aria-pressed',String(active));});
  document.querySelectorAll('[data-context]').forEach(b=>{const active=Number(b.dataset.context)===config.contextMu;b.classList.toggle('selected',active);b.setAttribute('aria-pressed',String(active));});
  const displayed=state?.mode==='complete'?state.config:config;
  $('condition-label').textContent=`μ = ${displayed.mu.toFixed(1)} · context μ = ${displayed.contextMu.toFixed(1)}`;
  if(motion)$('motion').value=motion.id;
  drawChart();enable();
}
function clear(){result=null;lanes.forEach(l=>{l.trace=[];l.summary=summarize([]);});$('timeline').value=0;$('speed').textContent='— ×';renderTable();drawChart();}
function renderTable(){
  const active=state?.mode==='running',complete=state?.mode==='complete';
  $('summary').innerHTML=lanes.map((l,i)=>{const s=l.summary;return `<tr><td><span class="swatch" style="--color:${colors[i]}"></span>${policyName(l.label)}${i?` ← ${(state?.config.contextMu??config.contextMu).toFixed(1)}`:''}</td><td>${s.world===null?'—':s.world.toFixed(1)}</td><td>${s.local===null?'—':s.local.toFixed(1)}</td></tr>`;}).join('');
  [...$('panels').children].forEach((el,i)=>{const s=lanes[i].summary;el.querySelector('.lane-stat').innerHTML=`${s.world===null?'—':s.world.toFixed(1)}<small>mm mean</small>`;
    el.querySelector('.lane-protocol').textContent=active||complete?(i?`Same-motion context stream · μ = ${state.config.contextMu.toFixed(1)}`:'Frozen tracker'):'Standing · frozen tracker';
    const status=el.querySelector('.lane-state');status.textContent=complete?(s.success?'Success · held':'Failure · held'):state?.paused?'Paused':active?(state.index<motion.transitionFrames?'Entering motion':'Running'):controllers?'Standing online':'Loading controller';status.classList.toggle('failed',s.failureFrame!==null);});
}
function drawChart(){
  const canvas=$('chart'),w=canvas.clientWidth,h=canvas.clientHeight,dpr=Math.min(devicePixelRatio,2);if(!w||!h)return;const pw=Math.round(w*dpr),ph=Math.round(h*dpr);if(canvas.width!==pw||canvas.height!==ph){canvas.width=pw;canvas.height=ph;}const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
  const left=38,right=w-10,top=10,bottom=h-22,maximum=Math.max(200,...lanes.map(l=>l.trace.reduce((v,t)=>Math.max(v,t.world),0))),max=Math.ceil(maximum/200)*200,seconds=(state&&['running','complete'].includes(state.mode)?experiment.motions.find(m=>m.id===state.config.motionId)?.seconds:motion?.seconds)??5.24;
  ctx.font='11px Inter, sans-serif';ctx.fillStyle='#6e6e73';ctx.strokeStyle='#e7e7ec';
  for(let i=0;i<=4;i++){const y=bottom-(bottom-top)*i/4;ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(right,y);ctx.stroke();ctx.fillText(String(Math.round(max*i/4)),0,y+3);ctx.textAlign=i===4?'right':'center';ctx.fillText(`${(seconds*i/4).toFixed(1)}s`,left+(right-left)*i/4,h-5);ctx.textAlign='left';}
  lanes.forEach((l,i)=>{ctx.strokeStyle=colors[i];ctx.lineWidth=1.8;ctx.beginPath();l.trace.forEach((t,j)=>{const x=left+(right-left)*t.time/seconds,y=bottom-(bottom-top)*t.world/max;j?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.stroke();});
}
new ResizeObserver(drawChart).observe($('chart'));
function update(m){
  const previous=state;state=m;if(m.mode==='running'&&window.lab.lastRunUi){const t=window.lab.lastRunUi;if(t.firstStateMs===null)t.firstStateMs=performance.now()-t.clickedAt;if(m.index>0&&t.firstProgressMs===null)t.firstProgressMs=performance.now()-t.clickedAt;}if(m.mode==='standing'&&m.steps===0)clear();window.lab.last=m;if(m.mode==='running'&&previous?.mode!=='running'){$('timeline').min=1;$('timeline').max=motion.frames-1;$('timeline').value=1;}viewer.update(m.lanes.map(l=>l.pose));if(m.mode==='running'&&previous?.mode!=='running')viewer.fit();
  m.lanes.forEach((l,i)=>{if(l.sample&&lanes[i].trace.at(-1)?.frame!==l.sample.frame)lanes[i].trace.push(l.sample);lanes[i].summary=l.summary;});
  setText('pause',m.paused?'Resume':'Pause');
  if(m.mode==='standing'){$('clock').textContent=`Standing · ${m.time.toFixed(1)} s`;$('status').textContent=preparing?'Preparing the selected motion and context; standing continues…':!controllers?'Loading and compiling controllers…':!ready?'Standing online. Preparing verified context stream…':m.paused?'Standing paused. Resume before starting a motion.':'Standing online. Choose a motion and context, then Run.';}
  else if(m.mode==='running'){$('clock').textContent=m.index<m.transitionFrames?`Entry · ${(m.index*.02).toFixed(2)} / 1.00 s`:`${((m.index-m.transitionFrames)*.02).toFixed(2)} / ${motion.seconds.toFixed(2)} s`;$('status').textContent=m.paused?'Paused. Physical state is preserved.':m.index<m.transitionFrames?'Transitioning from standing into the reference motion…':`Running ${motion.name} · ${m.index-m.transitionFrames}/${motion.frames-1} scored frames`;$('speed').textContent=`${m.speed.toFixed(2)} ×`;$('timeline').value=Math.max(1,m.index-m.transitionFrames);}
  else if(m.mode==='complete'){$('clock').textContent=`${motion.seconds.toFixed(2)} / ${motion.seconds.toFixed(2)} s`;$('status').textContent='Motion complete. Final scene held for inspection. Reset to stand again.';}
  else $('status').textContent='Standing lost support. Final scene held; use Reset.';
  if(previous?.mode!==m.mode||previous?.paused!==m.paused||performance.now()-lastMetrics>100){lastMetrics=performance.now();renderTable();if(m.mode!=='standing')drawChart();}enable();
  if(m.mode==='complete'&&previous?.mode!=='complete'){const token=runRevision;call('export').then(r=>{if(token===runRevision&&state.mode==='complete'){result=r;enable();}}).catch(fail);}
}
if(worker){worker.onerror=e=>{e.preventDefault?.();fail(e.message||'Simulation worker failed');};worker.onmessage=({data:m})=>{handleMessage(m).catch(fail);};}
async function handleMessage(m){
  if(fatalError)return;
  if(m.type==='reply'){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(new Error(m.error)):p.resolve(m.result);}return;}
  if(m.type==='scene'){experiment=m.experiment;config=m.config;motion=experiment.motions.find(x=>x.id===config.motionId);scenePrepared=viewer.model(m.model,{yieldBatches:true}).then(()=>{if(fatalError)return;viewer.setup(['PRE','N']);scene=true;$('loader').hidden=true;});await scenePrepared;if(fatalError)return;
    $('motion').replaceChildren(...experiment.motions.map(m=>{const o=document.createElement('option');o.value=m.id;o.textContent=m.name;return o;}));
    $('legend').innerHTML=['ECHO-PRE','ECHO-N'].map((s,i)=>`<span style="--color:${colors[i]}"><i></i>${s}</span>`).join('');setup();}
  else if(m.type==='status'){$('loading-text').textContent=m.text;if(!controllers)$('status').textContent=m.text;}
  else if(m.type==='controllers'){controllers=true;enable();}
  else if(m.type==='ready'){await scenePrepared;if(fatalError)return;ready=true;window.lab.ready=true;$('startup').hidden=true;$('startup').dataset.startupMs=performance.now().toFixed(1);$('startup').dataset.bootstrapMs=startedAt.toFixed(1);if(startup)$('startup').dataset.workerStartMs=startup.startedAt.toFixed(1);enable();}
  else if(m.type==='bank'){$('bank-info').textContent=`Verified · μ ${m.sourceMu.toFixed(1)} · 350 warmup steps · ${m.frames-1} motion steps`;window.lab.bank=m;}
  else if(m.type==='state'){await scenePrepared;if(!fatalError)update(m);}
  else if(m.type==='load-plan'){for(const a of m.assets)assetProgress.set(a.asset,{total:a.total,loaded:assetProgress.get(a.asset)?.loaded??0});hasLoadPlan=true;loadingProgress();}
  else if(m.type==='load-progress'){const a=assetProgress.get(m.asset);if(a){a.loaded=m.loaded;if(hasLoadPlan)loadingProgress();}else if(!hasLoadPlan)assetProgress.set(m.asset,{total:m.total,loaded:m.loaded});}
  else if(m.type==='startup-timing'){$('startup').dataset.workerTiming=JSON.stringify(m);}
  else if(m.type==='error')fail(m.message);
};
async function change(patch){
  if(fatalError||mutating||state?.mode==='running')return;const token=++selectionRevision;config={...config,...patch};motion=experiment.motions.find(x=>x.id===config.motionId);preparing=true;setup();
  try{await call('configure',{config});}catch(e){fail(e);}finally{if(!fatalError&&token===selectionRevision){preparing=false;setup();if(state?.mode==='complete')$('status').textContent='New setup selected. The displayed result is still the completed run; Reset before starting again.';}}
}
document.querySelectorAll('[data-mu]').forEach(b=>b.onclick=()=>change({mu:Number(b.dataset.mu)}));
document.querySelectorAll('[data-context]').forEach(b=>b.onclick=()=>change({contextMu:Number(b.dataset.context)}));
$('motion').onchange=()=>change({motionId:$('motion').value});
$('run').onclick=async()=>{if($('run').disabled)return;window.lab.lastRunUi={clickedAt:performance.now(),firstStateMs:null,firstProgressMs:null};runRevision++;mutating=true;clear();window.lab.lastRunUi.clearMs=performance.now()-window.lab.lastRunUi.clickedAt;enable();window.lab.lastRunUi.beforePostMs=performance.now()-window.lab.lastRunUi.clickedAt;try{const request=call('start');window.lab.lastRunUi.postedMs=performance.now()-window.lab.lastRunUi.clickedAt;window.lab.lastStart=await request;window.lab.lastRunUi.ackMs=performance.now()-window.lab.lastRunUi.clickedAt;window.lab.lastRunUi.workerBoundaryMs=window.lab.lastStart.startLatencyMs;}catch(e){fail(e);}finally{mutating=false;enable();}};
$('reset').onclick=async()=>{if($('reset').disabled)return;runRevision++;mutating=true;enable();try{clear();window.lab.lastReset=await call('reset');viewer.fit();setup();}catch(e){fail(e);}finally{mutating=false;enable();}};
$('pause').onclick=async()=>{if($('pause').disabled)return;try{await call(state.paused?'resume':'pause');}catch(e){fail(e);}};
$('follow').onchange=()=>viewer.setFollow($('follow').checked);
$('fit').onclick=()=>viewer.fit();
$('ghost').onchange=()=>{viewer.ghost=$('ghost').checked;viewer.dirty=true;};
$('timeline').oninput=async()=>{if(!result)return;const token=runRevision,frame=Number($('timeline').value);try{const poses=await Promise.all(result.lanes.map(l=>{const t=l.trace.find(t=>t.frame===frame);return call('pose',{qpos:t.qpos,frame});}));if(token===runRevision){viewer.update(poses);$('clock').textContent=`${(frame*.02).toFixed(2)} / ${result.motion.seconds.toFixed(2)} s`;}}catch(e){fail(e);}};
// Reuse the early worker and replay its messages only after UI setup is complete.
// A direct module entry retains the original self-contained initialization path.
if(constructionError)fail(constructionError);
if(startup&&worker)startup.attach(worker.onmessage,worker.onerror);
else if(worker&&!fatalError)call('init',{config}).catch(fail);
