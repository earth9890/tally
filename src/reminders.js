'use strict';

// Fires scheduled announcements: daily reminders at a fixed HH:MM (optionally
// weekdays only) and an interval "time chime" every N hours. Each is delivered
// as a macOS notification and, if enabled, spoken aloud with `say`.

const { Notification } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const db = require('./db');

// Bundled sounds (src/assets/sounds). asar can't be read by afplay, so swap in
// the unpacked path when packaged.
const SOUND_DIR = path.join(__dirname, 'assets', 'sounds')
  .replace('app.asar', 'app.asar.unpacked');

// kind/label → bundled mp3
function bundledSound(r) {
  if (r.kind === 'interval') return 'hourly.mp3';
  if (r.kind === 'goal') return 'daily-goal-logout.mp3';
  const l = (r.label || '').toLowerCase();
  if (l.includes('login') || l.includes('start') || l.includes('morning')) return 'goodmorning.mp3';
  if (l.includes('lunch') || l.includes('meal')) return 'lunchbreak.mp3';
  if (l.includes('tea') || l.includes('coffee')) return 'tea-sound.mp3';
  if (l.includes('logout') || l.includes('log out') || l.includes('wrap')) return 'daily-goal-logout.mp3';
  return null;
}

// Returns the mp3 to play for a reminder, or null (voice-only reminder).
function soundFor(r) {
  if (db.getSettings().custom_sounds === '1' && r.sound && fs.existsSync(r.sound)) {
    return r.sound;
  }
  const name = bundledSound(r);
  if (!name) return null;
  const p = path.join(SOUND_DIR, name);
  return fs.existsSync(p) ? p : null;
}

let timer = null;
const firedDaily = new Map();     // id -> 'YYYY-M-D'      (once per day)
const firedInterval = new Map();  // id -> 'YYYY-M-D-H'    (once per hour)

const DAY_MS = 24 * 60 * 60 * 1000;
function dayKey(d) { return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }
function startOfDay() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }

function clockText(d) {
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
}

function renderMessage(r, now) {
  return String(r.message || r.label).replace(/\{time\}/g, clockText(now));
}

function speak(text) {
  if (db.getSettings().announce_voice === '0') return;
  try { execFile('say', [text]); } catch (_) { /* `say` unavailable */ }
}

// Fire a reminder: notification always; then its sound, else the spoken voice
// (not both — overlapping audio is noise).
function fire(r, now = new Date()) {
  const body = renderMessage(r, now);
  try { new Notification({ title: r.label, body, silent: true }).show(); } catch (_) {}
  const snd = soundFor(r);
  if (snd) {
    try { execFile('afplay', [snd]); } catch (_) { speak(body); }
  } else {
    speak(body);
  }
}

function check() {
  const now = new Date();
  const key = dayKey(now);
  const hour = now.getHours();
  const minute = now.getMinutes();
  const weekend = now.getDay() === 0 || now.getDay() === 6;

  for (const r of db.getReminders()) {
    if (!r.enabled) continue;
    if (r.weekdays_only && weekend) continue;

    if (r.kind === 'daily' && r.time) {
      const [h, m] = r.time.split(':').map(Number);
      if (hour === h && minute === m && firedDaily.get(r.id) !== key) {
        firedDaily.set(r.id, key);
        fire(r, now);
      }
    } else if (r.kind === 'interval' && r.interval_hours > 0) {
      const hourKey = `${key}-${hour}`;
      if (minute === 0 && hour % r.interval_hours === 0 && firedInterval.get(r.id) !== hourKey) {
        firedInterval.set(r.id, hourKey);
        fire(r, now);
      }
    } else if (r.kind === 'goal' && r.interval_hours > 0) {
      // Fire once when today's active (non-idle) time reaches the goal.
      if (firedDaily.get(r.id) !== key) {
        const from = startOfDay();
        const active = db.summary(from, from + DAY_MS).total;
        if (active >= r.interval_hours * 3600) {
          firedDaily.set(r.id, key);
          fire(r, now);
        }
      }
    }
  }
}

function start() {
  if (timer) return;
  timer = setInterval(check, 20 * 1000); // 20s: catches the target minute reliably
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

function testFire(id) {
  const r = db.getReminder(id);
  if (r) fire(r);
}

module.exports = { start, stop, testFire };
