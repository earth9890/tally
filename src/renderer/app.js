'use strict';

const dt = window.api;
const PALETTE = ['#f59e0b', '#00ac96', '#8b7cf6', '#f2765f', '#2f9e44'];

// ---- formatting ---------------------------------------------------------

function fmt(sec) {
  sec = Math.round(sec || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${sec}s`;
}
function hms(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function hhmm(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const $ = (id) => document.getElementById(id);

function icon(a) {
  if (a.icon) return `<img class="ico" src="${a.icon}" alt="" />`;
  return `<span class="ico fallback">${esc((a.app || '?').charAt(0).toUpperCase())}</span>`;
}

// ---- nav ----------------------------------------------------------------

document.querySelectorAll('.nav button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.nav button').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    $(b.dataset.tab).classList.add('active');
    load(b.dataset.tab);
  });
});

function load(tab) {
  ({ dashboard: loadDashboard, history: loadHistory, categories: loadCategories, reminders: loadReminders, settings: loadSettings }[tab])();
}

// ---- dashboard ----------------------------------------------------------

async function loadDashboard() {
  const s = await dt.summary('today');
  $('d-total').textContent = fmt(s.total);
  $('d-prod').textContent = `${s.productivityPct}%`;
  $('d-idle').textContent = fmt(s.idle);
  const apps = s.byApp.filter((a) => a.app !== 'Unknown');
  $('d-apps-n').textContent = apps.length;

  const nowApp = s.current ? (s.current.idle ? 'Idle' : s.current.app) : '—';
  $('d-now-app').textContent = nowApp;
  $('d-now-sub').textContent = s.current && !s.current.idle && s.current.url ? s.current.url
    : (s.current && !s.current.idle && s.current.title ? s.current.title : 'Foreground app');

  drawDonut(s);
  drawUsage(apps);
  drawWeek(await dt.week());
  $('content').scrollTop = 0;
}

function drawDonut(s) {
  const parts = [
    ['Productive', s.productive, 'var(--accent)'],
    ['Neutral', s.neutral, 'var(--subtle)'],
    ['Unproductive', s.unproductive, 'var(--coral)'],
  ];
  const total = s.productive + s.neutral + s.unproductive;
  const C = 2 * Math.PI * 52;
  let cum = 0;
  $('donut-segs').innerHTML = parts.map(([, v, color]) => {
    if (!total || !v) return '';
    const seg = (v / total) * C;
    const el = `<circle cx="70" cy="70" r="52" fill="none" stroke="${color}" stroke-width="16" stroke-dasharray="${seg.toFixed(1)} ${(C - seg).toFixed(1)}" stroke-dashoffset="${(-cum).toFixed(1)}"/>`;
    cum += seg;
    return el;
  }).join('');
  $('donut-total').textContent = total ? (total / 3600).toFixed(1) + 'h' : '0h';
  $('donut-legend').innerHTML = parts.map(([label, v, color]) =>
    `<div class="row"><span class="sw" style="background:${color}"></span><span class="nm">${label}</span><span class="vl">${fmt(v)}</span></div>`).join('');
}

function drawUsage(apps) {
  const box = $('d-apps');
  const empty = $('d-empty');
  const list = apps.slice(0, 8);
  empty.hidden = list.length > 0;
  box.hidden = list.length === 0;
  const total = list.reduce((t, a) => t + a.duration, 0) || 1;
  box.innerHTML = list.map((a, i) => {
    const pct = Math.round((a.duration / total) * 100);
    const color = PALETTE[i % PALETTE.length];
    return `<div class="u">
      <div class="top">
        <span class="nm">${icon(a)}<span>${esc(a.app)}</span></span>
        <span class="tm">${fmt(a.duration)} · ${pct}%</span>
      </div>
      <div class="bar"><i style="width:${Math.max(3, pct)}%;background:${color}"></i></div>
    </div>`;
  }).join('');
}

function drawWeek(days) {
  const max = Math.max(1, ...days.map((d) => d.active));
  const totalH = days.reduce((t, d) => t + d.active, 0) / 3600;
  $('week-sub').textContent = totalH ? `${totalH.toFixed(1)}h tracked · amber = productive` : '';
  $('weekChart').innerHTML = days.map((d, i) => {
    const colH = (d.active / max) * 100;
    const prodH = d.active ? (d.productive / d.active) * 100 : 0;
    const isToday = i === days.length - 1;
    const hrs = d.active / 3600;
    const lbl = new Date(d.date).toLocaleDateString(undefined, { weekday: 'short' });
    return `<div class="bar ${isToday ? 'today' : ''}">
      <span class="val">${hrs >= 0.1 ? hrs.toFixed(1) : ''}</span>
      <span class="col" style="height:0%" data-h="${colH}"><i class="prod" style="height:${prodH}%"></i></span>
      <span class="lbl">${lbl}</span>
    </div>`;
  }).join('');
  requestAnimationFrame(() => {
    document.querySelectorAll('.week .col').forEach((c) => { c.style.height = `${c.dataset.h}%`; });
  });
}

// ---- timeline (history) -------------------------------------------------

function toDateInput(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function loadHistory() {
  const el = $('h-date');
  if (!el.value) el.value = toDateInput(Date.now());
  await renderHistory();
  el.onchange = renderHistory;
}

async function renderHistory() {
  const [y, m, d] = $('h-date').value.split('-').map(Number);
  const dayStart = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  const segs = await dt.timeline(dayStart);
  const cats = await dt.getCategories();

  const DAY = 24 * 3600 * 1000;
  let active = 0, idle = 0;
  $('timeline').innerHTML = segs.map((seg) => {
    const category = seg.idle ? 'idle' : (cats[seg.app] || 'neutral');
    if (seg.idle) idle += seg.duration; else active += seg.duration;
    const w = (seg.duration * 1000 / DAY) * 100;
    return `<span class="seg ${category}" style="width:${w}%" title="${esc(hhmm(seg.start_ts) + '  ' + seg.app + '  ' + fmt(seg.duration))}"></span>`;
  }).join('');
  $('h-summary').textContent = segs.length ? `Active ${fmt(active)} · Idle ${fmt(idle)} · ${segs.length} segments` : 'No activity this day.';

  $('h-segments').innerHTML = segs.slice().reverse().map((seg) => `
    <div class="r">
      <span class="time">${hhmm(seg.start_ts)}</span>
      <span class="dur">${fmt(seg.duration)}</span>
      <span class="app">${esc(seg.app)}</span>
      <span class="sub">${esc(seg.url || seg.title || '')}</span>
    </div>`).join('');
}

// ---- apps / categories --------------------------------------------------

async function loadCategories() {
  const apps = (await dt.seenApps()).filter((a) => a.app !== 'Idle' && a.app !== 'Unknown');
  const box = $('cat-rows');
  box.innerHTML = apps.map((a) => {
    const opts = ['productive', 'neutral', 'unproductive']
      .map((p) => `<option value="${p}" ${p === a.productivity ? 'selected' : ''}>${p}</option>`).join('');
    return `<div class="approw">
      <div class="ai">${icon(a)}<span>${esc(a.app)}</span></div>
      <span class="at">${fmt(a.duration)}</span>
      <select class="catpill cat-${a.productivity}" data-app="${esc(a.app)}">${opts}</select>
    </div>`;
  }).join('') || '<p class="empty" style="padding:22px">No apps tracked yet.</p>';
  box.querySelectorAll('select').forEach((sel) => {
    sel.onchange = () => {
      sel.className = `catpill cat-${sel.value}`;
      dt.setCategory(sel.dataset.app, sel.value);
    };
  });
}

// ---- reminders ----------------------------------------------------------

const ICONS = {
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  lunch: '<path d="M3 11h18"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M9 3.5V6M12 2.5V6M15 3.5V6"/>',
  tea: '<path d="M17 8h1a4 4 0 1 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"/><line x1="6" y1="2" x2="6" y2="4.5"/><line x1="10" y1="2" x2="10" y2="4.5"/><line x1="14" y1="2" x2="14" y2="4.5"/>',
  goal: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.3 2.3L15.5 9.5"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
};
function remIconKey(r) {
  if (r.kind === 'interval') return 'clock';
  if (r.kind === 'goal') return 'goal';
  const l = (r.label || '').toLowerCase();
  if (l.includes('login') || l.includes('start')) return 'login';
  if (l.includes('logout') || l.includes('log out') || l.includes('leave') || l.includes('wrap')) return 'logout';
  if (l.includes('lunch') || l.includes('meal')) return 'lunch';
  if (l.includes('tea') || l.includes('coffee')) return 'tea';
  return 'bell';
}
function remIcon(r) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[remIconKey(r)]}</svg>`;
}

async function loadReminders() {
  const s = await dt.getSettings();
  const speak = $('r-speak');
  speak.setAttribute('aria-checked', String(s.announce_voice !== '0'));
  speak.onclick = () => {
    const on = speak.getAttribute('aria-checked') !== 'true';
    speak.setAttribute('aria-checked', String(on));
    dt.setSetting('announce_voice', on ? '1' : '0');
  };

  const list = await dt.getReminders();
  const box = $('rem-rows');
  box.innerHTML = list.map(remRow).join('');
  box.querySelectorAll('.rem').forEach(wireRow);

  $('rem-add').onclick = async () => {
    await dt.saveReminder({ kind: 'daily', label: 'New reminder', message: 'Reminder', time: '12:00', interval_hours: null, weekdays_only: 0, enabled: 1 });
    loadReminders();
  };
}

function remRow(r) {
  let when;
  if (r.kind === 'interval') {
    when = `<span class="when">Every <input type="number" class="ivl" min="1" max="24" value="${r.interval_hours || 1}" /> hours</span>`;
  } else if (r.kind === 'goal') {
    when = `<span class="when">After <input type="number" class="ivl" min="1" max="16" value="${r.interval_hours || 8}" /> h worked</span>`;
  } else {
    when = `<span class="when"><input type="time" class="time" value="${esc(r.time || '12:00')}" /><label class="wkl"><input type="checkbox" class="wk" ${r.weekdays_only ? 'checked' : ''}/><span>Mon–Fri</span></label></span>`;
  }
  return `<div class="rem" data-id="${r.id}" data-kind="${r.kind}" data-enabled="${r.enabled ? 1 : 0}">
    <button type="button" class="switch en" role="switch" aria-checked="${r.enabled ? 'true' : 'false'}"><span></span></button>
    <span class="ricon">${remIcon(r)}</span>
    <div class="rbody">
      <div class="rtop"><input class="label" value="${esc(r.label)}" />${when}</div>
      <input class="msg" value="${esc(r.message || '')}" placeholder="Message${r.kind === 'interval' ? ' — use {time}' : ''}" />
    </div>
    <div class="ractions">
      <button type="button" class="test" title="Preview now">Test</button>
      <button type="button" class="del" title="Delete">✕</button>
    </div>
  </div>`;
}

function wireRow(el) {
  const id = Number(el.dataset.id);
  const kind = el.dataset.kind;
  const en = el.querySelector('.en');
  const gather = () => ({
    id, kind,
    label: el.querySelector('.label').value.trim() || 'Reminder',
    message: el.querySelector('.msg').value,
    time: kind === 'daily' ? el.querySelector('.time').value : null,
    interval_hours: (kind === 'interval' || kind === 'goal') ? Number(el.querySelector('.ivl').value) || 1 : null,
    weekdays_only: kind === 'daily' && el.querySelector('.wk').checked ? 1 : 0,
    enabled: en.getAttribute('aria-checked') === 'true' ? 1 : 0,
  });
  const save = () => dt.saveReminder(gather());
  en.onclick = () => {
    const on = en.getAttribute('aria-checked') !== 'true';
    en.setAttribute('aria-checked', String(on));
    el.dataset.enabled = on ? 1 : 0;
    save();
  };
  el.querySelectorAll('input').forEach((i) => { i.onchange = save; });
  el.querySelector('.test').onclick = async () => { await save(); dt.testReminder(id); };
  el.querySelector('.del').onclick = async () => { await dt.deleteReminder(id); el.remove(); };
}

// ---- settings -----------------------------------------------------------

async function loadSettings() {
  const s = await dt.getSettings();
  $('s-idle').value = s.idle_threshold || 300;
  $('s-poll').value = s.poll_interval || 3;
  const toggle = (el) => { el.onclick = () => el.setAttribute('aria-checked', el.getAttribute('aria-checked') !== 'true'); };
  const sw = $('s-tracking'); const login = $('s-login');
  sw.setAttribute('aria-checked', String(s.tracking !== '0'));
  login.setAttribute('aria-checked', String(s.launch_at_login !== '0'));
  toggle(sw); toggle(login);

  $('s-save').onclick = async () => {
    await dt.setSetting('idle_threshold', $('s-idle').value);
    await dt.setSetting('poll_interval', $('s-poll').value);
    await dt.setSetting('launch_at_login', login.getAttribute('aria-checked') === 'true' ? '1' : '0');
    await dt.setTracking(sw.getAttribute('aria-checked') === 'true');
    $('s-msg').textContent = 'Saved';
    setTimeout(() => { $('s-msg').textContent = ''; }, 1500);
  };
}

// ---- live now-card + topbar --------------------------------------------

let current = null;

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function paintNow() {
  const now = $('now');
  const app = current ? (current.idle ? 'Idle' : current.app) : null;
  $('now-app').textContent = app || 'Paused';
  $('now-clock').textContent = current && current.start && !current.idle
    ? hms((Date.now() - current.start) / 1000) : '00:00:00';
  now.classList.toggle('live', !!(current && !current.idle));
  now.classList.toggle('paused', !current);

  const st = $('tb-status');
  $('tb-status-text').textContent = current ? (current.idle ? 'idle' : 'tracking') : 'paused';
  st.classList.toggle('paused', !current);
  const na = $('d-now-app'); if (na) na.textContent = app || '—';
  $('now-pause').textContent = current ? 'Pause' : 'Resume';
}

dt.onCurrent((cur) => { current = cur; paintNow(); });

$('now-pause').onclick = async () => {
  const wasTracking = !!current;
  await dt.setTracking(!wasTracking);
  if (wasTracking) current = null;
  paintNow();
};

function tickTopbar() {
  $('tb-greet').textContent = greeting();
  $('tb-date').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

// ---- boot ---------------------------------------------------------------

tickTopbar();
dt.summary('today').then((s) => { current = s.current; paintNow(); });
const initialTab = new URLSearchParams(location.search).get('tab') || 'dashboard';
const initBtn = document.querySelector(`.nav button[data-tab="${initialTab}"]`);
if (initialTab !== 'dashboard' && initBtn) initBtn.click(); else load('dashboard');
setInterval(paintNow, 1000);
setInterval(() => { if ($('dashboard').classList.contains('active')) loadDashboard(); }, 15000);
