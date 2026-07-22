'use strict';

// Renders the Tally brand mark to PNGs used for the app icon and the tray icon.
// Run with: electron scripts/make-icon.js
// Produces build/icon.png (1024, colored squircle) + build/trayTemplate.png
// (monochrome mark for the macOS menu bar).

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const MARK = (stroke, w) => `<svg width="${w}" height="${w}" viewBox="0 0 100 100">
  <g stroke="${stroke}" stroke-width="9" stroke-linecap="round" fill="none">
    <line x1="24" y1="22" x2="24" y2="78"/><line x1="42" y1="22" x2="42" y2="78"/>
    <line x1="60" y1="22" x2="60" y2="78"/><line x1="78" y1="22" x2="78" y2="78"/>
    <line x1="16" y1="80" x2="86" y2="20"/>
  </g></svg>`;

// App icon: 840px honey squircle centered in a 1024 transparent canvas.
const APP_HTML = `<!doctype html><meta charset="utf-8">
<body style="margin:0;width:1024px;height:1024px;background:transparent;display:flex;align-items:center;justify-content:center">
  <div style="width:840px;height:840px;border-radius:200px;
    background:linear-gradient(150deg,#f8b23e 0%,#f59e0b 45%,#dd7008 100%);
    display:flex;align-items:center;justify-content:center;
    box-shadow:inset 0 8px 30px rgba(255,255,255,.25),inset 0 -20px 40px rgba(120,55,0,.25)">
    ${MARK('#fff', 470)}
  </div>
</body>`;

// Tray: black mark on transparent — a macOS "template" image, auto-tinted to
// black on a light menu bar and white on a dark one. Rendered large, resized
// down at runtime.
const TRAY_HTML = `<!doctype html><meta charset="utf-8">
<body style="margin:0;width:128px;height:128px;background:transparent;display:flex;align-items:center;justify-content:center">
  ${MARK('#000', 104)}
</body>`;

async function render(html, w, h, out) {
  const tmp = out + '.tmp.html';
  fs.writeFileSync(tmp, html);
  const win = new BrowserWindow({ width: w, height: h, show: false, frame: false, transparent: true });
  try {
    await win.loadFile(tmp);
    await new Promise((r) => setTimeout(r, 400));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(out, img.toPNG());
    console.log('wrote', out, img.getSize());
  } finally {
    win.destroy();
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

app.whenReady().then(async () => {
  const dir = path.join(__dirname, '..', 'build');
  fs.mkdirSync(dir, { recursive: true });
  const which = process.argv[2] || 'app';
  try {
    if (which === 'tray') await render(TRAY_HTML, 128, 128, path.join(dir, 'trayTemplate.png'));
    else await render(APP_HTML, 1024, 1024, path.join(dir, 'icon.png'));
  } catch (e) {
    console.error('ICONERR', e && e.stack || e);
  }
  app.quit();
});
