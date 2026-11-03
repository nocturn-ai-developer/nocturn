// The server every miner connects to. It hands out a job each round, checks every share itself and
// splits the round's reward by the work done. Balances are numbers in this server's file, not coins
// on a blockchain.
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { leadingZeroBits, shareHash } from './pow.mjs';
import { checkWalletProof } from './wallet-proof.mjs';

// A passed check lasts while the miner keeps talking to the pool, so a rig can run for days.
const CHECK_IDLE_LIMIT = 30 * 60 * 1000;
const MIN_DIFFICULTY = 8;
const MAX_DIFFICULTY = 44;
const MAX_SHARES_PER_SECOND = 20;
const REGISTER_LIMIT = 5;
const hashToken = (token) => createHash('sha256').update(token).digest('hex');

class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; }
}

export function startPool({ port = 18800, host = '127.0.0.1', file, roundMs = 60000, rewardCents = 10000, startDifficulty = 20, trustProxy = false, checkIdleMs = CHECK_IDLE_LIMIT }) {
  let saved = { accounts: {} };
  try { saved = JSON.parse(readFileSync(file, 'utf8')); } catch { /* first run */ }
  const accounts = saved.accounts;
  const byToken = new Map(Object.entries(accounts).map(([name, a]) => [a.tokenHash, name]));
  const live = new Map(); // per miner state that does not need to survive a restart
  const registers = new Map();
  let round = { seed: randomBytes(16).toString('hex'), endsAt: Date.now() + roundMs, work: new Map(), seen: new Set() };

  function persist() {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify({ accounts }), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }

  function liveOf(name) {
    if (!live.has(name)) live.set(name, { difficulty: startDifficulty, lastShare: 0, adjusted: Date.now(), pending: null, window: [] });
    return live.get(name);
  }

  function closeRound() {
    const total = [...round.work.values()].reduce((a, b) => a + b, 0);
    for (const [name, work] of round.work) {
      const cents = Math.floor(rewardCents * work / total);
      accounts[name].cents += cents;
      accounts[name].lastPayout = { cents, at: new Date().toISOString() };
    }
    if (total) persist();
    round = { seed: randomBytes(16).toString('hex'), endsAt: Date.now() + roundMs, work: new Map(), seen: new Set() };
  }
  const timer = setInterval(closeRound, roundMs);

  function job(name) {
    const state = liveOf(name);
    const now = Date.now();
    // Nothing found for a while: this machine is slower than its difficulty assumes.
    if (now - Math.max(state.lastShare, state.adjusted) > 20000 && state.difficulty > MIN_DIFFICULTY) {
      state.difficulty -= 1;
      state.adjusted = now;
    }
    const total = [...round.work.values()].reduce((a, b) => a + b, 0);
    return {
      seed: round.seed, difficulty: state.difficulty, endsAt: round.endsAt, roundMs, rewardCents, now,
      miners: [...live.values()].filter((s) => now - s.lastShare < 120000).length,
      roundWork: total, yourWork: round.work.get(name) ?? 0,
      cents: accounts[name].cents, lastPayout: accounts[name].lastPayout ?? null, wallet: accounts[name].wallet ?? null,
    };
  }

  function requireCheck(name) {
    const now = Date.now();
    if (now > (accounts[name].checkedUntil ?? 0)) throw new HttpError(403, 'check_required');
    accounts[name].checkedUntil = now + checkIdleMs;
  }

  const routes = {
    'POST /register': (body, _, ip) => {
      const name = String(body.name ?? '').toLowerCase();
      if (!/^[a-z0-9_-]{3,20}$/.test(name)) throw new HttpError(400, 'bad_name');
      if (accounts[name]) throw new HttpError(409, 'name_taken');
      const now = Date.now();
      const recent = (registers.get(ip) ?? []).filter((t) => now - t < 3600000);
      if (recent.length >= REGISTER_LIMIT) throw new HttpError(429, 'too_many_accounts');
      registers.set(ip, [...recent, now]);
      const token = randomBytes(24).toString('hex');
      accounts[name] = { tokenHash: hashToken(token), cents: 0, created: new Date().toISOString() };
      byToken.set(accounts[name].tokenHash, name);
      persist();
      return { name, token };
    },
    'POST /check': (_, name) => {
      const a = 2 + Math.floor(Math.random() * 18);
      const b = 2 + Math.floor(Math.random() * 18);
      liveOf(name).pending = a + b;
      return { question: `${a} + ${b}` };
    },
    'POST /check/answer': (body, name) => {
      const state = liveOf(name);
      const right = state.pending !== null && Number(body.answer) === state.pending;
      state.pending = null; // one try per question
      if (!right) throw new HttpError(403, 'wrong_answer');
      accounts[name].checkedUntil = Date.now() + checkIdleMs;
      persist(); // a pool restart must not stop a rig nobody is watching
      return { ok: true };
    },
    'GET /job': (_, name) => {
      requireCheck(name);
      return job(name);
    },
    'GET /balance': (_, name) => ({ cents: accounts[name].cents, wallet: accounts[name].wallet ?? null }),
    // Only the account's own token can set this, and only with a signature from that wallet.
    'POST /wallet': (body, name) => {
      let proof;
      try { proof = checkWalletProof(body); } catch { throw new HttpError(400, 'bad_wallet_proof'); }
      accounts[name].wallet = proof.address;
      persist();
      return { wallet: proof.address };
    },
    'POST /share': (body, name) => {
      const state = liveOf(name);
      requireCheck(name);
      const now = Date.now();
      state.window = state.window.filter((t) => now - t < 1000);
      if (state.window.length >= MAX_SHARES_PER_SECOND) throw new HttpError(429, 'slow_down');
      state.window.push(now);
      const nonce = String(body.nonce ?? '');
      if (body.seed !== round.seed) return { accepted: false, reason: 'stale', ...job(name) };
      if (!nonce || nonce.length > 64) throw new HttpError(400, 'bad_nonce');
      const key = `${name}:${nonce}`;
      if (round.seen.has(key)) return { accepted: false, reason: 'duplicate', ...job(name) };
      if (leadingZeroBits(shareHash(round.seed, name, nonce)) < state.difficulty) return { accepted: false, reason: 'low', ...job(name) };
      round.seen.add(key);
      round.work.set(name, (round.work.get(name) ?? 0) + 2 ** state.difficulty);
      const gap = state.lastShare ? now - state.lastShare : Infinity;
      state.lastShare = now;
      if (gap < 2500 && state.difficulty < MAX_DIFFICULTY) state.difficulty += 1;
      state.adjusted = now;
      return { accepted: true, ...job(name) };
    },
  };

  const server = createServer((req, res) => {
    const send = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 2048) { send(413, { error: 'too_large' }); req.destroy(); }
    });
    req.on('end', () => {
      try {
        const route = routes[`${req.method} ${req.url}`];
        if (!route) throw new HttpError(404, 'not_found');
        const open = req.url === '/register';
        const name = byToken.get(hashToken(String(req.headers.authorization ?? '').replace(/^Bearer /, '')));
        if (!open && !name) throw new HttpError(401, 'unauthorized');
        const forwarded = trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '';
        let body = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, 'bad_json'); }
        send(200, route(body ?? {}, name, forwarded || req.socket.remoteAddress));
      } catch (err) {
        if (!(err instanceof HttpError)) { console.error(err); send(500, { error: 'server_error' }); return; }
        send(err.status, { error: err.message });
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve({
      port: server.address().port,
      closeRound,
      close: () => { clearInterval(timer); persist(); server.close(); server.closeAllConnections(); },
    }));
  });
}
