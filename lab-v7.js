import {Viewer,colors,policyName} from './renderer.js';
import {summarize} from './metrics.js';
const $=id=>document.getElementById(id),worker=new Worker('./worker-v7.js',{type:'module'}),pending=new Map();
const levels=[.3,2],query=new URLSearchParams(location.search),viewer=new Viewer($('render-surface'),$('panels'));
viewer.setFollow(true);
const selectedLevel=(key,fallback)=>levels.includes(Number(query.get(key)))?Number(query.get(key)):fallback;
let config={mu:selectedLevel('mu',.3),contextMu:selectedLevel('context',.3)},experiment,motion,ready=false,controllers=false,scene=false,preparing=false,mutating=false,runRevision=0,selectionRevision=0,lastMetrics=0,state=null,result=null,lanes=['PRE','N'].map(label=>({label,trace:[],summary:summarize([])})),nextId=1;
if(query.get('motion'))config.motionId=query.get('motion');
const call=(type,extra={})=>new Promise((resolve,reject)=>{const id=nextId++;pending.set(id,{resolve,reject});worker.postMessage({type,id,...extra});});
window.lab={ready:false,errors:[],call,get state(){return {config,ready,controllers,preparing,mutating,progress:state,result,lanes,motion};},get renderer(){return viewer.renderer?'WebGL2':'Canvas2D';},get rendering(){return {gpu:viewer.gpu,meshes:viewer.data?.geoms.length,drawMs:viewer.drawMs,frameIntervalMs:viewer.frameInterval,softwareRendering:viewer.softwareRendering,scissorEnabled:viewer.gl?.isEnabled(viewer.gl.SCISSOR_TEST)??null,camera:viewer.camera.position.toArray(),target:viewer.controls.target.toArray()};}};
function fail(e){const text=String(e);window.lab.errors.push(text);$('status').textContent=text;$('loading-text').textContent=text;mutating=false;enable();}
function enable(){
  const running=state?.mode==='running',locked=running||mutating;
  $('share').disabled=!scene;
  $('run').disabled=!ready||preparing||locked||state?.mode!=='standing'||state?.paused||state?.steps<3;
  $('reset').disabled=!scene||mutating;
  $('motion').disabled=!ready||locked;
  document.querySelectorAll('[data-mu],[data-context]').forEach(b=>b.disabled=!ready||locked);
  $('pause').disabled=!controllers||mutating||!['standing','running'].includes(state?.mode);
  $('json').disabled=$('csv').disabled=!result;
  $('timeline').disabled=!result||locked;
}
function setup(){
  document.querySelectorAll('[data-mu]').forEach(b=>{const active=Number(b.dataset.mu)===config.mu;b.classList.toggle('selected',active);b.setAttribute('aria-pressed',String(active));});
  document.querySelectorAll('[data-context]').forEach(b=>{const active=Number(b.dataset.context)===config.contextMu;b.classList.toggle('selected',active);b.setAttribute('aria-pressed',String(active));});
  const displayed=state?.mode==='complete'?state.config:config;
  $('condition-label').textContent=`μ = ${displayed.mu.toFixed(1)} · context μ = ${displayed.contextMu.toFixed(1)}`;
  if(motion){$('motion').value=motion.id;$('motion-info').textContent=`${motion.frames} frames · 50 Hz · ${motion.seconds.toFixed(2)} s · fixed motion start`;
    $('motion-notes').textContent=`Original candidate: ${motion.originalStrict?'strict tracking criterion passed':'see original limitations'}. These labels use the earlier protocol.\n${Array.isArray(motion.originalLimitations)?motion.originalLimitations.join('\n'):motion.originalLimitations??''}`;}
  drawChart();enable();
}
function clear(){result=null;lanes.forEach(l=>{l.trace=[];l.summary=summarize([]);});$('timeline').value=0;$('speed').textContent='— ×';$('sample-note').textContent='Idle standing is not scored. Run resets to reference frame 0.';renderTable();drawChart();}
function renderTable(){
  const active=state?.mode==='running',complete=state?.mode==='complete';
  $('summary').innerHTML=lanes.map((l,i)=>{const s=l.summary,outcome=s.complete?(s.success?'Success':'Tracking failed'):s.failureFrame!==null?'Failure detected':s.samples?'In progress':'Not run';return `<tr><td><span class="swatch" style="--color:${colors[i]}"></span>${policyName(l.label)}${i?` ← ${(state?.config.contextMu??config.contextMu).toFixed(1)}`:''}</td><td>${s.world===null?'—':s.world.toFixed(1)}</td><td>${s.local===null?'—':s.local.toFixed(1)}</td><td><span class="outcome ${s.failureFrame!==null?'fail':!s.complete?'pending':''}">${outcome}</span></td><td>${s.samples?(s.supportLoss?'Detected':'None'):'—'}</td></tr>`;}).join('');
  [...$('panels').children].forEach((el,i)=>{const s=lanes[i].summary;el.querySelector('.lane-stat').innerHTML=`${s.world===null?'—':s.world.toFixed(1)}<small>mm mean</small>`;
    el.querySelector('.lane-protocol').textContent=active||complete?(i?`Same-motion context stream · μ = ${state.config.contextMu.toFixed(1)}`:'Frozen tracker'):'Standing · frozen tracker';
    const status=el.querySelector('.lane-state');status.textContent=complete?(s.success?'Success · held':'Failure · held'):state?.paused?'Paused':active?(state.index<motion.transitionFrames?'Entering motion':'Running'):controllers?'Standing online':'Loading controller';status.classList.toggle('failed',s.failureFrame!==null);});
}
function drawChart(){
  const canvas=$('chart'),w=canvas.clientWidth,h=canvas.clientHeight,dpr=devicePixelRatio;if(!w||!h)return;canvas.width=w*dpr;canvas.height=h*dpr;const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);
  const left=38,right=w-10,top=10,bottom=h-22,maximum=Math.max(200,...lanes.map(l=>l.trace.reduce((v,t)=>Math.max(v,t.world),0))),max=Math.ceil(maximum/200)*200,seconds=(state&&['running','complete'].includes(state.mode)?experiment.motions.find(m=>m.id===state.config.motionId)?.seconds:motion?.seconds)??5.24;
  ctx.font='9px sans-serif';ctx.fillStyle='#899581';ctx.strokeStyle='#edf0e7';
  for(let i=0;i<=4;i++){const y=bottom-(bottom-top)*i/4;ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(right,y);ctx.stroke();ctx.fillText(String(Math.round(max*i/4)),0,y+3);ctx.fillText(`${(seconds*i/4).toFixed(1)}s`,left+(right-left)*i/4-8,h-5);}
  lanes.forEach((l,i)=>{ctx.strokeStyle=colors[i];ctx.lineWidth=1.8;ctx.beginPath();l.trace.forEach((t,j)=>{const x=left+(right-left)*t.time/seconds,y=bottom-(bottom-top)*t.world/max;j?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.stroke();});
}
new ResizeObserver(drawChart).observe($('chart'));
function update(m){
  const previous=state;state=m;if(m.mode==='running'&&window.lab.lastRunUi){const t=window.lab.lastRunUi;if(t.firstStateMs===null)t.firstStateMs=performance.now()-t.clickedAt;if(m.index>0&&t.firstProgressMs===null)t.firstProgressMs=performance.now()-t.clickedAt;}if(m.mode==='standing'&&m.steps===0)clear();window.lab.last=m;if(m.mode==='running'&&previous?.mode!=='running'){$('timeline').min=1;$('timeline').max=motion.frames-1;$('timeline').value=1;}viewer.update(m.lanes.map(l=>l.pose));if(m.mode==='running'&&previous?.mode!=='running')viewer.fit();
  m.lanes.forEach((l,i)=>{if(l.sample&&lanes[i].trace.at(-1)?.frame!==l.sample.frame)lanes[i].trace.push(l.sample);lanes[i].summary=l.summary;});
  $('pause').textContent=m.paused?'▶':'Ⅱ';
  if(m.mode==='standing'){$('clock').textContent=`Standing · ${m.time.toFixed(1)} s`;$('status').textContent=preparing?'Preparing the selected motion and context; standing continues…':!controllers?'Loading and compiling controllers…':!ready?'Standing online. Preparing verified context stream…':m.paused?'Standing paused. Resume before starting a motion.':'Standing online. Choose a motion and context, then Run.';}
  else if(m.mode==='running'){$('clock').textContent=m.index<m.transitionFrames?`Entry · ${(m.index*.02).toFixed(2)} / 1.00 s`:`${((m.index-m.transitionFrames)*.02).toFixed(2)} / ${motion.seconds.toFixed(2)} s`;$('status').textContent=m.paused?'Paused. Physical state is preserved.':m.index<m.transitionFrames?'Transitioning from standing into the reference motion…':`Running ${motion.name} · ${m.index-m.transitionFrames}/${motion.frames-1} scored frames`;$('speed').textContent=`${m.speed.toFixed(2)} ×`;$('timeline').value=Math.max(1,m.index-m.transitionFrames);}
  else if(m.mode==='complete'){$('clock').textContent=`${motion.seconds.toFixed(2)} / ${motion.seconds.toFixed(2)} s`;$('status').textContent='Motion complete. Final scene held for inspection. Reset to stand again.';$('sample-note').textContent=`${motion.frames-1} scored frames per policy · idle standing excluded · fixed initial state`;}
  else $('status').textContent='Standing lost support. Final scene held; use Reset.';
  if(previous?.mode!==m.mode||previous?.paused!==m.paused||performance.now()-lastMetrics>100){lastMetrics=performance.now();renderTable();if(m.mode!=='standing')drawChart();}enable();
  if(m.mode==='complete'&&previous?.mode!=='complete'){const token=runRevision;call('export').then(r=>{if(token===runRevision&&state.mode==='complete'){result=r;enable();}}).catch(fail);}
}
worker.onerror=e=>fail(e.message||'Simulation worker failed');
worker.onmessage=({data:m})=>{
  if(m.type==='reply'){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(new Error(m.error)):p.resolve(m.result);}return;}
  if(m.type==='scene'){experiment=m.experiment;config=m.config;motion=experiment.motions.find(x=>x.id===config.motionId);scene=true;viewer.model(m.model);viewer.setup(['PRE','N']);$('loader').hidden=true;
    $('motion').replaceChildren(...experiment.motions.map(m=>{const o=document.createElement('option');o.value=m.id;o.textContent=m.name;return o;}));
    $('legend').innerHTML=['ECHO-PRE','ECHO-N'].map((s,i)=>`<span style="--color:${colors[i]}"><i></i>${s}</span>`).join('');setup();}
  else if(m.type==='status'){$('loading-text').textContent=m.text;if(!controllers)$('status').textContent=m.text;}
  else if(m.type==='controllers'){controllers=true;enable();}
  else if(m.type==='ready'){ready=true;window.lab.ready=true;enable();}
  else if(m.type==='bank'){$('bank-info').textContent=`Verified · μ ${m.sourceMu.toFixed(1)} · 350 warmup steps · ${m.frames-1} motion steps`;window.lab.bank=m;}
  else if(m.type==='state')update(m);
  else if(m.type==='error')fail(m.message);
};
async function change(patch){
  if(mutating||state?.mode==='running')return;const token=++selectionRevision;config={...config,...patch};motion=experiment.motions.find(x=>x.id===config.motionId);preparing=true;setup();
  try{await call('configure',{config});}catch(e){fail(e);}finally{if(token===selectionRevision){preparing=false;setup();if(state?.mode==='complete')$('status').textContent='New setup selected. The displayed result is still the completed run; Reset before starting again.';}}
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
function download(name,data,type){const url=URL.createObjectURL(new Blob([data],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('json').onclick=()=>{if(result)download(`echo-${result.config.motionId}-mu${result.config.mu}-context${result.config.contextMu}.json`,JSON.stringify(result),'application/json');};
$('csv').onclick=()=>{if(!result)return;const rows=['motion_id,actual_mu,context_mu,policy,frame,time_s,world_mm,local_mm,custom_pass,strict_pass,low_pelvis'];for(const l of result.lanes)for(const t of l.trace)rows.push([result.config.motionId,result.config.mu,result.config.contextMu,l.policy,t.frame,t.time,t.world,t.local,t.custom,t.strict,t.low].join(','));download(`echo-${result.config.motionId}.csv`,rows.join('\n'),'text/csv');};
$('share').onclick=async()=>{const url=new URL(location.href);url.search='';url.searchParams.set('mu',config.mu);url.searchParams.set('context',config.contextMu);url.searchParams.set('motion',config.motionId);try{await navigator.clipboard.writeText(url.href);$('toast').textContent='Configuration copied. Opens a fresh experiment.';$('toast').classList.add('visible');setTimeout(()=>$('toast').classList.remove('visible'),2500);}catch{prompt('Copy configuration',url.href);}};
// Validate deep links before initializing the worker; an unknown motion falls
// back to the registered default, and only the two explicit levels survive.
fetch('./assets/experiment-v7.json',{cache:'no-store'}).then(r=>{if(!r.ok)throw new Error('Motion catalog unavailable');return r.json();}).then(e=>{if(!e.motions.some(m=>m.id===config.motionId))config.motionId=e.motions[0].id;return call('init',{config});}).catch(fail);
