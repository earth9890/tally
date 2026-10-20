// Self-check for the activeWin() stall guard in src/tracker.js.
// Fails if a hanging window query can block a tick, spawn a call per poll, or
// crash the process on rejection.  Run: npx electron scripts/check-activewin-timeout.js
const { app } = require('electron');
const assert = require('assert');
const { singleFlightWithTimeout } = require('../src/tracker');

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

  await new Promise((r) => setTimeout(r, 300)); // let any late rejection surface
  console.log(fail ? `\n${fail} FAILED` : '\nall passed');
  app.exit(fail ? 1 : 0);
});
