// GPU hashing for the miner, with WebGPU. Works on any card the browser supports (NVIDIA, AMD,
// Intel, Apple) with no driver SDK. Each invocation hashes one candidate nonce for the current job;
// hits are re-checked on the CPU with SubtleCrypto before they are sent to the gateway, which
// forwards them to the pool like any CPU share.
//
// Message hashed by the pool: `${seed}:${name}:${nonce}`. Here nonce = prefix (16 hex) + counter
// (8 hex), so the message has a fixed length and the shader only writes eight characters.

const WORKGROUP = 256;
const GROUPS = 2048; // 524,288 hashes per dispatch
const MAX_HITS = 512;

const SHADER = /* wgsl */`
struct Params { headLen: u32, totalLen: u32, blocks: u32, difficulty: u32, base: u32, _p1: u32, _p2: u32, _p3: u32 };
struct Hits { count: atomic<u32>, nonces: array<u32, ${MAX_HITS}> };

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> message: array<u32, 32>;
@group(0) @binding(2) var<storage, read_write> hits: Hits;

const K = array<u32, 64>(
  0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
  0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u, 0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
  0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
  0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
  0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u, 0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
  0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
  0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
  0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u, 0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u);

fn rotr(x: u32, n: u32) -> u32 { return (x >> n) | (x << (32u - n)); }

fn compress(h: ptr<function, array<u32, 8>>, w: ptr<function, array<u32, 64>>) {
  for (var i = 16u; i < 64u; i++) {
    let s0 = rotr((*w)[i - 15u], 7u) ^ rotr((*w)[i - 15u], 18u) ^ ((*w)[i - 15u] >> 3u);
    let s1 = rotr((*w)[i - 2u], 17u) ^ rotr((*w)[i - 2u], 19u) ^ ((*w)[i - 2u] >> 10u);
    (*w)[i] = (*w)[i - 16u] + s0 + (*w)[i - 7u] + s1;
  }
  var a = (*h)[0]; var b = (*h)[1]; var c = (*h)[2]; var d = (*h)[3];
  var e = (*h)[4]; var f = (*h)[5]; var g = (*h)[6]; var hh = (*h)[7];
  for (var i = 0u; i < 64u; i++) {
    let S1 = rotr(e, 6u) ^ rotr(e, 11u) ^ rotr(e, 25u);
    let ch = (e & f) ^ ((~e) & g);
    let t1 = hh + S1 + ch + K[i] + (*w)[i];
    let S0 = rotr(a, 2u) ^ rotr(a, 13u) ^ rotr(a, 22u);
    let maj = (a & b) ^ (a & c) ^ (b & c);
    let t2 = S0 + maj;
    hh = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
  }
  (*h)[0] += a; (*h)[1] += b; (*h)[2] += c; (*h)[3] += d;
  (*h)[4] += e; (*h)[5] += f; (*h)[6] += g; (*h)[7] += hh;
}

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let counter = params.base + gid.x;
  var m: array<u32, 32>;
  for (var i = 0u; i < 32u; i++) { m[i] = message[i]; }
  // Eight lowercase hex characters at headLen..headLen+7, big-endian byte order inside each word.
  for (var i = 0u; i < 8u; i++) {
    let nibble = (counter >> (28u - 4u * i)) & 0xFu;
    var ch = 48u + nibble;
    if (nibble >= 10u) { ch = 87u + nibble; }
    let p = params.headLen + i;
    let word = p / 4u;
    let shift = (3u - (p % 4u)) * 8u;
    m[word] = (m[word] & ~(0xFFu << shift)) | (ch << shift);
  }
  var h = array<u32, 8>(0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au, 0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u);
  var w: array<u32, 64>;
  for (var i = 0u; i < 16u; i++) { w[i] = m[i]; }
  compress(&h, &w);
  if (params.blocks == 2u) {
    for (var i = 0u; i < 16u; i++) { w[i] = m[16u + i]; }
    compress(&h, &w);
  }
  var zeros = 0u;
  for (var i = 0u; i < 8u; i++) {
    if (h[i] == 0u) { zeros += 32u; continue; }
    zeros += countLeadingZeros(h[i]);
    break;
  }
  if (zeros >= params.difficulty) {
    let slot = atomicAdd(&hits.count, 1u);
    if (slot < ${MAX_HITS}u) { hits.nonces[slot] = counter; }
  }
}`;

const hex8 = (n) => (n >>> 0).toString(16).padStart(8, '0');
const randomPrefix = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');

// SHA-256 padding for a message of `len` bytes, as 32 big-endian words (two blocks of room).
function padded(bytes) {
  const len = bytes.length;
  if (len > 119) throw new Error('message too long for the shader');
  const buf = new Uint8Array(128);
  buf.set(bytes);
  buf[len] = 0x80;
  const bits = len * 8;
  const blocks = len <= 55 ? 1 : 2;
  const end = blocks * 64;
  buf[end - 4] = (bits >>> 24) & 255; buf[end - 3] = (bits >>> 16) & 255; buf[end - 2] = (bits >>> 8) & 255; buf[end - 1] = bits & 255;
  const words = new Uint32Array(32);
  for (let i = 0; i < 32; i++) words[i] = ((buf[i * 4] << 24) | (buf[i * 4 + 1] << 16) | (buf[i * 4 + 2] << 8) | buf[i * 4 + 3]) >>> 0;
  return { words, blocks };
}

async function leadingZeroBits(text) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  let bits = 0;
  for (const byte of digest) { if (byte === 0) { bits += 8; continue; } return bits + Math.clz32(byte) - 24; }
  return bits;
}

export async function detectGpu() {
  if (!navigator.gpu) return null;
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null);
  if (!adapter) return null;
  let name = 'GPU';
  try { const info = adapter.info ?? (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : null); name = info?.description || info?.device || info?.vendor || 'GPU'; } catch { /* no info */ }
  return { adapter, name };
}

export class GpuMiner {
  constructor({ onShares, onRate, onError }) {
    this.onShares = onShares;
    this.onRate = onRate;
    this.onError = onError;
    this.job = null;
    this.running = false;
    this.device = null;
    this.name = 'GPU';
  }

  async start() {
    const found = await detectGpu();
    if (!found) throw new Error('No WebGPU-capable GPU in this browser.');
    this.name = found.name;
    this.device = await found.adapter.requestDevice();
    this.device.lost.then((info) => { if (this.running) this.onError?.(new Error(`GPU lost: ${info.message}`)); this.running = false; });
    const d = this.device;
    this.params = d.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.message = d.createBuffer({ size: 128, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.hits = d.createBuffer({ size: 4 + MAX_HITS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    this.readback = d.createBuffer({ size: 4 + MAX_HITS * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    this.zero = new Uint32Array(1 + MAX_HITS);
    const module = d.createShaderModule({ code: SHADER });
    this.pipeline = await d.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    this.bind = d.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.params } }, { binding: 1, resource: { buffer: this.message } }, { binding: 2, resource: { buffer: this.hits } }] });
    this.running = true;
    this.#loop().catch((err) => { this.running = false; this.onError?.(err); });
    return this.name;
  }

  setJob(job) { this.job = job ? { ...job, prefix: randomPrefix(), base: 0 } : null; }

  stop() { this.running = false; this.job = null; this.device?.destroy(); this.device = null; }

  async #loop() {
    let hashes = 0;
    let last = performance.now();
    while (this.running) {
      const job = this.job;
      if (!job) { await new Promise((r) => setTimeout(r, 150)); continue; }
      if (job.base + WORKGROUP * GROUPS > 0xffffffff) { job.prefix = randomPrefix(); job.base = 0; }
      const head = `${job.seed}:${job.name}:${job.prefix}`;
      const headBytes = new TextEncoder().encode(head);
      const total = headBytes.length + 8;
      const { words, blocks } = padded(new Uint8Array([...headBytes, ...new Array(8).fill(48)]));
      const d = this.device;
      d.queue.writeBuffer(this.message, 0, words);
      d.queue.writeBuffer(this.params, 0, new Uint32Array([headBytes.length, total, blocks, job.difficulty, job.base, 0, 0, 0]));
      d.queue.writeBuffer(this.hits, 0, this.zero);
      const encoder = d.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.bind);
      pass.dispatchWorkgroups(GROUPS);
      pass.end();
      encoder.copyBufferToBuffer(this.hits, 0, this.readback, 0, 4 + MAX_HITS * 4);
      d.queue.submit([encoder.finish()]);
      await this.readback.mapAsync(GPUMapMode.READ);
      const out = new Uint32Array(this.readback.getMappedRange().slice(0));
      this.readback.unmap();
      const base = job.base;
      job.base += WORKGROUP * GROUPS;
      hashes += WORKGROUP * GROUPS;
      const count = Math.min(out[0], MAX_HITS);
      if (count && this.job?.seed === job.seed) {
        const shares = [];
        for (let i = 0; i < count; i++) {
          const nonce = `${job.prefix}${hex8(out[1 + i])}`;
          if (await leadingZeroBits(`${job.seed}:${job.name}:${nonce}`) >= job.difficulty) shares.push({ seed: job.seed, nonce });
          else this.onError?.(new Error('GPU hash mismatch: a hit failed the CPU check'));
        }
        if (shares.length) this.onShares?.(shares);
      }
      const now = performance.now();
      if (now - last > 1500) { this.onRate?.((hashes / (now - last)) * 1000, this.name); hashes = 0; last = now; }
      void base;
    }
  }
}
