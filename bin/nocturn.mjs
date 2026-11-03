#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import { availableParallelism, constants, homedir, setPriority } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { AUTH_TOKEN, DATA_DIR, config, redactedConfig, updateConfig } from '../src/config.mjs';
import { MOON, TICKER, WORD, checkPoolUrl, defaultThreads, loadAccount, money, poolClient, renderFrame, runMiner, saveAccount } from '../src/mine.mjs';

const SELF = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(SELF));
const PID_FILE = join(DATA_DIR, 'gateway.pid');
const LOG_FILE = join(DATA_DIR, 'gateway.log');
const PORT = Number(process.env.NOCTURN_PORT) || 18790;
const BASE = `http://127.0.0.1:${PORT}`;
const SERVICE = 'nocturn-gateway';
const FLAGS_WITH_VALUE = new Set(['message', 'm', 'session', 'to', 'token', 'bot-token', 'app-token', 'name', 'cron', 'deliver', 'lines', 'pool', 'threads', 'port', 'file', 'host', 'out']);

// Plain text whenever a script is reading: --json, a pipe, or NO_COLOR.
const colorOn = process.stdout.isTTY && !process.env.NO_COLOR && !process.argv.includes('--json');
const paint = (code) => (s) => (colorOn ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const sage = paint('38;2;173;195;184');
const dim = paint('38;2;135;151;152');
const good = paint('38;2;180;201;187');
const bad = paint('38;2;227;167;156');
const bold = paint('1');
// The brand gradient from the web page: purple, pink, blue.
const violet = paint('38;2;139;61;255');
const pink = paint('38;2;224;91;208');
const sky = paint('38;2;90;160;255');
const BRAND = [violet, violet, pink, pink, sky];
const RULE = (width = 56) => dim('─'.repeat(width));
// Model and tool output must not be able to drive the terminal.
const clean = (s) => String(s).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)?|[\x00-\x08\x0b-\x1f\x7f]/g, '');

class CliError extends Error {}

/* Terminal pieces */
// Boxed text: a question or a notice that must stand apart from streamed output.
function box(lines, tint = sage, width = 60) {
  const inner = width - 4;
  const fit = (l) => (l.length > inner ? `${l.slice(0, inner - 1)}…` : l.padEnd(inner));
  return [tint(`╭${'─'.repeat(width - 2)}╮`), ...lines.map((l) => `${tint('│')} ${fit(l)} ${tint('│')}`), tint(`╰${'─'.repeat(width - 2)}╯`)].join('\n');
}

// A one-line status on stderr that is erased before anything real is written.
function statusLine(enabled) {
  const frames = ['◐', '◓', '◑', '◒'];
  let text = '';
  let tick = 0;
  let timer = null;
  const draw = () => process.stderr.write(`\r${dim(frames[tick++ % frames.length])} ${dim(text)}\x1b[K`);
  const clear = () => { if (timer) { clearInterval(timer); timer = null; process.stderr.write('\r\x1b[K'); } };
  return {
    set(next) { if (!enabled) return; text = next; if (!timer) timer = setInterval(draw, 120); draw(); },
    clear,
  };
}

// The moon and wordmark, side by side, in the brand gradient.
function splash(status = []) {
  const right = ['', ...WORD.map((line, i) => BRAND[i](bold(line))), '', `${sage('PERSONAL AI AGENT')} ${dim('· runs on your own machine')}`, '', ...status];
  const wide = (process.stdout.columns ?? 80) >= 96;
  const height = wide ? Math.max(right.length, MOON.length) : right.length;
  const lines = [];
  for (let i = 0; i < height; i += 1) {
    const moon = MOON[i] ?? ' '.repeat(24);
    const tint = i < 4 ? violet : i < 8 ? pink : sky;
    lines.push(wide ? `  ${tint(moon)}  ${right[i] ?? ''}` : `  ${right[i] ?? ''}`);
  }
  return lines.join('\n');
}

function header(title, note = '') {
  return `\n${violet(bold('NOCTURN'))} ${dim('·')} ${bold(title)}${note ? `  ${dim(note)}` : ''}\n${RULE()}`;
}

// A quick look at the gateway for the splash: never slows the help down.
async function quickState() {
  try {
    const res = await fetch(`${BASE}/api/state`, { headers: { authorization: `Bearer ${AUTH_TOKEN}` }, signal: AbortSignal.timeout(1200) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

function statusSummary(s) {
  if (!s) return [`${bad('●')} ${dim('gateway stopped')}  ${dim('start it with')} ${sage('nocturn gateway start')}`];
  const model = s.config.provider === 'openai' ? s.config.openaiModel : s.config.model;
  const ready = s.config.provider === 'openai' ? s.credentials.openai : s.credentials.anthropic;
  const live = Object.entries(s.channelStatus).filter(([, v]) => v === 'connected').map(([k]) => k);
  const parts = [`${good('●')} gateway on ${dim(`127.0.0.1:${PORT}`)}`, `${dim('model')} ${model || 'not set'} ${ready ? good('ready') : bad('no key')}`];
  if (live.length) parts.push(`${dim('chat')} ${live.join(', ')}`);
  const waiting = [];
  if (s.approvals.length) waiting.push(`${s.approvals.length} approval${s.approvals.length > 1 ? 's' : ''}`);
  if (s.pairing.length) waiting.push(`${s.pairing.length} pairing request${s.pairing.length > 1 ? 's' : ''}`);
  if (waiting.length) parts.push(pink(`${waiting.join(', ')} waiting`));
  return [parts.join(dim('  ·  '))];
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') { positional.push(...argv.slice(i + 1)); break; }
    const match = arg.match(/^--?([a-zA-Z][\w-]*)(?:=(.*))?$/);
    if (!match) { positional.push(arg); continue; }
    if (match[2] !== undefined) flags[match[1]] = match[2];
    else if (FLAGS_WITH_VALUE.has(match[1])) {
      if (argv[i + 1] === undefined) throw new CliError(`--${match[1]} needs a value`);
      flags[match[1]] = argv[++i];
    } else flags[match[1]] = true;
  }
  return { positional, flags };
}

async function api(path, method = 'GET', body) {
  let res;
  try {
    res = await fetch(`${BASE}/api/${path}`, {
      method,
      headers: { authorization: `Bearer ${AUTH_TOKEN}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new CliError('The gateway is not running. Start it with: nocturn gateway start');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new CliError(data.error ?? `Gateway answered ${res.status}`);
  return data;
}

const gatewayUp = () => api('state').then(() => true, () => false);

async function applyConfig(patch) {
  if (await gatewayUp()) await api('config', 'PUT', patch);
  else updateConfig(patch);
}

function need(value, usage) {
  if (value === undefined || value === true || value === '') throw new CliError(`Usage: ${usage}`);
  return value;
}

function out(flags, value, render) {
  if (flags.json) console.log(JSON.stringify(value, null, 2));
  else render(value);
}

const when = (iso) => (iso ? new Date(iso).toLocaleString() : 'never');

/* Gateway */
function readPid() {
  try { return Number(readFileSync(PID_FILE, 'utf8')) || null; } catch { return null; }
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function gatewayRun() {
  const { boot } = await import('../src/index.mjs');
  const { port } = await boot(PORT).catch((err) => {
    throw new CliError(err.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Is the gateway running? Check with: nocturn gateway status` : err.message);
  });
  writeFileSync(PID_FILE, String(process.pid));
  const leave = () => { if (readPid() === process.pid) rmSync(PID_FILE, { force: true }); process.exit(0); };
  process.on('SIGINT', leave);
  process.on('SIGTERM', leave);
  console.log(`${new Date().toISOString()} gateway listening on 127.0.0.1:${port} (pid ${process.pid})`);
}

async function gatewayStart() {
  if (await gatewayUp()) { console.log(`Gateway is already running on port ${PORT}.`); return; }
  const log = openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [SELF, 'gateway', 'run'], { detached: true, stdio: ['ignore', log, log], windowsHide: true, env: process.env });
  child.unref();
  closeSync(log);
  for (let i = 0; i < 50; i += 1) {
    if (await gatewayUp()) { console.log(`${good('●')} Gateway running on 127.0.0.1:${PORT} (pid ${child.pid})\n  Logs: nocturn gateway logs`); return; }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new CliError(`The gateway did not start. See ${LOG_FILE}`);
}

async function gatewayStop() {
  const pid = readPid();
  if (!alive(pid)) { rmSync(PID_FILE, { force: true }); console.log('Gateway is not running.'); return; }
  process.kill(pid);
  for (let i = 0; i < 25 && alive(pid); i += 1) await new Promise((r) => setTimeout(r, 200));
  if (alive(pid)) throw new CliError(`Process ${pid} did not stop.`);
  rmSync(PID_FILE, { force: true });
  console.log('Gateway stopped.');
}

function tailLog(flags) {
  if (!existsSync(LOG_FILE)) { console.log('No gateway log yet.'); return; }
  const lines = readFileSync(LOG_FILE, 'utf8').trimEnd().split('\n');
  console.log(lines.slice(-Number(flags.lines || 50)).map(clean).join('\n'));
  if (!flags.f && !flags.follow) return;
  let size = statSync(LOG_FILE).size;
  watch(LOG_FILE, () => {
    const now = statSync(LOG_FILE).size;
    if (now <= size) { size = now; return; }
    process.stdout.write(clean(readFileSync(LOG_FILE).subarray(size).toString()) + '\n');
    size = now;
  });
  return new Promise(() => {});
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new CliError(`${cmd} failed: ${clean(result.stderr || result.error?.message || '')}`);
}

// Starts the gateway at login (Windows) or as a user service (Linux), so it survives reboots.
function serviceInstall() {
  if (process.platform === 'win32') {
    run('schtasks', ['/Create', '/F', '/SC', 'ONLOGON', '/TN', SERVICE, '/TR', `"${process.execPath}" "${SELF}" gateway run`]);
    console.log(`Installed scheduled task ${SERVICE}. It starts at your next login.`);
    return;
  }
  if (process.platform !== 'linux') throw new CliError('Automatic start is available on Linux and Windows. Elsewhere, run: nocturn gateway start');
  const dir = join(homedir(), '.config', 'systemd', 'user');
  run('mkdir', ['-p', dir]);
  writeFileSync(join(dir, `${SERVICE}.service`), `[Unit]\nDescription=Nocturn gateway\nAfter=network-online.target\n\n[Service]\nExecStart="${process.execPath}" "${SELF}" gateway run\nWorkingDirectory=${ROOT}\nEnvironment=NOCTURN_HOME=${DATA_DIR}\nEnvironment=NOCTURN_PORT=${PORT}\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`);
  run('systemctl', ['--user', 'daemon-reload']);
  run('systemctl', ['--user', 'enable', '--now', SERVICE]);
  console.log(`Installed and started ${SERVICE}. To keep it running after you log out: loginctl enable-linger $USER`);
}

function serviceUninstall() {
  if (process.platform === 'win32') {
    run('schtasks', ['/Delete', '/F', '/TN', SERVICE]);
  } else if (process.platform === 'linux') {
    run('systemctl', ['--user', 'disable', '--now', SERVICE]);
    rmSync(join(homedir(), '.config', 'systemd', 'user', `${SERVICE}.service`), { force: true });
    run('systemctl', ['--user', 'daemon-reload']);
  } else throw new CliError('Nothing to remove on this system.');
  console.log(`Removed ${SERVICE}.`);
}

async function cmdGateway([sub = 'run'], flags) {
  if (sub === 'run') return gatewayRun();
  if (sub === 'start') return gatewayStart();
  if (sub === 'stop') return gatewayStop();
  if (sub === 'restart') { await gatewayStop(); return gatewayStart(); }
  if (sub === 'status') return cmdStatus([], flags);
  if (sub === 'logs') return tailLog(flags);
  if (sub === 'install') return serviceInstall();
  if (sub === 'uninstall') return serviceUninstall();
  throw new CliError('Usage: nocturn gateway [run|start|stop|restart|status|logs|install|uninstall]');
}

/* Status */
async function cmdStatus(_, flags) {
  const up = await gatewayUp();
  if (!up) {
    out(flags, { gateway: 'stopped', port: PORT }, () => console.log(`${bad('●')} ${bold('Gateway stopped')}\n  ${dim('Start it with:')} ${sage('nocturn gateway start')}`));
    return;
  }
  const s = await api('state');
  const hasKey = s.config.provider === 'openai' ? s.credentials.openai : s.credentials.anthropic;
  const report = {
    gateway: 'running', port: PORT, pid: readPid(), provider: s.config.provider,
    model: s.config.provider === 'openai' ? s.config.openaiModel : s.config.model, modelReady: hasKey,
    channels: s.channelStatus, sessions: s.sessions.length, running: s.running.length,
    jobs: s.jobs.length, memories: s.memory.length, skills: s.skills.length,
    pendingApprovals: s.approvals.length, pendingPairing: s.pairing.length,
  };
  out(flags, report, (r) => {
    const row = (label, value) => console.log(`  ${dim(label.padEnd(10))} ${value}`);
    const channel = ([k, v]) => `${k} ${v === 'connected' ? good('✓') : v === 'off' ? dim('·') : /fail|missing/.test(v) ? bad('✗') : dim('…')} ${dim(v)}`;
    console.log(`${good('●')} ${bold('Gateway running')} ${dim(`on 127.0.0.1:${r.port}${r.pid ? ` · pid ${r.pid}` : ''}`)}`);
    row('Model', `${r.model || 'not set'}  ${r.modelReady ? good('✓ ready') : bad('✗ no key, run: nocturn onboard')}`);
    row('Channels', Object.entries(r.channels).map(channel).join(dim('  ')));
    row('Sessions', `${r.sessions}  ${dim(`${r.running} running`)}`);
    row('Cron jobs', String(r.jobs));
    row('Memory', `${r.memories}  ${dim('Skills')} ${r.skills}`);
    if (r.pendingApprovals) row('Waiting', pink(`${r.pendingApprovals} approval(s): nocturn approvals list`));
    if (r.pendingPairing) row('Waiting', pink(`${r.pendingPairing} pairing request(s): nocturn pairing list`));
  });
}

async function cmdDoctor(_, flags) {
  const checks = [];
  const add = (name, ok, fix = '') => checks.push({ name, ok, fix });
  add(`Node ${process.version}`, Number(process.versions.node.split('.')[0]) >= 22, 'Install Node 22 or newer');
  add('Dependencies installed', existsSync(join(ROOT, 'node_modules', '@anthropic-ai', 'sdk')), 'Run npm install');
  add(`State folder ${DATA_DIR}`, existsSync(DATA_DIR));
  const up = await gatewayUp();
  add('Gateway running', up, 'nocturn gateway start');
  const cfg = config;
  const key = cfg.provider === 'openai' ? Boolean(cfg.openaiModel) : Boolean(cfg.anthropicKey || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  add(`Model configured (${cfg.provider})`, key, 'nocturn onboard');
  if (up) {
    for (const [name, status] of Object.entries((await api('state')).channelStatus)) {
      if (status !== 'off') add(`Channel ${name}: ${status}`, !/failed|missing/.test(status), `nocturn channels add ${name}`);
    }
  }
  out(flags, checks, () => {
    const width = Math.max(...checks.map((c) => c.name.length));
    console.log(header('Doctor', `${checks.filter((c) => c.ok).length} of ${checks.length} checks pass`));
    for (const c of checks) console.log(`  ${c.ok ? good('✓') : bad('✗')} ${c.name.padEnd(width)}${!c.ok && c.fix ? `  ${dim('fix:')} ${sage(c.fix)}` : ''}`);
  });
  if (checks.some((c) => !c.ok)) process.exitCode = 1;
}

/* Talking to the agent */
async function* gatewayEvents(signal) {
  const res = await fetch(`${BASE}/api/events`, { headers: { authorization: `Bearer ${AUTH_TOKEN}` }, signal });
  if (!res.ok) throw new CliError(`Gateway answered ${res.status}`);
  let buffer = '';
  for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    const frames = buffer.split('\n\n');
    buffer = frames.pop();
    for (const frame of frames) if (frame.startsWith('data: ')) yield JSON.parse(frame.slice(6));
  }
}

function describeInput(input) {
  const text = clean(input?.command ?? input?.path ?? input?.url ?? input?.target ?? JSON.stringify(input ?? {}));
  return text.length > 100 ? `${text.slice(0, 100)}…` : text;
}

async function requireModel() {
  const { config: cfg, credentials } = await api('state');
  if (!(cfg.provider === 'openai' ? credentials.openai : credentials.anthropic)) throw new CliError('No model is set up yet. Run: nocturn onboard');
}

// One turn: sends the text, streams the reply and asks about anything that needs approval.
async function runTurn(sessionId, text, { rl, json }) {
  const stream = new AbortController();
  const events = gatewayEvents(stream.signal);
  const first = events.next(); // connect before sending, so no event is missed
  await api(`sessions/${encodeURIComponent(sessionId)}/messages`, 'POST', { text });
  let reply = '';
  let failure = null;
  const pretty = Boolean(rl) && !json && colorOn;
  const status = statusLine(pretty);
  let afterTool = false; // a blank line separates the reply from the last tool card
  const write = (s) => { if (!json) { status.clear(); process.stdout.write(s); } };
  const firstLine = (s) => clean(s).split('\n').find((l) => l.trim()) ?? '';
  const short = (s, max = 90) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
  const stop = () => api(`sessions/${encodeURIComponent(sessionId)}/stop`, 'POST').catch(() => {});
  process.once('SIGINT', stop);
  rl?.once('SIGINT', stop);
  status.set('waiting for the model');
  try {
    let next = first;
    for (;;) {
      const { value: e, done } = await next;
      if (done) throw new CliError('Lost the connection to the gateway.');
      if (e.sessionId === sessionId) {
        if (e.type === 'text') {
          if (afterTool) { write('\n'); afterTool = false; }
          reply += e.text;
          write(clean(e.text));
          status.set('writing');
        } else if (e.type === 'thinking') status.set('thinking…');
        else if (e.type === 'step_start') status.set('waiting for the model');
        else if (e.type === 'tool_start') {
          write(`${reply && !afterTool ? '\n' : ''}\n  ${dim('┌')} ${violet(bold(e.name))} ${dim(short(describeInput(e.input)))}\n`);
          afterTool = true;
          status.set(`running ${e.name}`);
        } else if (e.type === 'tool_result') {
          write(`  ${dim('└')} ${e.isError ? bad('✗') : good('✓')} ${dim(short(firstLine(e.content)))}\n`);
          status.set('waiting for the model');
        } else if (e.type === 'approval') {
          let approved = false;
          if (rl) {
            status.clear();
            const detail = describeInput(e.input);
            write(`\n${box([`? Allow ${e.tool}?`, `  ${detail}`], pink)}\n`);
            const answer = await rl.question(`  ${pink('›')} ${bold('Allow?')} ${dim('[y/N]')} `).catch(() => '');
            approved = /^y(es)?$/i.test(answer.trim());
            write(`  ${approved ? good('✓ allowed') : bad('✗ denied')}\n`);
            await api(`approvals/${e.id}`, 'POST', { approved }).catch(() => {});
            status.set(approved ? `running ${e.tool}` : 'waiting for the model');
          } else {
            console.error(`Waiting for approval of ${e.tool} ${describeInput(e.input)}\n  Run: nocturn approvals approve ${e.id}`);
          }
        } else if (e.type === 'turn_end') break;
        else if (e.type === 'turn_error') { failure = e.message; break; }
      }
      next = events.next();
    }
  } finally {
    status.clear();
    process.off('SIGINT', stop);
    rl?.off('SIGINT', stop);
    stream.abort();
    events.return().catch(() => {});
  }
  if (failure) throw new CliError(clean(failure));
  write(pretty ? `\n${RULE()}\n` : '\n');
  return reply;
}

async function cmdAgent(_, flags) {
  const text = need(flags.message ?? flags.m, 'nocturn agent --message "what to do" [--session <id>] [--json]');
  await requireModel();
  const sessionId = flags.session ?? (await api('sessions', 'POST', {})).id;
  const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    const reply = await runTurn(sessionId, text, { rl, json: flags.json });
    if (flags.json) console.log(JSON.stringify({ sessionId, reply }, null, 2));
  } finally { rl?.close(); }
}

const CHAT_HELP = [
  ['/new', 'start a new conversation'], ['/sessions', 'list conversations'], ['/status', 'gateway, model and channels'],
  ['/help', 'this list'], ['/exit', 'leave'], ['Ctrl+C', 'stop the running task'],
];

async function cmdChat(_, flags) {
  if (!(await gatewayUp())) await gatewayStart();
  await requireModel();
  let sessionId = flags.session ?? null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let open = true;
  rl.on('close', () => { open = false; });
  const { config: cfg } = await api('state');
  const model = cfg.provider === 'openai' ? cfg.openaiModel : cfg.model;
  const banner = () => console.log(`${header('Chat', `${model}${sessionId ? ` · session ${sessionId.slice(0, 8)}` : ' · new conversation'}`)}\n${dim('/help lists the commands · Ctrl+C stops a running task')}`);
  banner();
  try {
    while (open) {
      const line = (await rl.question(`\n${violet('›')} `).catch(() => null))?.trim();
      if (line === null || line === undefined) break;
      if (!line) continue;
      if (line === '/exit' || line === '/quit') break;
      if (line === '/help') { for (const [cmd, what] of CHAT_HELP) console.log(`  ${sage(cmd.padEnd(10))} ${dim(what)}`); continue; }
      if (line === '/new') { sessionId = null; banner(); continue; }
      if (line === '/sessions') { await cmdSessions([], {}); continue; }
      if (line === '/status') { await cmdStatus([], {}); continue; }
      if (!sessionId) { sessionId = (await api('sessions', 'POST', {})).id; console.log(dim(`  session ${sessionId.slice(0, 8)}`)); }
      await runTurn(sessionId, line, { rl }).catch((err) => {
        if (!(err instanceof CliError)) throw err;
        console.error(bad(err.message));
      });
    }
  } finally { rl.close(); }
}

async function cmdMessage([sub], flags) {
  if (sub !== 'send') throw new CliError('Usage: nocturn message send --to telegram:<chat> --message "text"');
  const target = need(flags.to, 'nocturn message send --to telegram:<chat> --message "text"');
  const text = need(flags.message ?? flags.m, 'nocturn message send --to telegram:<chat> --message "text"');
  await api('message', 'POST', { target, text });
  console.log(`Sent to ${target}.`);
}

async function cmdSessions(_, flags) {
  const { sessions } = await api('state');
  out(flags, sessions, () => {
    if (!sessions.length) console.log('No sessions yet.');
    for (const s of sessions) console.log(`${s.id}  ${dim(s.origin)}  ${clean(s.title)}  ${dim(when(s.updated))}`);
  });
}

/* Channels and pairing */
async function cmdChannels([sub = 'list', name], flags) {
  if (sub === 'list') {
    const { channelStatus, config: cfg } = await api('state');
    out(flags, channelStatus, () => {
      for (const [ch, status] of Object.entries(channelStatus)) console.log(`${ch.padEnd(10)} ${status}  ${dim(`${cfg.channels[ch].allow.length} allowed`)}`);
    });
    return;
  }
  if (!['telegram', 'discord', 'slack'].includes(name)) throw new CliError(`Usage: nocturn channels ${sub} telegram|discord|slack`);
  if (sub === 'remove') { await applyConfig({ channels: { [name]: { enabled: false } } }); console.log(`${name} turned off. Its token stays saved.`); return; }
  if (sub !== 'add') throw new CliError('Usage: nocturn channels [list|add|remove]');
  let patch;
  if (name === 'slack') {
    patch = { enabled: true, botToken: flags['bot-token'] ?? await askSecret('Slack bot token (xoxb-…): '), appToken: flags['app-token'] ?? await askSecret('Slack app token (xapp-…): ') };
  } else {
    patch = { enabled: true, token: flags.token ?? await askSecret(`${name} bot token: `) };
  }
  await applyConfig({ channels: { [name]: patch } });
  console.log(`${name} saved. Message your bot, then approve the code with: nocturn pairing list`);
}

async function cmdPairing([sub = 'list', code], flags) {
  if (sub === 'list') {
    const { pairing } = await api('state');
    out(flags, pairing, () => {
      if (!pairing.length) console.log('No pairing requests.');
      for (const p of pairing) console.log(`${bold(p.code)}  ${p.channel}  sender ${clean(p.sender)}`);
    });
    return;
  }
  if (sub !== 'approve' && sub !== 'deny') throw new CliError('Usage: nocturn pairing [list|approve <code>|deny <code>]');
  await api(`pairing/${encodeURIComponent(need(code, `nocturn pairing ${sub} <code>`))}`, 'POST', { approve: sub === 'approve' });
  console.log(sub === 'approve' ? 'Approved. That sender can talk to Nocturn now.' : 'Denied.');
}

async function cmdApprovals([sub = 'list', id], flags) {
  if (sub === 'list') {
    const { approvals } = await api('state');
    out(flags, approvals, () => {
      if (!approvals.length) console.log('Nothing is waiting for approval.');
      for (const a of approvals) console.log(`${a.id}  ${bold(a.tool)}  ${describeInput(a.input)}`);
    });
    return;
  }
  if (sub !== 'approve' && sub !== 'deny') throw new CliError('Usage: nocturn approvals [list|approve <id>|deny <id>]');
  await api(`approvals/${encodeURIComponent(need(id, `nocturn approvals ${sub} <id>`))}`, 'POST', { approved: sub === 'approve' });
  console.log(sub === 'approve' ? 'Approved.' : 'Denied.');
}

/* Cron, memory, skills, config */
async function cmdCron([sub = 'list', id], flags) {
  if (sub === 'list') {
    const { jobs } = await api('state');
    out(flags, jobs, () => {
      if (!jobs.length) console.log('No cron jobs.');
      for (const j of jobs) console.log(`${j.id}  ${bold(clean(j.name))}  ${j.cron}  ${j.enabled ? good('on') : dim('off')}  ${dim(`last: ${when(j.lastRun)} ${j.lastStatus ?? ''}`)}`);
    });
    return;
  }
  if (sub === 'add') {
    const usage = 'nocturn cron add --name "brief" --cron "0 8 * * 1-5" --message "what to do" [--deliver telegram:<chat>]';
    await api('jobs', 'POST', { name: need(flags.name, usage), cron: need(flags.cron, usage), prompt: need(flags.message ?? flags.m, usage), deliver: flags.deliver ?? '' });
    console.log('Cron job added.');
    return;
  }
  const job = encodeURIComponent(need(id, `nocturn cron ${sub} <id>`));
  if (sub === 'rm' || sub === 'remove') { await api(`jobs/${job}`, 'DELETE'); console.log('Removed.'); return; }
  if (sub === 'run') { await api(`jobs/${job}/run`, 'POST'); console.log('Started.'); return; }
  if (sub === 'enable' || sub === 'disable') { await api(`jobs/${job}`, 'PATCH', { enabled: sub === 'enable' }); console.log(`${sub}d.`); return; }
  throw new CliError('Usage: nocturn cron [list|add|rm|run|enable|disable]');
}

async function cmdMemory([sub = 'list', ...rest], flags) {
  if (sub === 'list') {
    const { memory } = await api('state');
    out(flags, memory, () => {
      if (!memory.length) console.log('Nothing remembered yet.');
      for (const m of memory) console.log(`${m.id}  ${clean(m.text)}`);
    });
    return;
  }
  if (sub === 'add') { await api('memory', 'POST', { text: need(rest.join(' '), 'nocturn memory add <text>') }); console.log('Remembered.'); return; }
  if (sub === 'rm' || sub === 'remove') { await api(`memory/${encodeURIComponent(need(rest[0], 'nocturn memory rm <id>'))}`, 'DELETE'); console.log('Forgotten.'); return; }
  throw new CliError('Usage: nocturn memory [list|add <text>|rm <id>]');
}

async function cmdSkills([sub = 'list', name], flags) {
  if (sub === 'rm' || sub === 'remove') { await api(`skills/${encodeURIComponent(need(name, 'nocturn skills rm <name>'))}`, 'DELETE'); console.log('Removed.'); return; }
  if (sub !== 'list') throw new CliError('Usage: nocturn skills [list|rm <name>]');
  const { skills } = await api('state');
  out(flags, skills, () => {
    if (!skills.length) console.log('No skills installed.');
    for (const s of skills) console.log(`${bold(s.name)}  ${dim(clean(s.description))}`);
  });
}

async function cmdConfig([sub = 'get', key, ...rest], flags) {
  if (sub === 'get') {
    let value = redactedConfig();
    for (const part of key ? key.split('.') : []) value = value?.[part];
    if (value === undefined) throw new CliError(`No such setting: ${key}`);
    console.log(typeof value === 'object' ? JSON.stringify(value, null, 2) : value);
    return;
  }
  if (sub !== 'set' || !key || !rest.length) throw new CliError('Usage: nocturn config [get <key>|set <key> <value>]');
  const raw = rest.join(' ');
  let value;
  try { value = JSON.parse(raw); } catch { value = raw; }
  await applyConfig(key.split('.').reduceRight((acc, part) => ({ [part]: acc }), value));
  console.log(`Set ${key}. ${flags.quiet ? '' : dim('Changes to channels need: nocturn gateway restart')}`);
}

/* Mining */
const PKG_NOCTURN = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).nocturn ?? {};
const DEFAULT_POOL = PKG_NOCTURN.pool ?? '';
const DOWNLOADS = PKG_NOCTURN.downloads ?? {};

function poolUrl(flags) {
  const url = flags.pool ?? process.env.NOCTURN_POOL ?? loadAccount()?.pool ?? DEFAULT_POOL;
  if (!url) throw new CliError('No mining pool is set yet. Pass one with --pool https://your-pool');
  try { return checkPoolUrl(url); } catch (err) { throw new CliError(err.message); }
}

async function signUp(pool, ask) {
  for (;;) {
    const name = await ask('Pick a miner name:');
    try {
      const account = { ...(await poolClient(pool)('/register', { name })), pool };
      saveAccount(account);
      return account;
    } catch (err) {
      if (err.code === 'name_taken') console.log('That name is taken.');
      else if (err.code === 'bad_name') console.log('Use 3 to 20 letters, numbers, - or _.');
      else throw new CliError(err.code ? `The pool said: ${err.code}` : `Cannot reach ${pool}`);
    }
  }
}

// Runs in the foreground and needs a person to answer the check: it cannot mine unattended.
async function cmdMine([sub], flags) {
  if (sub === 'balance') {
    const account = loadAccount();
    if (!account) throw new CliError('No miner account yet. Run: nocturn mine');
    let balance;
    try { balance = await poolClient(account.pool, account.token)('/balance'); } catch (err) {
      throw new CliError(`Cannot read the balance: ${err.code ?? err.message}`);
    }
    console.log(`${money(balance.cents)} ${TICKER}`);
    return;
  }
  if (sub) throw new CliError('Usage: nocturn mine [balance] [--threads N] [--pool URL]');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new CliError('nocturn mine needs a terminal, because a person has to answer its check.');
  const threads = flags.threads === undefined ? defaultThreads() : Number(flags.threads);
  if (!Number.isInteger(threads) || threads < 1 || threads > availableParallelism()) throw new CliError(`--threads must be between 1 and ${availableParallelism()}.`);
  const pool = poolUrl(flags);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const stop = new AbortController();
  let asking = false;
  let lines = 0;
  rl.on('SIGINT', () => stop.abort());
  rl.on('close', () => stop.abort());
  process.on('SIGINT', () => stop.abort());
  const ask = async (prompt) => {
    asking = true;
    process.stdout.write('\x1b[?25h');
    const answer = await rl.question(`${sage('?')} ${prompt} `, { signal: stop.signal }).then((s) => s.trim(), () => null);
    asking = false;
    lines = 0;
    if (answer !== null) process.stdout.write('\x1b[?25l');
    return answer;
  };
  try {
    let account = loadAccount();
    if (!account || account.pool !== pool) account = await signUp(pool, ask);
    try { setPriority(0, constants.priority.PRIORITY_LOW); } catch { /* not allowed here, keep the default */ }
    const draw = (state) => {
      if (asking) return;
      const frame = renderFrame(state, { sage, dim, good, bold }, process.stdout.columns);
      process.stdout.write(`${lines ? `\x1b[${lines}A` : ''}${frame.map((l) => `${l}\x1b[K`).join('\n')}\n`);
      lines = frame.length;
    };
    const last = await runMiner({ account, threads, ask, draw, signal: stop.signal });
    if (last.startCents !== null) console.log(`\nStopped. ${last.shares} shares this session.`);
  } catch (err) {
    throw new CliError(err.message);
  } finally {
    process.stdout.write('\x1b[?25h');
    rl.close();
  }
}

async function cmdPool([sub = 'run'], flags) {
  if (sub !== 'run') throw new CliError('Usage: nocturn pool run [--port 18800] [--host 0.0.0.0] [--file path]');
  const { startPool } = await import('../src/pool.mjs');
  const port = Number(flags.port) || 18800;
  const pool = await startPool({ port, host: flags.host ?? '127.0.0.1', file: flags.file ?? join(DATA_DIR, 'pool.json'), trustProxy: Boolean(flags['trust-proxy']) });
  const leave = () => { pool.close(); process.exit(0); };
  process.on('SIGINT', leave);
  process.on('SIGTERM', leave);
  console.log(`Pool listening on port ${pool.port}. Put it behind https before sharing the address.`);
}

/* Public site */
// Copies the landing page into a folder any static host can serve, such as Cloudflare Pages.
async function cmdSite([sub], flags) {
  if (sub !== 'build') throw new CliError('Usage: nocturn site build [--out folder]');
  const { cpSync, mkdirSync } = await import('node:fs');
  const { partners } = await import('../src/partners.mjs');
  const outDir = flags.out ?? join(process.cwd(), 'site');
  mkdirSync(outDir, { recursive: true });
  cpSync(join(ROOT, 'public'), outDir, { recursive: true });
  writeFileSync(join(outDir, 'partners.json'), JSON.stringify(partners.list().map(({ name, logo }) => ({ name, logo }))));
  writeFileSync(join(outDir, 'downloads.json'), JSON.stringify(DOWNLOADS)); // installer links for the Download buttons
  writeFileSync(join(outDir, '_headers'), `/*
  Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
`);
  console.log(`Site written to ${outDir}\nDeploy that folder to your static host, for example:\n  ${process.platform === 'win32' ? 'npx.cmd' : 'npx'} wrangler deploy   (from the folder with wrangler.jsonc)`);
}

function cmdDashboard() {
  console.log(`Web control panel (private link, do not share):\n  ${BASE}/panel.html#token=${AUTH_TOKEN}\n\nOn a server, reach it through a tunnel from your own computer:\n  ssh -L ${PORT}:127.0.0.1:${PORT} user@your-server`);
}

/* Onboarding */
async function askSecret(prompt) {
  if (!process.stdin.isTTY) throw new CliError('This needs a terminal. Pass the value with a flag instead.');
  process.stdout.write(prompt);
  let muted = true;
  const output = new Writable({ write(chunk, _, done) { if (!muted) process.stdout.write(chunk); done(); } });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  const value = await rl.question('');
  muted = false;
  rl.close();
  process.stdout.write('\n');
  return value.trim();
}

async function cmdOnboard() {
  if (!process.stdin.isTTY) throw new CliError('nocturn onboard needs a terminal.');
  console.log(`${header('Setup', '4 steps')}\n${dim(`State is stored in ${DATA_DIR}. Keys are saved as plain text there.`)}`);
  const step = (n, title) => console.log(`\n${violet(bold(`${n}/4`))} ${bold(title)}`);
  const ask = async (prompt, fallback = '') => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`${prompt}${fallback ? dim(` [${fallback}]`) : ''} `)).trim();
    rl.close();
    return answer || fallback;
  };
  const yes = async (prompt, fallback) => /^y/i.test(await ask(`${prompt} (y/n)`, fallback ? 'y' : 'n'));

  step(1, 'Model');
  const provider = /^o/i.test(await ask('Model provider: anthropic or openai-compatible?', config.provider)) ? 'openai' : 'anthropic';
  const patch = { provider };
  if (provider === 'anthropic') {
    const secret = await askSecret(`Anthropic API key${config.anthropicKey ? ' (Enter keeps the saved one)' : ''}: `);
    if (secret) patch.anthropicKey = secret;
    patch.model = await ask('Model', config.model);
  } else {
    patch.openaiBaseUrl = await ask('Base URL', config.openaiBaseUrl);
    patch.openaiModel = await ask('Model name', config.openaiModel || 'llama3.2');
    const secret = await askSecret('API key (Enter if not needed): ');
    if (secret) patch.openaiKey = secret;
  }
  await applyConfig(patch);

  step(2, 'Telegram');
  if (await yes('Connect a Telegram bot?', false)) {
    console.log(dim('Create one with @BotFather on Telegram, then paste its token.'));
    const token = await askSecret('Bot token: ');
    if (token) await applyConfig({ channels: { telegram: { enabled: true, token } } });
  }
  step(3, 'Gateway');
  await gatewayStart();
  step(4, 'Autostart');
  if (await yes('Start the gateway automatically at login?', false)) serviceInstall();
  console.log(`\n${good('✓')} ${bold('Done.')} Try these:\n  ${sage('nocturn chat')}        talk to it here\n  ${sage('nocturn status')}      see what is running\n  ${sage('nocturn pairing list')}  approve your Telegram account after messaging the bot\n  ${sage('nocturn dashboard')}   open the web panel\n`);
}

const HELP = `${sage(bold('nocturn'))} ${dim('personal AI agent gateway')}

${bold('Setup')}
  nocturn onboard                     Guided setup: model, Telegram, gateway
  nocturn doctor                      Check that everything is healthy
  nocturn config get|set <key> [val]  Read or change a setting
  nocturn dashboard                   Print the private web panel link

${bold('Gateway')}
  nocturn gateway run                 Run in the foreground
  nocturn gateway start|stop|restart  Run in the background
  nocturn gateway status|logs [-f]    Check on it
  nocturn gateway install|uninstall   Start automatically at login
  nocturn status [--json]             Gateway, model and channel summary

${bold('Agent')}
  nocturn chat                        Chat in this terminal
  nocturn agent -m "do this"          Run one task and print the reply
  nocturn message send --to telegram:<chat> -m "text"
  nocturn sessions                    List conversations
  nocturn approvals list|approve|deny Answer waiting tool requests

${bold('Channels')}
  nocturn channels list|add|remove <telegram|discord|slack>
  nocturn pairing list|approve|deny   Let a new sender in

${bold('Automation and knowledge')}
  nocturn cron list|add|rm|run|enable|disable
  nocturn memory list|add|rm
  nocturn skills list|rm

${bold('Mining')}
  nocturn mine [--threads N]          Mine ${TICKER} in this terminal, ctrl+c stops
  nocturn mine balance                Show your balance
  nocturn pool run [--port N]         Run the pool that miners connect to

${bold('Website')}
  nocturn site build [--out folder]   Export the landing page for nocturnh.com

Port: NOCTURN_PORT (default 18790). State: NOCTURN_HOME.`;

const COMMANDS = {
  gateway: cmdGateway, status: cmdStatus, doctor: cmdDoctor, onboard: cmdOnboard, setup: cmdOnboard,
  agent: cmdAgent, chat: cmdChat, tui: cmdChat, message: cmdMessage, sessions: cmdSessions,
  channels: cmdChannels, pairing: cmdPairing, approvals: cmdApprovals, cron: cmdCron,
  memory: cmdMemory, skills: cmdSkills, config: cmdConfig, dashboard: cmdDashboard, mine: cmdMine, pool: cmdPool, site: cmdSite,
  logs: (_, flags) => tailLog(flags),
};

try {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [name, ...rest] = positional;
  if (flags.version || flags.V || flags.v) {
    console.log(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version);
  } else if (!name || name === 'help' || flags.help || flags.h) {
    if (colorOn) console.log(`${splash(statusSummary(await quickState()))}\n`);
    console.log(HELP);
  } else {
    if (!COMMANDS[name]) throw new CliError(`Unknown command: ${name}. See: nocturn help`);
    await COMMANDS[name](rest, flags);
  }
} catch (err) {
  if (!(err instanceof CliError)) throw err;
  if (process.argv.includes('--json')) console.log(JSON.stringify({ ok: false, error: { type: 'cli_error', message: err.message } }));
  else console.error(bad(err.message));
  process.exitCode = 1;
}
