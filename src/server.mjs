import { timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { AUTH_TOKEN, DATA_DIR, PUBLIC_DIR, SKILLS_DIR, config, redactedConfig, updateConfig } from './config.mjs';
import { sessions, validSessionId } from './agent.mjs';
import { memory, skills, toolNames } from './tools.mjs';
import { partners } from './partners.mjs';
import { checkWalletProof } from './wallet-proof.mjs';

const WALLET_FILE = join(DATA_DIR, 'wallet.json');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' };
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
// Opt in to more hostnames (a Tailscale or LAN address) for the mobile app. The token is still required.
const TRUSTED_HOSTS = new Set((process.env.NOCTURN_TRUSTED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean));
const MAX_BODY = 1024 * 1024;

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((done, fail) => {
    let size = 0;
    const parts = [];
    req.on('data', (d) => {
      size += d.length;
      if (size > MAX_BODY) { fail(new HttpError(413, 'Body too large')); req.destroy(); return; }
      parts.push(d);
    });
    req.on('end', () => {
      if (!parts.length) return done({});
      try { done(JSON.parse(Buffer.concat(parts).toString('utf8'))); } catch { fail(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', fail);
  });
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function authorized(req) {
  const given = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer /, ''));
  const expected = Buffer.from(AUTH_TOKEN);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// Rejecting foreign Host and Origin values blocks DNS rebinding and cross-site requests.
function trustedRequest(req) {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
  if (!LOCAL_HOSTS.has(host) && !TRUSTED_HOSTS.has(host)) return false;
  const origin = req.headers.origin;
  return !origin || origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`;
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const file = resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + sep) || !existsSync(file) || !statSync(file).isFile()) {
    return send(res, 404, { error: 'Not found' });
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache', ...SECURITY_HEADERS });
  createReadStream(file).pipe(res);
}

function str(value, name, max = 100000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new HttpError(400, `Invalid ${name}`);
  return value;
}

export function startServer({ agent, channels, scheduler, port, host = '127.0.0.1' }) {
  const clients = new Set();
  agent.on('event', (event) => {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) client.write(line);
  });

  const state = () => ({
    config: redactedConfig(),
    toolNames,
    sessions: sessions.list(),
    approvals: agent.pendingApprovals(),
    running: [...agent.running.keys()],
    channelStatus: channels.status,
    pairing: channels.pairingRequests(),
    jobs: scheduler.jobs,
    skills: skills.list(),
    memory: memory.list(),
    credentials: {
      anthropic: Boolean(config.anthropicKey || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
      openai: Boolean(config.openaiModel),
    },
  });

  async function api(req, res, pathname) {
    const method = req.method;
    const parts = pathname.split('/').filter(Boolean).slice(1);
    const [resource, id, action] = parts;

    if (resource === 'events' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...SECURITY_HEADERS });
      res.write(': connected\n\n');
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }
    if (resource === 'state' && method === 'GET') return send(res, 200, state());

    if (resource === 'config' && method === 'PUT') {
      const body = await readBody(req);
      updateConfig(body);
      if (body.channels) channels.restart();
      return send(res, 200, state());
    }

    if (resource === 'sessions') {
      if (!id && method === 'POST') { const s = sessions.create(); agent.emit('event', { type: 'sessions_changed' }); return send(res, 201, s); }
      if (!id || !validSessionId(id)) throw new HttpError(400, 'Invalid session id');
      if (!action && method === 'GET') {
        const session = sessions.get(id);
        if (!session) throw new HttpError(404, 'No such session');
        return send(res, 200, session);
      }
      if (!action && method === 'DELETE') {
        agent.stop(id);
        sessions.remove(id);
        agent.emit('event', { type: 'sessions_changed' });
        return send(res, 200, { ok: true });
      }
      if (action === 'messages' && method === 'POST') {
        const { text } = await readBody(req);
        agent.run(id, str(text, 'text')).catch(() => {}); // failures reach the UI as turn_error events
        return send(res, 202, { ok: true });
      }
      if (action === 'stop' && method === 'POST') { agent.stop(id); return send(res, 200, { ok: true }); }
    }

    if (resource === 'approvals' && id && method === 'POST') {
      const { approved } = await readBody(req);
      if (!agent.resolveApproval(id, approved === true)) throw new HttpError(404, 'No such approval');
      return send(res, 200, { ok: true });
    }

    if (resource === 'pairing' && id && method === 'POST') {
      const { approve } = await readBody(req);
      if (!channels.resolvePairing(id, approve === true)) throw new HttpError(404, 'No such code');
      return send(res, 200, state());
    }

    if (resource === 'message' && method === 'POST') {
      const { target, text } = await readBody(req);
      try { await channels.send(str(target, 'target', 200), str(text, 'text')); } catch (err) { throw new HttpError(err.status ?? 400, err.message); }
      return send(res, 200, { ok: true });
    }

    if (resource === 'allow' && method === 'POST') {
      const { channel, sender } = await readBody(req);
      if (!config.channels[channel]) throw new HttpError(400, 'Invalid channel');
      updateConfig({ channels: { [channel]: { allow: config.channels[channel].allow.filter((s) => s !== sender) } } });
      return send(res, 200, state());
    }

    if (resource === 'jobs') {
      try {
        if (!id && method === 'POST') {
          const { name, cron, prompt, deliver } = await readBody(req);
          scheduler.add({ name: str(name, 'name', 200), cron: str(cron, 'cron', 100), prompt: str(prompt, 'prompt'), deliver: typeof deliver === 'string' ? deliver : '' });
          return send(res, 201, state());
        }
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(400, err.message);
      }
      const job = scheduler.jobs.find((j) => j.id === id);
      if (!job) throw new HttpError(404, 'No such job');
      if (action === 'run' && method === 'POST') { scheduler.fire(job); return send(res, 202, { ok: true }); }
      if (!action && method === 'PATCH') { scheduler.update(id, await readBody(req)); return send(res, 200, state()); }
      if (!action && method === 'DELETE') { scheduler.remove(id); return send(res, 200, state()); }
    }

    if (resource === 'skills') {
      if (!id && method === 'POST') {
        const { name, description, instructions } = await readBody(req);
        if (!skills.validName(name)) throw new HttpError(400, 'Use lowercase letters, digits and dashes for the name');
        const dir = join(SKILLS_DIR, name);
        mkdirSync(dir, { recursive: true });
        const summary = str(description, 'description', 500).replace(/\s+/g, ' ');
        writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${summary}\n---\n\n${str(instructions, 'instructions')}\n`);
        return send(res, 201, state());
      }
      if (id && method === 'DELETE') {
        if (!skills.validName(id)) throw new HttpError(400, 'Invalid skill name');
        rmSync(join(SKILLS_DIR, id), { recursive: true, force: true });
        return send(res, 200, state());
      }
    }

    if (resource === 'memory') {
      if (!id && method === 'POST') { const { text } = await readBody(req); memory.add(str(text, 'text', 5000)); return send(res, 201, state()); }
      if (id && method === 'DELETE') { memory.remove(id); return send(res, 200, state()); }
    }

    if (resource === 'wallet') {
      if (method === 'GET') {
        try { return send(res, 200, { address: JSON.parse(readFileSync(WALLET_FILE, 'utf8')).address }); } catch { return send(res, 200, {}); }
      }
      if (method === 'POST') {
        let proof;
        try { proof = checkWalletProof(await readBody(req)); } catch (err) { throw new HttpError(400, err.message); }
        writeFileSync(WALLET_FILE, JSON.stringify(proof, null, 2), { mode: 0o600 });
        return send(res, 200, { address: proof.address });
      }
      if (method === 'DELETE') { rmSync(WALLET_FILE, { force: true }); return send(res, 200, {}); }
    }

    if (resource === 'partners') {
      if (!id && method === 'GET') return send(res, 200, partners.list());
      if (!id && method === 'POST') {
        const { name, logo } = await readBody(req);
        try { return send(res, 201, partners.add(name, logo)); } catch (err) { throw new HttpError(400, err.message); }
      }
      if (id && method === 'DELETE') return send(res, 200, partners.remove(id));
    }

    throw new HttpError(404, 'Not found');
  }

  const server = createServer(async (req, res) => {
    try {
      if (!trustedRequest(req)) return send(res, 403, { error: 'Forbidden host or origin' });
      const { pathname } = new URL(req.url, 'http://local');
      if (!pathname.startsWith('/api/')) {
        if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
        return serveStatic(pathname, res);
      }
      if (!authorized(req)) return send(res, 401, { error: 'Unauthorized' });
      await api(req, res, pathname);
    } catch (err) {
      if (res.headersSent) { res.end(); return; }
      if (!err.status) console.error(err);
      send(res, err.status ?? 500, { error: err.status ? err.message : 'Internal error' });
    }
  });

  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => done(server));
  });
}
