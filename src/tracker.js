'use strict';

// Samples the foreground app every `poll_interval` seconds, groups consecutive
// identical samples into segments, and flushes them to the DB on change,
// on a 60s cap (crash safety + timeline granularity), and on idle transitions.

const { powerMonitor, systemPreferences } = require('electron');
const db = require('./db');

// get-windows is ESM-only and ships a prebuilt Swift binary (no native build).
// Load it lazily from this CommonJS module via dynamic import.
//
// A full call needs macOS Screen Recording permission (to read window title +
// browser URL). Crucially, calling it WITHOUT the permission makes the bundled
// Swift binary raise the system permission prompt and block on it — hanging our
// execFile forever. So we never blind-call: check the permission first.
//   - granted  -> full call (app name + window title + browser URL)
//   - otherwise -> screenRecordingPermission:false (app name + bundleId + path
//                  only, no prompt, no hang) so tracking works immediately.
let _activeWindow = null;
async function activeWin() {
  if (!_activeWindow) {
    const mod = await import('get-windows');
    _activeWindow = mod.activeWindow;
  }
  const granted = systemPreferences.getMediaAccessStatus('screen') === 'granted';
  return _activeWindow(granted ? undefined : { screenRecordingPermission: false });
}

const MAX_SEGMENT_MS = 60 * 1000; // force-flush a running segment after 60s

let timer = null;
let current = null; // { app, title, url, idle, start }
let cfg = { pollMs: 3000, idleThresholdSec: 300 };
let listeners = [];

function loadConfig() {
  const s = db.getSettings();
  cfg.pollMs = Math.max(1, Number(s.poll_interval || 3)) * 1000;
  cfg.idleThresholdSec = Math.max(30, Number(s.idle_threshold || 300));
}

function onChange(fn) { listeners.push(fn); }
function emit() { for (const fn of listeners) fn(current); }

function flush(endTs) {
  if (!current) return;
  // Clamp: timers don't fire during sleep, so a wake-up flush can span the
  // whole nap — without this, one segment silently books hours of "work".
  const maxSec = Math.round(MAX_SEGMENT_MS / 1000 + (2 * cfg.pollMs) / 1000);
  const duration = Math.min(Math.round((endTs - current.start) / 1000), maxSec);
  if (duration >= 1) {
    db.insertSegment({
      app: current.app,
      title: current.title,
      url: current.url,
      start_ts: current.start,
      end_ts: endTs,
      duration,
      idle: current.idle ? 1 : 0,
    });
  }
  current = null;
}

let lastTick = 0;

async function tick() {
  const now = Date.now();
  // Heartbeat rule (ActivityWatch's pulsetime model): a segment only grows
  // while ticks are actually observed. If ticks stopped for any reason —
  // sleep the event handlers missed, a hang, timer coalescing — close the
  // segment at the last observation instead of spanning the gap.
  if (lastTick && current && now - lastTick > cfg.pollMs * 3 + 2000) {
    flush(lastTick + cfg.pollMs);
    current = null;
  }
  lastTick = now;
  const idleSec = powerMonitor.getSystemIdleTime();
  const isIdle = idleSec >= cfg.idleThresholdSec;

  let sample;
  if (isIdle) {
    sample = { app: 'Idle', title: null, url: null, idle: true };
  } else {
    let win = null;
    try {
      win = await activeWin();
    } catch (_) {
      // No focused window, or a transient failure — record as Unknown.
    }
    if (win && win.owner && win.owner.name === 'loginwindow') {
      // Locked screen — that's idle time, not work.
      sample = { app: 'Idle', title: null, url: null, idle: true };
    } else if (win && win.owner && win.owner.name) {
      sample = {
        app: win.owner.name,
        title: win.title || null,
        url: win.url || null,
        idle: false,
      };
      if (win.owner.path) {
        db.upsertAppMeta(win.owner.name, win.owner.bundleId || null, win.owner.path);
      }
    } else {
      sample = { app: 'Unknown', title: null, url: null, idle: false };
    }
  }

  // Idle-onset back-date (ActivityWatch's last-input model): when an active
  // segment flips to idle, the grace between the real last input and now was
  // actually AFK, not work — but ticks kept booking it as active. Reclaim that
  // window so totals don't count away-time as work. `idleSec` is the true time
  // since input, so this self-adjusts and can't eat real work: a manual lock
  // (idleSec ~0) reclaims nothing; a timeout (idleSec ~threshold) reclaims just
  // the grace. Lock/suspend already null `current`, so this only fires on a
  // genuine inactivity timeout.
  const idleOnset = current && !current.idle && sample.idle;

  const changed = !current
    || current.app !== sample.app
    || current.title !== sample.title
    || current.url !== sample.url
    || current.idle !== sample.idle;

  const capped = current && (now - current.start) >= MAX_SEGMENT_MS;

  if (changed) {
    flush(now);
    if (idleOnset) db.reclaimActiveAsIdle(now - idleSec * 1000);
    current = { ...sample, start: now };
    emit();
  } else if (capped) {
    flush(now);
    current = { ...sample, start: now };
  }
}

let powerWired = false;
let wantTracking = false; // user intent — survives sleep pauses, gates auto-resume

// System sleep: stop polling entirely (not just flush). macOS wakes the machine
// for ~30s every ~15 min while asleep (dark wake / Power Nap); if the timer keeps
// running it logs a phantom idle blip on every one. suspend/resume bracket the
// whole sleep — dark wakes fire no resume — so a cleared timer stays dead through
// them and the sleep is simply untracked. Matches Tockler's approach. Idempotent:
// safe against the duplicate suspend/resume events macOS sometimes emits.
function pausePolling() {
  if (timer) { clearInterval(timer); timer = null; }
  flush(Date.now());
  current = null;
}

function resumePolling() {
  if (timer || !wantTracking) return; // already polling, or user paused → stay off
  lastTick = 0;                       // clean restart, no stale-gap heartbeat misfire
  timer = setInterval(() => { tick().catch(() => {}); }, cfg.pollMs);
  tick().catch(() => {});
}

function start() {
  if (timer) return;
  loadConfig();
  wantTracking = true;
  if (!powerWired) {
    powerWired = true;
    // Sleep pauses polling; wake (or unlock, as a redundant wake signal) resumes.
    powerMonitor.on('suspend', pausePolling);
    powerMonitor.on('resume', resumePolling);
    powerMonitor.on('unlock-screen', resumePolling);
    // Locked but awake is still idle time, not sleep — keep polling, just close
    // the running segment so the lock moment isn't booked to the last app.
    powerMonitor.on('lock-screen', () => { flush(Date.now()); current = null; });
  }
  timer = setInterval(() => { tick().catch(() => {}); }, cfg.pollMs);
  tick().catch(() => {});
}

function stop() {
  wantTracking = false;
  if (timer) { clearInterval(timer); timer = null; }
  flush(Date.now());
  current = null;
  emit();
}

function isRunning() { return timer !== null; }
function getCurrent() { return current; }

module.exports = { start, stop, isRunning, getCurrent, onChange, loadConfig };
