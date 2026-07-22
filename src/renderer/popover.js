'use strict';

const dt = window.api;
const $ = (id) => document.getElementById(id);

let data = { current: null, tracking: false, total: 0, productivityPct: 0, goalHours: 8 };

function fmtDur(sec) {
  sec = Math.round(sec || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${sec}s`;
}
function session() {
  const c = data.current;
  if (!c || c.idle || !c.start) return '00:00';
  const s = Math.max(0, Math.floor((Date.now() - c.start) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function paint() {
  const c = data.current;
  const dot = $('p-dot');
  dot.classList.toggle('live', !!(data.tracking && c && !c.idle));
  dot.classList.toggle('off', !data.tracking);
  $('p-status').textContent = !data.tracking ? 'Paused'
    : c ? (c.idle ? 'Idle' : `Tracking · ${c.app}`) : 'Tracking';
  $('p-timer').textContent = session();
  $('p-total').textContent = fmtDur(data.total);
  $('p-goal').textContent = `Today · goal ${data.goalHours}h`;
  $('p-pct').textContent = `${data.productivityPct}%`;
  const pct = Math.min(100, (data.total / (data.goalHours * 3600)) * 100);
  $('p-bar').style.width = `${pct}%`;
  $('p-pause').textContent = data.tracking ? 'Pause tracking' : 'Resume tracking';

  const uw = $('p-update-wrap');
  uw.hidden = !data.updateReady;
  if (data.updateReady) $('p-update').textContent = `Install v${data.updateReady} & Relaunch`;
  if (data.version) $('p-quit').textContent = `Quit Tally · v${data.version}`;
}

async function refresh() {
  data = await dt.popoverData();
  paint();
}

$('p-open').onclick = () => dt.openDashboard();
$('p-quit').onclick = () => dt.quit();
$('p-update').onclick = () => dt.installUpdate();
$('p-pause').onclick = async () => {
  await dt.setTracking(!data.tracking);
  await refresh();
};

dt.onPopoverRefresh(refresh);
refresh();
setInterval(() => { $('p-timer').textContent = session(); }, 1000);
