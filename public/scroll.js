// Eases mouse-wheel scrolling. Touch, keyboard and scrollbar dragging stay native.
const RATE = 9; // higher settles faster

function canScroll(node, dy) {
  if (node.scrollHeight <= node.clientHeight + 1) return false;
  const { overflowY } = getComputedStyle(node);
  if (overflowY !== 'auto' && overflowY !== 'scroll') return false;
  return dy < 0 ? node.scrollTop > 0 : node.scrollTop < node.scrollHeight - node.clientHeight - 1;
}

function scrollerFor(start, host, dy) {
  for (let node = start; node && node !== host; node = node.parentElement) {
    if (node.closest('.demo')) continue; // the demo's small panels must not trap the page
    if (canScroll(node, dy)) return node;
  }
  return null;
}

export function smoothWheel(host) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  let el = null, pos = 0, goal = 0, raf = 0, last = 0;

  const stop = () => { cancelAnimationFrame(raf); raf = 0; };
  function tick(now) {
    if (!el.isConnected) { stop(); return; }
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    pos += (goal - pos) * (1 - Math.exp(-dt * RATE));
    if (Math.abs(goal - pos) < 0.4) pos = goal;
    el.scrollTop = pos;
    if (pos === goal) { raf = 0; return; }
    raf = requestAnimationFrame(tick);
  }

  host.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.shiftKey || !e.deltaY || e.target.closest('textarea, select')) return;
    const node = scrollerFor(e.target, host, e.deltaY);
    if (!node) return;
    e.preventDefault();
    if (node !== el || !raf) { stop(); el = node; pos = goal = node.scrollTop; }
    const unit = e.deltaMode === 1 ? 18 : e.deltaMode === 2 ? node.clientHeight : 1;
    goal = Math.max(0, Math.min(node.scrollHeight - node.clientHeight, goal + e.deltaY * unit));
    if (!raf) { last = performance.now(); raf = requestAnimationFrame(tick); }
  }, { passive: false });
  // Grabbing the scrollbar or pressing a key takes over from the easing.
  host.addEventListener('pointerdown', stop);
  addEventListener('keydown', stop);
}
