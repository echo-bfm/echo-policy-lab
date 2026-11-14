import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile,access,writeFile} from 'node:fs/promises';
const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
const source=(await readFile(new URL('../startup.js',import.meta.url),'utf8'))
  .replace(/import\('\.\/lab-v9\.js\?v=[^']+'\)/,"loadUi()")
  .replace("import('./startup-diagnostics.js')","loadDiagnostics()")
  .replaceAll('import.meta.url',"'https://fixture.test/echo-policy-lab/startup.js'");
const uiSource=(await readFile(new URL('../lab-v9.js',import.meta.url),'utf8')).replace(/^import .+;\r?\n/gm,'');
const tick=()=>new Promise(r=>setTimeout(r,0));
function dom(){
  const elements=new Map([...html.matchAll(/id="([^"]+)"/g)].map(([,id])=>[id,{id,hidden:false,disabled:false,textContent:'',dataset:{},children:[],clientWidth:0,clientHeight:0,classList:{values:new Set(),add(name){this.values.add(name);},toggle(){},contains(name){return this.values.has(name);}},replaceChildren(...values){this.children=values;},setAttribute(){}}]));
  elements.get('retry-loading').hidden=true;
  const controls=['run','reset','motion','pause','timeline','ghost','follow','fit','retry-loading'].map(id=>elements.get(id));
  return {elements,controls,document:{getElementById:id=>elements.get(id),querySelectorAll:selector=>selector==='button,select,input'?controls:[],createElement:tag=>({tag})}};
}
function fixture({fail=false,constructFail=false,postFail=false,query='?mu=2&context=0.7&motion=example'}={}){
  const workers=[],view=dom();let reloads=0,diagnosticsLoads=0,uiLoads=0;
  class Worker{constructor(url,options){if(constructFail)throw new Error('Worker construction denied');this.url=url;this.options=options;this.posts=[];workers.push(this);}postMessage(m){if(postFail)throw new Error('Worker init failed');this.posts.push(m);}terminate(){this.terminated=true;}}
  const sandbox={URL,URLSearchParams,Worker,performance,location:{search:query,reload(){reloads++;}},window:{},document:view.document,loadUi:()=>{uiLoads++;return fail?Promise.reject(new Error('Module unavailable')):Promise.resolve();},loadDiagnostics:()=>{diagnosticsLoads++;return Promise.resolve();}};
  vm.createContext(sandbox);vm.runInContext(source,sandbox);return {sandbox,workers,...view,get reloads(){return reloads;},get diagnosticsLoads(){return diagnosticsLoads;},get uiLoads(){return uiLoads;}};
}
function failureVisible(f,message){
  const get=id=>f.elements.get(id);
  assert.equal(get('startup').hidden,false);assert.equal(get('loader').hidden,false);
  assert.equal(get('startup').classList.contains('failed'),true);assert.equal(get('loader').classList.contains('failed'),true);
  assert.equal(get('startup-title').textContent,'Unable to load experiment');assert.equal(get('loader-title').textContent,'Unable to load experiment');
  for(const id of ['loading-spinner','startup-progress','startup-percent'])assert.equal(get(id).hidden,true,id);
  assert.match(get('loading-text').textContent,message);assert.match(get('status').textContent,message);
  assert.equal(get('retry-loading').hidden,false);assert.equal(get('retry-loading').disabled,false);
  for(const control of f.controls.filter(c=>c.id!=='retry-loading'))assert.equal(control.disabled,true,control.id);
}
const base=fixture(),boot=base.sandbox.window.echoStartup,worker=base.workers[0];
assert.equal(base.workers.length,1);assert.equal(worker.options.type,'module');assert.equal(worker.posts.length,1);assert.equal(worker.posts[0].type,'init');
assert.equal(boot.config.mu,2);assert.equal(boot.config.contextMu,.3);assert.equal(boot.config.motionId,'example');
assert.equal(worker.url.origin,'https://fixture.test');assert.equal(worker.url.pathname,'/echo-policy-lab/worker-v9.js');assert.ok(worker.url.searchParams.get('v'));assert.equal(worker.url.searchParams.has('startup-test'),false);
const cold=fixture({query:'?startup-test=cold&mu=2&context=2'});assert.equal(cold.workers[0].url.searchParams.get('startup-test'),'cold');assert.equal(cold.workers[0].posts[0].config.contextMu,2);assert.equal(cold.diagnosticsLoads,1);
const vertices=new Float32Array([1,2,3]),scene={data:{type:'scene',model:{vertices}}};worker.onmessage(scene);
for(let i=0;i<1000;i++){
  if(i===500)worker.onmessage({data:{type:'controllers'}});
  worker.onmessage({data:{type:'state',step:i}});worker.onmessage({data:{type:'status',text:`Loading ${i}`}});
  worker.onmessage({data:{type:'load-progress',asset:`asset-${i%4}`,loaded:i}});
}
worker.onmessage({data:{type:'ready'}});
const received=[];boot.attach(e=>received.push(e),()=>{});
assert.equal(received.length,9);assert.equal(received[0],scene);assert.equal(received[0].data.model.vertices,vertices);
assert.deepEqual(received.filter(e=>['scene','controllers','ready'].includes(e.data.type)).map(e=>e.data.type),['scene','controllers','ready']);
assert.equal(received.filter(e=>e.data.type==='state').length,1);assert.equal(received.find(e=>e.data.type==='state').data.step,999);
assert.equal(received.filter(e=>e.data.type==='status').length,1);assert.equal(received.find(e=>e.data.type==='status').data.text,'Loading 999');
assert.equal(received.filter(e=>e.data.type==='load-progress').length,4);assert.ok(received.filter(e=>e.data.type==='load-progress').every(e=>e.data.loaded>=996));
worker.onmessage({data:{type:'state',step:1000}});assert.equal(received.length,10);
boot.attach(()=>{throw new Error('Unexpected second attachment');},()=>{});assert.equal(worker.posts.length,1);
const early=fixture(),error={message:'mujoco.wasm: download stalled',preventDefault(){this.prevented=true;}};early.workers[0].onerror(error);failureVisible(early,/download stalled/);assert.equal(error.prevented,true);assert.equal(early.workers[0].terminated,true);
const errors=[];early.sandbox.window.echoStartup.attach(()=>{},e=>errors.push(e));assert.equal(errors[0],error);early.elements.get('retry-loading').onclick();assert.equal(early.reloads,1);
const reported=fixture();reported.workers[0].onmessage({data:{type:'error',message:'Model checksum failed'}});failureVisible(reported,/checksum failed/);
const failed=fixture({fail:true});await tick();failureVisible(failed,/Module unavailable/);assert.equal(failed.workers[0].terminated,true);
for(const options of [{constructFail:true},{postFail:true}]){const f=fixture(options);failureVisible(f,/Worker/);assert.equal(f.uiLoads,0);f.elements.get('retry-loading').onclick();assert.equal(f.reloads,1);}
function uiFixture({constructFail=false,modelPromise=Promise.resolve()}={}){
  const view=dom(),workers=[];let reloads=0;
  class Worker{constructor(){if(constructFail)throw new Error('Worker construction denied');this.posts=[];workers.push(this);}postMessage(m){this.posts.push(m);}terminate(){this.terminated=true;}}
  class Viewer{setFollow(){} model(){return modelPromise;}setup(){}update(){}fit(){}}
  const sandbox={Worker,Viewer,colors:['red','blue'],policyName:x=>x,summarize:()=>({world:null,local:null}),performance,URLSearchParams,location:{search:'',reload(){reloads++;}},window:{},document:view.document,devicePixelRatio:1,ResizeObserver:class{observe(){}}};
  vm.createContext(sandbox);vm.runInContext(uiSource,sandbox);return {sandbox,workers,...view,get reloads(){return reloads;}};
}
let finishModel;const modelPromise=new Promise(resolve=>finishModel=resolve),ui=uiFixture({modelPromise}),uw=ui.workers[0];
uw.onmessage({data:{type:'scene',experiment:{motions:[{id:'test'}]},config:{motionId:'test',mu:.3,contextMu:.3},model:{}}});
uw.onmessage({data:{type:'ready'}});
let pendingError;ui.sandbox.window.lab.call('configure').catch(e=>pendingError=e);
uw.onmessage({data:{type:'error',message:'mujoco.wasm: download stalled'}});
finishModel();await tick();failureVisible(ui,/download stalled/);assert.equal(ui.sandbox.window.lab.ready,false);assert.match(String(pendingError),/download stalled/);
uw.onmessage({data:{type:'controllers'}});uw.onmessage({data:{type:'ready'}});uw.onmessage({data:{type:'status',text:'Preparing again'}});uw.onmessage({data:{type:'load-progress',asset:'x',loaded:100,total:100}});await tick();failureVisible(ui,/download stalled/);assert.equal(ui.sandbox.window.lab.errors.length,1);
ui.elements.get('retry-loading').onclick();assert.equal(ui.reloads,1);
const directError=uiFixture({constructFail:true});failureVisible(directError,/construction denied/);
for(const match of html.matchAll(/<link rel="modulepreload" href="([^"]+)"/g))await access(new URL('../docs/'+match[1].split('?')[0],import.meta.url));
assert.match(html,/src="startup\.js\?v=[^"]+"/);assert.match(html,/id="retry-loading"[^>]*hidden>Retry loading<\/button>/);
for(const name of ['startup.js','lab-v9.js','index.html','lab-ui.css'])assert.equal(await readFile(new URL('../'+name,import.meta.url),'utf8'),await readFile(new URL('../docs/'+name,import.meta.url),'utf8'),name+' mirror');
const checks=['One early Worker and validated config','Module-relative versioned URL and diagnostic forwarding','3,003 transient updates coalesce to six updates plus three ordered critical events','Transferred scene buffers retain identity','Handoff is idempotent and later messages are direct','Early Worker and reported errors immediately stop loading UI','Worker construction and init exceptions render failure without UI import','UI import rejection renders failure and terminates Worker','Retry reloads without touching asset caches','UI failure rejects pending commands and disables controls','In-flight scene and ready handlers cannot clear a failure','Late progress, status and readiness cannot overwrite the error','Direct UI Worker construction failure is handled','Published source mirrors and preload files match'];
await writeFile(new URL('./startup-handoff.json',import.meta.url),JSON.stringify({passed:true,checks},null,2));console.log(JSON.stringify({passed:true,checks:checks.length}));
