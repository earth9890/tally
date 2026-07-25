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
  const duration = Math.round((endTs - current.start) / 1000);
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

async function tick() {
  const now = Date.now();
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
    if (win && win.owner && win.owner.name) {
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

  const changed = !current
    || current.app !== sample.app
    || current.title !== sample.title
    || current.url !== sample.url
    || current.idle !== sample.idle;

  const capped = current && (now - current.start) >= MAX_SEGMENT_MS;

  if (changed) {
    flush(now);
    current = { ...sample, start: now };
    emit();
  } else if (capped) {
    flush(now);
    current = { ...sample, start: now };
  }
}

function start() {
  if (timer) return;
  loadConfig();
  timer = setInterval(() => { tick().catch(() => {}); }, cfg.pollMs);
  tick().catch(() => {});
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  flush(Date.now());
  current = null;
  emit();
}

function isRunning() { return timer !== null; }
function getCurrent() { return current; }

module.exports = { start, stop, isRunning, getCurrent, onChange, loadConfig };
