// Self-check for the activeWin() stall guard in src/tracker.js.
// Fails if a hanging window query can block a tick, spawn a call per poll, or
// crash the process on rejection.  Run: npx electron scripts/check-activewin-timeout.js
const { app } = require('electron');
const assert = require('assert');
const { singleFlightWithTimeout, resolveSample, forgetWindow,
        clampSetting, segmentBounds } = require('../src/tracker');

let fail = 0;
const t = async (name, fn) => {
  try { await fn(); console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};
const never = () => new Promise(() => {});
const after = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));

app.whenReady().then(async () => {
  process.on('unhandledRejection', (e) => {
    console.log('  FAIL unhandled rejection: ' + e); fail++;
  });

  await t('a fast call passes its result through', async () => {
    const f = singleFlightWithTimeout(async () => ({ owner: { name: 'Code' } }), 2000);
    assert.strictEqual((await f()).owner.name, 'Code');
  });

  await t('a hanging call resolves null at the timeout, not never', async () => {
    const f = singleFlightWithTimeout(never, 150);
    const t0 = Date.now();
    assert.strictEqual(await f(), null);
    const dt = Date.now() - t0;
    assert.ok(dt >= 140 && dt < 600, `took ${dt}ms`);
  });

  await t('a hanging call spawns ONCE across repeated polls', async () => {
    let calls = 0;
    const f = singleFlightWithTimeout(() => { calls++; return never(); }, 60);
    for (let i = 0; i < 6; i++) await f();
    assert.strictEqual(calls, 1, `spawned ${calls} times — would be a process storm`);
  });

  await t('a rejecting call yields null and does not crash', async () => {
    const f = singleFlightWithTimeout(async () => { throw new Error('boom'); }, 500);
    assert.strictEqual(await f(), null);
  });

  await t('recovers: next call runs again once the stall clears', async () => {
    let calls = 0;
    const f = singleFlightWithTimeout(() => { calls++; return after(20, { owner: { name: 'Slack' } }); }, 500);
    assert.strictEqual((await f()).owner.name, 'Slack');
    assert.strictEqual((await f()).owner.name, 'Slack');
    assert.strictEqual(calls, 2, 'should re-issue once the previous call settled');
  });

  await t('a slow-but-finishing call is not cut off early', async () => {
    const f = singleFlightWithTimeout(() => after(100, { owner: { name: 'Terminal' } }), 500);
    assert.strictEqual((await f()).owner.name, 'Terminal');
  });


  // ---- resolveSample: what we record when the query comes back empty -------
  const WIN = (name) => ({ owner: { name }, title: 't', url: null });
  const fresh = () => ({ lastKnown: null, carryStartedAt: 0 });
  const CAP = 1000;

  await t('a real window is recorded as itself', async () => {
    const st = fresh();
    assert.strictEqual(resolveSample(WIN('Code'), 0, st, CAP).app, 'Code');
    assert.strictEqual(st.lastKnown.app, 'Code');
  });

  await t('loginwindow counts as idle, not work', async () => {
    const st = fresh();
    const s = resolveSample(WIN('loginwindow'), 0, st, CAP);
    assert.strictEqual(s.app, 'Idle');
    assert.strictEqual(s.idle, true);
  });

  await t('no window and nothing known yet -> Unknown', async () => {
    assert.strictEqual(resolveSample(null, 0, fresh(), CAP).app, 'Unknown');
  });

  await t('a stall carries the last known app forward', async () => {
    const st = fresh();
    resolveSample(WIN('Google Chrome'), 0, st, CAP);
    assert.strictEqual(resolveSample(null, 100, st, CAP).app, 'Google Chrome');
    assert.strictEqual(resolveSample(null, 500, st, CAP).app, 'Google Chrome');
  });

  await t('carrying stops at the cap', async () => {
    const st = fresh();
    resolveSample(WIN('Google Chrome'), 0, st, CAP);
    resolveSample(null, 100, st, CAP);                       // carry starts at t=100
    assert.strictEqual(resolveSample(null, 1099, st, CAP).app, 'Google Chrome');
    assert.strictEqual(resolveSample(null, 1100, st, CAP).app, 'Unknown');
  });

  await t('past the cap it STAYS Unknown, no fresh carry run', async () => {
    const st = fresh();
    resolveSample(WIN('Google Chrome'), 0, st, CAP);
    resolveSample(null, 100, st, CAP);
    resolveSample(null, 1100, st, CAP);                      // cap passed
    for (const at of [1200, 5000, 50000]) {
      assert.strictEqual(resolveSample(null, at, st, CAP).app, 'Unknown', 'restarted at t=' + at);
    }
  });

  await t('a successful query resets the cap window', async () => {
    const st = fresh();
    resolveSample(WIN('Google Chrome'), 0, st, CAP);
    resolveSample(null, 100, st, CAP);
    resolveSample(WIN('Slack'), 200, st, CAP);               // recovered
    assert.strictEqual(st.carryStartedAt, 0);
    assert.strictEqual(resolveSample(null, 1000, st, CAP).app, 'Slack', 'should carry Slack, fresh budget');
  });

  await t('idle (loginwindow) resets the carry budget', async () => {
    const st = fresh();
    resolveSample(WIN('Code'), 0, st, CAP);
    resolveSample(null, 100, st, CAP);
    resolveSample(WIN('loginwindow'), 200, st, CAP);
    assert.strictEqual(st.carryStartedAt, 0);
  });

  await t('the carried sample is a copy, not the stored object', async () => {
    const st = fresh();
    resolveSample(WIN('Code'), 0, st, CAP);
    const carried = resolveSample(null, 100, st, CAP);
    carried.app = 'MUTATED';
    assert.strictEqual(st.lastKnown.app, 'Code');
  });


  // ---- forgetWindow: carry-forward must not survive sleep or a pause -------
  await t('forgetting the window stops carry-forward', async () => {
    const st = fresh();
    resolveSample(WIN('Google Chrome'), 0, st, CAP);
    assert.strictEqual(resolveSample(null, 10, st, CAP).app, 'Google Chrome');
    forgetWindow(st);                                    // sleep / user pause
    assert.strictEqual(resolveSample(null, 20, st, CAP).app, 'Unknown',
      'carried a 9h-stale app across a sleep');
    assert.strictEqual(st.carryStartedAt, 0);
  });

  // ---- clampSetting: both bounds and the NaN fallback ---------------------
  await t('settings clamp at both ends and survive junk', async () => {
    assert.strictEqual(clampSetting('3', 1, 60, 3), 3);
    assert.strictEqual(clampSetting('0', 1, 60, 3), 1, 'below floor');
    assert.strictEqual(clampSetting('99999', 1, 60, 3), 60, 'above ceiling');
    assert.strictEqual(clampSetting('', 1, 60, 3), 3, 'empty -> default');
    assert.strictEqual(clampSetting('abc', 1, 60, 3), 3, 'NaN -> default');
    assert.strictEqual(clampSetting(undefined, 30, 3600, 300), 300);
    assert.strictEqual(clampSetting('-5', 30, 3600, 300), 30, 'negative -> floor');
  });

  // ---- segmentBounds: duration must always equal the span it reports ------
  await t('an unclamped segment keeps its exact end', async () => {
    const r = segmentBounds(1000, 1000 + 30000, 66);
    assert.strictEqual(r.duration, 30);
    assert.strictEqual(r.endOut, 31000, 'must stay contiguous with the next segment');
  });

  await t('a clamped segment shrinks its end to match duration', async () => {
    const r = segmentBounds(1000, 1000 + 600000, 66);   // 10 min span, 66s cap
    assert.strictEqual(r.duration, 66);
    assert.strictEqual(r.endOut, 1000 + 66000, 'end_ts must follow the clamp');
    assert.strictEqual(Math.round((r.endOut - 1000) / 1000), r.duration,
      'duration != span would trip the timeline invariant');
  });

  await t('clamped end never runs past the real end (no overlap)', async () => {
    const endTs = 1000 + 600000;
    const r = segmentBounds(1000, endTs, 66);
    assert.ok(r.endOut <= endTs, 'would overlap whatever starts next');
  });

  await t('a backwards clock yields a dropped segment, not a corrupt one', async () => {
    const r = segmentBounds(5000, 1000, 66);            // end before start
    assert.ok(r.duration < 1, 'flush() drops it on duration >= 1');
    assert.ok(r.endOut <= 5000);
  });

  await new Promise((r) => setTimeout(r, 300)); // let any late rejection surface
  console.log(fail ? `\n${fail} FAILED` : '\nall passed');
  app.exit(fail ? 1 : 0);
});
