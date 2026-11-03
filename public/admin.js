// The admin page for nocturnh.com. It talks to the Worker's /admin/api routes; the session token
// lives in sessionStorage, so closing the tab signs out.
const $ = (id) => document.getElementById(id);
const store = {
  get: () => { try { return sessionStorage.getItem('nocturn-admin'); } catch { return null; } },
  set: (v) => { try { sessionStorage.setItem('nocturn-admin', v); } catch { /* private window */ } },
  clear: () => { try { sessionStorage.removeItem('nocturn-admin'); } catch { /* nothing stored */ } },
};
let token = store.get();

async function call(path, method, body) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/admin/api/login') { signOut(); throw new Error('Your session ended. Sign in again.'); }
  if (!res.ok) throw new Error(data.error || `The server answered ${res.status}.`);
  return data;
}

function show(editor) {
  $('login').classList.toggle('hidden', editor);
  $('editor').classList.toggle('hidden', !editor);
}

function signOut() {
  token = null;
  store.clear();
  $('password').value = '';
  show(false);
}

function paintLive({ contract, twitter, updated }) {
  $('live-contract').textContent = contract || 'Not deployed yet';
  $('live-twitter').textContent = twitter ? `@${twitter}` : 'Hidden';
  $('live-updated').textContent = updated ? new Date(updated).toLocaleString('en-US') : 'Never';
}

async function loadLive() {
  const live = await fetch('/api/site', { cache: 'no-store' }).then((r) => r.json()).catch(() => ({}));
  $('contract').value = live.contract || '';
  $('twitter').value = live.twitter ? `@${live.twitter}` : '';
  paintLive(live);
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const error = $('login-error');
  error.textContent = '';
  const button = e.target.querySelector('button');
  button.disabled = true;
  try {
    const { token: issued } = await call('/admin/api/login', 'POST', { password: $('password').value });
    token = issued;
    store.set(issued);
    show(true);
    await loadLive();
  } catch (err) {
    error.textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

$('site-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const error = $('site-error');
  const status = $('status');
  error.textContent = '';
  status.textContent = '';
  $('save').disabled = true;
  try {
    const saved = await call('/admin/api/site', 'PUT', { contract: $('contract').value, twitter: $('twitter').value });
    paintLive(saved);
    status.textContent = 'Published.';
    setTimeout(() => { status.textContent = ''; }, 2500);
  } catch (err) {
    error.textContent = err.message;
  } finally {
    $('save').disabled = false;
  }
});

$('signout').addEventListener('click', signOut);

if (token) { show(true); loadLive(); } else show(false);
