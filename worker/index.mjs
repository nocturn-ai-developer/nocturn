// nocturnh.com: the static site from site/, plus /download/<file> served from the R2 bucket that
// holds the installers (they are far larger than the 25 MB static asset limit).
const DOWNLOAD = /^\/download\/([A-Za-z0-9._-]+)$/;
const TYPES = { exe: 'application/vnd.microsoft.portable-executable', dmg: 'application/x-apple-diskimage', apk: 'application/vnd.android.package-archive', zip: 'application/zip', AppImage: 'application/octet-stream' };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = url.pathname.match(DOWNLOAD);
    if (!match) return env.ASSETS.fetch(request);
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    const name = match[1];
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
  },
};
