import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { DATA_DIR, SKILLS_DIR, WORKSPACE, readJson, writeJson } from './config.mjs';
import { browserAction } from './browser.mjs';
import { SearchIndex, snippet } from './embeddings.mjs';

const MAX_OUTPUT = 50000;
const MEMORY_FILE = join(DATA_DIR, 'memory.json');
const SHELL_TIMEOUT_MS = 120000;

export const memory = {
  list: () => readJson(MEMORY_FILE, []),
  add(text) {
    const entry = { id: randomUUID(), text, at: new Date().toISOString() };
    writeJson(MEMORY_FILE, [...this.list(), entry]);
    searchIndex.schedule();
    return entry;
  },
  remove(id) { writeJson(MEMORY_FILE, this.list().filter((m) => m.id !== id)); searchIndex.schedule(); },
};

// One index over memories and the workspace, refreshed after every write.
export const searchIndex = new SearchIndex({ memories: () => memory.list() });

export const skills = {
  list() {
    return readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).flatMap((d) => {
      const file = join(SKILLS_DIR, d.name, 'SKILL.md');
      if (!existsSync(file)) return [];
      const body = readFileSync(file, 'utf8');
      const description = body.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? '';
      return [{ name: d.name, description, body }];
    });
  },
  validName: (name) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(name),
};

function clip(text) {
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…[truncated ${text.length - MAX_OUTPUT} chars]` : text;
}

// Resolves through symlinks so a link inside the workspace cannot escape it.
export function safePath(input) {
  const base = realpathSync(WORKSPACE);
  const target = resolve(base, input);
  let probe = target;
  while (!existsSync(probe)) probe = dirname(probe);
  const real = join(realpathSync(probe), relative(probe, target));
  if (real !== base && !real.startsWith(base + sep)) throw new Error(`Path is outside the workspace: ${input}`);
  return real;
}

function isPrivateAddress(ip) {
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    if (lower.startsWith('::ffff:')) {
      // URL parsing rewrites ::ffff:127.0.0.1 as ::ffff:7f00:1, so both spellings must map back to IPv4.
      const mapped = lower.slice(7);
      if (mapped.includes('.')) return isPrivateAddress(mapped);
      const [hi, lo] = mapped.split(':').map((g) => parseInt(g, 16));
      return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return lower === '::1' || lower === '::' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

// Keeps the agent from reaching this gateway, the LAN, or cloud metadata endpoints.
export async function guardUrl(raw) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Blocked URL scheme: ${url.protocol}`);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addresses.some((a) => isPrivateAddress(a.address))) throw new Error(`Blocked private address: ${host}`);
  return url;
}

async function webFetch({ url }, signal) {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    await guardUrl(current);
    const res = await fetch(current, { redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]), headers: { 'user-agent': 'Nocturn/0.1' } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), current).href;
      continue;
    }
    const body = await res.text();
    const text = /html/.test(res.headers.get('content-type') ?? '')
      ? body.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      : body;
    return clip(`HTTP ${res.status} ${current}\n\n${text}`);
  }
  throw new Error('Too many redirects');
}

function runShell({ command }, signal) {
  return new Promise((done) => {
    const [exe, args] = process.platform === 'win32'
      ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]]
      : ['/bin/sh', ['-c', command]];
    const child = spawn(exe, args, { cwd: WORKSPACE, windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { if (out.length < MAX_OUTPUT * 2) out += d; });
    child.stderr.on('data', (d) => { if (out.length < MAX_OUTPUT * 2) out += d; });
    const kill = () => child.kill();
    const timer = setTimeout(kill, SHELL_TIMEOUT_MS);
    signal.addEventListener('abort', kill, { once: true });
    child.on('error', (err) => done(`Failed to start: ${err.message}`));
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', kill);
      done(clip(`${out}\n[exit ${code}]`.trim()));
    });
  });
}

function schema(properties, required = Object.keys(properties)) {
  return { type: 'object', properties, required, additionalProperties: false };
}
const str = (description) => ({ type: 'string', description });

const TOOLS = [
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file from the workspace.',
    input_schema: schema({ path: str('Path relative to the workspace') }),
    run: ({ path }) => clip(readFileSync(safePath(path), 'utf8')),
  },
  {
    name: 'list_files',
    description: 'List files in a workspace directory.',
    input_schema: schema({ path: str('Directory relative to the workspace; use . for the root') }),
    run: ({ path }) => readdirSync(safePath(path), { withFileTypes: true }).map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n') || '(empty)',
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a text file in the workspace.',
    input_schema: schema({ path: str('Path relative to the workspace'), content: str('Full file contents') }),
    run: ({ path, content }) => {
      const file = safePath(path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
      searchIndex.schedule();
      return `Wrote ${statSync(file).size} bytes to ${path}`;
    },
  },
  {
    name: 'edit_file',
    description: 'Replace one exact occurrence of text in a workspace file.',
    input_schema: schema({ path: str('Path relative to the workspace'), old_text: str('Exact text to replace; must occur once'), new_text: str('Replacement') }),
    run: ({ path, old_text, new_text }) => {
      const file = safePath(path);
      const body = readFileSync(file, 'utf8');
      const count = body.split(old_text).length - 1;
      if (count !== 1) throw new Error(`old_text occurs ${count} times, expected exactly 1`);
      writeFileSync(file, body.replace(old_text, () => new_text));
      searchIndex.schedule();
      return `Edited ${path}`;
    },
  },
  {
    name: 'shell',
    description: 'Run a shell command in the workspace (PowerShell on Windows, sh elsewhere). Times out after 2 minutes.',
    input_schema: schema({ command: str('The command to run') }),
    run: (input, ctx) => runShell(input, ctx.signal),
  },
  {
    name: 'web_fetch',
    description: 'Fetch a public web page or API over HTTP(S) and return its text.',
    input_schema: schema({ url: str('The http(s) URL') }),
    run: (input, ctx) => webFetch(input, ctx.signal),
  },
  {
    name: 'browser',
    description: 'Control a headless browser: navigate to a URL, read page text, click or type by CSS selector, or save a screenshot to the workspace.',
    input_schema: schema({
      action: { type: 'string', enum: ['navigate', 'text', 'click', 'type', 'screenshot'] },
      url: str('For navigate'),
      selector: str('CSS selector for click and type'),
      text: str('Text for type'),
    }, ['action']),
    run: (input) => browserAction(input, guardUrl),
  },
  {
    name: 'memory_save',
    description: 'Remember a durable fact about the owner or their work across conversations.',
    input_schema: schema({ text: str('The fact to remember') }),
    run: ({ text }) => { memory.add(text); return 'Saved to memory.'; },
  },
  {
    name: 'memory_search',
    description: 'Search saved memories by meaning and keywords. An empty query lists everything.',
    input_schema: schema({ query: str('What you are looking for, in plain words') }),
    run: async ({ query }) => {
      if (!query.trim()) return memory.list().map((m) => `- ${m.text}`).join('\n') || 'No memories yet.';
      if (searchIndex.size === 0) await searchIndex.refresh();
      const hits = await searchIndex.search(query, { kinds: ['memory'], limit: 8 });
      return hits.map((h) => `- ${h.text}`).join('\n') || 'No matching memories.';
    },
  },
  {
    name: 'search_workspace',
    description: 'Find the workspace files and passages most relevant to a question, by meaning and keywords. Returns paths with snippets; read the file for the full text.',
    input_schema: schema({ query: str('What you are looking for, in plain words') }),
    run: async ({ query }) => {
      if (searchIndex.size === 0) await searchIndex.refresh();
      const hits = await searchIndex.search(query, { kinds: ['file'], limit: 6 });
      return hits.map((h) => `${h.path} (offset ${h.pos}, score ${h.score})\n  ${snippet(h.text, query)}`).join('\n\n') || 'Nothing in the workspace matches.';
    },
  },
  {
    name: 'load_skill',
    description: 'Load the full instructions of an installed skill by name.',
    input_schema: schema({ name: str('Skill name') }),
    run: ({ name }) => {
      const skill = skills.list().find((s) => s.name === name);
      if (!skill) throw new Error(`No skill named ${name}`);
      return skill.body;
    },
  },
  {
    name: 'schedule_task',
    description: 'Create a recurring task that runs a prompt on a 5-field cron schedule in server local time.',
    input_schema: schema({ name: str('Short name'), cron: str('Cron expression, e.g. 0 8 * * 1-5'), prompt: str('What to do each run'), deliver: str('Optional chat target such as telegram:123, or empty') }),
    run: (input, ctx) => { const job = ctx.scheduler.add(input); return `Scheduled ${job.name} (${job.cron})`; },
  },
  {
    name: 'send_message',
    description: 'Send a message through a connected chat channel. Target format: telegram:<chat>, discord:<channel>, slack:<channel>.',
    input_schema: schema({ target: str('Channel target'), text: str('Message text') }),
    run: async ({ target, text }, ctx) => { await ctx.channels.send(target, text); return `Sent to ${target}`; },
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export const toolDefinitions = TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
export const toolNames = TOOLS.map((t) => t.name);

// Eagerly streamed inputs are not validated by the API, so check them before running anything.
export function validateInput(name, input) {
  const tool = BY_NAME.get(name);
  if (!tool) return `Unknown tool: ${name}`;
  if (!input || typeof input !== 'object') return 'Tool input was not valid JSON.';
  for (const key of tool.input_schema.required) {
    if (input[key] === undefined) return `Missing required field: ${key}`;
  }
  for (const [key, value] of Object.entries(input)) {
    const spec = tool.input_schema.properties[key];
    if (!spec) return `Unexpected field: ${key}`;
    if (typeof value !== 'string') return `Field ${key} must be a string`;
    if (spec.enum && !spec.enum.includes(value)) return `Field ${key} must be one of ${spec.enum.join(', ')}`;
  }
  return null;
}

export const runTool = (name, input, ctx) => BY_NAME.get(name).run(input, ctx);
