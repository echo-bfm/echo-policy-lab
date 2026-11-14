import {hash} from './assets.js?v=20261113-recovery';

export const contextKeys=['short_interactions','short_valid','long_interactions','long_valid','previous_latents'];
const widths={short_interactions:13650,short_valid:50,long_interactions:81900,long_valid:30,previous_latents:256};
export function contextBuffers(){return Object.fromEntries(contextKeys.map(k=>[k,new Float32Array(widths[k])]));}
export async function contextHash(inputs){
  const all=new Float32Array(contextKeys.reduce((n,k)=>n+widths[k],0));let offset=0;
  for(const k of contextKeys){all.set(inputs[k],offset);offset+=widths[k];}
  return hash(new Uint8Array(all.buffer));
}
export async function loadContextStream(assets,meta){
  const keys=['pool',...contextKeys,'latents'];
  const [data,receipts]=await Promise.all([
    Promise.all(keys.map(async k=>[k,await assets.array(meta.assetPrefix+'-'+k,k.endsWith('interactions')?Uint32Array:Float32Array)])).then(Object.fromEntries),
    assets.object(meta.assetPrefix+'-receipts'),
  ]);
  const n=meta.frames;
  if(data.pool.length!==meta.poolRows*273||data.latents.length!==n*64||receipts.contextHashes.length!==n||JSON.stringify(receipts.order)!==JSON.stringify(contextKeys))throw new Error('Invalid donor stream dimensions');
  for(const key of contextKeys){const w=key==='short_interactions'?50:key==='long_interactions'?300:widths[key];
    if(data[key].length!==n*w||!data[key].every(Number.isFinite))throw new Error('Invalid donor tensor: '+key);
    if(key.endsWith('interactions')&&!data[key].every(i=>i<meta.poolRows))throw new Error('Invalid donor interaction index');
  }
  if(!data.pool.every(Number.isFinite)||!data.latents.every(Number.isFinite))throw new Error('Nonfinite donor data');
  const stream={meta,hashes:receipts.contextHashes,
    at(i,inputs){
      if(!Number.isInteger(i)||i<0||i>=n)throw new Error('Donor stream is outside recorded motion');
      for(const [key,count] of [['short_interactions',50],['long_interactions',300]])for(let j=0;j<count;j++){
        const offset=data[key][i*count+j]*273;inputs[key].set(data.pool.subarray(offset,offset+273),j*273);
      }
      for(const [key,w] of [['short_valid',50],['long_valid',30],['previous_latents',256]])inputs[key].set(data[key].subarray(i*w,(i+1)*w));
    },
    latent(i){return data.latents.subarray(i*64,(i+1)*64);},
    longIndices(i){return Array.from(data.long_interactions.subarray(i*300,(i+1)*300));},
  };
  // Validate reconstructed tensors before enabling Run. Async hashes let the
  // separate standing controller keep ticking while a selection is prepared.
  const inputs=contextBuffers();
  for(let i=0;i<n;i++){
    stream.at(i,inputs);
    if(await contextHash(inputs)!==stream.hashes[i])throw new Error(`Donor round-trip mismatch at command ${i}`);
    if(inputs.short_valid.reduce((a,b)=>a+b,0)!==Math.min(i,50)||!inputs.long_valid.every(v=>v===1))throw new Error('Invalid donor validity masks');
    for(let j=0;j<256;j++){const previousCommand=i-4+Math.floor(j/64),expected=previousCommand<0?0:data.latents[previousCommand*64+j%64];if(inputs.previous_latents[j]!==expected)throw new Error('Noncausal donor previous latents');}
    if(i===0&&await hash(new Uint8Array(inputs.long_interactions.buffer))!==meta.initialLongSha256)throw new Error('Warmup memory does not match donor start');
  }
  return stream;
}
