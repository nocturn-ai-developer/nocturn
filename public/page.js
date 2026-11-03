// Theme toggle for the simple pages (install guide, changelog, legal, 404).
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const store = { get: () => { try { return localStorage.getItem('nocturn-theme'); } catch { return null; } }, set: (v) => { try { localStorage.setItem('nocturn-theme', v); } catch { /* private window */ } } };
const current = () => document.documentElement.dataset.theme || (darkQuery.matches ? 'dark' : 'light');
const btn = document.getElementById('theme');
const paint = () => { const dark = current() === 'dark'; btn.firstChild.textContent = dark ? '☀' : '☾'; btn.title = dark ? 'Switch to light mode' : 'Switch to dark mode'; btn.setAttribute('aria-label', btn.title); };
btn.addEventListener('click', () => { const next = current() === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = next; store.set(next); paint(); });
darkQuery.addEventListener('change', paint);
paint();

// The same reveal the docs use: sections fade in as they come into view.
const sections = [...document.querySelectorAll('.doc')];
if (matchMedia('(prefers-reduced-motion: reduce)').matches) sections.forEach((s) => s.classList.add('shown'));
else {
  const revealer = new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.isIntersecting) { entry.target.classList.add('shown'); revealer.unobserve(entry.target); }
  }, { threshold: 0.08 });
  sections.forEach((s, i) => (i === 0 ? s.classList.add('shown') : revealer.observe(s)));
}
