'use strict';

// Everything Tally needs from macOS, in one place, so the System Check panel can
// show what is actually granted instead of the README telling people to go
// hunting. Each entry reports a status, and where macOS allows it, triggers the
// real prompt rather than only deep-linking to Settings.

const { systemPreferences, app, shell, desktopCapturer, Notification } = require('electron');
const { execFile } = require('child_process');

const PANE = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
  notifications: 'x-apple.systempreferences:com.apple.preference.notifications',
};

// Apple Events have no status API, so the only honest check is to send one and
// read the failure. -1743 is "not authorised". Always time-boxed: this is the
// same class of call that hung the tracker for 120s at a stretch.
//
// The grant is PER TARGET APP, so asking System Events would say nothing about
// whether Chrome's URL can be read — which is the only reason Tally wants this.
// So probe whichever browser is actually running, and report 'unknown' when
// none is, rather than inventing a status.
//
// Caveat: TCC attributes the request to the responsible process. In a packaged
// build that is Tally.app, which is what we want. Running from source it is the
// terminal that launched Electron, so a dev run can report the terminal's grant.
const BROWSERS = ['Google Chrome', 'Brave Browser', 'Microsoft Edge', 'Arc', 'Safari'];

function isRunning(name) {
  return new Promise((resolve) => {
    execFile('/usr/bin/pgrep', ['-x', name], (err) => resolve(!err));
  });
}

async function probeAutomation(timeoutMs = 4000) {
  let target = null;
  for (const b of BROWSERS) {
    if (await isRunning(b)) { target = b; break; }
  }
  if (!target) return 'unknown';   // nothing to ask; do not guess

  return new Promise((resolve) => {
    // `name` is the cheapest property that still needs the grant, so a denial
    // comes back immediately instead of waiting on a real window query.
    const script = `tell application "${target}" to get name`;
    const child = execFile('/usr/bin/osascript', ['-e', script], { timeout: timeoutMs },
      (err, _stdout, stderr) => {
        if (!err) return resolve('granted');
        const msg = String(stderr || err.message || '');
        if (msg.includes('-1743') || /not authori[sz]ed|not allowed|not permitted/i.test(msg)) {
          return resolve('denied');
        }
        return resolve('unknown');    // target quit mid-probe, or timed out
      });
    child.on('error', () => resolve('unknown'));
  });
}

// Screen Recording cannot be requested through an Electron API. Asking
// desktopCapturer for a source is what actually makes macOS raise the prompt;
// if it is already denied the call simply returns nothing, so we follow up by
// opening the pane. Time-boxed for the same reason as above.
async function requestScreen() {
  const withTimeout = (p, ms) =>
    Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
  try {
    await withTimeout(desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }), 4000);
  } catch (_) { /* prompt raised or denied — either way fall through */ }
  if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
    await shell.openExternal(PANE.screen);
  }
}

async function list() {
  const automation = await probeAutomation();
  const login = app.getLoginItemSettings();

  return [
    {
      id: 'screen',
      name: 'Screen Recording',
      status: systemPreferences.getMediaAccessStatus('screen'),
      why: 'Reads the active window title. Without it Tally records app names only.',
      canRequest: true,
      impact: 'required',
    },
    {
      id: 'accessibility',
      name: 'Accessibility',
      status: systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied',
      why: 'Reads which window is frontmost. Tracking is unreliable without it.',
      canRequest: true,
      impact: 'required',
    },
    {
      id: 'automation',
      name: 'Automation (Apple Events)',
      status: automation,
      why: 'Reads the active browser tab URL, for per-site breakdown. Granted per browser. App-level tracking works without it.',
      canRequest: true,
      impact: 'optional',
    },
    {
      id: 'notifications',
      name: 'Notifications',
      // macOS exposes no query API, so claiming a status here would be a guess.
      status: Notification.isSupported() ? 'unknown' : 'denied',
      why: 'Shows reminder alerts. macOS does not let an app read this state, so check it in Settings.',
      canRequest: false,
      impact: 'optional',
    },
    {
      id: 'login',
      name: 'Launch at login',
      status: login.openAtLogin ? 'granted' : 'denied',
      why: 'Starts Tally in the menu bar when you log in. Not a permission — a preference.',
      canRequest: true,
      impact: 'optional',
    },
  ];
}

async function request(id) {
  switch (id) {
    case 'accessibility':
      // The only one macOS lets us prompt for directly.
      systemPreferences.isTrustedAccessibilityClient(true);
      return;
    case 'screen':
      await requestScreen();
      return;
    case 'automation':
      // Sending the event raises the prompt, provided
      // NSAppleEventsUsageDescription is in Info.plist. If it comes back denied
      // the user has refused before, and only Settings can undo that.
      if ((await probeAutomation()) !== 'granted') await shell.openExternal(PANE.automation);
      return;
    case 'login':
      app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
      return;
    default:
      if (PANE[id]) await shell.openExternal(PANE[id]);
  }
}

function openSettings(id) {
  return shell.openExternal(PANE[id] || PANE.screen);
}

module.exports = { list, request, openSettings, probeAutomation };
