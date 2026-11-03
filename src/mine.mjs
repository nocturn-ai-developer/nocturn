// The miner people see: asks the pool for work, hashes on worker threads and draws the screen.
import { readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { DATA_DIR } from './config.mjs';
import { detectHardware, readSensors, tuneThreads } from './hardware.mjs';

export const TICKER = 'NOCT';
const ACCOUNT_FILE = join(DATA_DIR, 'miner.json');
const clean = (s) => String(s).replace(/[\x00-\x1f\x7f]/g, '');
export const money = (cents) => (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const defaultThreads = () => Math.max(1, availableParallelism() - 1);

export function loadAccount() {
  try { return JSON.parse(readFileSync(ACCOUNT_FILE, 'utf8')); } catch { return null; }
}

export function loadWalletProof() {
  try { return JSON.parse(readFileSync(join(DATA_DIR, 'wallet.json'), 'utf8')); } catch { return null; }
}

export function saveAccount(account) {
  writeFileSync(ACCOUNT_FILE, JSON.stringify(account, null, 2), { mode: 0o600 });
}

// The token travels with every request, so anything but this machine has to be https.
export function checkPoolUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`Not a pool address: ${url}`); }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) throw new Error('The pool must use https.');
  return url.replace(/\/+$/, '');
}

export function poolClient(url, token) {
  return async (path, body) => {
    const res = await fetch(`${url}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const err = new Error(data.error ?? `http_${res.status}`); err.code = data.error; throw err; }
    return data;
  };
}

/* Screen */
const FONT = {
  N: ['#   #', '##  #', '# # #', '#  ##', '#   #'], O: [' ### ', '#   #', '#   #', '#   #', ' ### '],
  C: [' ####', '#    ', '#    ', '#    ', ' ####'], T: ['#####', '  #  ', '  #  ', '  #  ', '  #  '],
  U: ['#   #', '#   #', '#   #', '#   #', ' ### '], R: ['#### ', '#   #', '#### ', '#  # ', '#   #'],
};
export const WORD = [0, 1, 2, 3, 4].map((row) => [...'NOCTURN'].map((c) => FONT[c][row].replaceAll('#', '█')).join(' '));

function moon(rows = 11, cols = 24) {
  const lines = [];
  for (let y = 0; y < rows; y += 1) {
    let line = '';
    for (let x = 0; x < cols; x += 1) {
      const dx = (x - cols / 2 + 0.5) / (cols / 2);
      const dy = (y - rows / 2 + 0.5) / (rows / 2);
      const inDisc = dx * dx + dy * dy <= 0.95;
      const inBite = (dx - 0.42) ** 2 + (dy + 0.12) ** 2 <= 0.62;
      line += inDisc && !inBite ? ((x + y) % 2 ? '·' : '•') : ' ';
    }
    lines.push(line);
  }
  return lines;
}
export const MOON = moon();

const bar = (fraction, width = 26) => {
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
};
const clock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
};
export const rate = (perSecond) => {
  if (perSecond >= 1e6) return `${(perSecond / 1e6).toFixed(2)} MH/s`;
  if (perSecond >= 1e3) return `${(perSecond / 1e3).toFixed(1)} kH/s`;
  return `${perSecond.toFixed(0)} H/s`;
};

export function renderFrame(s, paint, columns = 80) {
  const { sage, dim, good, bold } = paint;
  const j = s.job;
  const label = (text) => dim(text.padEnd(12));
  const panel = [
    `${sage(bold('NOCTURN'))} ${bold('MINER')} ${dim('·')} ${clean(s.name)}${' '.repeat(Math.max(1, 28 - clean(s.name).length))}${dim(clock(Date.now() - s.started))}`,
    dim('─'.repeat(50)),
    `${label('HASHRATE')}${bold(rate(s.hashrate))}`,
  ];
  if (j) {
    const left = j.endsAt - (j.now + (Date.now() - s.jobAt));
    const round = Math.round((j.yourWork / Math.max(1, j.roundWork)) * 1000) / 10;
    const estimate = j.roundWork ? Math.floor(j.rewardCents * j.yourWork / j.roundWork) : 0;
    panel.push(
      `${label('JOB')}${bar(s.tried / 2 ** j.difficulty)} ${dim(`${j.difficulty} bits`)}`,
      `${label('ROUND')}${bar(1 - left / j.roundMs)} ${dim(`${clock(left).slice(3)} left · ${j.miners} miners`)}`,
      `${label('THIS ROUND')}${good(`+${money(estimate)} ${TICKER}`)} ${dim(`est. · ${round}% of ${money(j.rewardCents)}`)}`,
      `${label('LAST PAYOUT')}${j.lastPayout ? `${bold(`+${money(j.lastPayout.cents)} ${TICKER}`)} ${dim(new Date(j.lastPayout.at).toLocaleTimeString())}` : dim('none yet')}`,
      `${label('BALANCE')}${bold(`${money(j.cents)} ${TICKER}`)} ${dim(`+${money(j.cents - s.startCents)} this session`)}`,
    );
  } else panel.push(`${label('JOB')}${dim('waiting for the pool')}`);
  const hw = s.hardware;
  const gb = (bytes) => `${(bytes / 2 ** 30).toFixed(1)} GB`;
  const fit = (text) => (text.length > 44 ? `${text.slice(0, 43)}…` : text);
  const temp = s.sensors?.cpu ? `${Math.round(s.sensors.cpu.celsius)}°C ${dim(s.sensors.cpu.source === 'board' ? '(board sensor)' : '')}` : dim('no sensor this machine shares');
  panel.push(
    `${label('RIG')}CPU · ${s.active} of ${s.threads} threads ${dim(`· ${s.shares} shares`)}`,
    `${label('WALLET')}${j?.wallet ? `${j.wallet.slice(0, 6)}…${j.wallet.slice(-4)} ${dim('· linked')}` : dim(s.walletNote ?? 'none, connect one on the web page')}`,
    dim('─'.repeat(50)),
    `${label('PROCESSOR')}${hw ? fit(`${hw.cpu.model}${hw.cpu.cores ? ` · ${hw.cpu.cores} cores` : ''}`) : dim('reading…')}`,
    `${label('GRAPHICS')}${hw ? (hw.gpus.length ? `${fit(clean(hw.gpus.join(', ')))} ${dim('· not used')}` : dim('none found')) : dim('reading…')}`,
    `${label('TEMP')}${temp}${s.sensors?.gpuTemp ? `  ${dim('GPU')} ${s.sensors.gpuTemp}°C` : ''}`,
    `${label('MEMORY')}${hw && s.sensors ? `${gb(hw.ramTotal - s.sensors.ramFree)} used of ${gb(hw.ramTotal)}` : dim('reading…')}`,
    `${label('STORAGE')}${hw?.disk ? `${gb(hw.disk.free)} free of ${gb(hw.disk.total)}` : dim('unknown')}`,
    `${label('AUTO-TUNE')}${s.tuneNote ? sage(s.tuneNote) : dim('watching temperature and memory')}`,
    '',
    `${s.status === 'hashing' ? good('●') : dim('●')} ${dim(s.status)}${' '.repeat(Math.max(1, 34 - s.status.length))}${dim('ctrl+c to stop')}`,
  );
  const wide = columns >= 80;
  const lines = ['', ...WORD.map((line) => `  ${bold(line)}`), `  ${sage('MINE FROM THE TERMINAL')} ${dim('· sha-256 proof of work')}`, ''];
  const height = wide ? Math.max(panel.length, MOON.length) : panel.length;
  for (let i = 0; i < height; i += 1) lines.push(wide ? `  ${sage(MOON[i] ?? ' '.repeat(24))}  ${panel[i] ?? ''}` : `  ${panel[i] ?? ''}`);
  return lines;
}

/* Mining */
// Workers mine until `signal` aborts. `ask` puts a question to the person at the keyboard.
export async function runMiner({ account, threads, ask, draw, signal, api = poolClient(account.pool, account.token) }) {
  const state = { name: account.name, threads, active: threads, started: Date.now(), job: null, jobAt: Date.now(), hashrate: 0, tried: 0, shares: 0, startCents: null, status: 'connecting', hardware: null, sensors: null, tuneNote: null };
  let hashes = 0;
  let current = null;
  // Only the first `active` workers get the job; the rest sit idle until it is cool again.
  const send = (job) => {
    current = job;
    workers.forEach((w, i) => w.postMessage(i < state.active ? job : null));
  };

  function setJob(job) {
    const fresh = job.seed !== state.job?.seed || job.difficulty !== state.job?.difficulty;
    state.job = job;
    state.jobAt = Date.now();
    state.startCents ??= job.cents;
    if (fresh) { state.tried = 0; send({ seed: job.seed, name: account.name, difficulty: job.difficulty }); }
  }

  async function passCheck() {
    send(null);
    for (let tries = 0; tries < 3; tries += 1) {
      const { question } = await api('/check', {});
      const answer = await ask(`Anti-bot check, mining is paused. What is ${question}?`);
      if (answer === null) return false;
      try { await api('/check/answer', { answer }); return true; } catch (err) { if (err.code !== 'wrong_answer') throw err; }
    }
    throw new Error('Three wrong answers. Run nocturn mine again.');
  }

  async function guarded(fn) {
    try {
      setJob(await fn());
      state.status = 'hashing';
    } catch (err) {
      if (err.code === 'check_required') { state.status = 'waiting for the check'; state.needsCheck = true; }
      else if (err.code === 'unauthorized') throw new Error('The pool does not know this account. Delete miner.json and sign up again.');
      else if (err.code !== 'slow_down') { state.status = 'reconnecting'; }
    }
  }

  const workers = Array.from({ length: threads }, () => new Worker(new URL('./mine-worker.mjs', import.meta.url)));
  for (const w of workers) {
    w.on('message', (m) => {
      if (m.hashes) { hashes += m.hashes; state.tried += m.hashes; return; }
      if (m.seed !== state.job?.seed) return;
      guarded(async () => {
        const res = await api('/share', { seed: m.seed, nonce: m.nonce });
        if (res.accepted) { state.shares += 1; state.tried = 0; }
        return res;
      }).catch(fail);
    });
  }

  let failure = null;
  let wake = () => {};
  const fail = (err) => { failure = err; wake(); };
  let last = Date.now();
  const meter = setInterval(() => {
    const now = Date.now();
    const instant = (hashes / Math.max(1, now - last)) * 1000;
    state.hashrate = state.hashrate ? state.hashrate * 0.7 + instant * 0.3 : instant;
    hashes = 0;
    last = now;
    draw(state);
  }, 1000);
  const poller = setInterval(() => guarded(() => api('/job')).catch(fail), 2000);
  const proof = loadWalletProof();
  if (proof) api('/wallet', proof).then(() => { state.walletNote = null; }, () => { state.walletNote = 'the pool refused the wallet link'; });
  detectHardware().then((hw) => { state.hardware = hw; }, () => {});
  let lastChange = Date.now();
  const watch = async () => {
    const sensors = await readSensors().catch(() => null);
    if (!sensors || signal.aborted) return;
    state.sensors = sensors;
    const celsius = Math.max(sensors.cpu?.celsius ?? -1, sensors.gpuTemp ?? -1);
    const total = state.hardware?.ramTotal;
    const next = tuneThreads({ active: state.active, max: threads, celsius: celsius < 0 ? null : celsius, ramFreeRatio: total ? sensors.ramFree / total : null, now: Date.now(), lastChange });
    if (next.active !== state.active) {
      state.active = next.active;
      lastChange = Date.now();
      state.tuneNote = `${next.active} threads: ${next.reason}`;
      if (current) send(current);
    }
  };
  watch();
  const watcher = setInterval(watch, 15000);
  signal.addEventListener('abort', () => wake(), { once: true });

  try {
    state.needsCheck = true;
    while (!signal.aborted && !failure) {
      if (state.needsCheck) {
        state.needsCheck = false;
        state.job = null;
        if (!(await passCheck())) break;
        await guarded(() => api('/job'));
        continue;
      }
      await new Promise((resolve) => { wake = resolve; setTimeout(resolve, 250); });
    }
  } finally {
    clearInterval(meter);
    clearInterval(poller);
    clearInterval(watcher);
    await Promise.all(workers.map((w) => w.terminate()));
  }
  if (failure) throw failure;
  return state;
}
