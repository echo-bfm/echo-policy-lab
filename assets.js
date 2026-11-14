// Transport only: every compressed chunk and reconstructed asset is verified.
const root = new URL('./', import.meta.url);
const coldProbe = new URLSearchParams(globalThis.location?.search??'').get('startup-test')==='cold';
const CACHE_NAME = 'echo-policy-lab-verified-assets-v1', MAX_PARALLEL = 6;
const DOWNLOAD_IDLE_MS = 12000;
const inFlight = new Map(), queue = [];
const pendingWrites = new Set(), diagnostics = {cacheHits:0,cacheMisses:0,cacheWriteFailures:0,cachedBytes:0,downloadedBytes:0};
let active = 0;

function drain() {
  while (active < MAX_PARALLEL && queue.length) {
    const job = queue.shift();
    job.signal?.removeEventListener('abort', job.cancel);
    if (job.signal?.aborted) { job.reject(job.signal.reason); continue; }
    active++;
    Promise.resolve().then(job.task).then(job.resolve, job.reject).finally(() => { active--; drain(); });
  }
}
function scheduled(task, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const job = {task, signal, resolve, reject, cancel: () => {
      const index = queue.indexOf(job);
      if (index !== -1) { queue.splice(index, 1); reject(signal.reason); }
    }};
    signal?.addEventListener('abort', job.cancel, {once: true});
    queue.push(job); drain();
  });
}
function cacheDeadline(task, fallback, milliseconds=750) {
  // Browser storage is optional. A stalled disk operation must not hold startup;
  // its promise remains handled and may still finish safely in the background.
  let timer;
  const deadline=new Promise(resolve=>{timer=setTimeout(()=>resolve(fallback),milliseconds);});
  return Promise.race([Promise.resolve().then(task).catch(()=>fallback),deadline])
    .finally(()=>clearTimeout(timer));
}
async function persistentCache(name) {
  // Private mode, quota limits and storage failures must never block the demo.
  if (typeof caches === 'undefined') return null;
  return cacheDeadline(()=>caches.open(name),null);
}
async function cachedBytes(cache, key, entry) {
  if (!cache || coldProbe) return null;
  return cacheDeadline(async()=>{try {
    const response = await cache.match(key);
    if (!response) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === entry.bytes && await hash(bytes) === entry.sha256) return bytes;
    await cache.delete(key);
  } catch { /* Retry via the verified network path. */ }
  return null;},null,3000);
}
function progress(asset, loaded, total, phase) {
  if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope)
    postMessage({type: 'load-progress', asset, loaded, total, phase});
}
async function downloadPart(part, signal) {
  const urls = [part.url ?? new URL(`./assets/${part.file}`, root), ...(part.fallbackUrls ?? [])];
  for (let attempt = 0; ; attempt++) {
    const url = urls[Math.min(attempt, urls.length - 1)];
    signal.throwIfAborted();
    const request = new AbortController();
    const cancel = () => request.abort(signal.reason);
    signal.addEventListener('abort', cancel, {once:true});
    let timeout;
    const keepAlive = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => request.abort(new Error(`${part.file}: download stalled`)), attempt ? 30000 : DOWNLOAD_IDLE_MS);
    };
    try {
      keepAlive();
      const response = await fetch(url, {signal:request.signal,...(coldProbe||attempt?{cache:'reload'}:{})});
      if (!response.ok) {
        const error = new Error(`${part.file}: HTTP ${response.status}`);
        error.permanent = response.status < 500 && ![408, 429].includes(response.status);
        throw error;
      }
      if (!response.body) { const bytes=new Uint8Array(await response.arrayBuffer());diagnostics.downloadedBytes+=bytes.length;return bytes; }
      const reader = response.body.getReader(), chunks = [];
      let size = 0;
      try {
        while (true) {
          const {done,value} = await reader.read();
          if (done) break;
          keepAlive();chunks.push(value);size += value.length;
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size);let offset=0;
      for (const chunk of chunks) { bytes.set(chunk,offset);offset+=chunk.length; }
      diagnostics.downloadedBytes+=bytes.length;
      return bytes;
    } catch (error) {
      if (signal.aborted || (error.permanent && attempt >= urls.length - 1) || attempt >= 2) throw error;
      if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope)
        postMessage({type:'status',text:`Reconnecting to download ${part.file}${urls.length > 1 ? ' from a backup source' : ''}…`});
      await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    } finally { clearTimeout(timeout);signal.removeEventListener('abort',cancel); }
  }
}
export async function json(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}
export async function hash(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), v => v.toString(16).padStart(2, '0')).join('');
}
export class Assets {
  static async create(status = () => {}) {
    return new Assets(await json('./assets/manifest.json'), status);
  }
  constructor(manifest, status = () => {}, {cacheName=CACHE_NAME,cachePath='./verified-assets/'} = {}) {
    this.manifest=manifest;this.status=status;this.cacheName=cacheName;this.cachePath=cachePath;
  }
  async bytes(name) {
    const entry = this.manifest[name];
    if (!entry) throw new Error(`Missing asset: ${name}`);
    // Content identity prevents one manifest's same-named asset serving another.
    const key = `${entry.sha256}:${entry.bytes}`;
    if (inFlight.has(key)) return inFlight.get(key);
    const promise = this.load(name); inFlight.set(key, promise);
    try { return await promise; } finally { if (inFlight.get(key) === promise) inFlight.delete(key); }
  }
  async load(name) {
    const entry = this.manifest[name];
    if (!entry) throw new Error(`Missing asset: ${name}`);
    const key = new URL(`${this.cachePath}${entry.sha256}-${entry.bytes}`, root).href;
    const cache = await persistentCache(this.cacheName), cached = await scheduled(() => cachedBytes(cache, key, entry));
    if (cached) { diagnostics.cacheHits++;diagnostics.cachedBytes+=cached.length;progress(name, entry.bytes, entry.bytes, 'cached'); return cached; }
    diagnostics.cacheMisses++;
    const controller = new AbortController();
    let loaded = 0, completed = 0;
    progress(name, 0, entry.bytes, 'download');
    try {
      // The global queue bounds simultaneous downloads and decompression across
      // all models and motions. Chunk order is retained for exact reconstruction.
      const parts = await Promise.all(entry.parts.map(part => scheduled(async () => {
        const compressed = await downloadPart(part, controller.signal);
        if (compressed.length !== part.bytes || await hash(compressed) !== part.sha256) throw new Error(`Integrity check failed: ${part.file}`);
        const raw = part.encoding==='identity' ? compressed : new Uint8Array(await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
        controller.signal.throwIfAborted();
        loaded += raw.length; completed++;
        this.status(`Loading ${name} · ${completed}/${entry.parts.length}`);
        progress(name, loaded, entry.bytes, 'download');
        return raw;
      }, controller.signal)));
      const result = new Uint8Array(entry.bytes); let offset = 0;
      for (const raw of parts) {
        if (offset + raw.length > result.length) throw new Error(`Invalid asset size: ${name}`);
        result.set(raw, offset); offset += raw.length;
      }
      progress(name, entry.bytes, entry.bytes, 'verify');
      if (offset !== entry.bytes || await hash(result) !== entry.sha256) throw new Error(`Integrity check failed: ${name}`);
      progress(name, entry.bytes, entry.bytes, 'ready');
      // Persist in parallel with compilation. The ready handshake flushes these
      // writes so a quick revisit can reliably reuse all completed downloads.
      if (cache) {
        const write=Promise.resolve().then(()=>cache.put(key,new Response(result,{headers:{'Content-Type':'application/octet-stream','X-Echo-SHA256':entry.sha256}})))
          .catch(()=>{diagnostics.cacheWriteFailures++;});
        pendingWrites.add(write);void write.finally(()=>pendingWrites.delete(write));
      }
      return result;
    } catch (error) {
      controller.abort(error);
      throw error;
    }
  }
  async array(name, Type = Float32Array) {
    const b = await this.bytes(name);
    return new Type(b.buffer, b.byteOffset, b.byteLength / Type.BYTES_PER_ELEMENT);
  }
  async object(name) { return JSON.parse(new TextDecoder().decode(await this.bytes(name))); }
}

// Runtime binaries use the same verified, content-addressed cache as model
// assets. The server may apply HTTP compression; verification covers raw bytes.
export function verifiedBinary(url, bytes, sha256, status=()=>{}) {
  const resolved = new URL(url,root), name=resolved.pathname.split('/').at(-1);
  // These pinned mirrors contain identical bytes; the normal SHA-256 checks
  // still apply after failover. A stalled Pages connection cannot trap retries
  // on the same delivery route.
  const fallbackUrls=['mujoco.wasm','ort-wasm-simd-threaded.wasm'].includes(name)?[
    `https://raw.githubusercontent.com/echo-bfm/echo-policy-lab/main/docs/vendor/${name}`,
    `https://raw.githubusercontent.com/echo-bfm/echo-h-live-demo/main/site/vendor/${name}`
  ]:[];
  return new Assets({[name]:{bytes,sha256,parts:[{url:resolved.href,fallbackUrls,file:name,bytes,sha256,encoding:'identity'}]}},status,{cacheName:'echo-runtime-verified-v1',cachePath:'/.echo-cache/'}).bytes(name);
}
export async function flushAssetCache() {
  await cacheDeadline(()=>Promise.allSettled([...pendingWrites]),undefined);
}
export function assetDiagnostics() {
  // downloadedBytes counts decoded response payloads; HTTP content encoding may
  // make actual wire transfers smaller, especially for the WASM runtime files.
  return {...diagnostics,pendingCacheWrites:pendingWrites.size};
}

export async function loadDonor(assets, mu, frames) {
  const prefix = `donor-${mu}`, keys = ['pool', 'short_interactions', 'long_interactions', 'short_valid', 'long_valid', 'previous_latents'];
  const data = Object.fromEntries(await Promise.all(keys.map(async key => [key, await assets.array(`${prefix}-${key}`, key.endsWith('interactions') ? Uint32Array : Float32Array)])));
  return {
    mu,
    at(index, inputs) {
      if (index < 0 || index >= frames) throw new Error('Donor context time is outside recorded motion');
      for (const [key, count] of [['short_interactions', 50], ['long_interactions', 300]]) {
        for (let i = 0; i < count; i++) {
          const start = data[key][index * count + i] * 273;
          inputs[key].set(data.pool.subarray(start, start + 273), i * 273);
        }
      }
      for (const [key, width] of [['short_valid', 50], ['long_valid', 30], ['previous_latents', 256]]) inputs[key].set(data[key].subarray(index * width, (index + 1) * width));
    },
  };
}
