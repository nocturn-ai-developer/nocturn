// Nocturn Desktop: the same gateway as `nocturn gateway run`, inside one window.
// The gateway boots in this process, the window shows the control panel, and closing the window
// only hides it: the agent, channels and schedules keep running in the tray until you quit.
import { app, BrowserWindow, Menu, Tray, clipboard, nativeImage, nativeTheme, shell, Notification } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.NOCTURN_PORT) || 18790;
const APP_ID = 'com.nocturnh.desktop';

if (!app.requestSingleInstanceLock()) app.quit();
app.setAppUserModelId(APP_ID);

let win = null;
let tray = null;
let gateway = null;
let quitting = false;
let link = '';

const windowColor = () => (nativeTheme.shouldUseDarkColors ? '#0e0e11' : '#ffffff');

async function startGateway() {
  const { AUTH_TOKEN } = await import('../src/config.mjs');
  const { boot } = await import('../src/index.mjs');
  try {
    gateway = await boot(PORT);
  } catch (err) {
    // A gateway started from the terminal is already listening: use it instead of failing.
    if (err.code !== 'EADDRINUSE') throw err;
    gateway = null;
  }
  link = `http://127.0.0.1:${PORT}/panel.html#token=${AUTH_TOKEN}`;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 760,
    minHeight: 520,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: windowColor(),
    title: 'Nocturn',
    icon: join(here, process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.once('ready-to-show', () => win.show());
  // Links on the page open in the real browser, never in this window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${PORT}/`)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); }
  });
  win.on('close', (e) => {
    if (quitting || process.platform === 'darwin' && false) return;
    e.preventDefault();
    win.hide();
    if (!win.toldAboutTray && Notification.isSupported()) {
      win.toldAboutTray = true;
      new Notification({ title: 'Nocturn keeps working', body: 'The gateway is still running. Open or quit it from the tray icon.' }).show();
    }
  });
  win.loadURL(link);
}

function showWindow() {
  if (!win) createWindow();
  else { win.show(); win.focus(); }
}

function createTray() {
  const image = nativeImage.createFromPath(join(here, process.platform === 'win32' ? 'icon.ico' : 'icon.png')).resize({ width: 18, height: 18 });
  tray = new Tray(image);
  tray.setToolTip(`Nocturn · 127.0.0.1:${PORT}`);
  const menu = Menu.buildFromTemplate([
    { label: 'Open Nocturn', click: showWindow },
    { label: 'Open in browser', click: () => shell.openExternal(link) },
    { label: 'Copy private link', click: () => clipboard.writeText(link) },
    { type: 'separator' },
    {
      label: 'Start at login',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true }),
    },
    { type: 'separator' },
    { label: 'Quit Nocturn', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

app.on('second-instance', showWindow);
app.on('activate', showWindow);
app.on('window-all-closed', () => { /* stay alive in the tray */ });
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => { gateway?.server.close(); });
nativeTheme.on('updated', () => win?.setBackgroundColor(windowColor()));

app.whenReady().then(async () => {
  try {
    await startGateway();
  } catch (err) {
    const { dialog } = await import('electron');
    dialog.showErrorBox('Nocturn could not start', err.message);
    app.quit();
    return;
  }
  createTray();
  const hidden = process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAsHidden;
  if (!hidden) createWindow();
});
