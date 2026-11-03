// The phone never runs the gateway. This screen remembers where it is and opens its control panel.
(function () {
  var form = document.getElementById('form');
  var urlEl = document.getElementById('url');
  var tokenEl = document.getElementById('token');
  var error = document.getElementById('error');
  var saved = null;
  try { saved = JSON.parse(localStorage.getItem('nocturn-gateway') || 'null'); } catch (e) { saved = null; }

  function open(url, token) {
    location.href = url.replace(/\/+$/, '') + '/panel.html#token=' + encodeURIComponent(token);
  }

  async function check(url, token) {
    var res = await fetch(url.replace(/\/+$/, '') + '/api/state', { headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(8000) });
    if (res.status === 401) throw new Error('The gateway rejected this token.');
    if (res.status === 403) throw new Error('The gateway does not trust this address. Set NOCTURN_TRUSTED_HOSTS on it.');
    if (!res.ok) throw new Error('The gateway answered ' + res.status + '.');
  }

  if (saved && saved.url && saved.token) {
    urlEl.value = saved.url;
    tokenEl.value = saved.token;
    check(saved.url, saved.token).then(function () { open(saved.url, saved.token); }, function () { /* show the form */ });
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    error.textContent = '';
    var url = urlEl.value.trim();
    var token = tokenEl.value.trim();
    var button = form.querySelector('button');
    button.disabled = true;
    button.textContent = 'Connecting…';
    try {
      await check(url, token);
      try { localStorage.setItem('nocturn-gateway', JSON.stringify({ url: url, token: token })); } catch (err) { /* keep going */ }
      open(url, token);
    } catch (err) {
      error.textContent = err.name === 'TimeoutError' ? 'No answer from that address.' : err.message;
      button.disabled = false;
      button.textContent = 'Connect';
    }
  });
})();
