import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const PUBLIC_DIR = join(root, 'public');
export const DATA_DIR = process.env.NOCTURN_HOME || join(homedir(), '.nocturn');
export const WORKSPACE = join(DATA_DIR, 'workspace');
export const SKILLS_DIR = join(WORKSPACE, 'skills');
export const SESSIONS_DIR = join(DATA_DIR, 'sessions');
for (const dir of [DATA_DIR, WORKSPACE, SKILLS_DIR, SESSIONS_DIR]) mkdirSync(dir, { recursive: true });

export function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeJson(file, value) {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

const DEFAULTS = {
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  effort: 'high',
  anthropicKey: '',
  openaiBaseUrl: 'http://localhost:11434/v1',
  openaiKey: '',
  openaiModel: '',
  persona: 'You are Nocturn, a capable personal assistant running on your owner\'s own machine. Be direct and get things done.',
  policies: {
    read_file: 'auto', list_files: 'auto', memory_search: 'auto', memory_save: 'auto', load_skill: 'auto', search_workspace: 'auto',
    write_file: 'ask', edit_file: 'ask', shell: 'ask', web_fetch: 'ask', browser: 'ask',
    schedule_task: 'ask', send_message: 'ask',
  },
  embeddings: { provider: 'auto', model: '', baseUrl: '', voyageKey: '' },
  transcription: { provider: 'auto', baseUrl: '', key: '', model: '', command: '', language: '' },
  channels: {
    telegram: { enabled: false, token: '', allow: [] },
    discord: { enabled: false, token: '', allow: [] },
    slack: { enabled: false, botToken: '', appToken: '', allow: [] },
  },
};

const CONFIG_FILE = join(DATA_DIR, 'config.json');
const SECRET_KEYS = new Set(['anthropicKey', 'openaiKey', 'token', 'botToken', 'appToken', 'voyageKey', 'key']);

function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (!(k in base)) continue;
    const isObject = v && typeof v === 'object' && !Array.isArray(v);
    if (isObject && base[k] && typeof base[k] === 'object') out[k] = merge(base[k], v);
    else if (SECRET_KEYS.has(k) && v === '') continue; // blank means "keep the stored secret"
    else if (typeof v === typeof base[k]) out[k] = v;
  }
  return out;
}

export const config = merge(DEFAULTS, readJson(CONFIG_FILE, {}));
// Policies added by future versions should not be dropped from saved configs.
config.policies = { ...DEFAULTS.policies, ...config.policies };

export function updateConfig(patch) {
  Object.assign(config, merge(config, patch));
  writeJson(CONFIG_FILE, config);
}

export function redactedConfig() {
  const redact = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => {
    if (SECRET_KEYS.has(k)) return [k, v ? '••••••••' : ''];
    if (v && typeof v === 'object' && !Array.isArray(v)) return [k, redact(v)];
    return [k, v];
  }));
  return redact(config);
}

const TOKEN_FILE = join(DATA_DIR, 'token');
if (!existsSync(TOKEN_FILE)) writeFileSync(TOKEN_FILE, randomBytes(24).toString('hex'), { mode: 0o600 });
export const AUTH_TOKEN = readFileSync(TOKEN_FILE, 'utf8').trim();
