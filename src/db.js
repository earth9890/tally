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

  // Heal sleep/lock artifacts (pre-0.2.8): lock-screen time recorded as work,
  // and wake-up flushes that booked whole naps into one segment. Idempotent.
  try {
    db.exec("UPDATE segments SET app='Idle', title=NULL, url=NULL, idle=1 WHERE app='loginwindow'");
    // The active-segment cap has always been 60s + poll jitter; anything beyond
    // ~70s is a suspended-timer artifact, not real activity.
    //
    // One-time. Since 0.3.4, flush() derives end_ts from the clamped duration,
    // so no new row can exceed the cap and this has nothing left to heal. Left
    // running on every launch it truncated any legitimately long row to 66 — and
    // the de-overlap sweep then shrank end_ts to match, reopening a gap beneath
    // it. That silently reverted a repair of 53 segments a day after it was made.
    if (getSettings().duration_cap_healed !== '1') {
      db.exec('UPDATE segments SET duration=66 WHERE idle=0 AND duration > 70');
      setSetting('duration_cap_healed', '1');
    }
  } catch (_) { /* best effort */ }

  deOverlapSegments(file);

  seedDefaults();
  return db;
}

// Concurrent tracker ticks (fixed in 0.3.1) could write several segments
// covering the same wall-clock window, so SUM(duration) ran up to ~2x real time.
// Sweep in start order keeping a cursor of the furthest end seen, and clip each
// segment to the part after that cursor. Leaves the timeline a true partition:
// no overlaps, duration == span, and the total can only go down.
//
// eff_end = MIN(end_ts, start_ts + duration*1000) — never trust a span beyond
// its recorded duration. Pre-0.2.8 suspended-timer rows carry a multi-hour span
// with duration=66; without this clamp one phantom span would swallow every
// real segment after it. Runs AFTER the duration=66 heal above, which it relies on.
//
// Probed, not flagged: the EXISTS check is ~7ms on 100k rows, so a stale flag
// can never strand someone on a double-counted timeline. Self-heals instead.
//
// ponytail: first-writer-wins, not smarter attribution — overlapping rows are
// near-identical samples of the same app, so the choice rarely moves a second
// between apps. Revisit only if overlaps start spanning genuinely different apps.
function deOverlapSegments(file) {
  // Dirty if the timeline isn't a partition (overlap) OR a row's span disagrees
  // with its duration. The second half catches pre-0.2.8 nap artifacts, whose
  // end_ts still spans hours while duration was healed to 66 — the timeline drew
  // a 2h bar for 66s of work. The cheap scan goes first so OR short-circuits.
  const probe = db.prepare(`
    SELECT (
      EXISTS(SELECT 1 FROM segments
             WHERE ABS(duration - ROUND((end_ts - start_ts) / 1000.0)) > 0)
      OR EXISTS(SELECT 1 FROM (
             SELECT start_ts, LAG(end_ts) OVER (ORDER BY start_ts, id) pe FROM segments
           ) WHERE pe IS NOT NULL AND start_ts < pe)
    ) AS dirty
  `).get();
  if (!probe || !probe.dirty) return;

  // One keepsake of the pre-migration state. Never overwritten, so the backup
  // always holds the ORIGINAL timeline even if a later launch sweeps again.
  // VACUUM INTO is synchronous and WAL-consistent, unlike copying the file.
  try {
    const bak = file + '.bak-before-deoverlap';
    if (!require('fs').existsSync(bak)) db.prepare('VACUUM INTO ?').run(bak);
  } catch (_) { /* a missing backup must not block the fix */ }

  db.transaction(() => {
    db.exec(`
      CREATE TEMP TABLE clipped (
        id        INTEGER PRIMARY KEY,
        new_start INTEGER NOT NULL,
        new_end   INTEGER NOT NULL
      );

      INSERT INTO clipped (id, new_start, new_end)
      WITH eff AS (
        SELECT id, start_ts, MIN(end_ts, start_ts + duration * 1000) AS eff_end
        FROM segments
      ),
      sw AS (
        SELECT id, start_ts, eff_end,
               MAX(eff_end) OVER (ORDER BY start_ts, id
                                  ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS cur
        FROM eff
      )
      SELECT id, MAX(start_ts, COALESCE(cur, start_ts)), eff_end FROM sw;

      -- Fully swallowed duplicates, zero-duration rows, and start>end corruption
      -- all land here: they describe no time, so dropping them loses nothing.
      DELETE FROM segments WHERE id IN (
        SELECT id FROM clipped WHERE new_end - new_start < 500
      );

      UPDATE segments SET
        start_ts = c.new_start,
        end_ts   = c.new_end,
        duration = CAST(ROUND((c.new_end - c.new_start) / 1000.0) AS INTEGER)
      FROM clipped c
      WHERE c.id = segments.id;

      DROP TABLE clipped;
    `);
  })();
}

const DEFAULT_CATEGORIES = {
  productive: ['Code', 'Visual Studio Code', 'iTerm2', 'Terminal', 'Xcode',
    'Figma', 'Notion', 'Obsidian', 'IntelliJ IDEA', 'WebStorm', 'PyCharm',
    'Sublime Text', 'Warp', 'Docker Desktop', 'Postman'],
  unproductive: ['YouTube', 'Netflix', 'Spotify', 'Discord', 'Twitter',
    'X', 'Instagram', 'Facebook', 'TikTok', 'Reddit', 'Steam', 'Twitch'],
};

const DEFAULT_SETTINGS = {
  idle_threshold: '180',    // seconds without input -> idle (DeskTime/ActivityWatch default)
  poll_interval: '3',       // seconds between samples
  tracking: '1',            // 1 = tracking, 0 = paused
  launch_at_login: '1',     // 1 = start automatically at login (default on)
  announce_voice: '1',      // 1 = speak reminders aloud (macOS `say`)
  custom_sounds: '0',       // 1 = per-reminder custom mp3s can be chosen/used
  agent_watch: '0',         // 1 = watch Claude/Codex sessions, announce when done
  agent_caps: '0',          // 1 = blink caps-lock LED while an agent works (needs agent_watch)
  agent_voice: '0',         // 1 = speak when an agent finishes (needs agent_watch)
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

  // One-time: move installs still on the old 5-min idle default down to the new
  // 3-min default (matches DeskTime/ActivityWatch). Only the exact old value is
  // touched, so a user's custom threshold is never overwritten; the flag makes
  // it run once, so a deliberate 300 set later still sticks.
  if (getSettings().idle_default_180 !== '1') {
    if (getSettings().idle_threshold === '300') setSetting('idle_threshold', '180');
    setSetting('idle_default_180', '1');
  }

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

// Back-date an idle timeout (ActivityWatch's last-input model): the active
// segments logged during the [fromTs, now] inactivity grace were really AFK, so
// flip them to idle and totals stop counting away-time as work. Idle time is
// idle whatever app was frontmost, so normalise to the 'Idle' convention. Only
// touches idle=0 rows at/after fromTs — fromTs = now - real-seconds-since-input,
// so a manual lock (tiny gap) reclaims nothing and real work is never eaten.
// Bounded at both ends. fromTs alone is open-ended, so a bad clock or an
// unexpectedly large idleSec would rewrite arbitrarily far forward. Today the
// heartbeat rule nulls `current` before a stale idleSec can reach here, but that
// is one edit away from not being true, and the blast radius is the whole table.
function reclaimActiveAsIdle(fromTs, toTs) {
  db.prepare(
    "UPDATE segments SET app='Idle', title=NULL, url=NULL, idle=1 "
    + 'WHERE idle=0 AND start_ts >= ? AND start_ts <= ?'
  ).run(fromTs, toTs);
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

// Health counters for the System Check panel. These are the invariants the
// tracker is supposed to maintain: segments never overlap, and a row's duration
// always equals its span. A non-zero count here means time is being
// double-counted or the timeline disagrees with itself. Scoped to the last 7
// days so the query stays cheap on a table with six figures of rows.
function integrity(days = 7) {
  const since = Date.now() - days * 86400000;
  const overlaps = db.prepare(`
    WITH s AS (
      SELECT start_ts, LAG(end_ts) OVER (ORDER BY start_ts, id) pe
      FROM segments WHERE start_ts >= ?
    )
    SELECT COUNT(*) n FROM s WHERE pe IS NOT NULL AND start_ts < pe
  `).get(since).n;

  const mismatched = db.prepare(`
    SELECT COUNT(*) n FROM segments
    WHERE start_ts >= ? AND ABS(duration - ROUND((end_ts - start_ts) / 1000.0)) > 0
  `).get(since).n;

  const last = db.prepare('SELECT MAX(end_ts) m FROM segments').get().m;
  const rows = db.prepare('SELECT COUNT(*) n FROM segments').get().n;
  return { overlaps, mismatched, lastSegmentEnd: last || null, rows, days };
}

module.exports = {
  integrity,
  init,
  insertSegment,
  reclaimActiveAsIdle,
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
