// nocturnh.com: the static site from site/, installers from R2 at /download/<file>, a tiny public
// API with the site settings (token contract, X account) and the admin API that edits them.
const DOWNLOAD = /^\/download\/([A-Za-z0-9._-]+)$/;
const TYPES = { exe: 'application/vnd.microsoft.portable-executable', dmg: 'application/x-apple-diskimage', apk: 'application/vnd.android.package-archive', zip: 'application/zip', AppImage: 'application/octet-stream' };
const SETTINGS_KEY = 'site/settings.json';
const SESSION_HOURS = 12;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;

const json = (value, status = 200, extra = {}) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra },
});

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function sameString(a, b) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// A session is "<expiry>.<hmac of expiry>", signed with the admin password, so nothing is stored.
async function issueSession(secret) {
  const exp = String(Date.now() + SESSION_HOURS * 3600 * 1000);
  return `${exp}.${await hmac(secret, `session:${exp}`)}`;
}

async function validSession(secret, header) {
  const token = (header ?? '').replace(/^Bearer /, '');
  const [exp, sig] = token.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return sameString(sig, await hmac(secret, `session:${exp}`));
}

async function readSettings(env) {
  const object = await env.DOWNLOADS.get(SETTINGS_KEY);
  if (!object) return { contract: '', twitter: '', updated: null };
  try { return await object.json(); } catch { return { contract: '', twitter: '', updated: null }; }
}

async function readBody(request) {
  const text = await request.text();
  if (text.length > 4096) throw new Error('Body too large');
  try { return JSON.parse(text || '{}'); } catch { throw new Error('Invalid JSON'); }
}

async function admin(request, env, path) {
  if (!env.ADMIN_PASSWORD) return json({ error: 'The admin password is not set on the server.' }, 503);
  if (request.method !== 'POST' && request.method !== 'PUT') return json({ error: 'Method not allowed' }, 405);
  let body;
  try { body = await readBody(request); } catch (err) { return json({ error: err.message }, 400); }

  if (path === '/admin/api/login') {
    const given = typeof body.password === 'string' ? body.password : '';
    if (!sameString(given, env.ADMIN_PASSWORD)) {
      await new Promise((r) => setTimeout(r, 800)); // slows down guessing
      return json({ error: 'Wrong password.' }, 401);
    }
    return json({ token: await issueSession(env.ADMIN_PASSWORD), expiresInHours: SESSION_HOURS });
  }

  if (!(await validSession(env.ADMIN_PASSWORD, request.headers.get('authorization')))) return json({ error: 'Sign in again.' }, 401);

  if (path === '/admin/api/site' && request.method === 'PUT') {
    const contract = typeof body.contract === 'string' ? body.contract.trim() : '';
    const twitter = typeof body.twitter === 'string' ? body.twitter.trim().replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '').replace(/^@/, '').replace(/\/.*$/, '') : '';
    if (contract && !ADDRESS.test(contract)) return json({ error: 'The contract must be a 0x address with 40 hex characters.' }, 400);
    if (twitter && !HANDLE.test(twitter)) return json({ error: 'The X handle can only have letters, digits and underscores, up to 15.' }, 400);
    const settings = { contract, twitter, updated: new Date().toISOString() };
    await env.DOWNLOADS.put(SETTINGS_KEY, JSON.stringify(settings), { httpMetadata: { contentType: 'application/json' } });
    return json(settings);
  }
  return json({ error: 'Not found' }, 404);
}

async function download(request, env, name) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
  const ranged = request.headers.has('range');
  const object = await env.DOWNLOADS.get(name, { ...(ranged ? { range: request.headers } : {}), onlyIf: request.headers });
  if (!object) return new Response('Not found', { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  // R2 fills object.range even for a plain GET, so only the client's own Range request is partial.
  const partial = ranged && object.range && object.body;
  headers.set('content-length', String(partial ? (object.range.length ?? object.range.suffix) : object.size));
  headers.set('content-type', TYPES[name.split('.').pop()] ?? 'application/octet-stream');
  headers.set('content-disposition', `attachment; filename="${name}"`);
  headers.set('cache-control', 'public, max-age=3600');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('accept-ranges', 'bytes');
  if (partial) {
    const offset = object.range.offset ?? object.size - object.range.suffix;
    const length = object.range.length ?? object.range.suffix;
    headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
  }
  const status = object.body ? (partial ? 206 : 200) : 304;
  return new Response(request.method === 'HEAD' ? null : object.body, { status, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = url.pathname.match(DOWNLOAD);
    if (match) return download(request, env, match[1]);
    if (url.pathname === '/api/site' && request.method === 'GET') {
      const { contract, twitter, updated } = await readSettings(env);
      return json({ contract, twitter, updated }, 200, { 'cache-control': 'public, max-age=60' });
    }
    if (url.pathname.startsWith('/admin/api/')) return admin(request, env, url.pathname);
    return env.ASSETS.fetch(request);
  },
};
