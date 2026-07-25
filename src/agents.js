'use strict';

// Agent Watch (off by default): discovers live Claude Code / Codex CLI
// sessions on this machine and announces when a working session finishes,
// i.e. goes back to waiting for input.
//
// Detection is the c9watch-style hybrid:
//   process scan (who is running) -> pid cwd (lsof) -> project transcript dir
//   (~/.claude/projects/<encoded-cwd>/*.jsonl) -> tail-parse the newest
//   transcripts for state.
// State rules for Claude transcripts:
//   last user entry, or last assistant entry containing tool_use  -> working
//   last assistant text entry + file quiet >= 15s                 -> done
// Codex has no parsed tail (beta): fresh rollout file = working, stale = done.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Notification } = require('electron');
const db = require('./db');

const POLL_MS = 5000;
const QUIET_DONE_S = 15;        // assistant tail must be quiet this long
const ACTIVE_WINDOW_MS = 12 * 3600e3; // ignore transcripts older than 12h

let timer = null;
let baseline = true;            // first scan sets state without announcing
let latest = [];                // last computed session list (for the UI)
const cwdCache = new Map();     // pid -> cwd
const states = new Map();       // transcript path -> { state, since }

// ---- process discovery ----------------------------------------------------

function ps() {
  return new Promise((resolve) => {
    execFile('ps', ['-axo', 'pid=,command='], { maxBuffer: 4 * 1024 * 1024 },
      (err, out) => resolve(err ? '' : String(out)));
  });
}

// Interactive sessions only — not daemons, bg hosts, or MCP servers.
function interactivePids(psOut, tool) {
  const pids = [];
  for (const line of psOut.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    const cmd = m[2];
    if (tool === 'claude') {
      if (!/(^|\/)claude(\s|$)/.test(cmd)) continue;
      if (/daemon|bg-pty-host|bg-spare|mcp-server|ClaudeCode\.app/.test(cmd)) continue;
    } else {
      if (!/(^|\/)codex(\s|$)/.test(cmd)) continue;
      if (/mcp-server|extension-host|chrome|plugins\/cache/.test(cmd)) continue;
    }
    pids.push(Number(m[1]));
  }
  return pids;
}

function lsofCwd(pids) {
  return new Promise((resolve) => {
    if (!pids.length) return resolve({});
    execFile('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fn'],
      { maxBuffer: 1024 * 1024 }, (_err, out) => {
        const map = {};
        let pid = null;
        for (const line of String(out || '').split('\n')) {
          if (line[0] === 'p') pid = Number(line.slice(1));
          else if (line[0] === 'n' && pid) map[pid] = line.slice(1);
        }
        resolve(map);
      });
  });
}

// ---- claude transcripts ---------------------------------------------------

function encodeCwd(p) { return p.replace(/[^a-zA-Z0-9]/g, '-'); }

// For each project dir with N live sessions, take its N newest transcripts.
function claudeSessions(cwds) {
  const dirs = new Map(); // dir -> { cwd, count }
  for (const cwd of cwds) {
    const dir = path.join(os.homedir(), '.claude', 'projects', encodeCwd(cwd));
    const e = dirs.get(dir) || { cwd, count: 0 };
    e.count += 1;
    dirs.set(dir, e);
  }
  const out = [];
  for (const [dir, { cwd, count }] of dirs) {
    let files = [];
    try {
      files = fs.readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl') && !f.startsWith('agent-')) // skip subagent transcripts
        .map((f) => { const p = path.join(dir, f); return { p, m: fs.statSync(p).mtimeMs }; })
        .sort((a, b) => b.m - a.m)
        .slice(0, count);
    } catch (_) { continue; }
    const label = cwd === os.homedir() ? '~ (home)' : path.basename(cwd);
    for (const { p, m } of files) {
      if (Date.now() - m > ACTIVE_WINDOW_MS) continue;
      out.push({ tool: 'claude', project: label, file: p, mtime: m });
    }
  }
  return out;
}

// Read the last 64KB and find the last user/assistant entry.
function claudeState(file, mtime) {
  const quiet = (Date.now() - mtime) / 1000;
  let last = null;
  try {
    const fd = fs.openSync(file, 'r');
    const st = fs.fstatSync(fd);
    const size = Math.min(65536, st.size);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, st.size - size);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const e = JSON.parse(lines[i]);
        if (e.type === 'user' || e.type === 'assistant') { last = e; break; }
      } catch (_) { /* partial first line of the 64KB window */ }
    }
  } catch (_) { return 'idle'; }
  if (!last) return 'idle';
  if (last.type === 'user') return 'working'; // Claude is thinking/acting
  const content = last.message && last.message.content;
  const hasTool = Array.isArray(content) && content.some((c) => c && c.type === 'tool_use');
  if (hasTool) return 'working'; // waiting on a tool result
  return quiet >= QUIET_DONE_S ? 'done' : 'working';
}

// ---- codex (beta: mtime only) ---------------------------------------------

function codexSessions(count) {
  const root = path.join(os.homedir(), '.codex', 'sessions');
  let files = [];
  try {
    // sessions/YYYY/MM/DD/rollout-*.jsonl — walk two newest day dirs
    const walk = (dir, depth) => {
      for (const f of fs.readdirSync(dir).sort().reverse().slice(0, 3)) {
        const p = path.join(dir, f);
        const st = fs.statSync(p);
        if (st.isDirectory() && depth < 3) walk(p, depth + 1);
        else if (f.endsWith('.jsonl')) files.push({ p, m: st.mtimeMs });
      }
    };
    walk(root, 0);
  } catch (_) { return []; }
  return files.sort((a, b) => b.m - a.m).slice(0, count)
    .filter(({ m }) => Date.now() - m < ACTIVE_WINDOW_MS)
    .map(({ p, m }) => ({ tool: 'codex', project: 'Codex CLI', file: p, mtime: m }));
}

// ---- announce + tick ------------------------------------------------------

function announce(session) {
  const title = session.tool === 'claude' ? 'Claude is done' : 'Codex is done';
  const body = `${session.project} — finished, waiting for you`;
  try { new Notification({ title, body, silent: true }).show(); } catch (_) {}
  if (db.getSettings().announce_voice !== '0') {
    try { execFile('say', [`${session.tool === 'claude' ? 'Claude' : 'Codex'} is done in ${session.project}`]); } catch (_) {}
  }
}

async function tick() {
  const psOut = await ps();
  const claudePids = interactivePids(psOut, 'claude');
  const codexPids = interactivePids(psOut, 'codex');

  // resolve cwds for new pids only; drop dead pids
  const fresh = claudePids.filter((p) => !cwdCache.has(p));
  const resolved = await lsofCwd(fresh);
  for (const [pid, cwd] of Object.entries(resolved)) cwdCache.set(Number(pid), cwd);
  for (const pid of [...cwdCache.keys()]) if (!claudePids.includes(pid)) cwdCache.delete(pid);

  const cwds = claudePids.map((p) => cwdCache.get(p)).filter(Boolean);
  const sessions = claudeSessions(cwds);
  if (codexPids.length) sessions.push(...codexSessions(codexPids.length));

  const seen = new Set();
  const list = [];
  for (const s of sessions) {
    // refresh mtime — it changes between discovery and state read
    let mtime = s.mtime;
    try { mtime = fs.statSync(s.file).mtimeMs; } catch (_) {}
    const state = s.tool === 'claude'
      ? claudeState(s.file, mtime)
      : ((Date.now() - mtime) / 1000 < QUIET_DONE_S ? 'working' : 'done');

    seen.add(s.file);
    const prev = states.get(s.file);
    if (!prev) {
      states.set(s.file, { state, since: Date.now() });
    } else if (prev.state !== state) {
      if (!baseline && prev.state === 'working' && state === 'done') announce(s);
      prev.state = state;
      prev.since = Date.now();
    }
    list.push({ tool: s.tool, project: s.project, state, since: states.get(s.file).since });
  }
  for (const k of [...states.keys()]) if (!seen.has(k)) states.delete(k);

  baseline = false;
  latest = list.sort((a, b) => (a.state === 'working' ? -1 : 1) - (b.state === 'working' ? -1 : 1));
}

// ---- lifecycle -------------------------------------------------------------

function start() {
  if (timer) return;
  baseline = true;
  states.clear();
  cwdCache.clear();
  timer = setInterval(() => { tick().catch(() => {}); }, POLL_MS);
  tick().catch(() => {});
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  latest = [];
}

function isRunning() { return timer !== null; }
function getSessions() { return latest; }

module.exports = { start, stop, isRunning, getSessions };
