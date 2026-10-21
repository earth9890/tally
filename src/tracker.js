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

// activeWin() shells out to the get-windows Swift helper on every tick, and
// that call is unbounded. On 2026-10-20 it blocked for up to 141s at a stretch
// while Chrome was being driven by automation — long enough that ticks piled up
// and booked the same wall-clock repeatedly. safeTick() stops the pile-up; this
// stops a stall from blanking the timeline. Note it is NOT the browser-URL
// fetch: that needs Screen Recording, and without the grant the helper never
// touches the URL at all — the stall happens on the plain frontmost-window
// query, which blocks on the target app's own main thread.
//
// On timeout we resolve null, which falls through to the existing 'Unknown'
// branch: the idle check already ran, so we know the user was active, just not
// which app. Recording that beats leaving a hole.
//
// The in-flight call is shared rather than re-issued. Without that, timing out
// every poll would spawn a fresh helper process every 3s for the whole stall
// (~47 of them in the 141s case) and make the pressure worse.
// ponytail: no cancellation — an orphaned call resolves into the void, because
// get-windows never exposes the child handle. Harmless; it is one process, and
// the next caller reuses whatever it eventually returns.
const ACTIVE_WIN_TIMEOUT_MS = 2000;

// Kept generic so the self-check can drive it with a fake call instead of a
// real window — see scripts/check-activewin-timeout.js.
function singleFlightWithTimeout(makeCall, timeoutMs) {
  let inflight = null;
  return function () {
    if (!inflight) {
      inflight = makeCall()
        .catch(() => null)                   // one shared promise, so it must never reject
        .finally(() => { inflight = null; });
    }
    let t;
    return Promise.race([
      inflight,
      new Promise((resolve) => { t = setTimeout(() => resolve(null), timeoutMs); }),
    ]).finally(() => clearTimeout(t));
  };
}

const activeWinOrNull = singleFlightWithTimeout(() => activeWin(), ACTIVE_WIN_TIMEOUT_MS);

const MAX_SEGMENT_MS = 60 * 1000; // force-flush a running segment after 60s

let timer = null;
let current = null; // { app, title, url, idle, start }
let cfg = { pollMs: 3000, idleThresholdSec: 300 };
let listeners = [];

// Both are user-editable from the settings pane, so they are clamped at both
// ends. The upper bound on pollMs matters: flush()'s clamp is 60s + 2 polls, so
// an unbounded poll interval would license unbounded segment durations — the
// exact failure the clamp exists to prevent. NaN falls back to the default.
// Pure, so the self-check can cover the bounds and the NaN fallback.
function clampSetting(value, lo, hi, dflt) {
  // Number('') is 0, so an empty setting would clamp to the floor instead of
  // falling back to the default. Treat blank/missing as missing, like the
  // `value || default` this replaced.
  const blank = value === '' || value === null || value === undefined;
  const n = blank ? NaN : Number(value);
  return Math.min(Math.max(Number.isFinite(n) ? n : dflt, lo), hi);
}

function loadConfig() {
  const s = db.getSettings();
  cfg.pollMs = clampSetting(s.poll_interval, 1, 60, 3) * 1000;
  cfg.idleThresholdSec = clampSetting(s.idle_threshold, 30, 3600, 300);
}

function onChange(fn) { listeners.push(fn); }
function emit() { for (const fn of listeners) fn(current); }

// When the clamp bites we are saying the extra span is not attributable, so
// end_ts has to shrink with it. Leaving end_ts at the full span produced rows
// where duration != (end - start), which breaks the timeline invariant and makes
// db.init() re-sweep every segment on the next launch. The discarded span
// becomes an honest gap. Unclamped rows keep the exact endTs, so consecutive
// segments stay contiguous and cannot be nudged into overlapping by rounding.
// Pure, so the self-check can cover the clamp and the backwards-clock case.
function segmentBounds(startTs, endTs, maxSec) {
  const rawSec = Math.round((endTs - startTs) / 1000);
  const duration = Math.min(rawSec, maxSec);
  return { duration, endOut: duration === rawSec ? endTs : startTs + duration * 1000 };
}

function flush(endTs) {
  if (!current) return;
  // Clamp: timers don't fire during sleep, so a wake-up flush can span the
  // whole nap — without this, one segment silently books hours of "work".
  const maxSec = Math.round(MAX_SEGMENT_MS / 1000 + (2 * cfg.pollMs) / 1000);
  const { duration, endOut } = segmentBounds(current.start, endTs, maxSec);
  if (duration >= 1) {
    db.insertSegment({
      app: current.app,
      title: current.title,
      url: current.url,
      start_ts: current.start,
      end_ts: endOut,
      duration,
      idle: current.idle ? 1 : 0,
    });
  }
  current = null;
}

// When the window query times out we know the user is active — the idle check
// runs first and reads system input, which a hung app cannot affect — we just
// cannot see which app. Measured on 2026-10-20: 63 of 67 stalls had Chrome
// frontmost both before and after, so the frontmost app had not changed.
// Carrying the last known app forward is a better answer than 'Unknown'.
//
// Capped, because the assumption decays. The hung query is aimed at the app
// that WAS frontmost, so switching apps mid-stall does not unblock it, and we
// would book the new app's time to the old one. CARRY_FORWARD_MAX_MS bounds
// that to the observed 120s stall plus margin; past it we admit we do not know.
// Once the cap is passed carryStartedAt deliberately stays set, so it reports
// 'Unknown' until a query actually succeeds rather than starting a fresh run.
// ponytail: no 'inferred' column — that is a schema migration to mark a
// heuristic the cap already bounds. Add one if carried time ever needs
// excluding from reports.
const CARRY_FORWARD_MAX_MS = 5 * 60 * 1000;
const winState = { lastKnown: null, carryStartedAt: 0 };

// Pure, so the self-check can drive every branch without a real window.
function resolveSample(win, now, state, maxCarryMs) {
  if (win && win.owner && win.owner.name === 'loginwindow') {
    state.carryStartedAt = 0;               // locked screen is idle, not a stall
    return { app: 'Idle', title: null, url: null, idle: true };
  }
  if (win && win.owner && win.owner.name) {
    const s = {
      app: win.owner.name,
      title: win.title || null,
      url: win.url || null,
      idle: false,
    };
    state.lastKnown = s;
    state.carryStartedAt = 0;
    return s;
  }
  if (state.lastKnown) {
    if (!state.carryStartedAt) state.carryStartedAt = now;
    if (now - state.carryStartedAt < maxCarryMs) return { ...state.lastKnown };
  }
  return { app: 'Unknown', title: null, url: null, idle: false };
}

// Carrying an app forward is only defensible while we are actually sampling.
// Across a sleep or a user pause we stop observing entirely, so whatever was
// frontmost before is worthless — after a 9h sleep it may not even be running.
// Forget it, and a post-wake timeout reports 'Unknown' until a query succeeds.
function forgetWindow(state = winState) {
  state.lastKnown = null;
  state.carryStartedAt = 0;
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
      win = await activeWinOrNull();
    } catch (_) {
      // No focused window, or a transient failure — record as Unknown.
    }
    sample = resolveSample(win, now, winState, CARRY_FORWARD_MAX_MS);
    if (win && win.owner && win.owner.name && win.owner.path) {
      db.upsertAppMeta(win.owner.name, win.owner.bundleId || null, win.owner.path);
    }
  }

  // stop()/pausePolling() may have fired while we were awaiting activeWin().
  // They already flushed and nulled `current`; writing it again here would
  // resurrect a segment with no timer left to close it, and it would leak into
  // the next start().
  if (!timer) return;

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
    if (idleOnset) db.reclaimActiveAsIdle(now - idleSec * 1000, now);
    current = { ...sample, start: now };
    emit();
  } else if (capped) {
    flush(now);
    current = { ...sample, start: now };
  }
}

let ticking = false;

// tick() is async and `activeWin()` can outrun pollMs — see activeWinOrNull()
// for what actually stalls. setInterval fires regardless, so without this guard several ticks
// run concurrently, each holding a `now` captured before its await and each
// writing the shared `current` — producing overlapping segments that book the
// same wall-clock twice. Drop the tick instead of queueing it; the heartbeat
// rule in tick() already closes the gap a slow call leaves behind.
// ponytail: a plain boolean, not a queue — a skipped sample is cheaper than a
// double-counted hour. Revisit only if samples need to be lossless.
function safeTick() {
  if (ticking) return;
  ticking = true;
  tick().catch(() => {}).finally(() => { ticking = false; });
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
  forgetWindow();
}

function resumePolling() {
  if (timer || !wantTracking) return; // already polling, or user paused → stay off
  lastTick = 0;                       // clean restart, no stale-gap heartbeat misfire
  timer = setInterval(safeTick, cfg.pollMs);
  safeTick();
}

function start() {
  if (timer) return;
  loadConfig();
  wantTracking = true;
  lastTick = 0;   // same clean restart resumePolling() does; a stale lastTick
                  // would make the first tick's heartbeat compare against a gap
                  // from the previous run.
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
  timer = setInterval(safeTick, cfg.pollMs);
  safeTick();
}

function stop() {
  wantTracking = false;
  if (timer) { clearInterval(timer); timer = null; }
  flush(Date.now());
  current = null;
  forgetWindow();
  emit();
}

function isRunning() { return timer !== null; }
function getCurrent() { return current; }

module.exports = {
  start, stop, isRunning, getCurrent, onChange, loadConfig,
  singleFlightWithTimeout, resolveSample, forgetWindow,
  clampSetting, segmentBounds,
};
