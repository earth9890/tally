'use strict';

const path = require('path');
const { app } = require('electron');
const Database = require('better-sqlite3');

let db;

function init() {
  const file = path.join(app.getPath('userData'), 'desktime.db');
  db = new Database(file);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS segments (
      id       INTEGER PRIMARY KEY,
      app      TEXT NOT NULL,
      title    TEXT,
      url      TEXT,
      start_ts INTEGER NOT NULL,
      end_ts   INTEGER NOT NULL,
      duration INTEGER NOT NULL,
      idle     INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_segments_start ON segments(start_ts);

    CREATE TABLE IF NOT EXISTS categories (
      app          TEXT PRIMARY KEY,
      productivity TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS app_meta (
      app       TEXT PRIMARY KEY,
      bundle_id TEXT,
      path      TEXT
    );

    CREATE TABLE IF NOT EXISTS reminders (
      id             INTEGER PRIMARY KEY,
      kind           TEXT NOT NULL,          -- 'daily' | 'interval'
      label          TEXT NOT NULL,
      message        TEXT,                   -- spoken/shown; interval uses {time}
      time           TEXT,                   -- 'HH:MM' for daily
      interval_hours INTEGER,                -- for interval
      weekdays_only  INTEGER NOT NULL DEFAULT 0,
      enabled        INTEGER NOT NULL DEFAULT 1
    );
  `);

  // Migration: per-reminder custom sound path (added after v0.1.5).
  try { db.exec('ALTER TABLE reminders ADD COLUMN sound TEXT'); } catch (_) { /* exists */ }

  seedDefaults();
  return db;
}

const DEFAULT_CATEGORIES = {
  productive: ['Code', 'Visual Studio Code', 'iTerm2', 'Terminal', 'Xcode',
    'Figma', 'Notion', 'Obsidian', 'IntelliJ IDEA', 'WebStorm', 'PyCharm',
    'Sublime Text', 'Warp', 'Docker Desktop', 'Postman'],
  unproductive: ['YouTube', 'Netflix', 'Spotify', 'Discord', 'Twitter',
    'X', 'Instagram', 'Facebook', 'TikTok', 'Reddit', 'Steam', 'Twitch'],
};

const DEFAULT_SETTINGS = {
  idle_threshold: '300',    // seconds without input -> idle
  poll_interval: '3',       // seconds between samples
  tracking: '1',            // 1 = tracking, 0 = paused
  launch_at_login: '1',     // 1 = start automatically at login (default on)
  announce_voice: '1',      // 1 = speak reminders aloud (macOS `say`)
  custom_sounds: '0',       // 1 = per-reminder custom mp3s can be chosen/used
};

const DEFAULT_REMINDERS = [
  { kind: 'interval', label: 'Hourly time', message: "It's {time}", time: null, interval_hours: 1, weekdays_only: 0, enabled: 1 },
  { kind: 'daily', label: 'Login', message: "Login time — let's start the day", time: '09:00', interval_hours: null, weekdays_only: 1, enabled: 1 },
  { kind: 'daily', label: 'Lunch', message: "Hey, it's lunch time!", time: '13:00', interval_hours: null, weekdays_only: 0, enabled: 1 },
  { kind: 'daily', label: 'Tea', message: "Hey, it's tea time!", time: '16:00', interval_hours: null, weekdays_only: 0, enabled: 1 },
  { kind: 'daily', label: 'Logout', message: "It's logout time — wrap up", time: '18:00', interval_hours: null, weekdays_only: 1, enabled: 1 },
];

function seedDefaults() {
  const insCat = db.prepare(
    'INSERT OR IGNORE INTO categories (app, productivity) VALUES (?, ?)');
  const seed = db.transaction(() => {
    for (const [prod, apps] of Object.entries(DEFAULT_CATEGORIES)) {
      for (const a of apps) insCat.run(a, prod);
    }
  });
  seed();

  const insSet = db.prepare(
    'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSet.run(k, v);

  // Seed reminders once, so user edits/deletions survive restarts.
  if (getSettings().reminders_seeded !== '1') {
    const insRem = db.prepare(`
      INSERT INTO reminders (kind, label, message, time, interval_hours, weekdays_only, enabled)
      VALUES (@kind, @label, @message, @time, @interval_hours, @weekdays_only, @enabled)`);
    const seed = db.transaction(() => { for (const r of DEFAULT_REMINDERS) insRem.run(r); });
    seed();
    setSetting('reminders_seeded', '1');
  }

  // Daily-goal reminder: seeded separately so existing installs get it too.
  // interval_hours holds the goal (fire once when today's active time reaches it).
  if (getSettings().goal_seeded !== '1') {
    db.prepare(`
      INSERT INTO reminders (kind, label, message, time, interval_hours, weekdays_only, enabled)
      VALUES (@kind, @label, @message, @time, @interval_hours, @weekdays_only, @enabled)`).run({
      kind: 'goal', label: 'Daily goal',
      message: "Bro, you're done for the day — please wrap up and log out",
      time: null, interval_hours: 8, weekdays_only: 0, enabled: 1,
    });
    setSetting('goal_seeded', '1');
  }
}

// ---- writes -------------------------------------------------------------

function upsertAppMeta(app, bundleId, appPath) {
  db.prepare(`
    INSERT INTO app_meta (app, bundle_id, path) VALUES (?, ?, ?)
    ON CONFLICT(app) DO UPDATE SET bundle_id = excluded.bundle_id, path = excluded.path
    WHERE app_meta.path IS NOT excluded.path
  `).run(app, bundleId, appPath);
}

function getAppPaths() {
  const rows = db.prepare('SELECT app, path FROM app_meta WHERE path IS NOT NULL').all();
  const map = {};
  for (const r of rows) map[r.app] = r.path;
  return map;
}

// ---- reminders ----------------------------------------------------------

function getReminders() {
  return db.prepare('SELECT * FROM reminders ORDER BY kind DESC, time ASC, id ASC').all();
}

function getReminder(id) {
  return db.prepare('SELECT * FROM reminders WHERE id = ?').get(id);
}

function upsertReminder(r) {
  r.sound = r.sound || null;
  if (r.id) {
    db.prepare(`
      UPDATE reminders SET kind=@kind, label=@label, message=@message, time=@time,
        interval_hours=@interval_hours, weekdays_only=@weekdays_only, enabled=@enabled,
        sound=@sound
      WHERE id=@id`).run(r);
    return r.id;
  }
  const info = db.prepare(`
    INSERT INTO reminders (kind, label, message, time, interval_hours, weekdays_only, enabled, sound)
    VALUES (@kind, @label, @message, @time, @interval_hours, @weekdays_only, @enabled, @sound)`).run(r);
  return info.lastInsertRowid;
}

function deleteReminder(id) {
  db.prepare('DELETE FROM reminders WHERE id = ?').run(id);
}

function insertSegment(seg) {
  db.prepare(`
    INSERT INTO segments (app, title, url, start_ts, end_ts, duration, idle)
    VALUES (@app, @title, @url, @start_ts, @end_ts, @duration, @idle)
  `).run(seg);
}

// ---- settings -----------------------------------------------------------

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

// ---- categories ---------------------------------------------------------

function getCategoryMap() {
  const rows = db.prepare('SELECT app, productivity FROM categories').all();
  const map = {};
  for (const r of rows) map[r.app] = r.productivity;
  return map;
}

function setCategory(appName, productivity) {
  db.prepare(`
    INSERT INTO categories (app, productivity) VALUES (?, ?)
    ON CONFLICT(app) DO UPDATE SET productivity = excluded.productivity
  `).run(appName, productivity);
}

// ---- queries ------------------------------------------------------------

// Aggregate active (non-idle) time per app between [from, to) epoch ms.
function summary(from, to) {
  const cats = getCategoryMap();
  const rows = db.prepare(`
    SELECT app, SUM(duration) AS duration
    FROM segments
    WHERE start_ts >= ? AND start_ts < ? AND idle = 0
    GROUP BY app
    ORDER BY duration DESC
  `).all(from, to);

  const idleRow = db.prepare(`
    SELECT COALESCE(SUM(duration), 0) AS duration
    FROM segments
    WHERE start_ts >= ? AND start_ts < ? AND idle = 1
  `).get(from, to);

  let total = 0, productive = 0, neutral = 0, unproductive = 0;
  const byApp = rows.map((r) => {
    const category = cats[r.app] || 'neutral';
    total += r.duration;
    if (category === 'productive') productive += r.duration;
    else if (category === 'unproductive') unproductive += r.duration;
    else neutral += r.duration;
    return { app: r.app, duration: r.duration, category };
  });

  return {
    total,
    idle: idleRow.duration,
    productive,
    neutral,
    unproductive,
    productivityPct: total ? Math.round((productive / total) * 100) : 0,
    byApp,
  };
}

// Raw segments for a day (for timeline).
function segmentsBetween(from, to) {
  return db.prepare(`
    SELECT app, title, url, start_ts, end_ts, duration, idle
    FROM segments
    WHERE start_ts >= ? AND start_ts < ?
    ORDER BY start_ts ASC
  `).all(from, to);
}

// Per-day active totals for the last N days (for week chart).
function dailyTotals(from, to) {
  return db.prepare(`
    SELECT start_ts, duration, idle FROM segments
    WHERE start_ts >= ? AND start_ts < ?
  `).all(from, to);
}

// Distinct apps seen (for the categories editor).
function seenApps() {
  return db.prepare(`
    SELECT app, SUM(duration) AS duration
    FROM segments WHERE idle = 0
    GROUP BY app ORDER BY duration DESC
  `).all();
}

module.exports = {
  init,
  insertSegment,
  upsertAppMeta,
  getAppPaths,
  getReminders,
  getReminder,
  upsertReminder,
  deleteReminder,
  getSettings,
  setSetting,
  getCategoryMap,
  setCategory,
  summary,
  segmentsBetween,
  dailyTotals,
  seenApps,
};
