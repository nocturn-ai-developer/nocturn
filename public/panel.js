// The control panel: everything the gateway can do, in one window. Talks only to /api on the
// same origin with the private token. Desktop app, phone web app and the dashboard all load this.
const root = document.getElementById('app');

/* DOM helpers */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && k !== 'list' && k !== 'form') el[k] = v;
    else el.setAttribute(k, v);
  }
  el.append(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}
const text = (s) => document.createTextNode(String(s));

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* private window */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* nothing stored */ } },
};

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
function morph(change) {
  if (reducedMotion || !document.startViewTransition || document.hidden) { change(); return; }
  const t = document.startViewTransition(change);
  t.ready.catch(() => {});
  t.finished.catch(() => {});
}

/* Theme */
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const currentTheme = () => document.documentElement.dataset.theme || (darkQuery.matches ? 'dark' : 'light');
function themeButton() {
  const icon = h('span', { 'aria-hidden': 'true' });
  const button = h('button', { class: 'theme-btn', onclick: () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    morph(() => { document.documentElement.dataset.theme = next; store.set('nocturn-theme', next); paint(); });
  } }, icon);
  const paint = () => {
    const dark = currentTheme() === 'dark';
    icon.textContent = dark ? '☀' : '☾';
    button.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-pressed', String(dark));
  };
  darkQuery.addEventListener('change', paint);
  paint();
  return button;
}

/* Token and API */
let token = store.get('nocturn-token');
const hashToken = location.hash.match(/token=([a-f0-9]+)/)?.[1];
if (hashToken) {
  token = hashToken;
  store.set('nocturn-token', token);
  history.replaceState(null, '', location.pathname);
}

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function api(path, method = 'GET', body) {
  let res;
  try {
    res = await fetch(`/api/${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'The gateway did not answer. Is it running?');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { signOut(); throw new ApiError(401, 'The token was rejected.'); }
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status})`);
  return data;
}

function signOut() {
  store.remove('nocturn-token');
  token = null;
  stopEvents();
  renderConnect();
}

/* Toasts */
const toasts = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
function toast(message, kind = 'info') {
  const node = h('div', { class: `toast ${kind}` }, message);
  toasts.append(node);
  setTimeout(() => node.classList.add('gone'), 3600);
  setTimeout(() => node.remove(), 4200);
}
const report = (err) => toast(err?.message ?? String(err), 'bad');

/* Formatting */
const when = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};
const whenFull = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never');

function describeInput(input) {
  if (!input || typeof input !== 'object') return '';
  const pick = input.command ?? input.path ?? input.url ?? input.target ?? input.query ?? input.name ?? input.text ?? '';
  const s = typeof pick === 'string' && pick ? pick : JSON.stringify(input);
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}

// Markdown-lite built with DOM nodes: paragraphs, fenced code, lists, inline code and bold.
function inline(line) {
  const out = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)/g;
  let last = 0;
  let m;
  while ((m = re.exec(line))) {
    if (m.index > last) out.push(text(line.slice(last, m.index)));
    if (m[1]) out.push(h('code', {}, m[1].slice(1, -1)));
    else out.push(h('strong', {}, m[2].slice(2, -2)));
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push(text(line.slice(last)));
  return out;
}

function markdown(src) {
  const frag = document.createDocumentFragment();
  const parts = String(src ?? '').split(/^```[^\n]*\n?/m);
  parts.forEach((part, i) => {
    if (i % 2 === 1) { frag.append(h('pre', { class: 'md-code' }, h('code', {}, part.replace(/\n$/, '')))); return; }
    let list = null;
    let para = [];
    const flush = () => {
      if (para.length) { frag.append(h('p', {}, inline(para.join(' ')))); para = []; }
    };
    for (const raw of part.split('\n')) {
      const line = raw.trimEnd();
      const item = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
      if (item) {
        flush();
        const ordered = /^\s*\d/.test(line);
        if (!list || list.tagName !== (ordered ? 'OL' : 'UL')) { list = h(ordered ? 'ol' : 'ul', { class: 'md-list' }); frag.append(list); }
        list.append(h('li', {}, inline(item[1])));
        continue;
      }
      list = null;
      const head = line.match(/^(#{1,3})\s+(.*)$/);
      if (head) { flush(); frag.append(h(head[1].length === 1 ? 'h3' : 'h4', { class: 'md-head' }, inline(head[2]))); continue; }
      if (!line.trim()) { flush(); continue; }
      para.push(line.trim());
    }
    flush();
  });
  return frag;
}

/* State */
const ui = {
  data: null,
  view: 'chat',
  sessionId: store.get('nocturn-session') || null,
  connection: 'connecting',
  drawer: false,
  draft: '',
};
const VIEWS = [
  ['chat', 'Chat', '◌'], ['approvals', 'Approvals', '✓'], ['channels', 'Channels', '✉'],
  ['schedules', 'Schedules', '◷'], ['memory', 'Memory', '◈'], ['skills', 'Skills', '⌘'], ['settings', 'Settings', '⚙'],
];

async function refresh(parts = ['sidebar', 'view']) {
  try {
    ui.data = await api('state');
  } catch (err) {
    if (err.status !== 401) report(err);
    return;
  }
  if (parts.includes('sidebar')) renderSidebar();
  if (parts.includes('view') && ui.view !== 'chat') renderMain();
  if (ui.view === 'chat') { chat.refreshBadges(); }
  paintBadges();
}

/* Events (SSE over fetch, so the Authorization header can be sent) */
let eventsAbort = null;
let backoff = 1000;
const listeners = new Set();

async function startEvents() {
  stopEvents();
  const controller = new AbortController();
  eventsAbort = controller;
  for (;;) {
    if (controller.signal.aborted) return;
    setConnection('connecting');
    try {
      const res = await fetch('/api/events', { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
      if (res.status === 401) { signOut(); return; }
      if (!res.ok) throw new Error(`Gateway answered ${res.status}`);
      setConnection('connected');
      backoff = 1000;
      let buffer = '';
      for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
        buffer += chunk;
        const frames = buffer.split('\n\n');
        buffer = frames.pop();
        for (const frame of frames) {
          if (!frame.startsWith('data: ')) continue;
          let event;
          try { event = JSON.parse(frame.slice(6)); } catch { continue; }
          for (const fn of listeners) { try { fn(event); } catch (err) { console.error(err); } }
        }
      }
    } catch (err) {
      if (controller.signal.aborted) return;
    }
    setConnection('reconnecting');
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, 15000);
  }
}

function stopEvents() { eventsAbort?.abort(); eventsAbort = null; }

let statusDot = null;
function setConnection(value) {
  const was = ui.connection;
  ui.connection = value;
  if (statusDot) {
    statusDot.className = `conn ${value}`;
    statusDot.title = { connected: 'Connected to the gateway', connecting: 'Connecting…', reconnecting: 'Lost the gateway, retrying…' }[value];
    statusDot.lastChild.textContent = { connected: 'Live', connecting: 'Connecting', reconnecting: 'Retrying' }[value];
  }
  if (value === 'connected' && was === 'reconnecting') refresh();
}

listeners.add((e) => {
  if (e.type === 'sessions_changed') refresh(['sidebar', ...(ui.view === 'chat' ? [] : ['view'])]);
  else if (e.type === 'channels_changed' || e.type === 'jobs_changed' || e.type === 'approval' || e.type === 'approval_resolved') {
    refresh(ui.view === 'chat' ? ['sidebar'] : ['sidebar', 'view']);
  }
});

/* Shell */
let sidebarEl = null;
let mainEl = null;
let navButtons = new Map();
let badgeEls = new Map();

function renderShell() {
  sidebarEl = h('aside', { class: 'side' });
  mainEl = h('main', { class: 'content' });
  statusDot = h('span', { class: `conn ${ui.connection}` }, h('i'), h('b', {}, 'Connecting'));
  const menu = h('button', { class: 'side-toggle', 'aria-label': 'Open menu', onclick: () => setDrawer(true) }, h('span', { class: 'lines', 'aria-hidden': 'true' }, h('i'), h('i')));
  const top = h('header', { class: 'top' },
    h('div', { class: 'top-start' }, menu, h('a', { class: 'brand', href: '/' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }), 'NOCTURN'), h('span', { class: 'top-title' })),
    h('div', { class: 'top-end' }, statusDot, themeButton()));
  const scrim = h('div', { class: 'scrim', onclick: () => setDrawer(false) });
  root.replaceChildren(h('div', { class: 'app-grid' }, top, sidebarEl, mainEl, scrim), toasts);
  renderSidebar();
  renderMain();
}

function setDrawer(open) {
  ui.drawer = open;
  document.querySelector('.app-grid')?.classList.toggle('drawer', open);
}

function paintBadges() {
  const d = ui.data;
  if (!d) return;
  const counts = { approvals: d.approvals.length + d.pairing.length, schedules: d.jobs.length, memory: d.memory.length, skills: d.skills.length };
  for (const [view, el] of badgeEls) {
    const n = counts[view] ?? 0;
    el.textContent = n ? String(n) : '';
    el.classList.toggle('alert', view === 'approvals' && n > 0);
  }
  const title = document.querySelector('.top-title');
  if (title) title.textContent = VIEWS.find(([id]) => id === ui.view)?.[1] ?? '';
}

function renderSidebar() {
  const d = ui.data;
  navButtons = new Map();
  badgeEls = new Map();
  const nav = h('nav', { class: 'side-nav', 'aria-label': 'Sections' }, VIEWS.map(([id, label, glyph]) => {
    const badge = h('span', { class: 'badge' });
    badgeEls.set(id, badge);
    const b = h('button', { class: `nav-item ${ui.view === id ? 'active' : ''}`, onclick: () => goTo(id) }, h('span', { class: 'glyph', 'aria-hidden': 'true' }, glyph), label, badge);
    navButtons.set(id, b);
    return b;
  }));
  const sessions = (d?.sessions ?? []).map((s) => h('div', { class: `session ${ui.sessionId === s.id ? 'active' : ''}` },
    h('button', { class: 'session-open', onclick: () => openSession(s.id) },
      h('span', { class: 'session-title' }, s.title || 'New conversation'),
      h('span', { class: 'session-meta' }, h('i', { class: `origin ${s.origin}` }, s.origin), when(s.updated))),
    h('button', { class: 'session-del', 'aria-label': 'Delete conversation', title: 'Delete', onclick: async (e) => {
      e.stopPropagation();
      if (!confirm('Delete this conversation?')) return;
      try { await api(`sessions/${encodeURIComponent(s.id)}`, 'DELETE'); if (ui.sessionId === s.id) { ui.sessionId = null; store.remove('nocturn-session'); if (ui.view === 'chat') renderMain(); } } catch (err) { report(err); }
    } }, '×')));
  sidebarEl.replaceChildren(
    h('div', { class: 'side-head' }, h('span', { class: 'pill' }, 'Your gateway'), h('button', { class: 'side-close', 'aria-label': 'Close menu', onclick: () => setDrawer(false) }, '×')),
    nav,
    h('div', { class: 'side-sessions' },
      h('div', { class: 'side-row' }, h('span', { class: 'side-label' }, 'Conversations'), h('button', { class: 'btn small primary', onclick: newChat }, '+ New')),
      sessions.length ? h('div', { class: 'session-list' }, sessions) : h('div', { class: 'side-empty' }, 'No conversations yet.')),
    h('div', { class: 'side-foot' }, h('a', { href: '/docs', class: 'foot-link' }, 'Docs'), h('a', { href: '/', class: 'foot-link' }, 'Home'), h('button', { class: 'foot-link', onclick: () => { if (confirm('Forget the token on this device?')) signOut(); } }, 'Sign out')));
  paintBadges();
}

function goTo(view) {
  if (ui.view === view && view !== 'chat') return;
  ui.view = view;
  setDrawer(false);
  for (const [id, b] of navButtons) b.classList.toggle('active', id === view);
  morph(renderMain);
}

function renderMain() {
  const views = { chat: chat.render, approvals: viewApprovals, channels: viewChannels, schedules: viewSchedules, memory: viewMemory, skills: viewSkills, settings: viewSettings };
  mainEl.replaceChildren(views[ui.view]());
  paintBadges();
}

function page(title, lede, ...body) {
  return h('div', { class: 'view' }, h('div', { class: 'view-inner' }, h('h1', {}, title), lede ? h('p', { class: 'lede' }, lede) : null, body));
}

/* Chat */
async function newChat() {
  try {
    const s = await api('sessions', 'POST', {});
    await openSession(s.id);
  } catch (err) { report(err); }
}

async function openSession(id) {
  ui.sessionId = id;
  store.set('nocturn-session', id);
  setDrawer(false);
  if (ui.view !== 'chat') { ui.view = 'chat'; for (const [v, b] of navButtons) b.classList.toggle('active', v === 'chat'); }
  renderSidebar();
  morph(renderMain);
}

const chat = (() => {
  let log = null;
  let composer = null;
  let input = null;
  let sendBtn = null;
  let stopBtn = null;
  let stickToBottom = true;
  let turn = null; // the live assistant turn being streamed
  let toolCards = new Map();

  const scroll = () => { if (stickToBottom && log) log.scrollTop = log.scrollHeight; };

  function bubble(role, ...children) {
    const node = h('article', { class: `msg ${role}` }, h('div', { class: 'msg-body' }, children));
    log.append(node);
    scroll();
    return node;
  }

  function toolCard(id, name, inputValue) {
    const state = h('span', { class: 'tool-state run' }, 'running');
    const result = h('pre', { class: 'tool-result hidden' });
    const head = h('button', { class: 'tool-head', onclick: () => result.classList.toggle('hidden') },
      h('b', {}, name), h('span', { class: 'tool-hint' }, describeInput(inputValue)), state);
    const card = h('div', { class: 'tool' }, head, result);
    const entry = { card, state, result };
    if (id) toolCards.set(id, entry);
    return entry;
  }

  function finishTool(entry, content, isError) {
    if (!entry) return;
    entry.state.textContent = isError ? 'failed' : 'done';
    entry.state.className = `tool-state ${isError ? 'bad' : 'ok'}`;
    entry.result.textContent = String(content ?? '').slice(0, 20000) || '(no output)';
    if (isError) entry.result.classList.remove('hidden');
  }

  function approvalCard(e) {
    const card = h('div', { class: `approval ${e.risk?.level === 'high' ? 'high' : ''}` },
      h('div', { class: 'approval-head' }, h('span', { class: 'pill' }, 'Needs your yes'), h('b', {}, e.tool)),
      riskBadge(e.risk),
      h('pre', { class: 'approval-detail' }, JSON.stringify(e.input ?? {}, null, 2).slice(0, 4000)),
      h('div', { class: 'actions' },
        h('button', { class: 'btn small primary', onclick: () => answer(true) }, 'Allow'),
        h('button', { class: 'btn small danger', onclick: () => answer(false) }, 'Deny')));
    async function answer(approved) {
      try { await api(`approvals/${encodeURIComponent(e.id)}`, 'POST', { approved }); } catch (err) { report(err); }
    }
    card.dataset.approval = e.id;
    return card;
  }

  function resolveApproval(id, approved) {
    const card = log?.querySelector(`[data-approval="${CSS.escape(id)}"]`);
    if (!card) return;
    card.classList.add(approved ? 'allowed' : 'denied');
    card.querySelector('.actions')?.replaceWith(h('div', { class: 'approval-answer' }, approved ? '✓ Allowed' : '✗ Denied'));
  }

  // History from disk: Anthropic-style content blocks.
  function renderHistory(messages) {
    toolCards = new Map();
    const pendingResults = new Map();
    for (const m of messages) {
      if (m.role === 'user') {
        if (typeof m.content === 'string') { bubble('user', h('p', {}, m.content)); continue; }
        for (const b of m.content ?? []) {
          if (b.type === 'text') bubble('user', h('p', {}, b.text));
          else if (b.type === 'tool_result') {
            const entry = toolCards.get(b.tool_use_id);
            const content = Array.isArray(b.content) ? b.content.map((c) => c.text ?? '').join('') : b.content;
            if (entry) finishTool(entry, content, b.is_error); else pendingResults.set(b.tool_use_id, b);
          }
        }
      } else if (m.role === 'assistant') {
        const body = [];
        for (const b of m.content ?? []) {
          if (b.type === 'text' && b.text) body.push(h('div', { class: 'md' }, markdown(b.text)));
          else if (b.type === 'tool_use') {
            const entry = toolCard(b.id, b.name, b.input);
            body.push(entry.card);
          }
        }
        if (body.length) bubble('assistant', body);
      }
    }
  }

  function setRunning(running) {
    if (!composer) return;
    composer.classList.toggle('running', running);
    sendBtn.disabled = running;
    stopBtn.classList.toggle('hidden', !running);
  }

  function beginTurn() {
    if (turn) endTurn();
    const body = h('div', { class: 'msg-body' });
    const node = h('article', { class: 'msg assistant live' }, body);
    const pulse = h('div', { class: 'thinking' }, h('i'), h('i'), h('i'), 'thinking…');
    body.append(pulse);
    log.append(node);
    turn = { node, body, pulse, textEl: null, raw: '' };
    setRunning(true);
    scroll();
  }

  function endTurn(error) {
    if (!turn) { setRunning(false); return; }
    turn.pulse.remove();
    if (turn.textEl) { turn.textEl.replaceWith(h('div', { class: 'md' }, markdown(turn.raw))); turn.textEl = null; }
    if (error) turn.body.append(h('div', { class: 'turn-error' }, error));
    if (!turn.body.childNodes.length) turn.node.remove();
    turn.node.classList.remove('live');
    turn = null;
    setRunning(false);
    scroll();
  }

  function onEvent(e) {
    if (e.type === 'approval_resolved') { resolveApproval(e.id, e.approved); return; }
    if (e.sessionId !== ui.sessionId || !log) return;
    switch (e.type) {
      case 'turn_start': beginTurn(); break;
      case 'step_start': if (turn) { turn.textEl = null; turn.raw = ''; turn.body.append(turn.pulse); } break;
      case 'thinking': if (turn) turn.pulse.classList.add('on'); break;
      case 'text':
        if (!turn) beginTurn();
        turn.pulse.classList.remove('on');
        turn.pulse.remove();
        if (!turn.textEl) { turn.textEl = h('div', { class: 'md streaming' }); turn.body.append(turn.textEl); turn.raw = ''; }
        turn.raw += e.text;
        turn.textEl.textContent = turn.raw;
        scroll();
        break;
      case 'tool_start': {
        if (!turn) beginTurn();
        turn.pulse.remove();
        if (turn.textEl) { turn.textEl.replaceWith(h('div', { class: 'md' }, markdown(turn.raw))); turn.textEl = null; }
        const entry = toolCard(e.id, e.name, e.input);
        turn.body.append(entry.card);
        scroll();
        break;
      }
      case 'tool_result': finishTool(toolCards.get(e.id), e.content, e.isError); scroll(); break;
      case 'approval': {
        if (!turn) beginTurn();
        turn.pulse.remove();
        turn.body.append(approvalCard(e));
        scroll();
        break;
      }
      case 'turn_end': endTurn(); break;
      case 'turn_error': endTurn(e.message || 'Something went wrong.'); break;
      default: break;
    }
  }
  listeners.add(onEvent);

  async function send() {
    const value = input.value.trim();
    if (!value) return;
    if (!ui.sessionId) {
      try { const s = await api('sessions', 'POST', {}); ui.sessionId = s.id; store.set('nocturn-session', s.id); } catch (err) { report(err); return; }
    }
    input.value = '';
    ui.draft = '';
    autosize();
    log.querySelectorAll('.chat-empty, .chat-note').forEach((n) => n.remove());
    bubble('user', h('p', {}, value));
    setRunning(true);
    try {
      await api(`sessions/${encodeURIComponent(ui.sessionId)}/messages`, 'POST', { text: value });
    } catch (err) {
      setRunning(false);
      bubble('assistant', h('div', { class: 'turn-error' }, err.message));
    }
  }

  function autosize() {
    input.style.height = '';
    if (input.value) input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
  }

  function render() {
    toolCards = new Map();
    turn = null;
    stickToBottom = true;
    log = h('div', { class: 'log', onscroll: () => { stickToBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60; } });
    input = h('textarea', { class: 'composer-input', rows: 1, placeholder: 'Ask Nocturn to do something…', value: ui.draft,
      oninput: () => { ui.draft = input.value; autosize(); },
      onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } } });
    sendBtn = h('button', { class: 'btn primary send', onclick: send }, 'Send');
    stopBtn = h('button', { class: 'btn small danger hidden', onclick: async () => { try { await api(`sessions/${encodeURIComponent(ui.sessionId)}/stop`, 'POST', {}); } catch (err) { report(err); } } }, 'Stop');
    composer = h('form', { class: 'composer', onsubmit: (e) => { e.preventDefault(); send(); } },
      h('div', { class: 'composer-box' }, input, h('div', { class: 'composer-end' }, stopBtn, sendBtn)),
      h('p', { class: 'composer-note' }, 'Enter sends · Shift+Enter for a new line · risky tools wait for your approval here'));
    const view = h('div', { class: 'chat-view' }, log, composer);
    const session = ui.data?.sessions.find((s) => s.id === ui.sessionId);
    if (!ui.sessionId) {
      log.append(h('div', { class: 'chat-empty' },
        h('span', { class: 'brand-mark big', 'aria-hidden': 'true' }),
        h('h2', {}, 'Your machine, at your service'),
        h('p', {}, 'Ask for a file, a summary, a shell command or a scheduled job. Anything risky pauses for your yes.'),
        h('div', { class: 'starter-row' }, ['Summarize the files in my workspace', 'Remember that I prefer short answers', 'Plan my day every weekday at 8:00 AM'].map((s) => h('button', { class: 'starter', onclick: () => { input.value = s; ui.draft = s; input.focus(); autosize(); } }, s)))));
      if (!ui.data?.credentials?.anthropic && !ui.data?.credentials?.openai) {
        log.append(h('div', { class: 'chat-note' }, 'No model key is saved yet. Add one under ', h('button', { class: 'link', onclick: () => goTo('settings') }, 'Settings'), ' before sending.'));
      }
    } else {
      log.append(h('div', { class: 'chat-loading' }, 'Loading…'));
      api(`sessions/${encodeURIComponent(ui.sessionId)}`).then((s) => {
        if (ui.sessionId !== s.id || !log.isConnected) return;
        log.replaceChildren();
        renderHistory(s.messages ?? []);
        if (ui.data?.running?.includes(s.id)) { setRunning(true); beginTurn(); }
        scroll();
      }).catch((err) => {
        if (!log.isConnected) return;
        log.replaceChildren(h('div', { class: 'turn-error' }, err.status === 404 ? 'This conversation no longer exists.' : err.message));
        if (err.status === 404) { ui.sessionId = null; store.remove('nocturn-session'); }
      });
    }
    requestAnimationFrame(() => { autosize(); if (innerWidth > 900) input.focus(); });
    view.dataset.session = session?.title ?? '';
    return view;
  }

  function refreshBadges() { /* the sidebar handles counts; the chat keeps its scroll and draft */ }

  return { render, refreshBadges };
})();

/* Approvals */
// Rules and the owner's own history, as a short strip under a pending tool call.
function riskBadge(r) {
  if (!r) return null;
  const glyph = r.level === 'high' ? '▲' : r.level === 'medium' ? '●' : '○';
  return h('div', { class: `risk risk-${r.level}` },
    h('span', { class: 'risk-level' }, `${glyph} ${r.level}`),
    r.reasons.length ? h('span', { class: 'risk-reasons' }, r.reasons.join(' · ')) : null,
    h('span', { class: 'risk-label' }, r.label));
}

function viewApprovals() {
  const d = ui.data;
  const approvals = d.approvals.map((a) => h('div', { class: 'card' }, h('div', { class: 'row wrap' },
    h('div', { class: 'row-text' }, h('b', {}, a.tool), h('span', { class: 'muted' }, ` · session ${a.sessionId}`), riskBadge(a.risk), h('pre', { class: 'approval-detail' }, JSON.stringify(a.input ?? {}, null, 2).slice(0, 4000))),
    h('div', { class: 'actions tight' },
      h('button', { class: 'btn small primary', onclick: () => act(() => api(`approvals/${encodeURIComponent(a.id)}`, 'POST', { approved: true })) }, 'Allow'),
      h('button', { class: 'btn small danger', onclick: () => act(() => api(`approvals/${encodeURIComponent(a.id)}`, 'POST', { approved: false })) }, 'Deny')))));
  const pairing = d.pairing.map((p) => h('div', { class: 'card' }, h('div', { class: 'row wrap' },
    h('div', { class: 'row-text' }, h('b', { class: 'mono' }, p.code), h('span', { class: 'muted' }, ` · ${p.channel} · sender ${p.sender}`)),
    h('div', { class: 'actions tight' },
      h('button', { class: 'btn small primary', onclick: () => act(() => api(`pairing/${encodeURIComponent(p.code)}`, 'POST', { approve: true })) }, 'Approve'),
      h('button', { class: 'btn small danger', onclick: () => act(() => api(`pairing/${encodeURIComponent(p.code)}`, 'POST', { approve: false })) }, 'Deny')))));
  return page('Approvals', 'Tool calls that wait for your yes, and new chat senders asking to be let in.',
    h('div', { class: 'section-title' }, `${approvals.length} waiting`),
    approvals.length ? approvals : h('div', { class: 'empty' }, 'Nothing is waiting for approval.'),
    h('div', { class: 'section-title' }, `${pairing.length} pairing request${pairing.length === 1 ? '' : 's'}`),
    pairing.length ? pairing : h('div', { class: 'empty' }, 'No one is asking to pair. Message your bot to get a code.'));
}

async function act(fn, done) {
  try { await fn(); if (done) toast(done, 'good'); await refresh(); } catch (err) { report(err); }
}

/* Channels */
const CHANNELS = {
  telegram: { label: 'Telegram', help: 'Create a bot with @BotFather and paste its token.', fields: [['token', 'Bot token']] },
  discord: { label: 'Discord', help: 'A bot token from the Discord developer portal with the message content intent.', fields: [['token', 'Bot token']] },
  slack: { label: 'Slack', help: 'Socket Mode: a bot token (xoxb-…) and an app token (xapp-…).', fields: [['botToken', 'Bot token'], ['appToken', 'App token']] },
};

function viewChannels() {
  const d = ui.data;
  const cards = Object.entries(CHANNELS).map(([name, meta]) => {
    const cfg = d.config.channels[name];
    const status = d.channelStatus[name] ?? 'off';
    const enabled = h('input', { type: 'checkbox', checked: cfg.enabled });
    const inputs = meta.fields.map(([key, label]) => [key, h('input', { type: 'password', placeholder: cfg[key] ? 'Saved · leave blank to keep' : 'Paste the token', autocomplete: 'off' }), label]);
    const error = h('p', { class: 'error-text' });
    const save = async () => {
      error.textContent = '';
      const patch = { enabled: enabled.checked };
      for (const [key, input] of inputs) if (input.value.trim()) patch[key] = input.value.trim();
      try { ui.data = await api('config', 'PUT', { channels: { [name]: patch } }); toast(`${meta.label} saved`, 'good'); renderMain(); renderSidebar(); } catch (err) { error.textContent = err.message; }
    };
    const allow = (cfg.allow ?? []).map((sender) => h('span', { class: 'chip' }, sender, h('button', { 'aria-label': `Remove ${sender}`, title: 'Remove', onclick: () => act(() => api('allow', 'POST', { channel: name, sender }), 'Sender removed') }, '×')));
    return h('div', { class: 'card' },
      h('div', { class: 'row' }, h('div', { class: 'row-text' }, h('h3', {}, meta.label), h('p', { class: 'muted small-text' }, meta.help)), h('span', { class: `status ${/connected/.test(status) ? 'ok' : /retrying|failed|missing/.test(status) ? 'bad' : ''}` }, status)),
      h('label', { class: 'switch' }, enabled, h('span', {}, 'Enabled')),
      inputs.map(([, input, label]) => h('label', { class: 'field' }, h('span', {}, label), input)),
      h('div', { class: 'section-title' }, `${allow.length} allowed sender${allow.length === 1 ? '' : 's'}`),
      allow.length ? h('div', { class: 'chips' }, allow) : h('p', { class: 'muted small-text' }, 'Nobody yet. New senders get a pairing code you approve under Approvals.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: save }, 'Save')), error);
  });
  return page('Channels', 'Talk to your gateway from Telegram, Discord or Slack. The gateway reconnects on save.', cards);
}

/* Schedules */
function viewSchedules() {
  const d = ui.data;
  const name = h('input', { type: 'text', placeholder: 'Morning brief', maxLength: 200 });
  const cron = h('input', { type: 'text', placeholder: '0 8 * * 1-5', maxLength: 100, class: 'mono-input' });
  const prompt = h('textarea', { rows: 3, placeholder: 'Plan my day from notes/tasks.md and keep it short.' });
  const deliver = h('input', { type: 'text', placeholder: 'telegram:123456 (optional)', maxLength: 200 });
  const error = h('p', { class: 'error-text' });
  const add = async () => {
    error.textContent = '';
    try {
      ui.data = await api('jobs', 'POST', { name: name.value, cron: cron.value, prompt: prompt.value, deliver: deliver.value.trim() });
      toast('Schedule added', 'good'); renderMain(); renderSidebar();
    } catch (err) { error.textContent = err.message; }
  };
  const jobs = d.jobs.map((j) => h('div', { class: `card ${j.enabled ? '' : 'off'}` },
    h('div', { class: 'row wrap' },
      h('div', { class: 'row-text' }, h('b', {}, j.name), h('code', { class: 'cron' }, j.cron), h('p', { class: 'muted small-text' }, j.prompt), h('p', { class: 'muted small-text' }, `Last run ${whenFull(j.lastRun)}${j.lastStatus ? ` · ${j.lastStatus}` : ''}${j.deliver ? ` · delivers to ${j.deliver}` : ''}`)),
      h('div', { class: 'actions tight' },
        h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: j.enabled, onchange: (e) => act(() => api(`jobs/${encodeURIComponent(j.id)}`, 'PATCH', { enabled: e.target.checked })) }), h('span', {}, j.enabled ? 'On' : 'Off')),
        h('button', { class: 'btn small', onclick: () => act(() => api(`jobs/${encodeURIComponent(j.id)}/run`, 'POST', {}), 'Started') }, 'Run now'),
        h('button', { class: 'btn small danger', onclick: () => { if (confirm(`Delete ${j.name}?`)) act(() => api(`jobs/${encodeURIComponent(j.id)}`, 'DELETE'), 'Removed'); } }, 'Delete')))));
  return page('Schedules', 'Five-field cron in the gateway\'s local time. Results can be delivered to a chat.',
    h('div', { class: 'card' },
      h('label', { class: 'field' }, h('span', {}, 'Name'), name),
      h('label', { class: 'field' }, h('span', {}, 'Cron'), cron, h('small', {}, 'minute hour day month weekday · 0 8 * * 1-5 is every weekday at 8:00 AM')),
      h('label', { class: 'field' }, h('span', {}, 'Prompt'), prompt),
      h('label', { class: 'field' }, h('span', {}, 'Deliver to'), deliver, h('small', {}, 'telegram:<chat>, discord:<channel> or slack:<channel>')),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: add }, 'Add schedule')), error),
    h('div', { class: 'section-title' }, `${jobs.length} scheduled`),
    jobs.length ? jobs : h('div', { class: 'empty' }, 'No schedules yet.'));
}

/* Memory */
function viewMemory() {
  const d = ui.data;
  const input = h('textarea', { rows: 2, placeholder: 'I prefer short answers.', maxLength: 5000 });
  const error = h('p', { class: 'error-text' });
  const add = async () => {
    error.textContent = '';
    try { ui.data = await api('memory', 'POST', { text: input.value }); toast('Remembered', 'good'); renderMain(); renderSidebar(); } catch (err) { error.textContent = err.message; }
  };
  const items = [...d.memory].reverse().map((m) => h('div', { class: 'card' }, h('div', { class: 'row' },
    h('div', { class: 'row-text' }, h('p', { class: 'memory-text' }, m.text), h('span', { class: 'muted small-text' }, whenFull(m.at))),
    h('button', { class: 'btn small danger', onclick: () => act(() => api(`memory/${encodeURIComponent(m.id)}`, 'DELETE'), 'Forgotten') }, 'Forget'))));
  return page('Memory', 'Facts the agent carries into every conversation. It can also save these itself with the memory_save tool.',
    h('div', { class: 'card' }, h('label', { class: 'field' }, h('span', {}, 'Remember'), input), h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: add }, 'Save')), error),
    h('div', { class: 'section-title' }, `${items.length} saved`),
    items.length ? items : h('div', { class: 'empty' }, 'Nothing remembered yet.'));
}

/* Skills */
function viewSkills() {
  const d = ui.data;
  const name = h('input', { type: 'text', placeholder: 'weekly-report', maxLength: 64 });
  const description = h('input', { type: 'text', placeholder: 'When to use it, in one line', maxLength: 500 });
  const instructions = h('textarea', { rows: 6, placeholder: 'Step-by-step instructions the agent follows after loading this skill.' });
  const error = h('p', { class: 'error-text' });
  const add = async () => {
    error.textContent = '';
    try { ui.data = await api('skills', 'POST', { name: name.value.trim(), description: description.value, instructions: instructions.value }); toast('Skill added', 'good'); renderMain(); renderSidebar(); } catch (err) { error.textContent = err.message; }
  };
  const items = d.skills.map((s) => h('div', { class: 'card' }, h('div', { class: 'row' },
    h('div', { class: 'row-text' }, h('b', { class: 'mono' }, s.name), h('p', { class: 'muted small-text' }, s.description || 'No description')),
    h('button', { class: 'btn small danger', onclick: () => { if (confirm(`Remove ${s.name}?`)) act(() => api(`skills/${encodeURIComponent(s.name)}`, 'DELETE'), 'Removed'); } }, 'Remove'))));
  return page('Skills', 'SKILL.md files in ~/.nocturn/workspace/skills. The agent sees the list and loads one on demand.',
    h('div', { class: 'card' },
      h('label', { class: 'field' }, h('span', {}, 'Name'), name, h('small', {}, 'Lowercase letters, digits and dashes')),
      h('label', { class: 'field' }, h('span', {}, 'Description'), description),
      h('label', { class: 'field' }, h('span', {}, 'Instructions'), instructions),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: add }, 'Add skill')), error),
    h('div', { class: 'section-title' }, `${items.length} installed`),
    items.length ? items : h('div', { class: 'empty' }, 'No skills installed.'));
}

/* Settings */
function viewSettings() {
  const d = ui.data;
  const cfg = d.config;
  const select = (options, value) => h('select', {}, options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
  const provider = select([['anthropic', 'Claude (Anthropic API)'], ['openai', 'OpenAI-compatible (GPT, Ollama, …)']], cfg.provider);
  const model = h('input', { type: 'text', value: cfg.model, placeholder: 'claude-opus-5-5' });
  const effort = select([['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['max', 'Max']], cfg.effort);
  const anthropicKey = h('input', { type: 'password', placeholder: d.credentials.anthropic ? 'Saved · leave blank to keep' : 'sk-ant-…', autocomplete: 'off' });
  const openaiBaseUrl = h('input', { type: 'text', value: cfg.openaiBaseUrl });
  const openaiModel = h('input', { type: 'text', value: cfg.openaiModel, placeholder: 'llama3.2' });
  const openaiKey = h('input', { type: 'password', placeholder: cfg.openaiKey ? 'Saved · leave blank to keep' : 'Optional', autocomplete: 'off' });
  const persona = h('textarea', { rows: 4, value: cfg.persona });
  const emb = cfg.embeddings ?? {};
  const search = d.search ?? {};
  const embProvider = select([['auto', 'Automatic (Voyage, then Ollama, then built-in)'], ['voyage', 'Voyage AI'], ['ollama', 'Ollama / OpenAI-compatible'], ['local', 'Built-in (no model needed)']], emb.provider ?? 'auto');
  const embModel = h('input', { type: 'text', value: emb.model ?? '', placeholder: 'nomic-embed-text, bge-m3, voyage-3-large' });
  const embBaseUrl = h('input', { type: 'text', value: emb.baseUrl ?? '', placeholder: 'Leave blank to use the provider base URL' });
  const voyageKey = h('input', { type: 'password', placeholder: emb.voyageKey ? 'Saved · leave blank to keep' : 'pa-…', autocomplete: 'off' });
  const reindex = h('button', { class: 'btn small', onclick: async (e) => { e.preventDefault(); try { const r = await api('index/rebuild', 'POST', {}); toast(`Indexed ${r.entries} chunks with ${r.provider}`, 'good'); } catch (err) { toast(err.message, 'bad'); } } }, 'Rebuild index');
  const tr = cfg.transcription ?? {};
  const voice = d.voice ?? {};
  const trProvider = select([['auto', 'Automatic (whisper.cpp if installed, else an endpoint)'], ['whisper-cpp', 'whisper.cpp on this machine'], ['openai', 'OpenAI-compatible endpoint'], ['off', 'Off']], tr.provider ?? 'auto');
  const trBaseUrl = h('input', { type: 'text', value: tr.baseUrl ?? '', placeholder: 'https://api.openai.com/v1 or http://localhost:8000/v1' });
  const trKey = h('input', { type: 'password', placeholder: tr.key ? 'Saved · leave blank to keep' : 'Optional for local servers', autocomplete: 'off' });
  const trModel = h('input', { type: 'text', value: tr.model ?? '', placeholder: 'whisper-1, or a ggml model path for whisper.cpp' });
  const trCommand = h('input', { type: 'text', value: tr.command ?? '', placeholder: 'whisper-cli -m {model} -f {file} -nt -np' });
  const trLanguage = h('input', { type: 'text', value: tr.language ?? '', placeholder: 'en (blank = detect)' });
  const voiceBox = h('div', { class: 'provider-box' },
    h('p', { class: 'small-text' }, 'In use now: ', h('b', {}, voice.ready ? `${voice.provider} · ${voice.model}` : 'off'), voice.note ? h('span', { class: 'muted' }, ` · ${voice.note}`) : null),
    h('label', { class: 'field' }, h('span', {}, 'Voice backend'), trProvider, h('small', {}, 'Voice notes from Telegram and audio files from Discord are transcribed before the agent reads them. whisper.cpp keeps audio on this machine and needs ffmpeg on PATH.')),
    h('label', { class: 'field' }, h('span', {}, 'Endpoint base URL'), trBaseUrl),
    h('label', { class: 'field' }, h('span', {}, 'Endpoint API key'), trKey),
    h('label', { class: 'field' }, h('span', {}, 'Model'), trModel),
    h('label', { class: 'field' }, h('span', {}, 'whisper.cpp command'), trCommand, h('small', {}, '{file} is the 16 kHz wav, {model} is the model field. Leave blank to call whisper-cli on PATH.')),
    h('label', { class: 'field' }, h('span', {}, 'Language'), trLanguage));
  const searchBox = h('div', { class: 'provider-box' },
    h('p', { class: 'small-text' }, 'In use now: ', h('b', {}, `${search.provider ?? '?'} · ${search.model ?? ''}`), ` · ${search.entries ?? 0} chunks indexed`, search.note ? h('span', { class: 'muted' }, ` · ${search.note}`) : null),
    h('label', { class: 'field' }, h('span', {}, 'Embedding backend'), embProvider, h('small', {}, 'Sharpest: Voyage voyage-3-large (cloud) or Ollama bge-m3 / nomic-embed-text (local, private). The built-in backend needs nothing but matches on words, not meaning.')),
    h('label', { class: 'field' }, h('span', {}, 'Embedding model'), embModel),
    h('label', { class: 'field' }, h('span', {}, 'Embedding endpoint'), embBaseUrl),
    h('label', { class: 'field' }, h('span', {}, 'Voyage API key'), voyageKey),
    h('div', { class: 'actions' }, reindex));
  const policies = {};
  const policyRows = d.toolNames.map((tool) => {
    policies[tool] = select([['auto', 'Always allow'], ['ask', 'Ask me'], ['deny', 'Block']], cfg.policies[tool] ?? 'ask');
    return h('div', { class: 'policy-row' }, h('code', {}, tool), policies[tool]);
  });
  const error = h('p', { class: 'error-text' });
  const anthropicBox = h('div', { class: 'provider-box' },
    h('label', { class: 'field' }, h('span', {}, 'Anthropic API key'), anthropicKey, h('small', {}, d.credentials.anthropic ? 'A key is saved (or set in the environment).' : 'Needed before the agent can answer.')),
    h('label', { class: 'field' }, h('span', {}, 'Model'), model),
    h('label', { class: 'field' }, h('span', {}, 'Effort'), effort));
  const openaiBox = h('div', { class: 'provider-box' },
    h('label', { class: 'field' }, h('span', {}, 'Base URL'), openaiBaseUrl, h('small', {}, 'Ollama is http://localhost:11434/v1')),
    h('label', { class: 'field' }, h('span', {}, 'Model name'), openaiModel),
    h('label', { class: 'field' }, h('span', {}, 'API key'), openaiKey));
  const showProvider = () => { anthropicBox.classList.toggle('hidden', provider.value !== 'anthropic'); openaiBox.classList.toggle('hidden', provider.value !== 'openai'); };
  provider.addEventListener('change', showProvider);
  showProvider();
  const save = async () => {
    error.textContent = '';
    const patch = {
      provider: provider.value, model: model.value.trim() || cfg.model, effort: effort.value,
      openaiBaseUrl: openaiBaseUrl.value.trim() || cfg.openaiBaseUrl, openaiModel: openaiModel.value.trim(),
      persona: persona.value.trim() || cfg.persona,
      embeddings: { provider: embProvider.value, model: embModel.value.trim(), baseUrl: embBaseUrl.value.trim(), ...(voyageKey.value.trim() ? { voyageKey: voyageKey.value.trim() } : {}) },
      transcription: { provider: trProvider.value, baseUrl: trBaseUrl.value.trim(), model: trModel.value.trim(), command: trCommand.value.trim(), language: trLanguage.value.trim(), ...(trKey.value.trim() ? { key: trKey.value.trim() } : {}) },
      policies: Object.fromEntries(Object.entries(policies).map(([tool, sel]) => [tool, sel.value])),
    };
    if (anthropicKey.value.trim()) patch.anthropicKey = anthropicKey.value.trim();
    if (openaiKey.value.trim()) patch.openaiKey = openaiKey.value.trim();
    try { ui.data = await api('config', 'PUT', patch); toast('Settings saved', 'good'); renderMain(); renderSidebar(); } catch (err) { error.textContent = err.message; }
  };
  return page('Settings', 'Model, persona and what each tool may do. Keys are stored in plain text in ~/.nocturn/config.json on the gateway machine.',
    h('div', { class: 'card' },
      h('label', { class: 'field' }, h('span', {}, 'Provider'), provider),
      anthropicBox, openaiBox,
      h('label', { class: 'field' }, h('span', {}, 'Persona'), persona, h('small', {}, 'The first line of the system prompt.'))),
    h('div', { class: 'section-title' }, 'Voice notes'),
    h('div', { class: 'card' }, voiceBox),
    h('div', { class: 'section-title' }, 'Semantic search'),
    h('div', { class: 'card' }, searchBox),
    h('div', { class: 'section-title' }, 'Tool permissions'),
    h('div', { class: 'card' }, policyRows, h('p', { class: 'muted small-text' }, 'The shell tool is not sandboxed: an approved command runs with your user\'s full permissions.')),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: save }, 'Save settings')), error,
    h('div', { class: 'section-title' }, 'This panel'),
    h('div', { class: 'card' },
      h('p', { class: 'small-text' }, 'The private link is ', h('code', {}, `${location.origin}/panel.html#token=…`), '. Get it with ', h('code', {}, 'nocturn dashboard'), ' and never share it.'),
      h('p', { class: 'muted small-text' }, 'On a server, reach the gateway through an SSH tunnel: ', h('code', {}, 'ssh -L 18790:127.0.0.1:18790 user@your-server'), '.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn small danger', onclick: () => { if (confirm('Forget the token on this device?')) signOut(); } }, 'Sign out on this device'))));
}

/* Connect screen (no token yet) */
function renderConnect() {
  const input = h('input', { type: 'text', placeholder: 'http://127.0.0.1:18790/#token=… or the token', autocomplete: 'off', spellcheck: false });
  const error = h('p', { class: 'error-text' });
  const go = async () => {
    const found = input.value.match(/token=([a-f0-9]+)/)?.[1] ?? input.value.trim().match(/^[a-f0-9]{16,}$/)?.[0];
    if (!found) { error.textContent = 'Paste the private link printed by nocturn dashboard.'; return; }
    token = found;
    store.set('nocturn-token', token);
    try { await start(); } catch (err) { token = null; store.remove('nocturn-token'); error.textContent = err.message; }
  };
  root.replaceChildren(h('div', { class: 'connect' },
    h('div', { class: 'connect-card' },
      h('span', { class: 'brand-mark big', 'aria-hidden': 'true' }),
      h('h1', {}, 'Connect to your gateway'),
      h('p', { class: 'lede' }, 'This panel talks to the Nocturn gateway on this address. Paste the private link it printed.'),
      h('label', { class: 'field' }, h('span', {}, 'Private link'), input),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: go }, 'Connect'), themeButton()),
      error,
      h('p', { class: 'muted small-text' }, 'Get the link with ', h('code', {}, 'nocturn dashboard'), ' on the machine that runs the gateway.'))), toasts);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  input.focus();
}

async function start() {
  ui.data = await api('state');
  if (ui.sessionId && !ui.data.sessions.some((s) => s.id === ui.sessionId)) { ui.sessionId = null; store.remove('nocturn-session'); }
  renderShell();
  startEvents();
}

if (!token) renderConnect();
else start().catch((err) => { if (err.status !== 401) { token = null; store.remove('nocturn-token'); renderConnect(); toast(err.message, 'bad'); } });
