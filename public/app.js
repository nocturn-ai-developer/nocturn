import { downloadButton, installLine, landing, setStats, setTrusted } from '/demo.js';
import { smoothWheel } from '/scroll.js';
import { walletButton } from '/wallet.js';
import { particleMoon } from '/four.js';

// The web page is only the product page. Nocturn itself is driven from the terminal.
// With the dashboard token it also edits Trusted by and links a wallet to the miner; without one
// (the public site) it is the plain landing page.
const root = document.getElementById('app');

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v);
  }
  el.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* private window: token lasts for this page only */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* nothing stored */ } },
};

let token = store.get('nocturn-token');
const hashToken = location.hash.match(/token=([a-f0-9]+)/)?.[1];
if (hashToken) {
  token = hashToken;
  store.set('nocturn-token', token);
  history.replaceState(null, '', location.pathname);
}

async function api(path, method = 'GET', body) {
  const res = await fetch(`/api/${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { signOut(); throw new Error('Signed out'); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function signOut() {
  store.remove('nocturn-token');
  token = null;
  startPublic();
}

const ui = { state: null, partners: [], view: 'home' };
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

function morph(change) {
  if (reducedMotion || !document.startViewTransition || document.hidden) { change(); return; }
  const transition = document.startViewTransition(change);
  transition.ready.catch(() => {});
  transition.finished.catch(() => {});
}

/* Theme: the system decides until the moon button picks one, then that choice is kept */
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const currentTheme = () => document.documentElement.dataset.theme || (darkQuery.matches ? 'dark' : 'light');

function themeButton() {
  const icon = h('span', { 'aria-hidden': 'true' });
  const button = h('button', { class: 'theme-btn', onclick: () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    morph(() => {
      document.documentElement.dataset.theme = next;
      store.set('nocturn-theme', next);
      paint();
    });
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

// A plain link to the documentation, styled like the menu button.
function docsLink() {
  const a = h('a', { class: 'nav-menu', href: '/docs' }, 'Docs');
  a.style.textDecoration = 'none';
  return a;
}

/* Shell */
const SECTIONS = [['top', 'Intro'], ['night', 'Night'], ['why', 'Why'], ['token', 'Token'], ['download', 'Download'], ['install', 'Install']];

function jump(id) {
  const go = () => document.getElementById(id)?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth' });
  if (ui.view === 'home') { go(); return; }
  goTo('home');
  setTimeout(go, 60);
}
let mainEl;
let heroOn = false;

// A plain header (wordmark, menu, wallet) and a section index down the left edge that marks
// where the reader is.
function renderShell() {
  mainEl = h('main', { class: 'main' });
  const sheet = h('nav', { class: 'nav-sheet', 'aria-label': 'Sections' },
    SECTIONS.map(([id, label], i) => h('button', { onclick: () => { setMenu(false); jump(id); } }, h('span', {}, String(i + 1).padStart(2, '0')), label)),
    h('button', { onclick: () => { location.href = '/docs'; } }, h('span', {}, '→'), 'Docs'));
  const menuBtn = h('button', { class: 'nav-menu', 'aria-expanded': 'false', onclick: () => setMenu(!bar.classList.contains('open')) }, h('span', { class: 'lines', 'aria-hidden': 'true' }, h('i'), h('i')), 'Menu');
  const bar = h('header', { class: 'topbar' },
    h('div', { class: 'topbar-start' }, h('button', { class: 'brand', onclick: () => jump('top') }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }), 'NOCTURN'), menuBtn, docsLink()),
    h('div', { class: 'topbar-end' }, downloadButton('btn small topbar-download'), themeButton(), walletButton(token ? api : null)),
    sheet);
  function setMenu(open) {
    bar.classList.toggle('open', open);
    menuBtn.setAttribute('aria-expanded', String(open));
  }
  const marks = SECTIONS.map(([id, label]) => h('button', { 'data-id': id, onclick: () => jump(id) }, label));
  const index = h('nav', { class: 'index', 'aria-label': 'Sections' }, h('span', { class: 'index-line', 'aria-hidden': 'true' }, h('i')), marks);
  root.replaceChildren(h('div', { class: 'shell' }, bar, index, mainEl));
  renderView();
  smoothWheel(mainEl);

  const mark = (current) => marks.forEach((m, i) => {
    m.classList.toggle('active', m.dataset.id === current);
    m.classList.toggle('past', i < SECTIONS.findIndex(([id]) => id === current));
  });
  mainEl.addEventListener('scroll', (e) => {
    const top = e.target.scrollTop ?? 0;
    bar.classList.toggle('scrolled', top > 30);
    index.classList.toggle('hidden-index', ui.view !== 'home');
    const middle = innerHeight * 0.45;
    let current = 'top';
    for (const [id] of SECTIONS) {
      const section = document.getElementById(id);
      if (section && section.getBoundingClientRect().top <= middle) current = id;
    }
    mark(current);
    const scroller = e.target;
    if (scroller.scrollHeight > scroller.clientHeight) index.style.setProperty('--progress', (top / (scroller.scrollHeight - scroller.clientHeight)).toFixed(3));
  }, { capture: true, passive: true });
  mark('top');
}

function goTo(view) {
  if (ui.view === view) return;
  ui.view = view;
  morph(renderView);
}

function renderView() {
  mainEl.replaceChildren(ui.view === 'admin' ? viewAdmin() : viewHome());
  heroOn = ui.view === 'home';
}

/* Home */
let moonCanvas = null;

function welcome() {
  moonCanvas ??= particleMoon(); // one instance, so a refresh does not restart it
  return h('section', { class: `hero ${heroOn ? '' : 'hero-enter'}`, id: 'top' },
    moonCanvas,
    h('div', { class: 'hero-copy' },
      h('p', { class: 'kicker' }, 'Purpose of Nocturn'),
      h('h1', {}, 'Your machine works', h('br'), 'the night shift'),
      h('p', { class: 'hero-lede' }, 'An AI agent and miner you install from your terminal. Leave your computer on or put it on a server, and it works through the night.'),
      h('div', { class: 'hero-cta' },
        downloadButton('btn primary'),
        h('button', { class: 'btn outline', onclick: () => jump('install') }, 'Install with npm'),
        installLine())),
    h('button', { class: 'btn dark scroll-more', onclick: () => jump('night') }, h('span', { 'aria-hidden': 'true' }, '↓'), 'Scroll for more'),
    h('article', { class: 'hero-card' },
      h('span', { class: 'hero-num' }, '01'),
      h('div', {}, h('h3', {}, 'Published on npm as', h('br'), '@morpheapp/nocturn')),
      h('p', {}, 'Nocturn is a self-hosted AI agent with a built-in miner for your CPU and GPU. One gateway runs on your own machine, takes jobs from the terminal or your chat apps, asks before anything risky, and keeps going while you sleep.')));
}

function viewHome() {
  const sections = landing({ onAdmin: token ? () => goTo('admin') : null });
  if (ui.state) setStats(ui.state);
  return h('div', { class: 'chat' }, h('section', { class: 'conversation' },
    h('div', { class: 'transcript' }, h('div', { class: 'transcript-inner wide' }, welcome(), sections))));
}

/* Admin: who appears under Trusted by */
const LOGO_SIZE = 256;

function formError() { return h('p', { class: 'error-text', role: 'alert' }); }

async function attempt(errorEl, fn) {
  errorEl.textContent = '';
  try { return await fn(); } catch (err) { errorEl.textContent = err.message; return undefined; }
}

// Shrinking here keeps stored logos small. The canvas also drops anything but the pixels.
async function logoFromFile(file) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Use a PNG, JPG or WebP image');
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error('That image could not be read'); });
  const scale = Math.min(1, LOGO_SIZE / Math.max(bitmap.width, bitmap.height));
  const canvas = h('canvas', { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) });
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/png');
}

function setPartners(list) {
  ui.partners = list;
  setTrusted(list);
  renderView();
}

function viewAdmin() {
  const list = ui.partners;
  const name = h('input', { type: 'text', maxLength: 60, placeholder: 'Company or person' });
  const preview = h('img', { class: 'trust-preview hidden', alt: '' });
  const error = formError();
  let logo = null;
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', onchange: () => attempt(error, async () => {
    logo = null;
    preview.classList.add('hidden');
    if (!file.files[0]) return;
    logo = await logoFromFile(file.files[0]);
    preview.src = logo;
    preview.classList.remove('hidden');
  }) });
  const add = () => attempt(error, async () => {
    if (!logo) throw new Error('Choose a logo first');
    setPartners(await api('partners', 'POST', { name: name.value, logo }));
  });
  return h('div', { class: 'page' }, h('div', { class: 'page-inner' },
    h('button', { class: 'btn small', onclick: () => goTo('home') }, '← Home'),
    h('h1', {}, 'Trusted by'),
    h('p', { class: 'lede' }, 'Choose who appears on the home page. List only people and companies that agreed to be shown.'),
    h('div', { class: 'card' },
      h('label', { class: 'field' }, h('span', {}, 'Name'), name),
      h('label', { class: 'field' }, h('span', {}, 'Logo'), file, h('small', {}, 'PNG, JPG or WebP. Resized to 256 px at most.')),
      preview,
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: add }, 'Add to home page')),
      error),
    h('div', { class: 'section-title' }, `${list.length} shown`),
    list.length ? list.map((p) => h('div', { class: 'card' }, h('div', { class: 'row' },
      h('img', { class: 'trust-thumb', src: p.logo, alt: '' }),
      h('div', { class: 'row-text' }, p.name),
      h('button', { class: 'btn small danger', onclick: () => attempt(error, async () => setPartners(await api(`partners/${p.id}`, 'DELETE'))) }, 'Remove'))))
      : h('div', { class: 'empty' }, 'Nobody listed yet. The section stays hidden until you add someone.')));
}

async function start() {
  ui.state = await api('state');
  ui.partners = await api('partners');
  setTrusted(ui.partners);
  renderShell();
}

// The public site has no gateway: Trusted by comes from a file written at build time.
async function startPublic() {
  ui.state = null;
  ui.partners = await fetch('/partners.json').then((r) => (r.ok ? r.json() : []), () => []);
  setTrusted(ui.partners);
  renderShell();
}

if (!token) startPublic();
else start().catch(() => { store.remove('nocturn-token'); token = null; startPublic(); });
