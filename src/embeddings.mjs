// Semantic search over memories and workspace files. Every chunk gets an embedding and a BM25
// entry; a query is run through both and the two rankings are fused (reciprocal rank fusion), so
// meaning-level matches and exact words (file names, numbers, identifiers) both count.
//
// Embeddings come from the best backend available: Voyage when a key is set, an Ollama model when
// one is reachable, otherwise a built-in hashed-feature vector that needs nothing installed.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { DATA_DIR, WORKSPACE, config } from './config.mjs';

const META_FILE = join(DATA_DIR, 'index.json');
const VEC_FILE = join(DATA_DIR, 'index.vec');
const CHUNK = 700;
const STEP = 550;
const MAX_FILE = 512 * 1024;
const MAX_FILES = 5000;
const BATCH = 32;
const LOCAL_DIMS = 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', '.cache']);
const SKIP_EXT = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|zip|gz|7z|rar|mp[34]|mov|exe|dll|so|dylib|bin|sqlite|db)$/i;
const RRF_K = 60;

const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 24);

/* Text */
export function tokens(text) {
  return text.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((t) => t.length > 1).map((t) => (t.length > 4 && t.endsWith('s') ? t.slice(0, -1) : t));
}

export function chunk(text) {
  const clean = text.replace(/\r\n?/g, '\n').trim();
  if (clean.length <= CHUNK) return clean ? [{ pos: 0, text: clean }] : [];
  const out = [];
  let pos = 0;
  while (pos < clean.length) {
    let end = Math.min(clean.length, pos + CHUNK);
    if (end < clean.length) {
      const nl = clean.lastIndexOf('\n', end);
      if (nl > pos + CHUNK / 2) end = nl;
    }
    out.push({ pos, text: clean.slice(pos, end).trim() });
    if (end >= clean.length) break;
    pos = Math.max(pos + 1, end - (CHUNK - STEP));
  }
  return out.filter((c) => c.text);
}

/* Local embedding: hashed word and character trigram features, sign-hashed, L2 normalized. */
function localEmbed(text) {
  const vec = new Float32Array(LOCAL_DIMS);
  const words = tokens(text);
  const bump = (key, weight) => {
    const h = createHash('md5').update(key).digest();
    const idx = h.readUInt32LE(0) % LOCAL_DIMS;
    vec[idx] += (h[4] & 1 ? 1 : -1) * weight;
  };
  for (let i = 0; i < words.length; i++) {
    bump(`w:${words[i]}`, 1);
    if (i) bump(`b:${words[i - 1]} ${words[i]}`, 0.6);
    const w = `_${words[i]}_`;
    for (let j = 0; j + 3 <= w.length; j++) bump(`c:${w.slice(j, j + 3)}`, 0.35);
  }
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

/* Backends */
const settings = () => ({ provider: 'auto', model: '', baseUrl: '', voyageKey: '', ...(config.embeddings ?? {}) });

async function voyageEmbed(texts, kind, s) {
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${s.voyageKey}` },
    body: JSON.stringify({ input: texts, model: s.model || 'voyage-3-large', input_type: kind }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`Voyage answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const { data } = await res.json();
  return data.sort((a, b) => a.index - b.index).map((d) => Float32Array.from(d.embedding));
}

const ollamaBase = (s) => (s.baseUrl || config.openaiBaseUrl || 'http://localhost:11434/v1').replace(/\/$/, '');

async function ollamaEmbed(texts, s) {
  const res = await fetch(`${ollamaBase(s)}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(config.openaiKey ? { authorization: `Bearer ${config.openaiKey}` } : {}) },
    body: JSON.stringify({ input: texts, model: s.model || 'nomic-embed-text' }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`Embedding endpoint answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const { data } = await res.json();
  return data.sort((a, b) => a.index - b.index).map((d) => Float32Array.from(d.embedding));
}

async function ollamaReachable(s) {
  try {
    const res = await fetch(`${ollamaBase(s)}/models`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return false;
    const { data } = await res.json();
    const want = s.model || 'nomic-embed-text';
    return (data ?? []).some((m) => String(m.id).split(':')[0] === want.split(':')[0]) ? true : 'missing-model';
  } catch { return false; }
}

export const embedder = {
  status: { provider: 'local', model: 'hashed-features', ready: true, note: 'Built-in. Add an Ollama embedding model or a Voyage key for sharper results.' },
  decided: null,
  async decide(force = false) {
    if (this.decided && !force) return this.decided;
    const s = settings();
    let choice = s.provider;
    if (choice === 'auto') {
      if (s.voyageKey) choice = 'voyage';
      else {
        const o = await ollamaReachable(s);
        choice = o === true ? 'ollama' : 'local';
        if (o === 'missing-model') this.status.note = `Ollama is up but has no ${s.model || 'nomic-embed-text'}. Run: ollama pull ${s.model || 'nomic-embed-text'}`;
      }
    }
    if (choice === 'voyage') this.status = { provider: 'voyage', model: s.model || 'voyage-3-large', ready: Boolean(s.voyageKey), note: s.voyageKey ? '' : 'Set a Voyage API key in Settings.' };
    else if (choice === 'ollama') this.status = { provider: 'ollama', model: s.model || 'nomic-embed-text', ready: true, note: `${ollamaBase(s)}/embeddings` };
    else this.status = { provider: 'local', model: 'hashed-features', ready: true, note: this.status.note };
    this.decided = this.status.provider;
    return this.decided;
  },
  // kind is 'document' or 'query'; Voyage uses it, the others ignore it.
  async embed(texts, kind = 'document') {
    const provider = await this.decide();
    const s = settings();
    if (provider === 'voyage') return voyageEmbed(texts, kind, s);
    if (provider === 'ollama') return ollamaEmbed(texts, s);
    return texts.map(localEmbed);
  },
  reset() { this.decided = null; },
};

/* Index */
function readIndex() {
  try {
    const meta = JSON.parse(readFileSync(META_FILE, 'utf8'));
    const raw = readFileSync(VEC_FILE);
    const dims = meta.dims;
    const vectors = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
    if (vectors.length !== meta.entries.length * dims) throw new Error('vector file does not match');
    return { ...meta, vectors };
  } catch {
    return { provider: '', model: '', dims: 0, entries: [], vectors: new Float32Array(0) };
  }
}

function writeIndex(index) {
  const tmp = `${VEC_FILE}.tmp`;
  writeFileSync(tmp, Buffer.from(index.vectors.buffer, index.vectors.byteOffset, index.vectors.byteLength));
  renameSync(tmp, VEC_FILE);
  const { vectors, ...meta } = index;
  writeFileSync(`${META_FILE}.tmp`, JSON.stringify(meta));
  renameSync(`${META_FILE}.tmp`, META_FILE);
}

function listFiles(dir, out = [], base = dir) {
  if (out.length >= MAX_FILES) return out;
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) listFiles(full, out, base);
    else if (e.isFile() && !SKIP_EXT.test(e.name)) {
      try {
        const st = statSync(full);
        if (st.size > 0 && st.size <= MAX_FILE) out.push({ path: relative(base, full).split(sep).join('/'), full, mtime: st.mtimeMs, size: st.size });
      } catch { /* vanished */ }
    }
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

const isText = (buf) => !buf.subarray(0, 4096).includes(0);

export class SearchIndex {
  constructor({ workspace = WORKSPACE, memories = () => [] } = {}) {
    this.workspace = workspace;
    this.memories = memories;
    this.index = readIndex();
    this.bm25 = null;
    this.timer = null;
    this.building = null;
  }

  get size() { return this.index.entries.length; }

  // Re-embeds only what changed. Safe to call often.
  refresh() {
    if (this.building) return this.building;
    this.building = this.#refresh().finally(() => { this.building = null; });
    return this.building;
  }

  schedule(delay = 1500) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh().catch(() => {}), delay);
    this.timer.unref?.();
  }

  async #refresh() {
    await embedder.decide();
    const { provider, model } = embedder.status;
    const wanted = new Map(); // key -> { kind, path, pos, text, hash }
    for (const m of this.memories()) {
      const text = String(m.text ?? '').trim();
      if (text) wanted.set(`memory:${m.id}:0`, { kind: 'memory', path: m.id, pos: 0, text, hash: sha(text) });
    }
    for (const f of listFiles(this.workspace)) {
      let buf;
      try { buf = readFileSync(f.full); } catch { continue; }
      if (!isText(buf)) continue;
      const body = buf.toString('utf8');
      const fileHash = sha(body);
      for (const c of chunk(body)) wanted.set(`file:${f.path}:${c.pos}`, { kind: 'file', path: f.path, pos: c.pos, text: c.text, hash: fileHash });
    }
    const sameBackend = this.index.provider === provider && this.index.model === model;
    const keep = new Map();
    if (sameBackend) {
      this.index.entries.forEach((e, i) => {
        const key = `${e.kind}:${e.path}:${e.pos}`;
        const w = wanted.get(key);
        if (w && w.hash === e.hash) keep.set(key, i);
      });
    }
    const fresh = [...wanted].filter(([key]) => !keep.has(key));
    const vectors = [];
    for (let i = 0; i < fresh.length; i += BATCH) {
      const slice = fresh.slice(i, i + BATCH);
      vectors.push(...await embedder.embed(slice.map(([, w]) => `${w.kind === 'file' ? `${w.path}\n` : ''}${w.text}`), 'document'));
    }
    const dims = vectors[0]?.length ?? (keep.size ? this.index.dims : 0);
    const entries = [];
    const out = new Float32Array(wanted.size * dims);
    let n = 0;
    const put = (entry, vec) => { entries.push(entry); out.set(vec, n * dims); n++; };
    for (const [key, i] of keep) put(this.index.entries[i], this.index.vectors.subarray(i * this.index.dims, (i + 1) * this.index.dims)), keep.set(key, i);
    fresh.forEach(([, w], i) => put({ kind: w.kind, path: w.path, pos: w.pos, text: w.text, hash: w.hash }, vectors[i]));
    this.index = { provider, model, dims, entries, vectors: out.subarray(0, n * dims), updated: new Date().toISOString() };
    this.bm25 = null;
    writeIndex(this.index);
    return { entries: entries.length, embedded: fresh.length, provider, model };
  }

  #lexical() {
    if (this.bm25) return this.bm25;
    const docs = this.index.entries.map((e) => tokens(`${e.path} ${e.text}`));
    const df = new Map();
    for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
    const avgdl = docs.reduce((a, d) => a + d.length, 0) / Math.max(1, docs.length);
    this.bm25 = { docs, df, avgdl, N: docs.length };
    return this.bm25;
  }

  #bm25Scores(query) {
    const { docs, df, avgdl, N } = this.#lexical();
    const q = [...new Set(tokens(query))];
    const k1 = 1.4;
    const b = 0.75;
    return docs.map((d) => {
      if (!d.length) return 0;
      const tf = new Map();
      for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
      let score = 0;
      for (const t of q) {
        const f = tf.get(t);
        if (!f) continue;
        const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
        score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.length / avgdl));
      }
      return score;
    });
  }

  async search(query, { kinds = ['memory', 'file'], limit = 8 } = {}) {
    const text = String(query ?? '').trim();
    const allowed = this.index.entries.map((e) => kinds.includes(e.kind));
    if (!this.index.entries.length) return [];
    if (!text) return this.index.entries.map((e, i) => ({ ...e, score: 0, i })).filter((e) => allowed[e.i]).slice(0, limit);
    const [qv] = await embedder.embed([text], 'query');
    const dims = this.index.dims;
    const cosine = new Float32Array(this.index.entries.length);
    if (qv && qv.length === dims) {
      let qn = 0;
      for (const v of qv) qn += v * v;
      qn = Math.sqrt(qn) || 1;
      for (let i = 0; i < cosine.length; i++) {
        let dot = 0;
        let dn = 0;
        const off = i * dims;
        for (let j = 0; j < dims; j++) { const d = this.index.vectors[off + j]; dot += d * qv[j]; dn += d * d; }
        cosine[i] = dot / ((Math.sqrt(dn) || 1) * qn);
      }
    }
    const lexical = this.#bm25Scores(text);
    const rank = (scores) => scores.map((s, i) => [s, i]).filter(([s, i]) => allowed[i] && s > 0).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
    const fused = new Map();
    for (const list of [rank([...cosine]), rank(lexical)]) list.forEach((i, r) => fused.set(i, (fused.get(i) ?? 0) + 1 / (RRF_K + r)));
    return [...fused].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([i, score]) => ({ ...this.index.entries[i], score: Number(score.toFixed(4)), similarity: Number(cosine[i].toFixed(3)) }));
  }
}

export const snippet = (text, query, width = 240) => {
  const q = tokens(query);
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of q) { at = lower.indexOf(t); if (at >= 0) break; }
  const start = Math.max(0, (at < 0 ? 0 : at) - width / 3);
  const cut = text.slice(start, start + width).replace(/\s+/g, ' ').trim();
  return `${start ? '…' : ''}${cut}${start + width < text.length ? '…' : ''}`;
};
