'use strict';

const path = require('path');
const {
  app, BrowserWindow, Tray, Menu, nativeImage, ipcMain,
} = require('electron');

const db = require('./db');
const tracker = require('./tracker');
const reminders = require('./reminders');

let tray = null;
let win = null;
let pop = null;

// ---- date helpers -------------------------------------------------------

function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}
const DAY_MS = 24 * 60 * 60 * 1000;

function fmt(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

// ---- window -------------------------------------------------------------

function createWindow() {
  if (win) { win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 720,
    minHeight: 520,
    title: 'Tally',
    show: false,
    // Menu-bar app: never enter a native fullscreen Space (it hides the macOS
    // menu bar and with it the Tally tray icon). Green button zooms instead.
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'),
    process.env.DT_TAB ? { search: `tab=${process.env.DT_TAB}` } : undefined);
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
}

// ---- tray + custom popover ----------------------------------------------

// Right-click fallback: a plain native menu (the styled panel is the popover).
function trayMenu() {
  const tracking = tracker.isRunning();
  return Menu.buildFromTemplate([
    { label: 'Open Dashboard', click: createWindow },
    {
      label: tracking ? 'Pause tracking' : 'Resume tracking',
      click: () => { setTracking(!tracking); },
    },
    { type: 'separator' },
    { label: 'Quit Tally', click: () => { tracker.stop(); app.quit(); } },
  ]);
}

function refreshTray() {
  if (!tray) return;
  const s = db.summary(startOfDay(), startOfDay() + DAY_MS);
  tray.setTitle(` ${fmt(s.total)}`);
}

function setTracking(on) {
  if (on) { tracker.start(); db.setSetting('tracking', 1); }
  else { tracker.stop(); db.setSetting('tracking', 0); }
  refreshTray();
}

// Frameless, transparent panel shown under the menu-bar icon (the design's
// "menu-bar dropdown"). Hidden on blur so it behaves like a real menu.
function createPopover() {
  pop = new BrowserWindow({
    width: 300, height: 264, show: false, frame: false, transparent: true,
    resizable: false, movable: false, skipTaskbar: true, alwaysOnTop: true,
    fullscreenable: false, hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  // Behave like a real menu-bar dropdown: float above other apps (including
  // fullscreen ones) on every Space, and never transform the process type —
  // that's what would otherwise yank the user to Tally's Space when it opens.
  pop.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  pop.setAlwaysOnTop(true, 'pop-up-menu');
  pop.loadFile(path.join(__dirname, 'renderer', 'popover.html'));
  // Size the window to the rendered panel so nothing is cropped.
  pop.webContents.on('did-finish-load', sizePopover);
  pop.on('blur', () => { if (pop && !pop.webContents.isDevToolsOpened()) pop.hide(); });
}

async function sizePopover() {
  try {
    const h = await pop.webContents.executeJavaScript('document.querySelector(".pop").offsetHeight');
    if (h) pop.setSize(300, Math.ceil(h) + 16, false);
  } catch (_) { /* keep current height */ }
}

function togglePopover() {
  if (!pop) createPopover();
  if (pop.isVisible()) { pop.hide(); return; }
  const tb = tray.getBounds();
  const pb = pop.getBounds();
  const x = Math.round(tb.x + tb.width / 2 - pb.width / 2);
  const y = Math.round(tb.y + tb.height + 2);
  pop.setPosition(x, y, false);
  pop.showInactive(); // don't focus → don't activate Tally / switch Space
  pop.webContents.send('popover:refresh');
  setTimeout(sizePopover, 120); // row set may have changed (e.g. update ready)
}

// Auto-update: check GitHub Releases on launch and again hourly. Only in a
// packaged build — electron-updater needs the published latest-mac.yml + zip.
// (macOS applies updates only for signed builds; unsigned installs still get
// the "update available" notification but must be replaced manually.)
let updateReady = null; // version string once an update is downloaded
let _autoUpdater = null;

function checkForUpdates() {
  if (!app.isPackaged) return;
  try { ({ autoUpdater: _autoUpdater } = require('electron-updater')); } catch (_) { return; }
  _autoUpdater.on('update-downloaded', (info) => {
    updateReady = info.version;
    refreshTray();
    if (pop && !pop.isDestroyed()) pop.webContents.send('popover:refresh');
  });
  _autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  setInterval(() => _autoUpdater.checkForUpdatesAndNotify().catch(() => {}), 60 * 60 * 1000);
}

// Mirror the `launch_at_login` setting into the macOS login-item registration.
// openAsHidden starts the app straight to the menu bar, no window.
function syncLoginItem() {
  const on = db.getSettings().launch_at_login !== '0';
  app.setLoginItemSettings({ openAtLogin: on, openAsHidden: true });
}

function createTray() {
  // Tally mark as a template image (auto-tinted for light/dark menu bar) + the
  // running total as the title next to it.
  let img = nativeImage.createEmpty();
  try {
    img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'))
      .resize({ width: 18, height: 18 });
    img.setTemplateImage(true);
  } catch (_) { /* fall back to text-only */ }
  tray = new Tray(img);
  tray.setToolTip('Tally');
  tray.on('click', togglePopover);
  tray.on('right-click', () => tray.popUpContextMenu(trayMenu()));
  refreshTray();
  setInterval(refreshTray, 5000);
}

// ---- IPC ----------------------------------------------------------------

// Resolve a macOS app icon to a PNG data URL, cached by path.
// app.getFileIcon() returns a generic placeholder for .app bundles, and qlmanage
// hangs, so we read the bundle's .icns (via CFBundleIconFile, falling back to the
// largest .icns in Resources) and convert it with sips — fast and dependency-free.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const iconCache = new Map();

const ICON_SH = `
p="$1"; out="$2"; res="$p/Contents/Resources"
name=$(plutil -extract CFBundleIconFile raw "$p/Contents/Info.plist" 2>/dev/null)
icns="$res/$name"
[ -f "$icns" ] || icns="$res/$name.icns"
[ -f "$icns" ] || icns=$(ls -S "$res"/*.icns 2>/dev/null | head -1)
[ -f "$icns" ] || exit 1
sips -s format png "$icns" --out "$out" -Z 128 >/dev/null 2>&1
`;

function renderIcon(appPath) {
  return new Promise((resolve) => {
    const outDir = path.join(os.tmpdir(), 'wend-icons');
    try { fs.mkdirSync(outDir, { recursive: true }); } catch (_) {}
    const out = path.join(outDir, path.basename(appPath).replace(/[^\w.-]/g, '_') + '.png');
    execFile('/bin/sh', ['-c', ICON_SH, 'sh', appPath, out], { timeout: 5000 }, () => {
      try {
        resolve('data:image/png;base64,' + fs.readFileSync(out).toString('base64'));
      } catch (_) {
        resolve(null);
      }
    });
  });
}

async function iconFor(appName, pathMap) {
  const p = pathMap[appName];
  if (!p) return null;
  if (iconCache.has(p)) return iconCache.get(p);
  const url = await renderIcon(p);
  iconCache.set(p, url);
  return url;
}

async function withIcons(list) {
  const pathMap = db.getAppPaths();
  await Promise.all(list.map(async (a) => { a.icon = await iconFor(a.app, pathMap); }));
  return list;
}

function rangeFor(range) {
  const today = startOfDay();
  if (range === 'week') return [today - 6 * DAY_MS, today + DAY_MS];
  if (typeof range === 'number') return [range, range + DAY_MS]; // a day's start_ts
  return [today, today + DAY_MS]; // default: today
}

function registerIpc() {
  ipcMain.handle('summary', async (_e, range) => {
    const [from, to] = rangeFor(range);
    const s = db.summary(from, to);
    s.byApp = await withIcons(s.byApp);
    return { ...s, current: tracker.getCurrent() };
  });

  ipcMain.handle('timeline', (_e, day) => {
    const from = day || startOfDay();
    return db.segmentsBetween(from, from + DAY_MS);
  });

  ipcMain.handle('week', () => {
    const today = startOfDay();
    const from = today - 6 * DAY_MS;
    const days = [];
    for (let i = 0; i < 7; i++) {
      const dayStart = from + i * DAY_MS;
      const s = db.summary(dayStart, dayStart + DAY_MS);
      days.push({ date: dayStart, active: s.total, productive: s.productive });
    }
    return days;
  });

  ipcMain.handle('seenApps', async () => {
    const cats = db.getCategoryMap();
    const list = db.seenApps().map((r) => ({
      app: r.app,
      duration: r.duration,
      productivity: cats[r.app] || 'neutral',
    }));
    return withIcons(list);
  });

  ipcMain.handle('getCategories', () => db.getCategoryMap());
  ipcMain.handle('setCategory', (_e, { app: a, prod }) => {
    db.setCategory(a, prod);
    return true;
  });

  ipcMain.handle('getSettings', () => db.getSettings());
  ipcMain.handle('setSetting', (_e, { key, value }) => {
    db.setSetting(key, value);
    if (key === 'poll_interval' || key === 'idle_threshold') {
      if (tracker.isRunning()) { tracker.stop(); tracker.start(); }
    }
    if (key === 'launch_at_login') syncLoginItem();
    return true;
  });

  ipcMain.handle('getReminders', () => db.getReminders());
  ipcMain.handle('saveReminder', (_e, r) => db.upsertReminder(r));
  ipcMain.handle('deleteReminder', (_e, id) => { db.deleteReminder(id); return true; });
  ipcMain.handle('testReminder', (_e, id) => { reminders.testFire(id); return true; });

  ipcMain.handle('popoverData', () => {
    const s = db.summary(startOfDay(), startOfDay() + DAY_MS);
    const goal = db.getReminders().find((r) => r.kind === 'goal' && r.enabled);
    return {
      total: s.total,
      productivityPct: s.productivityPct,
      current: tracker.getCurrent(),
      tracking: tracker.isRunning(),
      goalHours: goal ? goal.interval_hours : 8,
      updateReady,
      version: app.getVersion(),
    };
  });
  ipcMain.handle('openDashboard', () => { createWindow(); if (pop) pop.hide(); });
  ipcMain.handle('quit', () => { tracker.stop(); app.quit(); });
  ipcMain.handle('installUpdate', () => {
    if (_autoUpdater && updateReady) { tracker.stop(); _autoUpdater.quitAndInstall(); }
  });

  ipcMain.handle('getTracking', () => tracker.isRunning());
  ipcMain.handle('setTracking', (_e, on) => {
    if (on) { tracker.start(); db.setSetting('tracking', 1); }
    else { tracker.stop(); db.setSetting('tracking', 0); }
    refreshTray();
    return tracker.isRunning();
  });
}

// ---- lifecycle ----------------------------------------------------------

app.whenReady().then(() => {
  db.init();
  registerIpc();
  createTray();

  tracker.onChange((cur) => {
    if (win) win.webContents.send('current', cur);
    refreshTray();
  });

  syncLoginItem();
  checkForUpdates();
  reminders.start();
  if (db.getSettings().tracking !== '0') tracker.start();

  if (process.env.DT_SHOW) {
    createWindow();
    if (win) { win.center(); win.setAlwaysOnTop(true); win.focus(); }
  }
  if (process.env.DT_POP) {
    setTimeout(() => {
      if (!pop) createPopover();
      pop.center();
      pop.show();
      pop.webContents.send('popover:refresh');
      setTimeout(() => {
        pop.webContents.capturePage().then((img) => {
          require('fs').writeFileSync(process.env.DT_POP, img.toPNG());
          require('fs').appendFileSync('/tmp/dt.log', `POP captured ${img.getSize().width}x${img.getSize().height}\n`);
        }).catch((e) => { require('fs').appendFileSync('/tmp/dt.log', 'POP ERR ' + e.message + '\n'); });
      }, 2800);
    }, 1500);
  }
  if (process.env.DT_SHOT && win) {
    setTimeout(async () => {
      win.webContents.capturePage().then((img) => {
        require('fs').writeFileSync(process.env.DT_SHOT, img.toPNG());
      }).catch(() => {});
    }, 3000);
  }

  // Menu-bar app: don't quit when the dashboard window closes.
  app.on('window-all-closed', (e) => { e.preventDefault(); });
  if (app.dock) app.dock.hide();
});

app.on('before-quit', () => tracker.stop());
