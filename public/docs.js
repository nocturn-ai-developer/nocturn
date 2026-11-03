// Documentation page behaviour: theme, table of contents, search, copy buttons, pager.
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* private window */ } },
};

/* Theme: same rules as the home page, one shared localStorage key */
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const currentTheme = () => document.documentElement.dataset.theme || (darkQuery.matches ? 'dark' : 'light');
const themeBtn = document.getElementById('theme');
const paintTheme = () => {
  const dark = currentTheme() === 'dark';
  themeBtn.firstElementChild.textContent = dark ? '☀' : '☾';
  themeBtn.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
  themeBtn.setAttribute('aria-label', themeBtn.title);
  themeBtn.setAttribute('aria-pressed', String(dark));
};
themeBtn.addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  const change = () => { document.documentElement.dataset.theme = next; store.set('nocturn-theme', next); paintTheme(); };
  if (reducedMotion || !document.startViewTransition) change();
  else document.startViewTransition(change).finished.catch(() => {});
});
darkQuery.addEventListener('change', paintTheme);
paintTheme();

/* Headings: anchors, table of contents, "On this page" */
const content = document.querySelector('.content');
const sections = [...content.querySelectorAll('section.doc')];
const toc = document.getElementById('toc');
const onpage = document.getElementById('onpage');
const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

for (const section of sections) {
  const h2 = section.querySelector('h2');
  section.id ||= slug(h2.textContent);
  const item = document.createElement('li');
  const top = document.createElement('a');
  top.href = `#${section.id}`;
  top.textContent = h2.textContent;
  item.append(top);
  const subs = [...section.querySelectorAll('h3')];
  if (subs.length) {
    const list = document.createElement('ul');
    for (const h3 of subs) {
      h3.id ||= `${section.id}-${slug(h3.textContent)}`;
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = `#${h3.id}`;
      a.textContent = h3.textContent;
      li.append(a);
      list.append(li);
    }
    item.append(list);
  }
  toc.append(item);
  for (const heading of [h2, ...subs]) {
    const anchor = document.createElement('a');
    anchor.className = 'anchor';
    anchor.href = `#${heading.id}`;
    anchor.textContent = '#';
    anchor.setAttribute('aria-label', `Link to ${heading.textContent}`);
    heading.append(anchor);
  }
}

const headings = [...content.querySelectorAll('section.doc h2, section.doc h3')];
const tocLinks = new Map([...toc.querySelectorAll('a')].map((a) => [a.getAttribute('href').slice(1), a]));

function paintOnPage(section) {
  onpage.querySelector('ol').replaceChildren(...[...section.querySelectorAll('h3')].map((h3) => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `#${h3.id}`;
    a.textContent = h3.textContent;
    li.append(a);
    return li;
  }));
}

let currentSection = null;
let queued = false;
function spy() {
  queued = false;
  const line = innerHeight * 0.3;
  let current = headings[0];
  for (const h of headings) if (h.getBoundingClientRect().top <= line) current = h;
  if (!current) return;
  for (const a of tocLinks.values()) a.classList.toggle('active', a.getAttribute('href') === `#${current.id}`);
  const section = current.closest('section.doc');
  if (section !== currentSection) {
    currentSection = section;
    paintOnPage(section);
    tocLinks.get(section.id)?.scrollIntoView?.({ block: 'nearest' });
  }
  for (const a of onpage.querySelectorAll('a')) a.classList.toggle('active', a.getAttribute('href') === `#${current.id}`);
  const doc = document.documentElement;
  onpage.style.setProperty('--p', (doc.scrollTop / Math.max(1, doc.scrollHeight - doc.clientHeight)).toFixed(3));
}
addEventListener('scroll', () => { if (!queued) { queued = true; requestAnimationFrame(spy); } }, { passive: true });
addEventListener('resize', spy);
spy();

/* Search: filters the table of contents by heading text */
const search = document.getElementById('search');
const empty = document.getElementById('toc-empty');
search.addEventListener('input', () => {
  const q = search.value.trim().toLowerCase();
  toc.classList.toggle('filtered', Boolean(q));
  let hits = 0;
  for (const top of toc.children) {
    let any = false;
    for (const li of top.querySelectorAll('ul li')) {
      const hit = !q || li.textContent.toLowerCase().includes(q);
      li.classList.toggle('miss', !hit);
      any ||= hit;
    }
    const topHit = !q || top.firstElementChild.textContent.toLowerCase().includes(q) || any;
    top.classList.toggle('miss', !topHit);
    if (topHit) hits += 1;
    if (topHit && !any && q) top.querySelectorAll('ul li').forEach((li) => li.classList.remove('miss'));
  }
  empty.classList.toggle('show', Boolean(q) && !hits);
});
addEventListener('keydown', (e) => {
  if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) { e.preventDefault(); search.focus(); search.select(); }
  if (e.key === 'Escape' && document.activeElement === search) { search.value = ''; search.dispatchEvent(new Event('input')); search.blur(); }
});

/* Mobile: the table of contents slides over the page */
const sidebar = document.querySelector('.sidebar');
const toggle = document.getElementById('toc-toggle');
toggle.addEventListener('click', () => {
  const open = sidebar.classList.toggle('open');
  toggle.textContent = open ? 'Close' : 'Contents';
  toggle.setAttribute('aria-expanded', String(open));
});
toc.addEventListener('click', (e) => {
  if (e.target.tagName === 'A' && sidebar.classList.contains('open')) toggle.click();
});

/* Copy buttons on every code block */
for (const pre of content.querySelectorAll('pre')) {
  const button = document.createElement('button');
  button.className = 'copy';
  button.type = 'button';
  button.textContent = 'Copy';
  button.addEventListener('click', async () => {
    // Prompts and comments are decoration; only the commands are copied.
    const text = [...pre.querySelectorAll('code')].map((c) => c.textContent).join('\n')
      .split('\n').filter((line) => !line.trim().startsWith('#')).map((line) => line.replace(/^\$ /, '')).join('\n').trim();
    try { await navigator.clipboard.writeText(text); button.textContent = 'Copied'; } catch { button.textContent = 'Could not copy'; }
    setTimeout(() => { button.textContent = 'Copy'; }, 1200);
  });
  pre.append(button);
}

/* Previous and next section */
for (const [i, section] of sections.entries()) {
  const pager = document.createElement('nav');
  pager.className = 'pager';
  pager.setAttribute('aria-label', 'Previous and next');
  const link = (target, cls, label) => {
    const a = document.createElement('a');
    a.href = `#${target.id}`;
    a.className = cls;
    const small = document.createElement('small');
    small.textContent = label;
    const b = document.createElement('b');
    b.textContent = target.querySelector('h2').firstChild.textContent;
    a.append(small, b);
    return a;
  };
  const prev = sections[i - 1] ? link(sections[i - 1], 'prev', 'Previous') : document.createElement('span');
  const next = sections[i + 1] ? link(sections[i + 1], 'next', 'Next') : document.createElement('span');
  pager.append(prev, next);
  section.append(pager);
}

/* Reveal sections as they scroll in */
if (reducedMotion) sections.forEach((s) => s.classList.add('shown'));
else {
  const revealer = new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.isIntersecting) { entry.target.classList.add('shown'); revealer.unobserve(entry.target); }
  }, { threshold: 0.05 });
  // The first section is already on screen; the rest fade in as they arrive.
  sections.forEach((s, i) => (i === 0 ? s.classList.add('shown') : revealer.observe(s)));
}

// Landing on a hash: wait a frame so the layout is final, then jump.
if (location.hash) requestAnimationFrame(() => document.querySelector(location.hash)?.scrollIntoView());
