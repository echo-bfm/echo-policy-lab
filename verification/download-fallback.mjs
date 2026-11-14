import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile,writeFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
const source=(await readFile(new URL('../assets.js',import.meta.url),'utf8')).replace(/^export /gm,'').replaceAll('import.meta.url',"'https://fixture.test/echo-policy-lab/assets.js'");
const bytes=new Uint8Array([1,2,3,4]),results=[];
function fixture(fetch){
  const requests=[],timeouts=[];
  const context={URL,URLSearchParams,Uint8Array,Uint32Array,Float32Array,Response,Blob,DecompressionStream,AbortController,crypto:webcrypto,
    fetch:(url,options)=>{requests.push({url:String(url),cache:options.cache});return fetch(String(url),options);},
    setTimeout(fn,delay){timeouts.push(delay);return setTimeout(fn,delay>=12000?5:delay>=250?1:delay);},clearTimeout};
  vm.createContext(context);vm.runInContext(source,context);
  return {context,requests,timeouts,run:code=>vm.runInContext(code,context)};
}
const part={url:'https://fixture.test/primary',fallbackUrls:['https://backup.test/runtime'],file:'mujoco.wasm'};
{
  const f=fixture((url,{signal})=>url.includes('primary')?new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})):Promise.resolve(new Response(bytes)));
  f.context.part=part;assert.deepEqual(await f.run('downloadPart(part,new AbortController().signal)'),bytes);
  assert.deepEqual(f.requests.map(x=>x.url),[part.url,...part.fallbackUrls]);assert.equal(f.requests[1].cache,'reload');
  assert.ok(f.timeouts.includes(12000));assert.ok(f.timeouts.includes(30000));
  results.push('Stalled primary switches to backup with a longer inactivity timeout');
}
{
  const f=fixture((url,{signal})=>Promise.resolve(url.includes('primary')?new Response(new ReadableStream({start(stream){stream.enqueue(new Uint8Array([1]));signal.addEventListener('abort',()=>stream.error(signal.reason),{once:true});}})):new Response(bytes)));
  f.context.part=part;assert.deepEqual(await f.run('downloadPart(part,new AbortController().signal)'),bytes);
  assert.equal(f.requests.length,2);results.push('A response that stalls after its first bytes also switches to backup');
}
{
  const f=fixture(url=>Promise.resolve(url.includes('primary')?new Response('Not found',{status:404}):new Response(bytes)));
  f.context.part=part;assert.deepEqual(await f.run('downloadPart(part,new AbortController().signal)'),bytes);
  assert.equal(f.requests.length,2);results.push('An unavailable primary can use an existing mirror');
}
{
  const f=fixture((url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})));
  f.context.part=part;f.context.controller=new AbortController();
  const loading=f.run('downloadPart(part,controller.signal)');f.context.controller.abort(new Error('Cancelled'));
  await assert.rejects(loading,/Cancelled/);assert.equal(f.requests.length,1);results.push('Explicit cancellation never starts a mirror request');
}
{
  const sha=Buffer.from(await webcrypto.subtle.digest('SHA-256',bytes)).toString('hex');
  const f=fixture(url=>Promise.resolve(url.startsWith('https://fixture.test')?new Response('',{status:503}):new Response(bytes)));
  f.context.sha=sha;
  assert.deepEqual(await f.run("verifiedBinary('./vendor/mujoco.wasm',4,sha)"),bytes);
  assert.ok(f.requests[1].url.startsWith('https://raw.githubusercontent.com/echo-bfm/echo-policy-lab/ac4d226'));
  results.push('Verified runtime bytes load from the pinned repository mirror');
}
{
  const f=fixture(url=>Promise.resolve(url.startsWith('https://fixture.test')?new Response('',{status:503}):new Response(bytes)));
  await assert.rejects(f.run("verifiedBinary('./vendor/mujoco.wasm',4,'invalid')"),/Integrity check/);
  results.push('Backup content still must pass the original SHA-256 check');
}
await writeFile(new URL('./download-fallback.json',import.meta.url),JSON.stringify({passed:true,checks:results},null,2));
console.log(JSON.stringify({passed:true,checks:results.length}));
