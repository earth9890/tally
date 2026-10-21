const { app } = require('electron');
const os = require('os');
const fs = require('fs'), path = require('path');
const assert = require('assert');
const ROOT = path.join(__dirname, '..');
const Database = require(path.join(ROOT, 'node_modules/better-sqlite3'));

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-dbcheck-'));
let fail = 0;
const t = (n, fn) => { try { fn(); console.log('  ok   ' + n); }
                       catch (e) { fail++; console.log('  FAIL ' + n + '\n       ' + e.message); } };

const SCHEMA = `CREATE TABLE segments (id INTEGER PRIMARY KEY, app TEXT NOT NULL, title TEXT,
  url TEXT, start_ts INTEGER NOT NULL, end_ts INTEGER NOT NULL, duration INTEGER NOT NULL,
  idle INTEGER NOT NULL DEFAULT 0);`;

// Run one scenario through the REAL db.init() in its own userData dir.
let n = 0;
function run(rows) {
  const dir = path.join(SB, 'case' + (++n));
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'desktime.db');
  const d = new Database(f);
  d.exec(SCHEMA);
  const ins = d.prepare('INSERT INTO segments (id,app,title,url,start_ts,end_ts,duration,idle) VALUES (?,?,?,?,?,?,?,?)');
  for (const r of rows) ins.run(r.id, r.app, null, null, r.s, r.e, r.d, r.idle || 0);
  d.close();

  app.setPath('userData', dir);
  delete require.cache[require.resolve(path.join(ROOT, 'src/db.js'))];
  require(path.join(ROOT, 'src/db.js')).init();

  const q = new Database(f, { readonly: true });
  const out = q.prepare('SELECT id,app,start_ts s,end_ts e,duration d FROM segments ORDER BY s,id').all();
  q.close();
  return out;
}

const T = 1_000_000_000_000;

app.whenReady().then(async () => {
  t('empty db (fresh install) does not crash', () => {
    assert.deepStrictEqual(run([]), []);
  });

  t('single clean segment survives untouched', () => {
    const o = run([{ id: 1, app: 'Code', s: T, e: T + 60000, d: 60 }]);
    assert.strictEqual(o.length, 1);
    assert.strictEqual(o[0].d, 60);
  });

  t('exact duplicate rows collapse to one', () => {
    const o = run([{ id: 1, app: 'Code', s: T, e: T + 60000, d: 60 },
                   { id: 2, app: 'Code', s: T, e: T + 60000, d: 60 }]);
    assert.strictEqual(o.length, 1, 'expected 1 row, got ' + o.length);
    assert.strictEqual(o[0].d, 60);
  });

  t('corrupt row (end before start) is dropped', () => {
    const o = run([{ id: 1, app: 'X', s: T + 60000, e: T, d: 60 }]);
    assert.strictEqual(o.length, 0);
  });

  t('zero-duration row is dropped', () => {
    const o = run([{ id: 1, app: 'X', s: T, e: T + 60000, d: 0 }]);
    assert.strictEqual(o.length, 0);
  });

  // THE case the eff_end clamp exists for.
  t('nap artifact (2h span, duration 66) does NOT swallow later real segments', () => {
    const o = run([
      { id: 1, app: 'Chrome', s: T,                e: T + 2 * 3600 * 1000, d: 66 }, // phantom
      { id: 2, app: 'Code',   s: T + 10 * 60000,   e: T + 10 * 60000 + 60000, d: 60 },
      { id: 3, app: 'Slack',  s: T + 20 * 60000,   e: T + 20 * 60000 + 60000, d: 60 },
    ]);
    assert.strictEqual(o.length, 3, 'later segments were swallowed: ' + JSON.stringify(o));
    assert.strictEqual(o[0].d, 66, 'phantom should be clamped to its duration');
    assert.strictEqual(o[1].d, 60);
    assert.strictEqual(o[2].d, 60);
  });

  t('the real bug: 3s-apart ticks each spanning 66s collapse to ~3s each', () => {
    const rows = [];
    for (let i = 0; i < 20; i++) rows.push({ id: i + 1, app: 'Chrome', s: T + i * 3000, e: T + i * 3000 + 66000, d: 66 });
    const o = run(rows);
    const total = o.reduce((a, r) => a + r.d, 0);
    const wall = Math.round(((T + 19 * 3000 + 66000) - T) / 1000); // 123s
    assert.ok(Math.abs(total - wall) <= 1, `total ${total}s vs wall ${wall}s`);
  });

  t('idle and active overlap resolves without double-booking', () => {
    const o = run([
      { id: 1, app: 'Idle',   s: T,         e: T + 60000, d: 60, idle: 1 },
      { id: 2, app: 'Chrome', s: T + 30000, e: T + 90000, d: 60 },
    ]);
    const total = o.reduce((a, r) => a + r.d, 0);
    assert.strictEqual(total, 90, 'expected 90s of real time, got ' + total);
  });

  t('identical start_ts ties resolve deterministically', () => {
    const a = run([{ id: 1, app: 'A', s: T, e: T + 60000, d: 60 }, { id: 2, app: 'B', s: T, e: T + 60000, d: 60 }]);
    const b = run([{ id: 1, app: 'A', s: T, e: T + 60000, d: 60 }, { id: 2, app: 'B', s: T, e: T + 60000, d: 60 }]);
    assert.deepStrictEqual(a.map(r => r.app), b.map(r => r.app));
  });

  t('already-clean db is left bit-identical (no needless churn)', () => {
    const rows = [{ id: 1, app: 'A', s: T, e: T + 60000, d: 60 },
                  { id: 2, app: 'B', s: T + 60000, e: T + 120000, d: 60 }];
    const o = run(rows);
    assert.deepStrictEqual(o.map(r => [r.app, r.s, r.e, r.d]),
                           rows.map(r => [r.app, r.s, r.e, r.d]));
  });


  // ---- reclaimActiveAsIdle must stay inside the window it is given --------
  const Database = require(path.join(ROOT, 'node_modules/better-sqlite3'));
  await (async () => {
    const dir = path.join(SB, 'reclaim');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'desktime.db');
    const d0 = new Database(f);
    d0.exec(SCHEMA);
    const ins = d0.prepare('INSERT INTO segments (id,app,title,url,start_ts,end_ts,duration,idle) VALUES (?,?,?,?,?,?,?,?)');
    ins.run(1, 'Code',   null, null, T - 10000, T - 9000, 1, 0);   // before window
    ins.run(2, 'Chrome', null, null, T,          T + 1000, 1, 0);  // inside
    ins.run(3, 'Slack',  null, null, T + 5000,   T + 6000, 1, 0);  // inside
    ins.run(4, 'Future', null, null, T + 99000,  T + 100000, 1, 0);// after window
    d0.close();

    app.setPath('userData', dir);
    delete require.cache[require.resolve(path.join(ROOT, 'src/db.js'))];
    const db = require(path.join(ROOT, 'src/db.js'));
    db.init();
    db.reclaimActiveAsIdle(T, T + 10000);

    const q = new Database(f, { readonly: true });
    const got = Object.fromEntries(q.prepare('SELECT id, idle FROM segments').all().map((r) => [r.id, r.idle]));
    q.close();
    t('reclaim leaves rows before the window alone', () => assert.strictEqual(got[1], 0));
    t('reclaim flips rows inside the window', () => { assert.strictEqual(got[2], 1); assert.strictEqual(got[3], 1); });
    t('reclaim leaves rows after the window alone', () => assert.strictEqual(got[4], 0,
      'an unbounded UPDATE would have eaten this'));
  })();

  console.log(fail ? `\n${fail} FAILED` : '\nall passed');
  app.exit(fail ? 1 : 0);
});
