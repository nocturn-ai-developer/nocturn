// A soft pill that slides and reshapes itself behind the current tab or the hovered link.
function indicator(container) {
  const ind = document.createElement('span');
  ind.className = 'tab-ind';
  ind.setAttribute('aria-hidden', 'true');
  container.prepend(ind);
  container.classList.add('has-ind');
  return (target) => {
    if (!target) { ind.style.opacity = '0'; return; }
    ind.style.opacity = '1';
    ind.style.width = `${target.offsetWidth}px`;
    ind.style.height = `${target.offsetHeight}px`;
    ind.style.transform = `translate(${target.offsetLeft}px, ${target.offsetTop}px)`;
  };
}

// Follows whichever button has the `active` class.
export function followActive(container) {
  const move = indicator(container);
  const update = () => move(container.querySelector('button.active'));
  new ResizeObserver(update).observe(container);
  new MutationObserver(update).observe(container, { subtree: true, attributes: true, attributeFilter: ['class'] });
  requestAnimationFrame(update);
}
