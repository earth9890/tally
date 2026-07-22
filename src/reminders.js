'use strict';

// Fires scheduled announcements: daily reminders at a fixed HH:MM (optionally
// weekdays only) and an interval "time chime" every N hours. Each is delivered
// as a macOS notification and, if enabled, spoken aloud with `say`.

const { Notification } = require('electron');
const { execFile } = require('child_process');
const db = require('./db');

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

function announce(title, body) {
  try { new Notification({ title, body }).show(); } catch (_) {}
  speak(body);
}

// Fire a reminder immediately (used by the "Test" button and the scheduler).
function fire(r, now = new Date()) {
  announce(r.label, renderMessage(r, now));
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
