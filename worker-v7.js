import * as ort from './vendor/ort.wasm.bundle.min.mjs';
import {Engine} from './runtime.js';
import {json,hash} from './assets.js';
import {frameMetrics,summarize} from './metrics.js';
import {loadContextStream,contextHash} from './context-streams.js';

let engine,experiment,bank,bankHash,sessions,standingCache,lanes=[],selected=null,selectedStream=null,run=null,mode='loading',paused=false,generation=0,ticking=false,steps=0;
const streams=new Map(),motions=new Map(),send=(type,data={})=>postMessage({type,...data}),delay=(ms=0)=>new Promise(r=>setTimeout(r,ms));
const levels=[.3,2];
let config={mu:.3,contextMu:.3,motionId:null};
function validate(c){if(!levels.includes(c.mu)||!levels.includes(c.contextMu)||!experiment.motions.some(m=>m.id===c.motionId))throw new Error('Choose one of the two friction/context levels and a registered motion');}
async function infer(name,inputs){
  const feeds=Object.fromEntries(Object.entries(experiment.models[name].inputs).map(([key,shape])=>[key,new ort.Tensor('float32',inputs[key],shape)]));let output;
  try{output=await sessions[name].run(feeds);return Object.fromEntries(Object.entries(output).map(([key,t])=>[key,Float32Array.from(t.data)]));}
  finally{Object.values(feeds).forEach(t=>t.dispose());if(output)Object.values(output).forEach(t=>t.dispose());}
}
async function loadMotion(id){
  if(motions.has(id))return motions.get(id);
  const entry=experiment.motions.find(m=>m.id===id);if(!entry)throw new Error('Unknown motion');
  const p=(async()=>{const [qpos,cache,targets]=await Promise.all([engine.assets.array(entry.assetPrefix+'-qpos',Float64Array),engine.assets.array(entry.assetPrefix+'-cache'),engine.assets.array(entry.assetPrefix+'-targets')]);
    if(qpos.length!==entry.totalFrames*engine.config.nq||cache.length!==entry.totalFrames*experiment.referenceWidth||targets.length!==entry.frames*42)throw new Error('Motion asset dimensions disagree');return {...entry,qpos,cache,targets};})();
  motions.set(id,p);try{return await p;}catch(e){motions.delete(id);throw e;}
}
async function stop(){const token=++generation;while(ticking)await delay();return token;}
function elapsed(){if(!run)return 0;const end=run.finishedAt??(run.pauseAt??performance.now());return Math.max(0,end-run.startedAt-run.pausedMs);}
function snapshot(){
  const wallMs=elapsed(),motion=run?.motion,frame=run?.index??0,ghost=motion?motion.qpos.subarray(frame*engine.config.nq,(frame+1)*engine.config.nq):engine.standing.qpos;
  return {mode,paused,steps,time:steps*.02,appliedMu:engine.mu,config:{...(run?.config??config)},index:run?.index??0,total:motion?motion.totalFrames-1:0,transitionFrames:motion?.transitionFrames??0,
    speed:wallMs&&run?run.index*20/wallMs:0,elapsedMs:wallMs,startLatencyMs:run?.startLatencyMs??null,
    lanes:lanes.map(l=>({label:l.label,summary:summarize(l.trace,mode==='complete'),sample:l.trace.at(-1)??null,pose:engine.poseAt(l.env.data.qpos,ghost),qpos:Array.from(l.env.data.qpos),qvel:Array.from(l.env.data.qvel)}))};
}
function publish(){send('state',snapshot());}
async function tick(){
  const begin=performance.now(),active=mode==='running',i=run?.index??0,w=experiment.referenceWidth;
  if(!active&&engine.mu!==config.mu)engine.physics(config.mu);
  const cache=active?run.motion.cache.subarray(i*w,(i+1)*w):standingCache;
  for(const l of lanes){
    const obs=l.env.observe(engine.standing.reference);
    const output=await infer('tracker',{...obs,reference_cache:cache});
    let action=output[experiment.trackerAction],latent=null;
    if(active&&l.label==='N'){
      run.stream.at(i,obs);
      latent=(await infer('encoder',obs)).context_latent;
      action=(await infer('residual',{...output,context_latent:latent,previous_latents:obs.previous_latents})).action;
      const expected=run.stream.latent(i);
      run.contextTrace.push({command:i,shortCount:obs.short_valid.reduce((n,v)=>n+v,0),longCount:obs.long_valid.reduce((n,v)=>n+v,0),
        contextSha256:await contextHash(obs),longIndices:run.stream.longIndices(i),latent:Array.from(latent),previous:Array.from(obs.previous_latents),
        donorLatentMaxError:latent.reduce((m,v,j)=>Math.max(m,Math.abs(v-expected[j])),0)});
    }
    const appliedAction=l.env.advance(action,latent,{warmup:!active});
    if(active&&i<run.motion.transitionFrames)l.entry.push({step:i+1,time:(i+1)*.02,qpos:Array.from(l.env.data.qpos),qvel:Array.from(l.env.data.qvel)});
    if(active&&i>=run.motion.transitionFrames){
      const frame=i+1-run.motion.transitionFrames,positions=new Float32Array(42);
      engine.config.bodyIds.forEach((id,j)=>positions.set(l.env.data.xpos.subarray(id*3,id*3+3),j*3));
      const reference=run.motion.targets.subarray(frame*42,(frame+1)*42);
      l.trace.push({frame,time:frame*.02,...frameMetrics(positions,reference),qpos:Array.from(l.env.data.qpos),positions:Array.from(positions),appliedAction:Array.from(appliedAction)});
    }
  }
  steps++;
  if(active){run.index++;run.computeMs+=performance.now()-begin;if(run.index===run.motion.totalFrames-1){mode='complete';run.finishedAt=performance.now();}}
  else if(lanes.some(l=>l.env.data.qpos[2]<.3))mode='standing-failed';
  publish();
}
async function loop(){
  if(ticking||paused||!controllersReady||!['standing','running'].includes(mode))return;
  ticking=true;const token=generation;
  try{while(token===generation&&!paused&&['standing','running'].includes(mode)){const begin=performance.now();await tick();await delay(Math.max(0,20-(performance.now()-begin)));}}
  catch(e){mode='error';send('error',{message:String(e),stack:e.stack});}
  finally{ticking=false;}
}
async function reset(){
  const token=await stop();if(token!==generation)return;
  lanes.forEach(l=>l.env.dispose());engine.physics(config.mu);run=null;steps=0;paused=false;
  lanes=['PRE','N'].map(label=>({label,env:engine.environment(label,[],{standing:true,memory:false}),trace:[],entry:[]}));mode='standing';publish();const initial=snapshot();loop();return initial;
}
async function configure(c){
  validate(c);if(mode==='running')throw new Error('Reset before changing a running experiment');
  // Prefetch while the standing controller continues to tick. Commit only the
  // latest selection, and leave a completed experiment's scene untouched.
  const request=++configureRevision;config={...c};const [motion,stream]=await Promise.all([loadMotion(c.motionId),loadStream(c.motionId,c.contextMu)]);
  if(request!==configureRevision)return {stale:true};
  selected=motion;selectedStream=stream;
  send('bank',{hash:bankHash,motionName:motion.name,sourceMu:stream.meta.mu,warmupSteps:350,frames:stream.meta.frames});
  send('configured',{config:{...config},motion:experiment.motions.find(m=>m.id===c.motionId)});return {ready:true};
}
let configureRevision=0,controllersReady=false;
async function start(){
  const requested=performance.now();validate(config);
  if(mode!=='standing'||paused||!sessions||!bank||selected?.id!==config.motionId||selectedStream?.meta.motionId!==config.motionId||selectedStream?.meta.mu!==config.contextMu)throw new Error('Wait for standing and selected motion to be ready; Reset after a completed run');
  const token=await stop();if(token!==generation)return;
  engine.physics(config.mu);lanes.forEach(l=>{l.env.memory=false;l.env.reset([],{qpos:selected.initialQpos,qvel:selected.initialQvel});});
  run={config:{...config},motion:selected,stream:selectedStream,index:0,computeMs:0,contextTrace:[],standingSteps:steps,
    initial:lanes.map(l=>({label:l.label,qpos:Array.from(l.env.data.qpos),qvel:Array.from(l.env.data.qvel),history:Array.from(l.env.history),firstObservation:l.env.first,previousAction:Array.from(l.env.prev),previousLatents:Array.from(l.env.latents),shortCount:l.env.short.length,time:l.env.data.time,control:Array.from(l.env.data.ctrl),actuatorForce:Array.from(l.env.data.actuator_force),qaccWarmstart:Array.from(l.env.data.qacc_warmstart)})),startLatencyMs:performance.now()-requested,startedAt:performance.now(),pausedMs:0,pauseAt:null,finishedAt:null};
  lanes.forEach(l=>{l.trace=[];l.entry=[];});mode='running';paused=false;publish();loop();return {startLatencyMs:run.startLatencyMs};
}
async function loadBank(){
  const raw=await fetch('./assets/context-streams-v7.json',{cache:'no-store'});if(!raw.ok)throw new Error(`Context streams unavailable (${raw.status})`);
  const bytes=new Uint8Array(await raw.arrayBuffer()),candidate=JSON.parse(new TextDecoder().decode(bytes));
  if(candidate.schema!==1||candidate.kind!=='same-motion-causal-context-streams'||candidate.aggregation!=='none'||candidate.warmupSteps!==350||candidate.policySha256!==experiment.sourcePolicySha256||candidate.streams.length!==experiment.motions.length*levels.length)throw new Error('Context stream provenance does not match ECHO-N');
  for(const m of experiment.motions)for(const mu of levels){const matches=candidate.streams.filter(s=>s.motionId===m.id&&s.mu===mu);
    if(matches.length!==1||matches[0].frames!==m.frames||matches[0].motionSha256!==m.sourceSha256)throw new Error('Missing or mismatched same-motion donor');
  }
  bank=candidate;bankHash=await hash(bytes);
}
async function loadStream(motionId,mu){
  if(!bank)throw new Error('Context catalog is not ready');
  const meta=bank.streams.find(s=>s.motionId===motionId&&s.mu===mu),key=meta.assetPrefix;
  if(!streams.has(key))streams.set(key,loadContextStream(engine.assets,meta));
  try{return await streams.get(key);}catch(e){streams.delete(key);throw e;}
}
async function init(c){
  [engine,experiment]=await Promise.all([Engine.create(text=>send('status',{text}),{loadLegacy:false}),json('./assets/experiment-v7.json?catalog=9')]);
  if(experiment.schema!==7)throw new Error('Canonical-start motion assets are required');config={...config,motionId:experiment.motions[0].id,...c};validate(config);
  if(engine.standing.qpos.some((x,i)=>Math.abs(x-experiment.standingQpos[i])>1e-10))throw new Error('Standing reference differs from native export');
  send('scene',{model:engine.renderModel(),experiment,config});await reset();
  ort.env.wasm.numThreads=1;ort.env.wasm.wasmPaths=new URL('./vendor/',import.meta.url).href;
  sessions={};
  for(const name of ['tracker','encoder','residual'])sessions[name]=await ort.InferenceSession.create(await engine.assets.bytes(experiment.models[name].asset),{executionProviders:['wasm'],executionMode:'sequential',graphOptimizationLevel:'all'});
  standingCache=await engine.assets.array(experiment.standingCacheAsset);
  // Compile and warm all online graphs before enabling Run. Standing never waits for
  // a new encoder rollout, donor stream, or scene rebuild on a button click.
  const o=await infer('tracker',{...lanes[0].env.observe(engine.standing.reference),reference_cache:standingCache});
  const warm=await infer('encoder',{short_interactions:new Float32Array(13650),short_valid:new Float32Array(50),long_interactions:new Float32Array(81900),long_valid:new Float32Array(30).fill(1)});
  await infer('residual',{...o,...warm,previous_latents:new Float32Array(256)});
  lanes.forEach(l=>l.env.reset([],{standing:true}));controllersReady=true;send('controllers');loop();
  await loadBank();await configure(config);send('ready');
}
async function verify(){
  const fixtures=await json('./assets/fixtures.json'),rows=[];
  const ref=await ort.InferenceSession.create(await engine.assets.bytes(experiment.models.reference.asset),{executionProviders:['wasm']});
  try{for(const fixture of fixtures.filter(x=>x.label==='N')){
    const input={};for(const [key,name] of Object.entries(fixture.inputs))input[key]=await engine.assets.array(name);
    const t=new ort.Tensor('float32',input.reference_encoder_input,[1,1900]),out=await ref.run({reference_encoder_input:t});
    const tracker=await infer('tracker',{...input,reference_cache:Float32Array.from(out.reference_cache.data)});t.dispose();Object.values(out).forEach(t=>t.dispose());
    const readout=await infer('encoder',input);
    const result=await infer('residual',{...tracker,...readout,previous_latents:input.previous_latents});
    const max=(a,b)=>a.reduce((m,v,i)=>Math.max(m,Math.abs(v-b[i])),0);
    rows.push({key:fixture.key,latentMaxError:max(readout.context_latent,fixture.outputs.context_latent),actionMaxError:max(result.action,fixture.outputs.action),trackerMaxError:max(tracker[experiment.trackerAction],fixture.outputs.tracker_action)});
  }}finally{await ref.release();}
  return {passed:rows.every(r=>r.actionMaxError<2e-3&&r.trackerMaxError<2e-3&&r.latentMaxError<2e-3),rows};
}
onmessage=async({data:m})=>{try{
  let result;
  if(m.type==='init')await init(m.config);
  else if(m.type==='configure')result=await configure(m.config);
  else if(m.type==='start')result=await start();
  else if(m.type==='reset')result=await reset();
  else if(m.type==='pause'){paused=true;await stop();if(run&&!run.finishedAt)run.pauseAt=performance.now();publish();}
  else if(m.type==='resume'){if(!['standing','running'].includes(mode))throw new Error('Reset to continue');if(run&&run.pauseAt!==null){run.pausedMs+=performance.now()-run.pauseAt;run.pauseAt=null;}paused=false;publish();loop();}
  else if(m.type==='bank'){await loadBank();await configure(config);send('ready');}
  else if(m.type==='verify'){await stop();result=await verify();loop();}
  else if(m.type==='pose'){const frame=m.frame+run.motion.transitionFrames;result=engine.poseAt(m.qpos,run.motion.qpos.subarray(frame*engine.config.nq,(frame+1)*engine.config.nq));}
  else if(m.type==='export')result=run?{schema:7,kind:'browser-simulation',protocol:experiment.protocol,startProtocol:experiment.startProtocol,config:run.config,phase:mode,controlSteps:run.index,standingSteps:run.standingSteps,initial:run.initial,transitionFrames:run.motion.transitionFrames,
    motion:experiment.motions.find(x=>x.id===run.motion.id),contextBankSha256:bankHash,contextStream:run.stream.meta,contextProtocol:bank.protocol,
    injection:'same-motion donor full context stream (short50, long300, validity masks and four donor previous latents); online encoder, live target tracker and residual; canonical motion reset',contextTrace:run.contextTrace,models:experiment.models,sourcePolicySha256:experiment.sourcePolicySha256,
    engine:engine.config.mujocoVersion,dt:.02,substeps:engine.config.substeps,onnxRuntime:'1.31.1',threads:ort.env.wasm.numThreads,startLatencyMs:run.startLatencyMs,computeMs:run.computeMs,elapsedMs:elapsed(),
    lanes:lanes.map(l=>({policy:l.label,contacts:l.env.contactCount,summary:summarize(l.trace,mode==='complete'),entryTrace:l.entry,trace:l.trace}))}:null;
  else throw new Error('Unknown operation');
  if(m.id)send('reply',{id:m.id,result});
}catch(e){if(m.id)send('reply',{id:m.id,error:String(e)});else send('error',{message:String(e),stack:e.stack});}};
