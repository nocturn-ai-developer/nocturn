// Approval risk: a label on every tool call that waits for the owner, from two sources.
// 1. Rules that never change: patterns that destroy, escalate, exfiltrate or touch secrets.
// 2. What the owner decided before: a Bernoulli naive Bayes over features of the tool call, trained
//    online from the owner's own approve/deny answers (timeouts and cancels are not counted).
// It never decides. It tells the owner what they usually do and where to look twice.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.mjs';

const DECISIONS_FILE = join(DATA_DIR, 'decisions.jsonl');
const ALPHA = 0.5;

const RULES = [
  { tool: 'shell', test: /\brm\s+(-[a-z]*[rf][a-z]*\s+|--recursive|--force)/i, level: 'high', why: 'deletes recursively' },
  { tool: 'shell', test: /\b(Remove-Item|rd|rmdir|del)\b[^\n]*(-Recurse|\/s|\/q|-Force)/i, level: 'high', why: 'deletes recursively' },
  { tool: 'shell', test: /\b(format|mkfs|diskpart|dd\s+if=)/i, level: 'high', why: 'rewrites a disk' },
  { tool: 'shell', test: /\b(sudo|runas|Start-Process[^\n]*-Verb\s+RunAs)\b/i, level: 'high', why: 'asks for elevated rights' },
  { tool: 'shell', test: /(curl|wget|Invoke-WebRequest|iwr)[^\n|]*\|\s*(sh|bash|zsh|powershell|iex)\b/i, level: 'high', why: 'runs code straight from the internet' },
  { tool: 'shell', test: /\b(shutdown|reboot|Restart-Computer|Stop-Computer)\b/i, level: 'high', why: 'reboots or shuts down' },
  { tool: 'shell', test: /\bgit\s+push\b[^\n]*(--force|-f\b)/i, level: 'high', why: 'rewrites shared history' },
  { tool: 'shell', test: /\b(chmod\s+777|chown\s+-R|icacls[^\n]*Everyone)/i, level: 'medium', why: 'loosens permissions' },
  { tool: 'shell', test: /\b(ssh|scp|rsync|sftp)\b/i, level: 'medium', why: 'reaches another machine' },
  { tool: 'shell', test: /\b(npm|pip|pipx|cargo|gem)\s+(install|i)\b|\bnpx\b/i, level: 'medium', why: 'installs or runs third-party code' },
  { tool: 'shell', test: /\.(env|pem|key|p12|pfx)\b|id_rsa|\.ssh[\\/]|\.aws[\\/]|\.nocturn[\\/](config\.json|token)/i, level: 'high', why: 'touches secrets' },
  { tool: 'shell', test: /\b(cd\s+\.\.|\.\.[\\/])/, level: 'medium', why: 'steps out of the workspace' },
  { tool: ['write_file', 'edit_file', 'read_file'], test: ({ path = '' }) => /\.(env|pem|key|p12|pfx)$|id_rsa|credentials|secret/i.test(path), level: 'high', why: 'a secrets file' },
  { tool: ['write_file', 'edit_file'], test: ({ path = '' }) => /\.\./.test(path), level: 'high', why: 'a path that climbs out of the workspace' },
  { tool: ['write_file', 'edit_file'], test: ({ path = '' }) => /\.(sh|ps1|bat|cmd|exe)$/i.test(path), level: 'medium', why: 'an executable script' },
  { tool: ['web_fetch', 'browser'], test: ({ url = '' }) => /^http:\/\//i.test(url), level: 'medium', why: 'plain http, not https' },
  { tool: 'browser', test: ({ action }) => action === 'type', level: 'medium', why: 'types into a web page' },
  { tool: 'send_message', test: () => true, level: 'medium', why: 'leaves the machine as a message' },
  { tool: 'schedule_task', test: () => true, level: 'low', why: 'will run again on its own' },
];

const WORD = /[^\s"'`|&;<>()]+/g;

// Short, stable strings that describe the call without its free text.
export function features(tool, input = {}) {
  const out = new Set([`tool=${tool}`]);
  const add = (k, v) => { if (v !== undefined && v !== '' && v !== null) out.add(`${k}=${String(v).toLowerCase().slice(0, 60)}`); };
  if (tool === 'shell') {
    const words = String(input.command ?? '').match(WORD) ?? [];
    const cmd = words[0]?.replace(/^.*[\\/]/, '');
    add('cmd', cmd);
    words.slice(1, 6).forEach((w) => { if (w.startsWith('-')) add(`flag:${cmd}`, w); });
    if (words[1] && !words[1].startsWith('-')) add(`sub:${cmd}`, words[1]);
    if (/[|]/.test(input.command ?? '')) out.add('shell:pipe');
    if (/>|>>/.test(input.command ?? '')) out.add('shell:redirect');
  }
  if (['read_file', 'write_file', 'edit_file', 'list_files'].includes(tool)) {
    const path = String(input.path ?? '').replace(/\\/g, '/');
    const parts = path.split('/').filter(Boolean);
    add('dir', parts.length > 1 ? parts[0] : '.');
    add('ext', path.includes('.') ? path.split('.').pop() : 'none');
    if (parts.length > 2) add('dir2', `${parts[0]}/${parts[1]}`);
  }
  if (tool === 'web_fetch' || tool === 'browser') {
    try { const u = new URL(input.url ?? ''); add('host', u.hostname); add('scheme', u.protocol.replace(':', '')); } catch { /* no url for this action */ }
    add('action', input.action);
  }
  if (tool === 'send_message') { add('channel', String(input.target ?? '').split(':')[0]); add('target', input.target); }
  if (tool === 'schedule_task') { add('cron', input.cron); add('deliver', String(input.deliver ?? '').split(':')[0] || 'none'); }
  return [...out];
}

export class RiskModel {
  constructor(file = DECISIONS_FILE) {
    this.file = file;
    this.approved = new Map(); // feature -> count in approved decisions
    this.denied = new Map();
    this.nApproved = 0;
    this.nDenied = 0;
    this.recent = []; // last decisions, for "seen before" counts
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { this.#learn(JSON.parse(line)); } catch { /* skip a bad line */ }
      }
    }
  }

  #learn(d) {
    if (d.by !== 'owner') return;
    const bag = d.approved ? this.approved : this.denied;
    for (const f of d.features ?? features(d.tool, d.input)) bag.set(f, (bag.get(f) ?? 0) + 1);
    if (d.approved) this.nApproved++; else this.nDenied++;
    this.recent.push({ tool: d.tool, features: new Set(d.features ?? features(d.tool, d.input)), approved: d.approved });
    if (this.recent.length > 2000) this.recent.shift();
  }

  // Called once per owner decision. Timeouts and cancels are logged but do not train the model.
  record({ tool, input, approved, by, sessionId }) {
    const d = { at: new Date().toISOString(), tool, input, features: features(tool, input), approved, by, sessionId };
    try { appendFileSync(this.file, `${JSON.stringify(d)}\n`, { mode: 0o600 }); } catch { /* read-only data dir */ }
    this.#learn(d);
  }

  rules(tool, input = {}) {
    const hits = [];
    for (const r of RULES) {
      const tools = Array.isArray(r.tool) ? r.tool : [r.tool];
      if (!tools.includes(tool)) continue;
      const matched = typeof r.test === 'function' ? r.test(input) : r.test.test(String(input.command ?? ''));
      if (matched) hits.push({ level: r.level, why: r.why });
    }
    return hits;
  }

  // Probability the owner approves, with the number of comparable past decisions.
  learned(tool, input = {}) {
    const fs = features(tool, input);
    const total = this.nApproved + this.nDenied;
    if (!total) return { p: null, seen: 0, approvedSeen: 0 };
    let logit = Math.log((this.nApproved + ALPHA) / (this.nDenied + ALPHA));
    for (const f of fs) {
      const a = this.approved.get(f) ?? 0;
      const d = this.denied.get(f) ?? 0;
      if (!a && !d) continue; // unseen feature: no evidence either way
      logit += Math.log((a + ALPHA) / (this.nApproved + 2 * ALPHA)) - Math.log((d + ALPHA) / (this.nDenied + 2 * ALPHA));
    }
    const strong = fs.filter((f) => !f.startsWith('tool='));
    const similar = this.recent.filter((r) => r.tool === tool && (strong.length === 0 || strong.some((f) => r.features.has(f))));
    return { p: 1 / (1 + Math.exp(-logit)), seen: similar.length, approvedSeen: similar.filter((r) => r.approved).length };
  }

  score(tool, input = {}) {
    const rules = this.rules(tool, input);
    const { p, seen, approvedSeen } = this.learned(tool, input);
    const order = { high: 3, medium: 2, low: 1 };
    let level = rules.reduce((m, r) => (order[r.level] > order[m] ? r.level : m), 'low');
    const reasons = rules.map((r) => r.why);
    let label;
    if (seen >= 3 && p !== null && p >= 0.85) label = `You usually allow this (${approvedSeen} of ${seen})`;
    else if (seen >= 3 && p !== null && p <= 0.15) { label = `You usually deny this (${seen - approvedSeen} of ${seen})`; if (level === 'low') level = 'medium'; }
    else if (seen >= 2) label = `Mixed before (${approvedSeen} allowed of ${seen})`;
    else { label = seen === 0 ? 'New: nothing like this has been asked before' : 'Seen once before'; if (level === 'low') level = 'medium'; }
    return { level, label, reasons, p: p === null ? null : Number(p.toFixed(2)), seen };
  }
}

export const risk = new RiskModel();
