import { randomInt } from 'node:crypto';
import { config, updateConfig } from './config.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function chunks(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : ['(no text)'];
}

class Telegram {
  name = 'telegram';
  stopped = false;
  constructor(hub, cfg) { this.hub = hub; this.base = `${process.env.NOCTURN_TELEGRAM_API || 'https://api.telegram.org'}/bot${cfg.token}`; }

  async #call(method, body) {
    const res = await fetch(`${this.base}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!data.ok) throw new Error(`Telegram ${method}: ${data.description}`);
    return data.result;
  }

  async start() {
    await this.#call('getMe', {});
    this.hub.setStatus(this.name, 'connected');
    let offset = 0;
    while (!this.stopped) {
      try {
        for (const update of await this.#call('getUpdates', { offset, timeout: 25 })) {
          offset = update.update_id + 1;
          const m = update.message;
          if (!m?.text || m.chat.type !== 'private') continue;
          this.hub.inbound(this.name, String(m.from.id), String(m.chat.id), m.text);
        }
      } catch (err) {
        if (this.stopped) return;
        this.hub.setStatus(this.name, `retrying: ${err.message}`);
        await sleep(5000);
        this.hub.setStatus(this.name, 'connected');
      }
    }
  }

  async send(chat, text) {
    for (const part of chunks(text, 4000)) await this.#call('sendMessage', { chat_id: chat, text: part });
  }

  stop() { this.stopped = true; }
}

class Discord {
  name = 'discord';
  stopped = false;
  constructor(hub, cfg) { this.hub = hub; this.token = cfg.token; }

  async start() {
    while (!this.stopped) {
      try { await this.#connect(); } catch (err) { this.hub.setStatus(this.name, `retrying: ${err.message}`); }
      if (!this.stopped) await sleep(5000);
    }
  }

  #connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');
      this.ws = ws;
      let seq = null;
      let beat = null;
      ws.onmessage = (e) => {
        const { op, d, s, t } = JSON.parse(e.data);
        if (s) seq = s;
        if (op === 10) {
          beat = setInterval(() => ws.send(JSON.stringify({ op: 1, d: seq })), d.heartbeat_interval);
          // GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT
          ws.send(JSON.stringify({ op: 2, d: { token: this.token, intents: 512 | 4096 | 32768, properties: { os: process.platform, browser: 'nocturn', device: 'nocturn' } } }));
        } else if (t === 'READY') {
          this.botId = d.user.id;
          this.hub.setStatus(this.name, 'connected');
        } else if (t === 'MESSAGE_CREATE' && !d.author.bot) {
          const mention = new RegExp(`<@!?${this.botId}>`, 'g');
          const direct = !d.guild_id;
          if (!direct && !mention.test(d.content)) return;
          this.hub.inbound(this.name, d.author.id, d.channel_id, d.content.replace(mention, '').trim());
        } else if (op === 7 || op === 9) {
          ws.close();
        }
      };
      ws.onerror = () => reject(new Error('gateway connection failed'));
      ws.onclose = (e) => { clearInterval(beat); e.code === 4004 ? reject(new Error('invalid token')) : resolve(); };
    });
  }

  async send(channel, text) {
    for (const part of chunks(text, 1900)) {
      const res = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(channel)}/messages`, {
        method: 'POST',
        headers: { authorization: `Bot ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ content: part, allowed_mentions: { parse: [] } }),
      });
      if (!res.ok) throw new Error(`Discord send failed: ${res.status}`);
    }
  }

  stop() { this.stopped = true; this.ws?.close(); }
}

class Slack {
  name = 'slack';
  stopped = false;
  constructor(hub, cfg) { this.hub = hub; this.cfg = cfg; }

  async #api(method, token, body) {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body ?? {}),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`Slack ${method}: ${data.error}`);
    return data;
  }

  async start() {
    while (!this.stopped) {
      try {
        const { url } = await this.#api('apps.connections.open', this.cfg.appToken);
        await new Promise((resolve, reject) => {
          const ws = new WebSocket(url);
          this.ws = ws;
          ws.onopen = () => this.hub.setStatus(this.name, 'connected');
          ws.onmessage = (e) => {
            const msg = JSON.parse(e.data);
            if (msg.envelope_id) ws.send(JSON.stringify({ envelope_id: msg.envelope_id }));
            if (msg.type === 'disconnect') ws.close();
            const ev = msg.payload?.event;
            if (!ev?.text || ev.bot_id || ev.subtype) return;
            const relevant = ev.type === 'app_mention' || (ev.type === 'message' && ev.channel_type === 'im');
            if (relevant) this.hub.inbound(this.name, ev.user, ev.channel, ev.text.replace(/<@[A-Z0-9]+>/g, '').trim());
          };
          ws.onerror = () => reject(new Error('socket connection failed'));
          ws.onclose = resolve;
        });
      } catch (err) {
        this.hub.setStatus(this.name, `retrying: ${err.message}`);
      }
      if (!this.stopped) await sleep(5000);
    }
  }

  async send(channel, text) {
    for (const part of chunks(text, 3500)) await this.#api('chat.postMessage', this.cfg.botToken, { channel, text: part });
  }

  stop() { this.stopped = true; this.ws?.close(); }
}

const FACTORIES = { telegram: Telegram, discord: Discord, slack: Slack };

export class ChannelHub {
  active = new Map();
  status = {};
  pairing = new Map();

  constructor(agent) {
    this.agent = agent;
    // A run started from chat asks in that same chat, so the owner never needs the web panel.
    agent.on('event', (e) => {
      if (e.type !== 'approval') return;
      const split = e.sessionId.indexOf(':');
      const adapter = this.active.get(e.sessionId.slice(0, split));
      if (split < 1 || !adapter) return;
      const detail = JSON.stringify(e.input).slice(0, 300);
      adapter.send(e.sessionId.slice(split + 1), `Allow ${e.tool}?\n${detail}\n\nReply /approve or /deny`).catch(() => {});
    });
  }

  setStatus(name, value) {
    this.status[name] = value;
    this.agent.emit('event', { type: 'channels_changed' });
  }

  pairingRequests() {
    return [...this.pairing.entries()].map(([code, p]) => ({ code, channel: p.channel, sender: p.sender }));
  }

  // Unknown senders never reach the agent: they get a code the owner must approve.
  async inbound(channel, sender, chat, text) {
    const adapter = this.active.get(channel);
    if (!adapter) return;
    if (!config.channels[channel].allow.includes(sender)) {
      let code = [...this.pairing].find(([, p]) => p.channel === channel && p.sender === sender)?.[0];
      if (!code) {
        if (this.pairing.size >= 20) return;
        code = String(randomInt(100000, 1000000));
        this.pairing.set(code, { channel, sender });
        this.agent.emit('event', { type: 'channels_changed' });
      }
      await adapter.send(chat, `This Nocturn is private. Pairing code: ${code}. Ask its owner to approve it.`).catch(() => {});
      return;
    }
    const answer = text.trim().match(/^\/(approve|deny)$/i);
    if (answer) {
      const pending = this.agent.pendingApprovals().find((a) => a.sessionId === `${channel}:${chat}`);
      if (pending) this.agent.resolveApproval(pending.id, answer[1].toLowerCase() === 'approve');
      else await adapter.send(chat, 'Nothing is waiting for approval.').catch(() => {});
      return;
    }
    try {
      const reply = await this.agent.run(`${channel}:${chat}`, text, channel);
      await adapter.send(chat, reply);
    } catch (err) {
      await adapter.send(chat, `Could not finish: ${err.message}`).catch(() => {});
    }
  }

  resolvePairing(code, approve) {
    const request = this.pairing.get(code);
    if (!request) return false;
    this.pairing.delete(code);
    if (approve) {
      const allow = [...config.channels[request.channel].allow, request.sender];
      updateConfig({ channels: { [request.channel]: { allow } } });
    }
    this.agent.emit('event', { type: 'channels_changed' });
    return true;
  }

  async send(target, text) {
    const split = target.indexOf(':');
    const adapter = this.active.get(target.slice(0, split));
    if (split < 1 || !adapter) throw new Error(`Channel is not connected: ${target}`);
    await adapter.send(target.slice(split + 1), text);
  }

  restart() {
    for (const adapter of this.active.values()) adapter.stop();
    this.active.clear();
    this.status = {};
    for (const [name, Factory] of Object.entries(FACTORIES)) {
      const cfg = config.channels[name];
      const ready = cfg.enabled && (name === 'slack' ? cfg.botToken && cfg.appToken : cfg.token);
      if (!ready) { this.status[name] = cfg.enabled ? 'missing token' : 'off'; continue; }
      const adapter = new Factory(this, cfg);
      this.active.set(name, adapter);
      this.status[name] = 'connecting';
      adapter.start().catch((err) => this.setStatus(name, `failed: ${err.message}`));
    }
    this.agent.emit('event', { type: 'channels_changed' });
  }
}
