// Voice notes become text before they reach the agent. Two backends: whisper.cpp on this machine
// (private, needs ffmpeg to convert Telegram's ogg/opus to 16 kHz wav) or any OpenAI-compatible
// /audio/transcriptions endpoint (the Whisper API, or a local server such as faster-whisper or
// speaches). Chosen automatically unless the owner picks one.
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from './config.mjs';

const MAX_BYTES = 25 * 1024 * 1024;
const settings = () => ({ provider: 'auto', baseUrl: '', key: '', model: '', command: '', language: '', ...(config.transcription ?? {}) });

const which = (exe) => new Promise((resolve) => {
  execFile(process.platform === 'win32' ? 'where' : 'which', [exe], { windowsHide: true }, (err, out) => resolve(err ? '' : String(out).split(/\r?\n/)[0].trim()));
});

function run(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited with ${code}: ${err.slice(-400)}`))));
    if (input) { child.stdin.end(input); }
  });
}

export const transcriber = {
  status: { provider: 'off', model: '', ready: false, note: 'Voice notes are ignored until a backend is set up.' },
  decided: null,
  async decide(force = false) {
    if (this.decided && !force) return this.decided;
    const s = settings();
    let choice = s.provider;
    const localCommand = s.command || ((await which('whisper-cli')) && 'whisper-cli');
    const ffmpeg = await which('ffmpeg');
    if (choice === 'auto') {
      if (localCommand && ffmpeg) choice = 'whisper-cpp';
      else if (s.baseUrl || s.key || config.openaiKey || (config.provider === 'openai' && config.openaiBaseUrl)) choice = 'openai';
      else choice = 'off';
    }
    if (choice === 'whisper-cpp') {
      const ready = Boolean(localCommand && ffmpeg);
      this.status = { provider: 'whisper-cpp', model: s.command ? 'custom command' : 'whisper-cli', ready, note: ready ? (s.command || 'whisper-cli on PATH') : !ffmpeg ? 'ffmpeg is not on PATH; it converts voice notes to wav.' : 'whisper-cli is not on PATH. Set transcription.command to your whisper.cpp command with {file} and {model}.' };
    } else if (choice === 'openai') {
      const base = (s.baseUrl || (config.provider === 'openai' ? config.openaiBaseUrl : 'https://api.openai.com/v1')).replace(/\/$/, '');
      this.status = { provider: 'openai', model: s.model || 'whisper-1', ready: true, note: `${base}/audio/transcriptions` };
    } else {
      this.status = { provider: 'off', model: '', ready: false, note: 'Install whisper.cpp and ffmpeg, or set a transcription endpoint in Settings.' };
    }
    this.decided = this.status.provider;
    return this.decided;
  },
  reset() { this.decided = null; },

  // bytes: Buffer; name: original file name (extension matters); returns plain text.
  async transcribe(bytes, name = 'voice.ogg', mime = 'audio/ogg') {
    if (bytes.length > MAX_BYTES) throw new Error('The recording is larger than 25 MB.');
    const provider = await this.decide();
    const s = settings();
    if (provider === 'whisper-cpp') return local(bytes, name, s);
    if (provider === 'openai') return remote(bytes, name, mime, s);
    throw new Error('No transcription backend is set up.');
  },

};

async function remote(bytes, name, mime, s) {
    const base = (s.baseUrl || (config.provider === 'openai' ? config.openaiBaseUrl : 'https://api.openai.com/v1')).replace(/\/$/, '');
    const key = s.key || config.openaiKey;
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mime }), name);
    form.append('model', s.model || 'whisper-1');
    form.append('response_format', 'json');
    if (s.language) form.append('language', s.language);
    const res = await fetch(`${base}/audio/transcriptions`, { method: 'POST', headers: key ? { authorization: `Bearer ${key}` } : {}, body: form, signal: AbortSignal.timeout(180000) });
    if (!res.ok) throw new Error(`Transcription endpoint answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const text = String(data.text ?? '').trim();
    if (!text) throw new Error('The transcription came back empty.');
    return text;
}

async function local(bytes, name, s) {
    const dir = mkdtempSync(join(tmpdir(), 'nocturn-voice-'));
    try {
      const src = join(dir, name.replace(/[^\w.-]/g, '_') || 'voice.ogg');
      const wav = join(dir, 'voice.wav');
      writeFileSync(src, bytes);
      await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
      let out;
      if (s.command) {
        const parts = s.command.match(/"[^"]*"|\S+/g).map((p) => p.replace(/^"|"$/g, '').replaceAll('{file}', wav).replaceAll('{model}', s.model));
        out = await run(parts[0], parts.slice(1));
      } else {
        const args = ['-f', wav, '-nt', '-np'];
        if (s.model) args.push('-m', s.model);
        if (s.language) args.push('-l', s.language);
        out = await run('whisper-cli', args);
      }
      const text = out.split(/\r?\n/).map((l) => l.replace(/^\[[^\]]*\]\s*/, '').trim()).filter((l) => l && !l.startsWith('whisper_')).join(' ').trim();
      if (!text) throw new Error('whisper.cpp returned no text.');
      return text;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
}

export const readVoice = (file) => readFileSync(file);
