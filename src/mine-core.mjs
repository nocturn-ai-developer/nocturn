// The miner as a service: the same job/check/share loop the terminal miner runs, driven by events
// instead of a screen, so the control panel and the desktop app can start it, answer the check,
// and add shares found on the GPU. CPU hashing stays in worker threads here; GPU hashing happens
// in the panel (WebGPU) and arrives through addShares().
import { EventEmitter } from 'node:events';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { detectHardware, readSensors, tuneThreads } from './hardware.mjs';
import { checkPoolUrl, defaultThreads, loadAccount, loadWalletProof, poolClient, saveAccount } from './mine.mjs';
import { config } from './config.mjs';

export class MinerCore extends EventEmitter {
  state = { status: 'idle', name: null, pool: null, threads: 0, active: 0, started: null, job: null, jobAt: 0, hashrate: 0, gpuHashrate: 0, gpu: null, tried: 0, shares: 0, gpuShares: 0, startCents: null, hardware: null, sensors: null, tuneNote: null, question: null, error: null, walletNote: null };
  workers = [];
  timers = [];
  api = null;
  current = null;
  hashes = 0;
  stopping = false;

  poolUrl(explicit) {
    const url = explicit || config.mining?.pool || process.env.NOCTURN_POOL || loadAccount()?.pool || '';
    if (!url) throw new Error('No mining pool is set. Add one in Settings or pass --pool.');
    return checkPoolUrl(url);
  }

  get running() { return this.state.status !== 'idle' && this.state.status !== 'stopped' && this.state.status !== 'error'; }

  snapshot() {
    const { job } = this.state;
    return { ...this.state, maxThreads: availableParallelism(), job: job && { ...job, left: Math.max(0, job.endsAt - (job.now + (Date.now() - this.state.jobAt))) } };
  }

  #emit() { this.emit('state', this.snapshot()); }

  async register(name, pool) {
    const url = this.poolUrl(pool);
    const account = { ...(await poolClient(url)('/register', { name })), pool: url };
    saveAccount(account);
    return { name: account.name, pool: url };
  }

  // The saved account for the pool in use, or null when there is no pool or no account yet.
  account(pool) {
    let url;
    try { url = this.poolUrl(pool); } catch { return null; }
    const saved = loadAccount();
    return saved && saved.pool === url ? saved : null;
  }

  // Starts hashing. Resolves once the job loop is up; the check question arrives as a 'question' event.
  async start({ threads = defaultThreads(), pool = '', gpu = true } = {}) {
    if (this.running) throw new Error('The miner is already running.');
    const account = this.account(pool);
    if (!account) throw new Error('No miner account for this pool yet. Pick a name first.');
    threads = Math.max(0, Math.min(availableParallelism(), Number(threads) || 0));
    this.api = poolClient(account.pool, account.token);
    this.stopping = false;
    this.hashes = 0;
    Object.assign(this.state, { status: 'connecting', name: account.name, pool: account.pool, threads, active: threads, started: Date.now(), job: null, jobAt: Date.now(), hashrate: 0, gpuHashrate: 0, gpu: gpu ? 'waiting' : 'off', tried: 0, shares: 0, gpuShares: 0, startCents: null, tuneNote: null, question: null, error: null });

    this.workers = Array.from({ length: threads }, () => new Worker(new URL('./mine-worker.mjs', import.meta.url)));
    for (const w of this.workers) {
      w.on('message', (m) => {
        if (m.hashes) { this.hashes += m.hashes; this.state.tried += m.hashes; return; }
        if (m.seed !== this.state.job?.seed) return;
        this.#submit(m.seed, m.nonce, 'cpu').catch(() => {});
      });
      w.on('error', () => {});
    }

    let last = Date.now();
    this.timers.push(setInterval(() => {
      const now = Date.now();
      const instant = (this.hashes / Math.max(1, now - last)) * 1000;
      this.state.hashrate = this.state.hashrate ? this.state.hashrate * 0.7 + instant * 0.3 : instant;
      this.hashes = 0;
      last = now;
      this.#emit();
    }, 1000));
    this.timers.push(setInterval(() => this.#guarded(() => this.api('/job')), 2000));
    detectHardware().then((hw) => { this.state.hardware = hw; }, () => {});
    const proof = loadWalletProof();
    if (proof) this.api('/wallet', proof).then(() => { this.state.walletNote = null; }, () => { this.state.walletNote = 'the pool refused the wallet link'; });
    let lastChange = Date.now();
    const watch = async () => {
      const sensors = await readSensors().catch(() => null);
      if (!sensors || !this.running) return;
      this.state.sensors = sensors;
      const celsius = Math.max(sensors.cpu?.celsius ?? -1, sensors.gpuTemp ?? -1);
      const total = this.state.hardware?.ramTotal;
      const next = tuneThreads({ active: this.state.active, max: this.state.threads, celsius: celsius < 0 ? null : celsius, ramFreeRatio: total ? sensors.ramFree / total : null, now: Date.now(), lastChange });
      if (next.active !== this.state.active) {
        this.state.active = next.active;
        lastChange = Date.now();
        this.state.tuneNote = `${next.active} threads: ${next.reason}`;
        if (this.current) this.#send(this.current);
      }
    };
    watch();
    this.timers.push(setInterval(watch, 15000));
    await this.#guarded(() => this.api('/job'));
    this.#emit();
    return this.snapshot();
  }

  async stop() {
    if (!this.running && !this.workers.length) return;
    this.stopping = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await Promise.all(this.workers.map((w) => w.terminate()));
    this.workers = [];
    this.current = null;
    Object.assign(this.state, { status: 'stopped', job: null, question: null, hashrate: 0, gpuHashrate: 0, gpu: null });
    this.#emit();
  }

  // The owner's answer to the anti-bot check.
  async answer(text) {
    if (!this.state.question) throw new Error('Nothing is waiting for an answer.');
    try {
      await this.api('/check/answer', { answer: String(text).trim() });
      this.state.question = null;
      this.state.error = null;
      await this.#guarded(() => this.api('/job'));
      this.#emit();
      return true;
    } catch (err) {
      if (err.code !== 'wrong_answer') throw err;
      await this.#askCheck();
      return false;
    }
  }

  // Shares found elsewhere (the GPU in the panel). Returns how many the pool accepted.
  async addShares(shares) {
    let accepted = 0;
    for (const s of shares.slice(0, 50)) {
      if (!s || s.seed !== this.state.job?.seed || typeof s.nonce !== 'string' || s.nonce.length > 64) continue;
      if (await this.#submit(s.seed, s.nonce, 'gpu')) accepted++;
    }
    return accepted;
  }

  reportGpu({ hashrate, active, name }) {
    this.state.gpuHashrate = Math.max(0, Number(hashrate) || 0);
    this.state.gpu = active ? (name || 'on') : 'off';
  }

  // The job to hash: the first `active` workers get it, the rest idle until it is cool again.
  #send(job) {
    this.current = job;
    this.workers.forEach((w, i) => w.postMessage(i < this.state.active ? job : null));
  }

  #setJob(job) {
    const fresh = job.seed !== this.state.job?.seed || job.difficulty !== this.state.job?.difficulty;
    this.state.job = job;
    this.state.jobAt = Date.now();
    this.state.startCents ??= job.cents;
    if (fresh) { this.state.tried = 0; this.#send({ seed: job.seed, name: this.state.name, difficulty: job.difficulty }); this.emit('job', { seed: job.seed, name: this.state.name, difficulty: job.difficulty }); }
  }

  async #askCheck() {
    this.#send(null);
    const { question } = await this.api('/check', {});
    this.state.status = 'waiting for the check';
    this.state.question = question;
    this.emit('question', { question });
    this.#emit();
  }

  async #guarded(fn) {
    if (this.stopping) return;
    try {
      this.#setJob(await fn());
      if (this.state.status !== 'hashing') { this.state.status = 'hashing'; this.#emit(); }
    } catch (err) {
      if (err.code === 'check_required') { if (!this.state.question) await this.#askCheck().catch(() => {}); }
      else if (err.code === 'unauthorized') { this.state.error = 'The pool does not know this account. Pick a name again.'; this.state.status = 'error'; await this.stop(); }
      else if (err.code !== 'slow_down' && err.code !== 'wrong_answer') { this.state.status = 'reconnecting'; this.#emit(); }
    }
  }

  // Submits one share. The pool rate-limits to 20 a second, so a burst waits its turn instead of
  // losing work; that matters most for the GPU at low difficulty.
  async #submit(seed, nonce, source) {
    let accepted = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      if (this.stopping || seed !== this.state.job?.seed) return false;
      let slow = false;
      await this.#guarded(async () => {
        try {
          const res = await this.api('/share', { seed, nonce });
          if (res.accepted) { accepted = true; if (source === 'gpu') this.state.gpuShares++; else { this.state.shares++; this.state.tried = 0; } }
          return res;
        } catch (err) { if (err.code === 'slow_down') slow = true; throw err; }
      });
      if (!slow) break;
      await new Promise((r) => setTimeout(r, 120 + Math.random() * 200));
    }
    return accepted;
  }
}

export const miner = new MinerCore();
