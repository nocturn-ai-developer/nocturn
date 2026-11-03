import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DATA_DIR, readJson, writeJson } from './config.mjs';

const JOBS_FILE = join(DATA_DIR, 'jobs.json');
const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];

function parseField(field, [min, max]) {
  const values = new Set();
  for (const part of field.split(',')) {
    const match = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!match) throw new Error(`Invalid cron field: ${field}`);
    const step = Number(match[2] ?? 1);
    if (step < 1) throw new Error(`Invalid cron step: ${field}`);
    const [from, to] = match[1] === '*' ? [min, max] : match[1].includes('-')
      ? match[1].split('-').map(Number)
      : [Number(match[1]), match[2] ? max : Number(match[1])];
    if (from < min || to > max || from > to) throw new Error(`Cron value out of range: ${field}`);
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return values;
}

export function parseCron(expr) {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('Cron needs 5 fields: minute hour day month weekday');
  return fields.map((f, i) => parseField(f, RANGES[i]));
}

export function cronMatches(expr, date) {
  const [minute, hour, day, month, weekday] = parseCron(expr);
  return minute.has(date.getMinutes()) && hour.has(date.getHours()) && day.has(date.getDate())
    && month.has(date.getMonth() + 1) && weekday.has(date.getDay());
}

export class Scheduler {
  constructor(agent, channels) {
    this.agent = agent;
    this.channels = channels;
    this.jobs = readJson(JOBS_FILE, []);
    this.timer = null;
  }

  #save() { writeJson(JOBS_FILE, this.jobs); this.agent.emit('event', { type: 'jobs_changed' }); }

  add({ name, cron, prompt, deliver = '' }) {
    parseCron(cron);
    const job = { id: randomUUID(), name, cron, prompt, deliver, enabled: true, lastRun: null, lastStatus: null };
    this.jobs.push(job);
    this.#save();
    return job;
  }

  update(id, patch) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return null;
    if (typeof patch.enabled === 'boolean') job.enabled = patch.enabled;
    this.#save();
    return job;
  }

  remove(id) { this.jobs = this.jobs.filter((j) => j.id !== id); this.#save(); }

  async fire(job) {
    job.lastRun = new Date().toISOString();
    job.lastStatus = 'running';
    this.#save();
    try {
      const text = await this.agent.run(`cron:${job.id}`, job.prompt, 'cron');
      job.lastStatus = 'ok';
      if (job.deliver && text) await this.channels.send(job.deliver, text);
    } catch (err) {
      job.lastStatus = `error: ${err.message}`;
    }
    this.#save();
  }

  start() {
    let lastMinute = -1;
    this.timer = setInterval(() => {
      const now = new Date();
      if (now.getMinutes() === lastMinute) return;
      lastMinute = now.getMinutes();
      for (const job of this.jobs) {
        if (job.enabled && cronMatches(job.cron, now)) this.fire(job);
      }
    }, 5000);
    this.timer.unref();
  }
}
