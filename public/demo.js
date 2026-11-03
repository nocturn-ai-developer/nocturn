// The scrolling part of the home page. The demo is scripted: it calls no model, no tool and no
// messaging service, and it says so on screen.
import { CHAIN, useRobinhoodChain } from '/wallet.js';
import { followActive } from '/morph.js';
import { bloomingFlower, tesseract } from '/four.js';

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// The contract address and the X account are published from the admin page (nocturnh.com/admin)
// and read from /api/site. On a local gateway that route does not exist, so the defaults stay.
const TOKEN = { ticker: '$NCTRN', contract: '' };
const site = fetch('/api/site').then((r) => (r.ok ? r.json() : {}), () => ({})).then((s) => ({
  contract: typeof s?.contract === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s.contract) ? s.contract : '',
  twitter: typeof s?.twitter === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(s.twitter) ? s.twitter : '',
}));

// A link to the official X account that appears once the admin has set one.
export function xLink(className = 'foot-link') {
  const a = el('a', `${className} hidden`, 'X');
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  site.then(({ twitter }) => { if (twitter) { a.href = `https://x.com/${twitter}`; a.textContent = `@${twitter}`; a.classList.remove('hidden'); } });
  return a;
}

function el(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

const SCENARIOS = [
  {
    id: 'brief', label: 'Morning brief', trigger: 'Schedule · weekdays 8:00 AM',
    steps: [
      { type: 'log', text: 'Scheduled run started. Nobody had to ask.' },
      { type: 'tool', name: 'memory_search', hint: 'priorities this week', result: '3 memories: launch on Friday, short answers, gym at 6:00 PM' },
      { type: 'tool', name: 'read_file', hint: 'notes/tasks.md', result: '7 open tasks, 2 due today' },
      { type: 'tool', name: 'web_fetch', hint: 'https://example.com/industry-news', result: '12 headlines read, 2 relevant' },
      { type: 'file', path: 'briefs/today.md', lines: ['# Today', '', '1. Send launch checklist to the team', '2. Review the pricing page', '3. Reply to supplier about delivery', '', 'Watch: 2 competitor announcements', 'Evening: gym at 6:00 PM'] },
      { type: 'tool', name: 'send_message', hint: 'telegram', result: 'Delivered' },
      { type: 'bot', text: 'Good morning. 3 things matter today:\n\n1. Send the launch checklist\n2. Review the pricing page\n3. Reply to the supplier\n\nFull brief saved in briefs/today.md' },
      { type: 'user', text: 'Move #2 to tomorrow' },
      { type: 'tool', name: 'edit_file', hint: 'notes/tasks.md', result: 'Pricing review moved to tomorrow' },
      { type: 'bot', text: 'Done. Moved to tomorrow.' },
    ],
  },
  {
    id: 'site', label: 'Build a page', trigger: 'Telegram message',
    steps: [
      { type: 'user', text: 'Make a one-page site for my coffee shop, Ember & Oak. Warm colors, menu and opening hours.' },
      { type: 'bot', text: 'On it. I will message you when it is ready.' },
      { type: 'tool', name: 'list_files', hint: 'sites/', result: 'Empty. Starting a new folder.' },
      { type: 'file', path: 'sites/ember-oak/index.html', lines: ['<!doctype html>', '<title>Ember & Oak</title>', '<header>', '  <h1>Ember & Oak</h1>', '  <p>Slow coffee, warm evenings.</p>', '</header>', '<section id="menu">', '  <h2>Menu</h2>', '  <li>Drip coffee</li>', '  <li>Cold brew</li>', '</section>', '<footer>Open daily 7:00 AM to 10:00 PM</footer>'] },
      { type: 'tool', name: 'browser', hint: 'open and screenshot the page', result: 'Page renders. No console errors.' },
      { type: 'preview' },
      { type: 'tool', name: 'send_message', hint: 'telegram', result: 'Delivered' },
      { type: 'bot', text: 'Ready: sites/ember-oak/index.html\nMenu, hours and a warm color theme are in. Want a reservation form too?' },
    ],
  },
  {
    id: 'invoices', label: 'Chase invoices', trigger: 'Telegram message',
    steps: [
      { type: 'user', text: 'Who still owes me money?' },
      { type: 'tool', name: 'read_file', hint: 'finance/invoices.csv', result: '24 invoices, 3 overdue' },
      { type: 'file', path: 'finance/overdue.md', lines: ['# Overdue', '', '| Customer | Days late |', '| Northwind Studio | 12 |', '| Bluepeak Labs | 9 |', '| Harbor & Co | 3 |', '', 'Three reminders drafted below.'] },
      { type: 'bot', text: '3 invoices are overdue: Northwind Studio, Bluepeak Labs and Harbor & Co. I drafted a polite reminder for each.' },
      { type: 'approval', tool: 'send_message', detail: 'Send 3 reminders?' },
      { type: 'tool', name: 'send_message', hint: '3 reminders', result: 'All 3 delivered' },
      { type: 'tool', name: 'schedule_task', hint: 'check payments on Monday 9:00 AM', result: 'Schedule created' },
      { type: 'bot', text: 'Sent. I will check again on Monday at 9:00 AM and tell you who has paid.' },
    ],
  },
  {
    id: 'ops', label: 'Fix a problem', trigger: 'Telegram message',
    steps: [
      { type: 'user', text: 'The app is slow again, can you look?' },
      { type: 'tool', name: 'shell', hint: 'tail -n 200 logs/app.log', result: 'Database pool exhausted, 41 times in 10 minutes' },
      { type: 'tool', name: 'read_file', hint: 'config/database.yml', result: 'pool: 5' },
      { type: 'bot', text: 'Found it: the database pool is too small. Raising it from 5 to 20 should fix this. It needs a restart.' },
      { type: 'approval', tool: 'shell', detail: 'Change pool to 20 and restart?' },
      { type: 'file', path: 'config/database.yml', lines: ['production:', '  adapter: postgresql', '  pool: 20  # was 5', '  timeout: 5000'] },
      { type: 'tool', name: 'shell', hint: 'systemctl restart app', result: 'Restarted. No pool errors in 2 minutes.' },
      { type: 'memory', text: 'Remembered: this app needs a pool of 20' },
      { type: 'bot', text: 'Fixed. The app is responding normally again and I noted the cause for next time.' },
    ],
  },
];

const IDEAS = [
  'Summarize my notes into a one-page report', 'Rename the photos in my workspace by date', 'Draft a weekly update for my team',
  'Turn this CSV into a clean summary', 'Check this page every morning and tell me what changed', 'Write a README for this project',
  'Plan a content calendar for next month', 'Find the error in these logs', 'Remember my clients and how they like to be contacted',
  'Send me a reminder on Telegram every Friday at 4pm', 'Compare these three suppliers in a table', 'Build a small landing page for my idea',
  'Clean up the duplicate files in my downloads folder copy', 'Prepare an agenda for tomorrow\'s meeting',
];

/* Demo player */
function buildDemo() {
  const log = el('div', 'demo-log');
  const fileChips = el('div', 'demo-chips');
  const fileName = el('div', 'demo-filename', 'No files yet');
  const fileBody = el('pre', 'demo-code');
  const preview = el('div', 'demo-preview hidden',
    el('b', '', 'Ember & Oak'), el('span', '', 'Slow coffee, warm evenings.'),
    el('div', 'demo-preview-menu', el('i', '', 'Drip coffee'), el('i', '', 'Cold brew'), el('i', '', 'Open 7 AM')));
  const phoneBody = el('div', 'phone-body');
  const trigger = el('span', 'demo-trigger');
  const bar = el('i');
  const stepLabel = el('span', 'demo-step', '0/0');
  const pauseBtn = el('button', 'btn small', 'Pause');
  const tabs = el('div', 'demo-tabs');
  tabs.setAttribute('role', 'tablist');

  let runId = 0;
  let current = 0;
  let paused = false;
  let visible = false;

  // A desktop window (agent log + workspace) and a phone, like the real thing on your desk.
  const lights = el('span', 'win-lights', el('i'), el('i'), el('i'));
  const window_ = el('div', 'demo-window',
    el('div', 'win-bar', lights, el('span', 'win-title', el('span', 'brand-mark win-mark'), 'Nocturn', el('small', '', '127.0.0.1:18790')), el('span', 'win-live', el('i'), 'live')),
    el('div', 'win-panes',
      el('div', 'demo-panel', el('div', 'demo-panel-head', el('span', '', 'Agent run'), el('small', 'demo-panel-sub', 'tool calls and approvals')), log),
      el('div', 'demo-panel', el('div', 'demo-panel-head', el('span', '', 'Workspace'), el('small', 'demo-panel-sub', '~/.nocturn/workspace')), fileChips, fileName, fileBody, preview)),
    el('div', 'win-foot', el('span', '', 'gateway · 127.0.0.1 only'), el('span', '', 'policy · asks before acting'), el('span', '', 'model · your choice')));
  const phone = el('div', 'phone',
    el('div', 'phone-top'),
    el('div', 'phone-head', el('span', 'phone-avatar', 'N'), el('div', '', el('b', '', 'Nocturn'), el('small', '', 'bot · simulated chat'))),
    phoneBody,
    el('div', 'phone-input', el('span', '', 'Message'), el('i')),
    el('div', 'phone-bottom'));
  const root = el('section', 'demo',
    el('div', 'demo-bar', tabs, el('span', 'demo-bar-end', el('span', 'demo-sim', 'Simulation'), trigger, stepLabel, pauseBtn)),
    el('div', 'demo-progress', bar),
    el('div', 'demo-grid', window_, el('div', 'phone-shell', phone)));
  const setStep = (done, total) => {
    bar.style.width = `${(done / total) * 100}%`;
    stepLabel.textContent = `${done}/${total}`;
  };

  const stop = Symbol('stop');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  async function sleep(ms, id) {
    if (reducedMotion) return;
    let left = ms;
    while (left > 0) {
      if (id !== runId) throw stop;
      if (paused || !visible || document.hidden) { await wait(150); continue; } // only runs while someone can see it
      await wait(40);
      left -= 40;
    }
    if (id !== runId) throw stop;
  }
  const toBottom = (node) => { node.scrollTop = node.scrollHeight; };

  function bubble(kind, text) {
    const node = el('div', `tg ${kind}`, text);
    phoneBody.append(node);
    toBottom(phoneBody);
    return node;
  }

  async function runStep(step, id) {
    if (step.type === 'log') {
      log.append(el('div', 'demo-line', step.text));
    } else if (step.type === 'memory') {
      log.append(el('div', 'demo-line memory', step.text));
    } else if (step.type === 'tool') {
      const state = el('span', 'demo-state run', 'running');
      const result = el('div', 'demo-result hidden', step.result);
      log.append(el('div', 'demo-tool', el('div', 'demo-tool-row', el('b', '', step.name), el('span', 'demo-hint', step.hint), state), result));
      toBottom(log);
      await sleep(850, id);
      state.textContent = 'done';
      state.className = 'demo-state ok';
      result.classList.remove('hidden');
    } else if (step.type === 'file') {
      const chip = el('span', 'demo-chip', step.path.split('/').pop());
      fileChips.querySelectorAll('.active').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      fileChips.append(chip);
      fileName.textContent = step.path;
      fileBody.textContent = '';
      preview.classList.add('hidden');
      fileBody.classList.remove('hidden');
      log.append(el('div', 'demo-tool', el('div', 'demo-tool-row', el('b', '', 'write_file'), el('span', 'demo-hint', step.path), el('span', 'demo-state ok', 'done'))));
      for (const line of step.lines) {
        const kind = /^\s*</.test(line) ? 'tag' : /^\s*(#|\/\/|-{2,}|\|)/.test(line) ? 'muted' : /^\s*\d+\./.test(line) ? 'list' : '';
        fileBody.append(el('span', `demo-codeline ${kind}`, line || ' '));
        toBottom(fileBody);
        await sleep(110, id);
      }
    } else if (step.type === 'preview') {
      fileBody.classList.add('hidden');
      preview.classList.remove('hidden');
    } else if (step.type === 'user') {
      await sleep(350, id);
      bubble('me', step.text);
      log.append(el('div', 'demo-line incoming', `Telegram: ${step.text}`));
    } else if (step.type === 'bot') {
      const typing = bubble('bot typing', '');
      typing.append(el('i'), el('i'), el('i'));
      await sleep(800, id);
      typing.remove();
      bubble('bot', step.text);
    } else if (step.type === 'approval') {
      const allow = el('span', 'tg-btn', 'Allow');
      const state = el('span', 'demo-state run', 'waiting for you');
      log.append(el('div', 'demo-tool', el('div', 'demo-tool-row', el('b', '', step.tool), el('span', 'demo-hint', step.detail), state)));
      toBottom(log);
      const ask = bubble('bot', `${step.detail}\n`);
      ask.append(el('div', 'tg-actions', el('span', 'tg-btn', 'Deny'), allow));
      toBottom(phoneBody);
      await sleep(1500, id);
      allow.classList.add('pressed');
      state.textContent = 'approved';
      state.className = 'demo-state ok';
    }
    toBottom(log);
  }

  function select(index) {
    current = index;
    runId += 1;
    const id = runId;
    const scenario = SCENARIOS[index];
    tabs.querySelectorAll('.demo-tab').forEach((tab, i) => {
      tab.classList.toggle('active', i === index);
      tab.setAttribute('aria-selected', String(i === index));
    });
    log.replaceChildren();
    phoneBody.replaceChildren();
    fileChips.replaceChildren();
    fileName.textContent = 'No files yet';
    fileBody.textContent = '';
    fileBody.classList.remove('hidden');
    preview.classList.add('hidden');
    setStep(0, scenario.steps.length);
    trigger.textContent = `Starts from: ${scenario.trigger}`;
    (async () => {
      try {
        for (const [i, step] of scenario.steps.entries()) {
          await runStep(step, id);
          setStep(i + 1, scenario.steps.length);
          await sleep(450, id);
        }
        if (reducedMotion) return;
        await sleep(3500, id);
        select((index + 1) % SCENARIOS.length);
      } catch (err) {
        if (err !== stop) throw err;
      }
    })();
  }

  SCENARIOS.forEach((scenario, i) => {
    const tab = el('button', 'demo-tab', scenario.label);
    tab.setAttribute('role', 'tab');
    tab.addEventListener('click', () => select(i));
    tabs.append(tab);
  });
  pauseBtn.addEventListener('click', () => {
    paused = !paused;
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
  });

  new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; }, { threshold: 0.15 }).observe(root);
  followActive(tabs);
  select(0);
  return root;
}

/* Page sections */
function heading(title, text, { badge = null } = {}) {
  return el('div', 'section-head reveal', badge ? el('span', 'pill', badge) : null,
    el('h2', '', title), text ? el('p', '', text) : null);
}

const stats = {};

// Numbers on the page come from this install, so they are true for whoever is looking.
export function setStats({ memory, skills, config }) {
  if (!stats.memory) return;
  stats.memory.textContent = memory.length;
  stats.skills.textContent = skills.length;
  for (const [policy, list] of Object.entries(stats.rules)) {
    const tools = Object.keys(config.policies).filter((tool) => config.policies[tool] === policy);
    list.replaceChildren(...(tools.length ? tools.map((tool) => el('span', 'rule-tool', tool)) : [el('span', 'rule-none', 'None')]));
  }
}

function tile(art, title, text) {
  return el('article', 'tile reveal', art, el('h3', '', title), el('p', '', text));
}

function buildBento() {
  const pairing = el('div', 'tile-art pairing',
    el('div', 'pair-msg', el('small', '', 'Telegram · new sender'), 'Your pairing code is 482913'),
    el('div', 'pair-cmd', el('span', '', '$'), ' nocturn pairing approve 482913'),
    el('div', 'pair-ok', 'Approved. That sender can talk to Nocturn now.'));
  const week = el('div', 'tile-art schedule',
    el('code', 'cron-line', '0 8 * * 1-5'),
    el('div', 'week', ...['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((day, i) => el('span', i < 5 ? 'on' : '', day))),
    el('div', 'cron-note', 'Every weekday at 8:00 AM'));
  stats.memory = el('b', '', '0');
  stats.skills = el('b', '', '0');
  const numbers = el('div', 'tile-art stats',
    el('div', 'stat', stats.memory, el('small', '', 'Memories')),
    el('div', 'stat', stats.skills, el('small', '', 'Skills')));
  stats.rules = {};
  const rule = (key, label) => {
    stats.rules[key] = el('div', 'rule-list');
    return el('div', 'rule', el('small', '', label), stats.rules[key]);
  };
  const rules = el('div', 'tile-art rules', rule('auto', 'Always allow'), rule('ask', 'Asks you'), rule('deny', 'Blocked'));
  return el('div', 'bento',
    tile(pairing, 'Reach it from your chat apps', 'Connect Telegram, Discord or Slack to the gateway. New senders need a pairing code you approve.'),
    tile(week, 'Works on a schedule', 'Jobs run by themselves while your computer is on, and the result lands in your chat.'),
    tile(numbers, 'Remembers how you like things', 'Memory carries across conversations. Skills hold the jobs you repeat. These are your numbers.'),
    tile(rules, 'You set the rules', 'Your tools right now, by permission. It can edit files, run commands and drive a browser only as far as you allow.'));
}

async function copyText(button, text) {
  const label = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Could not copy';
  }
  setTimeout(() => { button.textContent = label; }, 1200);
}

function marquee(items, reverse) {
  const row = el('div', `marquee-row ${reverse ? 'reverse' : ''}`);
  const copy = (hidden) => items.map((text) => {
    const chip = el('button', 'idea', text);
    chip.addEventListener('click', () => copyText(chip, `nocturn agent -m "${text.replaceAll('"', '\\"')}"`));
    if (hidden) { chip.setAttribute('aria-hidden', 'true'); chip.tabIndex = -1; } // second copy only closes the loop
    return chip;
  });
  row.append(...copy(false), ...copy(true));
  return el('div', 'marquee', row);
}

const TERMINAL = [
  ['nocturn onboard', ['Nocturn setup', 'Model provider: anthropic', 'Connect a Telegram bot? y', 'Done.']],
  ['nocturn gateway start', ['● Gateway running on 127.0.0.1:18790 (pid 8952)', '  Logs: nocturn gateway logs']],
  ['nocturn pairing approve 482913', ['Approved. That sender can talk to Nocturn now.']],
  ['nocturn cron add --name brief --cron "0 8 * * 1-5" -m "plan my day" --deliver telegram:42', ['Cron job added.']],
  ['nocturn agent -m "summarize my notes into report.md"', ['→ read_file notes.md', '? Allow write_file report.md [y/N] y', '→ write_file report.md', 'Done. The summary is in report.md.']],
  ['nocturn status', ['● Gateway running on 127.0.0.1:18790 (pid 8952)', '  Model      claude-opus-5-5 ready', '  Channels   telegram: connected, discord: off, slack: off', '  Cron jobs  1']],
];

// Plays the commands like a real session, only while it is on screen.
let terminalNode = null;
// One instance, so a refresh of the hero does not restart the session.
export function heroTerminal() {
  terminalNode ??= buildTerminal();
  return terminalNode;
}

function buildTerminal() {
  const body = el('pre', 'term-body');
  const root = el('div', 'term', el('div', 'term-head', el('i'), 'nocturn', el('span', '', 'Example session')), body);
  let visible = false;
  new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; }, { threshold: 0.2 }).observe(root);
  const pause = async (ms) => {
    for (let left = ms; left > 0; left -= 30) {
      await new Promise((r) => setTimeout(r, 30));
      while (!visible || document.hidden) await new Promise((r) => setTimeout(r, 150));
    }
  };
  const line = (text, className) => {
    const node = el('span', className, text);
    body.append(node, '\n');
    body.scrollTop = body.scrollHeight;
    return node;
  };
  if (reducedMotion) {
    for (const [command, output] of TERMINAL) { line(`$ ${command}`, 'term-cmd'); output.forEach((o) => line(o, 'term-out')); }
    return root;
  }
  (async () => {
    for (;;) {
      body.textContent = '';
      for (const [command, output] of TERMINAL) {
        const typed = line('$ ', 'term-cmd');
        for (const char of command) { typed.textContent += char; await pause(24); }
        await pause(320);
        for (const text of output) { line(text, 'term-out'); await pause(170); }
        await pause(650);
      }
      await pause(3500);
    }
  })();
  return root;
}

const isWindows = navigator.platform.startsWith('Win');

export function installLine() {
  const command = isWindows ? 'npm.cmd install -g @morpheapp/nocturn' : 'npm install -g @morpheapp/nocturn';
  const copy = el('button', 'btn small primary', 'Copy');
  copy.addEventListener('click', () => copyText(copy, command));
  return el('div', 'install-line', el('code', '', el('span', '', '$ '), command), copy);
}

const NIGHT = [
  ['11:00 PM', 'You', 'Start the gateway and go to bed.', 0],
  ['12:30 AM', 'Cron', 'Checks the page you asked it to watch. Nothing changed, so it stays quiet.', 0.14],
  ['2:14 AM', 'Shell', 'Reads the app logs. The database pool is too small.', 0.3],
  ['2:15 AM', 'Telegram', 'Changing it needs a restart, so it asks you and waits.', 0.42],
  ['5:00 AM', 'Files', 'Summarizes your notes into report.md.', 0.58],
  ['6:30 AM', 'Memory', 'Saves what it learned about your app for next time.', 0.74],
  ['7:00 AM', 'Telegram', 'Your brief is waiting. You tap Allow, and the fix goes out.', 0.9],
];
const NIGHT_START = 23 * 60;
const NIGHT_LENGTH = 8 * 60;

// The page scroll is the night: the clock runs from 11:00 PM to 7:00 AM as the reader moves down.
const twelveHour = (minutes) => `${Math.floor(minutes / 60) % 12 || 12}:${String(minutes % 60).padStart(2, '0')} ${minutes < 720 ? 'AM' : 'PM'}`;
function buildNight() {
  const clock = el('div', 'night-clock', '11:00 PM');
  const fill = el('i');
  const rows = NIGHT.map(([time, source, text]) => el('li', 'night-row', el('time', '', time), el('b', '', source), el('span', '', text)));
  const root = el('section', 'night',
    el('div', 'night-pin',
      el('div', 'night-side',
        el('span', 'pill', 'Example night'),
        clock,
        el('div', 'night-track', fill),
        el('h2', '', 'What it does while you are asleep'),
        el('p', '', 'Your computer has to stay on, or it can run on a server. Anything risky waits for your answer.')),
      el('ol', 'night-log', ...rows)));
  root.id = 'night';

  const paint = () => {
    const pin = root.firstChild;
    const pinned = getComputedStyle(pin).position === 'sticky' && !reducedMotion;
    const rect = root.getBoundingClientRect();
    const p = pinned ? Math.min(1, Math.max(0, -rect.top / Math.max(1, rect.height - pin.offsetHeight))) : 1;
    const minutes = Math.round(NIGHT_START + p * NIGHT_LENGTH) % 1440;
    clock.textContent = twelveHour(minutes);
    fill.style.width = `${p * 100}%`;
    root.style.setProperty('--dawn', p.toFixed(3));
    rows.forEach((row, i) => row.classList.toggle('lit', p >= NIGHT[i][3]));
  };
  let queued = false;
  const queue = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; paint(); });
  };
  addEventListener('scroll', queue, { capture: true, passive: true });
  addEventListener('resize', queue);
  requestAnimationFrame(paint);
  return root;
}

/* Why Nocturn */
const REASONS = [
  ['One install, two jobs', 'npm install -g @morpheapp/nocturn gives you the agent, its gateway and the miner. Nothing else to download.'],
  ['On your laptop or a VPS', 'Run it at home, or on a server so it keeps working around the clock while your own computer is off.'],
  ['Your data stays yours', 'Keys, memory and files live in ~/.nocturn. The gateway only listens on this machine.'],
  ['It asks before it acts', 'Shell commands, file changes and outgoing messages wait for your yes, from the terminal or your chat.'],
  ['Bring any model', 'Use Claude, or any OpenAI-compatible endpoint. With a local model such as Ollama, your prompts never leave the machine.'],
  ['Reach it from your chats', 'Telegram, Discord and Slack connect to the same gateway. A stranger cannot use it without a pairing code you approve.'],
];

function buildWhy() {
  const section = el('section', 'why reveal',
    el('div', 'why-head',
      el('div', 'why-copy',
        el('span', 'pill', 'Why'),
        el('h2', '', 'Why Nocturn'),
        el('p', '', 'Most AI tools live in someone else\'s browser tab. Nocturn lives on a machine you control and keeps working when you close the lid on your day.')),
      el('div', 'cube-scene', tesseract())),
    el('ol', 'why-grid', ...REASONS.map(([title, text], i) => el('li', 'why-cell',
      el('span', 'why-icon', ['⌘', '☾', '◈', '✓', '◐', '✉'][i]), el('h3', '', title), el('p', '', text)))));
  section.id = 'why';
  return section;
}

/* Light by design: an x-ray flower that blooms, labelled like a specimen */
function buildLight() {
  const fact = (value, label) => el('div', 'light-fact', el('b', '', value), el('span', '', label));
  return el('section', 'light reveal',
    el('div', 'light-art', bloomingFlower([['object (1)', 'gateway, idle', '0.0% CPU'], ['object (2)', 'memory', '63 MB'], ['object (3)', 'new hardware', 'none']])),
    el('div', 'light-copy',
      el('span', 'pill', 'Energy'),
      el('h2', '', 'Light by design'),
      el('p', '', 'Nocturn needs no new machine and no data center of its own. It runs on the computer or server you already have, and while it waits for work it uses almost nothing.'),
      el('div', 'light-facts', fact('0.0%', 'CPU while idle'), fact('63 MB', 'memory'), fact('0', 'new machines')),
      el('p', 'light-note', 'Measured on one Windows laptop with the gateway waiting for a task. Model calls run on your provider\'s servers, and mining uses power for every thread you give it. For the lightest setup, use a local model and a host that runs on renewable energy.')));
}

/* A flower drawn in pixels that grows when it comes into view */
function pixelFlower() {
  const SIZE = 9;
  const COLS = 25;
  const ROWS = 34;
  const canvas = el('canvas', 'pixel-flower');
  canvas.width = COLS * SIZE;
  canvas.height = ROWS * SIZE;
  canvas.setAttribute('aria-hidden', 'true');
  let seed = 7;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const cells = [];
  for (let y = ROWS - 1; y >= 0; y -= 1) {
    for (let x = 0; x < COLS; x += 1) {
      const dx = (x - 12) / 7.5;
      const dy = (y - 8.5) / 7;
      const petalAngle = Math.atan2(dy, dx);
      const bloom = dx * dx + dy * dy <= (0.62 + 0.38 * Math.abs(Math.cos(petalAngle * 2.5))) * (0.9 + random() * 0.2);
      const stemX = 12 + Math.round(Math.sin(y / 5) * 1.4);
      const stem = y > 14 && Math.abs(x - stemX) <= (y > 30 ? 1 : 0);
      const leaf = (y >= 21 && y <= 24 && x > stemX && x - stemX <= 25 - y) || (y >= 25 && y <= 28 && x < stemX && stemX - x <= y - 22);
      if (bloom || stem || leaf) cells.push({ x, y, order: bloom ? 20 + (8.5 - Math.hypot(dx * 7.5, dy * 7)) * -1.2 + 14 : ROWS - y, tone: bloom ? 120 + random() * 135 : 70 + random() * 60, sage: leaf || stem });
    }
  }
  cells.sort((a, b) => a.order - b.order);
  const ctx = canvas.getContext('2d');
  const draw = (count) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const cell of cells.slice(0, count)) {
      const t = Math.round(cell.tone);
      ctx.fillStyle = cell.sage ? `rgb(${80 + t * 0.2}, ${150 + t * 0.3}, ${220})` : `rgb(${120 + t * 0.5}, ${70 + t * 0.2}, ${255})`;
      ctx.fillRect(cell.x * SIZE + 1, cell.y * SIZE + 1, SIZE - 2, SIZE - 2);
    }
  };
  if (reducedMotion) { draw(cells.length); return canvas; }
  draw(0);
  let started = false;
  new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting || started) return;
    started = true;
    const begin = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - begin) / 2600);
      draw(Math.round(cells.length * (1 - (1 - p) ** 3)));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, { threshold: 0.4 }).observe(canvas);
  return canvas;
}

/* $NCTRN */
function buildToken() {
  const add = el('button', 'btn', 'Add Robinhood Chain to wallet');
  const note = el('p', 'token-note');
  add.addEventListener('click', async () => {
    note.textContent = '';
    try { await useRobinhoodChain(); note.textContent = 'Your wallet is on Robinhood Chain.'; } catch (err) { note.textContent = err?.code === 4001 ? 'You canceled in your wallet.' : err.message; }
  });
  const contract = el('span', 'token-pending', 'Not deployed yet');
  const number = el('div', 'glass-card-number', '0x···· not deployed');
  const follow = xLink('btn');
  site.then(({ contract: address }) => {
    if (!address) return;
    const link = el('a', 'mono', address);
    link.href = `${CHAIN.blockExplorerUrls[0]}/address/${address}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    contract.replaceWith(link);
    number.textContent = `${address.slice(0, 6)} ···· ${address.slice(-4)}`;
  });
  const row = (label, value) => el('div', 'token-row', el('span', '', label), value);
  const section = el('section', 'token reveal',
    el('div', 'token-copy',
      el('span', 'pill', 'Token'),
      el('h2', 'token-ticker', TOKEN.ticker),
      el('p', '', 'The Nocturn token, launching on Robinhood Chain.'),
      el('div', 'actions', add, follow), note),
    el('div', 'token-art',
      el('div', 'glass-card',
        el('div', 'glass-card-top', el('b', '', TOKEN.ticker), el('span', 'glass-chip')),
        number,
        el('div', 'glass-card-foot', el('span', '', 'Robinhood Chain'), el('span', '', `ID ${parseInt(CHAIN.chainId, 16)}`)))),
    el('div', 'token-card',
      row('Ticker', el('b', '', TOKEN.ticker)),
      row('Network', el('b', '', `${CHAIN.chainName} · chain ID ${parseInt(CHAIN.chainId, 16)}`)),
      row('Contract', contract),
      el('p', 'token-fine', 'Check the contract address only here or on nocturnh.com. The NOCT balance in the miner is a pool score, not $NCTRN. Nothing on this page is an offer or investment advice.')));
  section.id = 'token';
  return section;
}

/* Download: the same gateway as an app */
const PLATFORMS = [
  { key: 'windows', name: 'Windows', kind: 'Installer · .exe', test: () => /Win/.test(navigator.platform), note: 'Windows 10 or newer. Starts the gateway and opens the panel in its own window.' },
  { key: 'mac', name: 'macOS', kind: 'Disk image · .dmg', test: () => /Mac/.test(navigator.platform) && !('ontouchend' in document), note: 'Apple silicon and Intel. Lives in the menu bar and keeps working when the window is closed.' },
  { key: 'android', name: 'Android', kind: 'Package · .apk', test: () => /Android/.test(navigator.userAgent), note: 'A client for a gateway you run at home or on a server, over a private network such as Tailscale.' },
];

// One fetch for every Download button on the page.
const downloads = fetch('/downloads.json').then((r) => (r.ok ? r.json() : {}), () => ({}));
const directUrl = (urls, key) => (typeof urls?.[key] === 'string' && /^https:\/\//.test(urls[key]) ? urls[key] : '');
const thisPlatform = () => PLATFORMS.find((p) => p.test()) ?? null;

// A button that names the visitor's platform and links straight to its installer when there is
// one, or scrolls to the Download section when there is not yet.
export function downloadButton(className = 'btn primary') {
  const platform = thisPlatform();
  const button = el('a', className, platform ? `Download for ${platform.name}` : 'Download the app');
  if (className.includes('primary')) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'btn-icon');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M12 4v11m0 0l-4-4m4 4l4-4M5 20h14');
    svg.append(path);
    button.prepend(svg);
  }
  button.href = '#download';
  button.addEventListener('click', (e) => {
    if (button.dataset.direct) return;
    e.preventDefault();
    document.getElementById('download')?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth' });
  });
  if (platform) downloads.then((urls) => { const url = directUrl(urls, platform.key); if (url) { button.href = url; button.dataset.direct = '1'; } });
  return button;
}

function buildDownload() {
  const cards = PLATFORMS.map((p) => {
    const button = el('a', 'btn primary', 'Download');
    button.setAttribute('aria-disabled', 'true');
    button.textContent = 'Coming soon';
    const card = el('article', 'dl-card tile reveal', el('span', 'dl-kind', p.kind), el('h3', '', p.name), el('p', '', p.note), el('div', 'actions', button));
    if (p.test()) card.append(el('span', 'dl-here', 'For this device'));
    return { card, button, key: p.key };
  });
  const web = el('article', 'dl-card tile reveal',
    el('span', 'dl-kind', 'Web app'), el('h3', '', 'Install from the browser'),
    el('p', '', 'Open your own gateway at 127.0.0.1:18790/panel.html and choose Install app. Same panel, no download, on any phone or desktop that can reach your gateway.'),
    el('div', 'actions', (() => { const a = el('a', 'btn', 'Read how'); a.href = '/docs#apps'; return a; })()));
  const terminal = el('article', 'dl-card tile reveal',
    el('span', 'dl-kind', 'Terminal'), el('h3', '', 'npm'),
    el('p', '', 'The original. One package gives you the gateway, the CLI and the miner on Windows, macOS and Linux.'),
    el('div', 'actions', (() => { const b = el('button', 'btn', 'Install command'); b.addEventListener('click', () => document.getElementById('install')?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth' })); return b; })()));
  downloads.then((urls) => {
    for (const { button, key } of cards) {
      const url = directUrl(urls, key);
      if (!url) continue;
      button.href = url;
      button.textContent = `Download for ${PLATFORMS.find((p) => p.key === key).name}`;
      button.removeAttribute('aria-disabled');
    }
  });
  const section = el('section', 'landing-block download',
    heading('Download the app', 'Windows and macOS run the gateway for you. Android and the web app connect to one you already run.', { badge: 'Download' }),
    el('div', 'dl-grid', ...cards.map((c) => c.card), web, terminal),
    el('p', 'dl-fine', 'Downloads are built from the same source as the npm package. The phone never runs the agent: it needs a gateway on a computer or server that stays on.'));
  section.id = 'download';
  return section;
}

const INSTALL = {
  'Windows (PowerShell)': ['npm.cmd install -g @morpheapp/nocturn', 'nocturn.cmd onboard'],
  'Linux and macOS': ['npm install -g @morpheapp/nocturn', 'nocturn onboard'],
};

function buildInstall() {
  const code = el('pre', 'install-code');
  const copy = el('button', 'btn small primary', 'Copy');
  const tabs = el('div', 'install-tabs');
  let current = [];
  const show = (name) => {
    current = INSTALL[name];
    code.textContent = current.join('\n');
    [...tabs.children].forEach((t) => t.classList.toggle('active', t.textContent === name));
  };
  for (const name of Object.keys(INSTALL)) {
    const tab = el('button', 'demo-tab', name);
    tab.addEventListener('click', () => show(name));
    tabs.append(tab);
  }
  copy.addEventListener('click', () => copyText(copy, current.join('\n')));
  show(Object.keys(INSTALL)[isWindows ? 0 : 1]);
  followActive(tabs);
  return el('div', 'install', tabs, el('div', 'install-box', code, copy));
}

let page = null;
let trustBlock = null;
let trusted = [];

function renderTrusted() {
  if (!trustBlock) return;
  const card = ({ name, logo }, hidden) => {
    const img = el('img');
    img.src = logo;
    img.alt = '';
    const item = el('div', 'trust-item', img, el('span', '', name));
    if (hidden) item.setAttribute('aria-hidden', 'true');
    return item;
  };
  // A short list stays still. Only a long one has enough width to loop without a gap.
  const body = trusted.length < 6
    ? el('div', 'trust-row', ...trusted.map((p) => card(p)))
    : el('div', 'marquee', el('div', 'marquee-row', ...trusted.map((p) => card(p)), ...trusted.map((p) => card(p, true))));
  trustBlock.querySelector('.trust-row, .marquee')?.remove();
  trustBlock.append(body);
  trustBlock.classList.toggle('hidden', !trusted.length);
}

export function setTrusted(list) {
  trusted = list;
  renderTrusted();
}

/* Footer: the night ends here */
function buildFooter(admin) {
  const link = (text, href, external = false) => {
    const a = el('a', 'foot-item', text);
    a.href = href;
    if (external) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    return a;
  };
  const column = (title, ...items) => el('div', 'foot-col', el('span', 'foot-title', title), ...items);
  const x = xLink('foot-item');
  const command = isWindows ? 'npm.cmd install -g @morpheapp/nocturn' : 'npm install -g @morpheapp/nocturn';
  const copy = el('button', 'btn small primary', 'Copy');
  copy.addEventListener('click', () => copyText(copy, command));
  const top = el('button', 'foot-top', el('span', '', '↑'), 'Back to top');
  top.addEventListener('click', () => document.getElementById('top')?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth' }));
  const year = new Date().getFullYear();
  const footer = el('footer', 'site-foot',
    el('div', 'foot-glow'),
    el('div', 'foot-grid',
      el('div', 'foot-brand',
        el('span', 'brand-mark foot-mark'),
        el('b', '', 'NOCTURN'),
        el('small', 'foot-origin', 'Nocturn USA'),
        el('p', '', 'A self-hosted AI agent for your computer or server. It asks before it acts, and keeps working while you sleep.'),
        el('div', 'foot-install', el('code', '', el('span', '', '$ '), command), copy),
        el('div', 'foot-chips', el('span', '', el('i'), 'Open source'), el('span', '', el('i'), 'Asks before it acts'), el('span', '', el('i'), 'Runs where you run it'))),
      column('Product', link('Download', '/#download'), link('Install guide', '/install'), link('Documentation', '/docs'), link('Changelog', '/changelog'), link('Mining', '/docs#mining')),
      column('Source', link('GitHub', 'https://github.com/nocturn-ai-developer/nocturn', true), link('npm package', 'https://www.npmjs.com/package/@morpheapp/nocturn', true), link('Releases', 'https://github.com/nocturn-ai-developer/nocturn/releases', true), link('Report an issue', 'https://github.com/nocturn-ai-developer/nocturn/issues', true)),
      column('Token', link('$NCTRN', '/#token'), link('Robinhood Chain', CHAIN.blockExplorerUrls[0], true), x, el('small', 'foot-note', 'The contract address is published only on this site. Not financial advice.'))),
    el('div', 'foot-word', 'NOCTURN'),
    el('div', 'foot-bar',
      el('span', '', `© ${year} Nocturn USA · All rights reserved · nocturnh.com`),
      el('span', 'foot-bar-links', link('Privacy', '/privacy'), link('Terms', '/terms'), link('Docs', '/docs'), admin, top)));
  return footer;
}

// One instance for the whole visit, so a page refresh does not restart the demo.
export function landing(actions) {
  if (page) return page;
  const half = Math.ceil(IDEAS.length / 2);
  const demo = el('div', 'landing-block', heading('Watch it work', 'A scripted example of the gateway at work. Nothing here is really sent.', { badge: 'Simulation' }), buildDemo());
  demo.id = 'demo';

  trustBlock = el('div', 'trust', el('div', 'trust-label', 'Trusted by'));
  renderTrusted();

  const install = el('div', 'closing reveal',
    el('div', 'closing-copy', pixelFlower(), el('span', 'pill', 'Get started'),
      el('h2', '', 'Install it once. Sleep on it.'),
      el('p', '', 'Needs Node 22 or newer, plus a Claude or OpenAI-compatible model key.'), buildInstall()));
  let admin = null;
  if (actions.onAdmin) {
    admin = el('button', 'foot-link', 'Edit Trusted by');
    admin.addEventListener('click', actions.onAdmin);
  }
  install.id = 'install';

  page = el('div', 'landing',
    trustBlock,
    buildDownload(),
    el('div', 'landing-block', heading('Run it with commands', 'Start the gateway once. After that it works by itself.', { badge: 'Terminal' }), heroTerminal()),
    buildNight(),
    buildWhy(),
    el('div', 'landing-block', heading('What runs on your machine', 'One gateway on your own computer or server, with your rules.', { badge: 'Gateway' }), buildBento()),
    buildLight(),
    demo,
    el('div', 'landing-block', heading('Jobs to hand it', 'Click one to copy the command.', { badge: 'Ideas' }),
      marquee(IDEAS.slice(0, half), false), marquee(IDEAS.slice(half), true)),
    buildToken(),
    install,
    buildFooter(admin));

  const revealer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('shown');
      revealer.unobserve(entry.target);
    }
  }, { threshold: 0.12 });
  page.querySelectorAll('.reveal').forEach((node) => revealer.observe(node));
  return page;
}
