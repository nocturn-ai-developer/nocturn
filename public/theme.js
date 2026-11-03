// Applies a saved theme before the first paint, so the page never flashes the wrong colours.
// A classic script, not a module: it must run before the stylesheet is used.
(function () {
  var theme = null;
  try { theme = localStorage.getItem('nocturn-theme'); } catch (e) { /* private window */ }
  if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;
})();
