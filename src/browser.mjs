import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, WORKSPACE } from './config.mjs';

const CANDIDATES = [
  process.env.NOCTURN_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

let page = null;

async function launch() {
  const exe = CANDIDATES.find((p) => existsSync(p));
  if (!exe) throw new Error('No Chrome or Edge found. Set NOCTURN_BROWSER to a browser executable.');
  const profile = join(DATA_DIR, 'browser');
  mkdirSync(profile, { recursive: true });
  const proc = spawn(exe, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  process.once('exit', () => proc.kill());

  const wsUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Browser did not start in time.')), 20000);
    let log = '';
    proc.stderr.on('data', (d) => {
      log += d;
      const match = log.match(/DevTools listening on (ws:\S+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    proc.once('exit', () => { clearTimeout(timer); reject(new Error('Browser exited during startup.')); });
  });

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('Could not connect to browser.')); });
  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(msg.error.message));
    else waiter.resolve(msg.result);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const cmd = (method, params) => send(method, params, sessionId);
  await cmd('Page.enable');
  await cmd('Runtime.enable');
  ws.onclose = () => { page = null; };
  proc.once('exit', () => { page = null; });
  return { cmd, close: () => proc.kill() };
}

async function evaluate(p, expression) {
  const { result, exceptionDetails } = await p.cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
  return result.value;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 800));

export async function browserAction({ action, url, selector, text }, guardUrl) {
  page ??= await launch();
  const p = page;
  switch (action) {
    case 'navigate': {
      if (!url) throw new Error('navigate needs url');
      await guardUrl(url);
      const { errorText } = await p.cmd('Page.navigate', { url });
      if (errorText) throw new Error(errorText);
      await settle();
      return `Opened ${await evaluate(p, 'location.href')} — "${await evaluate(p, 'document.title')}"`;
    }
    case 'text':
      return (await evaluate(p, 'document.body ? document.body.innerText : ""')).slice(0, 50000);
    case 'click': {
      if (!selector) throw new Error('click needs selector');
      await evaluate(p, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('No element matches selector'); el.click(); })()`);
      await settle();
      return `Clicked ${selector}. Now at ${await evaluate(p, 'location.href')}`;
    }
    case 'type': {
      if (!selector || text === undefined) throw new Error('type needs selector and text');
      await evaluate(p, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('No element matches selector'); el.focus(); el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); })()`);
      return `Typed into ${selector}`;
    }
    case 'screenshot': {
      const { data } = await p.cmd('Page.captureScreenshot', { format: 'png' });
      const file = `screenshot-${Date.now()}.png`;
      writeFileSync(join(WORKSPACE, file), Buffer.from(data, 'base64'));
      return `Saved ${file} in the workspace`;
    }
    default:
      throw new Error(`Unknown browser action: ${action}`);
  }
}

export function closeBrowser() {
  page?.close();
  page = null;
}
