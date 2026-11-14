import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile,writeFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
const source=(await readFile(new URL('../assets.js',import.meta.url),'utf8')).replace(/^export /gm,'').replaceAll('import.meta.url',"'https://fixture.test/echo-policy-lab/assets.js'");
const never=()=>new Promise(()=>{}),results=[];
const drain=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function fixture(cache){
  let now=0,id=0;const timers=new Map();
  const context={URL,URLSearchParams,Uint8Array,Uint32Array,Float32Array,Response,Blob,DecompressionStream,AbortController,crypto:webcrypto,caches:cache,
    setTimeout(fn,delay){const key=++id;timers.set(key,{fn,at:now+delay,delay});return key;},clearTimeout(key){timers.delete(key);}};
  vm.createContext(context);vm.runInContext(source,context);
  return {context,timers,run:code=>vm.runInContext(code,context),async advance(ms){now+=ms;for(const [key,timer]of [...timers])if(timer.at<=now){timers.delete(key);timer.fn();}await drain();}};
}
async function deadline(name,setup,expression,milliseconds=750){
  const f=fixture();setup(f);let done=false;
  const pending=f.run(expression).then(value=>{done=true;return value;});await drain();
  assert.equal(done,false);assert.equal([...f.timers.values()][0].delay,milliseconds);
  await f.advance(milliseconds-1);assert.equal(done,false);await f.advance(1);assert.equal(done,true);assert.equal(await pending,null);assert.equal(f.timers.size,0);
  results.push({name,passed:true});
}
await deadline('Hanging cache open falls back after 750 ms',f=>{f.context.caches={open:never};},"persistentCache('test')");
await deadline('Hanging cache match falls back after 3000 ms',f=>{f.context.cache={match:never};f.context.entry={bytes:4,sha256:'x'};},"cachedBytes(cache,'key',entry)",3000);
await deadline('Hanging cache body read falls back after 3000 ms',f=>{f.context.cache={match:async()=>({arrayBuffer:never})};f.context.entry={bytes:4,sha256:'x'};},"cachedBytes(cache,'key',entry)",3000);
{
  const f=fixture();let finish,done=false,written=false;const write=new Promise(resolve=>{finish=()=>{written=true;resolve();};});
  f.context.write=write;f.run('pendingWrites.add(write);write.finally(()=>pendingWrites.delete(write));');
  const flush=f.run('flushAssetCache()').then(()=>{done=true;});await drain();
  await f.advance(749);assert.equal(done,false);await f.advance(1);assert.equal(done,true);await flush;
  assert.equal(written,false);assert.equal(f.run('pendingWrites.size'),1);
  finish();await drain();assert.equal(written,true);assert.equal(f.run('pendingWrites.size'),0);
  results.push({name:'Flush waits at most 750 ms while late cache writes continue',passed:true});
}
{
  const bytes=new Uint8Array([1,2,3,4]),sha=Buffer.from(await webcrypto.subtle.digest('SHA-256',bytes)).toString('hex');
  const f=fixture({open:async()=>({tag:'cache'})});f.context.cache={match:async()=>new Response(bytes)};f.context.entry={bytes:4,sha256:sha};
  assert.equal((await f.run("persistentCache('test')")).tag,'cache');
  assert.deepEqual(await f.run("cachedBytes(cache,'key',entry)"),bytes);assert.equal(f.timers.size,0);
  results.push({name:'Available cache reads retain full SHA verification and clear timers',passed:true});
}
{
  const f=fixture({open:async()=>{throw new Error('Storage denied');}});assert.equal(await f.run("persistentCache('test')"),null);assert.equal(f.timers.size,0);
  const failure=Promise.reject(new Error('Quota exceeded'));failure.catch(()=>{});f.context.failure=failure;f.run('pendingWrites.add(failure);');
  await f.run('flushAssetCache()');assert.equal(f.timers.size,0);results.push({name:'Storage rejections remain nonfatal and settle immediately',passed:true});
}
await writeFile(new URL('./cache-timeouts.json',import.meta.url),JSON.stringify({passed:true,tests:results},null,2));
console.log(JSON.stringify({passed:true,tests:results.length,clock:'virtual; no real waits'}));
