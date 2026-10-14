/*
 * wingding — acceptance checks for wingding.html
 *
 * Requires Playwright (the Chromium bundled with it) — no other dependency,
 * and the page itself makes zero network requests.
 *
 *   node wingding.qa.mjs                 # run every check
 *   SHOTS=dir node wingding.qa.mjs       # also save screenshots into dir
 *
 * Every input goes through real keyboard (or pointer) events. Most sections
 * stop the page's real-time clock (wingding.manual = true) and advance the
 * fixed-step simulation themselves, so keyed sequences land on exact
 * simulation times and every run is identical. W6 runs on the real clock.
 */
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

// Playwright may be installed locally or globally; find it either way.
const chromium = await (async function () {
  for (const spec of ['playwright', 'playwright-core']) {
    try { return (await import(spec)).chromium; } catch (e) { /* keep looking */ }
  }
  const root = execSync('npm root -g').toString().trim();
  return (await import(pathToFileURL(resolve(root, 'playwright/index.mjs')).href)).chromium;
})();

const FILE = pathToFileURL(resolve(process.argv[2] || 'wingding.html')).href;
const SHOTS = process.env.SHOTS ? resolve(process.env.SHOTS) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const SEED = 1234;

const results = [];
function check(n, ok, i = '') {
  results.push(ok);
  console.log((ok ? 'PASS' : 'FAIL') + ' — ' + n + (i ? '  [' + i + ']' : ''));
}
function section(t) { console.log('\n• ' + t); }
const f2 = (x) => Number(x).toFixed(2);

async function open(browser, opts = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, ...opts });
  const net = [], errs = [];
  page.on('request', r => { if (!r.url().startsWith('file://')) net.push(r.url()); });
  page.on('pageerror', e => errs.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto(FILE);
  await page.waitForTimeout(250);
  return { page, net, errs };
}

// start a session from the title screen with the keyboard, then stop the clock
async function startManual(page, diffKey = 'Digit2', seed = SEED) {
  await page.evaluate((sd) => { wingding.setSeed(sd); }, seed);
  // find the way back to the title from wherever we are
  const state = await page.evaluate(() => wingding.state);
  if (state === 'PLAYING') { await page.keyboard.press('KeyP'); await page.keyboard.press('KeyQ'); }
  else if (state === 'PAUSED') await page.keyboard.press('KeyQ');
  else if (state === 'RESULTS') await page.keyboard.press('Escape');
  await page.keyboard.press(diffKey);
  await page.keyboard.press('Enter');
  await page.evaluate(() => { wingding.manual = true; });
  // the real clock may have run a frame or two between Enter and manual; restart cleanly
  await page.keyboard.press('KeyR');
}

const snap = (page) => page.evaluate(() => {
  const s = wingding.sim;
  return { t: s.t, x: s.x, v: s.v, h: s.h, hd: s.hd, th: s.th, thd: s.thd, phi: s.phi, phid: s.phid,
           lean: s.lean, rollIn: s.rollIn, stamina: s.stamina, flying: s.flying, crash: s.crash && s.crash.reason,
           total: s.total, longest: s.longest, takeoffs: s.takeoffs, crashes: s.crashes, reasons: s.crashReasons.slice(),
           dingCombo: s.ding.combo, pumpCombo: s.pump.combo, dings: s.ding.count, pumps: s.pump.count,
           depth: s.depth, over: s.over, state: wingding.state };
});
const steps = (page, n) => page.evaluate((k) => { wingding.step(k); }, n);

/*
 * Drive the game with the keyboard. `policy(state, mem)` returns the keys that
 * should be held ({ lean: 'KeyW'|'KeyS'|null, roll: 'KeyA'|'KeyD'|null }) and
 * the keys to tap this tick (['Space', 'KeyK']). The driver turns that into
 * keydown/keyup events, then advances the simulation one tick.
 */
async function drive(page, seconds, policy, tick = 0.05, until = null) {
  const C = await page.evaluate(() => ({ dt: wingding.CONFIG.dt }));
  const n = Math.round(tick / C.dt);
  const down = new Set();
  const mem = {};
  let s = await snap(page);
  const trace = [];
  const t0 = s.t;
  while (s.t - t0 < seconds - 1e-9 && s.state === 'PLAYING') {
    const want = policy(s, mem);
    const hold = new Set([want.lean, want.roll].filter(Boolean));
    for (const k of down) if (!hold.has(k)) { await page.keyboard.up(k); down.delete(k); }
    for (const k of hold) if (!down.has(k)) { await page.keyboard.down(k); down.add(k); }
    for (const k of want.tap || []) await page.keyboard.press(k);
    await steps(page, n);
    s = await snap(page);
    trace.push(s);
    if (until && until(s)) break;
  }
  for (const k of down) await page.keyboard.up(k);
  return { s, trace };
}

// the keyboard player used across sections — a decent rider, decisions every 50 ms
function rider(opts = {}) {
  const cruise = opts.cruise ?? 5.6;
  return (s, m) => {
    let lean = null;
    if (s.h <= 0.01) lean = s.v > 2.6 ? 'KeyS' : null;
    else {
      const u = 4 * ((s.h - 0.42) + 0.35 * s.hd) + 1.5 * s.th;
      lean = u > 0.25 ? 'KeyW' : u < -0.25 ? 'KeyS' : null;
    }
    const r = s.phi + 0.45 * s.phid;
    const roll = opts.noRoll ? null : r > 0.02 ? 'KeyA' : r < -0.02 ? 'KeyD' : null;
    const tap = [];
    if ((s.h <= 0.01 || s.v < cruise - 0.8) && s.t - (m.ld ?? -9) >= 0.549) { tap.push('KeyK'); m.ld = s.t; }
    const pint = s.h <= 0.01 ? 0.649 : 0.799;
    if ((s.h <= 0.01 || s.v < cruise) && s.t - (m.lp ?? -9) >= pint && s.stamina > 0.12) { tap.push('Space'); m.lp = s.t; }
    return { lean, roll, tap };
  };
}

const browser = await chromium.launch();

// ---------------------------------------------------------------------------
section('W1 — page, title screen and session shell');
{
  const { page, net, errs } = await open(browser);
  check('loads with no page errors', errs.length === 0, errs.join(' | '));
  check('zero network requests', net.length === 0, net.join(','));
  check('the title screen is the first thing shown', await page.locator('#title').isVisible());
  check('the canvas fills the viewport', await page.evaluate(() => {
    const c = document.getElementById('game');
    return c.clientWidth === innerWidth && c.clientHeight === innerHeight && c.width >= innerWidth;
  }));
  if (SHOTS) await page.screenshot({ path: join(SHOTS, '1-title.png') });

  await page.keyboard.press('KeyW');
  await page.keyboard.press('Space');
  await page.keyboard.press('KeyK');
  await page.waitForTimeout(100);
  check('ride keys on the title do not start a session', await page.evaluate(() => wingding.state) === 'TITLE');

  await page.keyboard.press('Digit3');
  check('3 picks Gnarly', await page.evaluate(() => wingding.diff) === 'gnarly' &&
        await page.locator('[data-diff=gnarly]').getAttribute('aria-pressed') === 'true');
  await page.keyboard.press('Digit1');
  check('1 picks Chill', await page.evaluate(() => wingding.diff) === 'chill' &&
        await page.locator('[data-diff=chill]').getAttribute('aria-pressed') === 'true' &&
        await page.locator('[data-diff=gnarly]').getAttribute('aria-pressed') === 'false');
  await page.keyboard.press('Digit2');

  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  check('Enter starts a session', await page.evaluate(() => wingding.state) === 'PLAYING');
  check('the title closes', await page.locator('#title').isHidden());
  check('the session is on Normal', await page.evaluate(() => wingding.sim.diff) === 'normal');

  // game keys must not scroll or click anything: the page swallows them
  const prevented = await page.evaluate(() => {
    const seen = {};
    const spy = (e) => { seen[e.code] = e.defaultPrevented; };
    window.addEventListener('keydown', spy);
    for (const code of ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyK']) {
      window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true, cancelable: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code, key: code, bubbles: true, cancelable: true }));
    }
    window.removeEventListener('keydown', spy);
    return seen;
  });
  check('Space, arrows and K have their default prevented',
        Object.values(prevented).length === 6 && Object.values(prevented).every(Boolean), JSON.stringify(prevented));

  // pause, resume, restart
  await page.keyboard.press('KeyP');
  check('P pauses', await page.evaluate(() => wingding.state) === 'PAUSED' && await page.locator('#pause').isVisible());
  const tp = await page.evaluate(() => wingding.sim.t);
  await page.waitForTimeout(400);
  check('the clock is frozen while paused', await page.evaluate(() => wingding.sim.t) === tp);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('Esc resumes', await page.evaluate(() => wingding.state) === 'PLAYING' && await page.locator('#pause').isHidden());
  check('the clock runs again', await page.evaluate(() => wingding.sim.t) > tp);
  const before = await page.evaluate(() => wingding.sim.t);
  await page.keyboard.press('KeyR');
  check('R restarts the session', await page.evaluate(() => wingding.sim.t) < before);

  // losing focus mid-ride lets go of every key and pauses
  await page.keyboard.down('KeyS');
  await page.keyboard.down('KeyA');
  check('held keys register', await page.evaluate(() => wingding.held.back && wingding.held.left));
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  check('blur releases every held key', await page.evaluate(() => Object.values(wingding.held).every(v => !v)));
  check('blur pauses', await page.evaluate(() => wingding.state) === 'PAUSED');
  await page.keyboard.up('KeyS');
  await page.keyboard.up('KeyA');
  await page.keyboard.press('KeyQ');
  check('Q on the pause screen quits to the title', await page.evaluate(() => wingding.state) === 'TITLE' &&
        await page.locator('#title').isVisible() && await page.locator('#pause').isHidden());
  check('no page errors', errs.length === 0, errs.join(' | '));
  await page.close();
}

// ---------------------------------------------------------------------------
section('W2 — keys reach the rider (manual clock)');
{
  const { page, errs } = await open(browser);
  await startManual(page);
  let s = await snap(page);
  check('manual mode holds the clock', s.t === 0 && (await page.waitForTimeout(200), (await snap(page)).t === 0));

  await page.keyboard.down('KeyW');
  await steps(page, 60);
  s = await snap(page);
  check('holding W leans forward', s.lean > 0.99, f2(s.lean));
  await page.keyboard.up('KeyW');
  await steps(page, 60);
  s = await snap(page);
  check('letting go of W returns to centre', Math.abs(s.lean) < 1e-9, f2(s.lean));

  await page.keyboard.down('ArrowDown');
  await steps(page, 30);
  s = await snap(page);
  check('ArrowDown leans back', s.lean < -0.7, f2(s.lean));
  await steps(page, 60);
  s = await snap(page);
  check('leaning back on the water lifts the nose', s.th > 0.1, f2(s.th));
  await page.keyboard.up('ArrowDown');

  await page.keyboard.down('ArrowLeft');
  await steps(page, 30);
  s = await snap(page);
  check('ArrowLeft shifts weight left', s.rollIn < -0.99, f2(s.rollIn));
  await page.keyboard.up('ArrowLeft');
  await page.keyboard.down('KeyD');
  await steps(page, 60);
  s = await snap(page);
  check('D shifts weight right', s.rollIn > 0.99, f2(s.rollIn));
  check('the hull keeps the board steady in roll on the water', Math.abs(s.phi) < 0.2, f2(s.phi));
  await page.keyboard.up('KeyD');
  await steps(page, 120);

  // one stroke per press
  await page.keyboard.press('Space');
  check('a Space press queues one board pump', JSON.stringify(await page.evaluate(() => wingding.queued)) === '["pump"]');
  await steps(page, 1);
  s = await snap(page);
  check('the pump happens on the next step', s.pumps === 1 && (await page.evaluate(() => wingding.queued)).length === 0);
  await page.keyboard.press('KeyK');
  await steps(page, 1);
  await page.keyboard.press('ShiftLeft');
  await steps(page, 1);
  s = await snap(page);
  check('K and Shift each ding the wing', s.dings === 2, String(s.dings));

  // holding a pump key: auto-repeat must not pump again
  await steps(page, 120);
  await page.keyboard.down('Space');
  await page.keyboard.down('Space');   // auto-repeat
  await page.keyboard.down('Space');
  await page.keyboard.up('Space');
  await steps(page, 1);
  s = await snap(page);
  check('auto-repeat of a held Space is ignored', s.pumps === 2, String(s.pumps));

  // stroke shape: a ding is a pulse of thrust, not a step
  await steps(page, 120);
  const pulse = await page.evaluate(() => {
    const out = [];
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyK', key: 'k' }));
    for (let i = 0; i < 70; i++) { wingding.step(1); out.push(wingding.sim.dingP); }
    return out;
  });
  const peakAt = pulse.indexOf(Math.max(...pulse));
  check('a ding rises, peaks mid-stroke and ends', pulse[0] < 0.1 && Math.max(...pulse) > 0.99 &&
        peakAt > 20 && peakAt < 30 && pulse[60] === 0, 'peak at step ' + peakAt);
  check('no page errors', errs.length === 0, errs.join(' | '));
  await page.close();
}

// ---------------------------------------------------------------------------
section('W3 — getting up: rhythm beats mashing (keyed sequences)');
{
  const { page, errs } = await open(browser);

  // nothing pressed: the wing alone drifts you along, never up on foil
  await startManual(page);
  let { s } = await drive(page, 12, () => ({ tap: [] }));
  check('with no input the board stays on the water', s.takeoffs === 0 && s.h === 0, 'v ' + f2(s.v));
  check('…drifting slowly under the wing alone', s.v > 0.6 && s.v < 1.6, f2(s.v) + ' m/s');

  // leaning back alone does nothing useful either
  await startManual(page);
  ({ s } = await drive(page, 12, () => ({ lean: 'KeyS', tap: [] })));
  check('leaning back without pumping does not take off', s.takeoffs === 0);

  // a steady keyed rhythm: K every 0.55 s, Space every 0.65 s, lean back once moving
  await startManual(page);
  let up = null;
  const steady = (st, m) => {
    const tap = [];
    if (st.t - (m.k ?? -9) >= 0.549) { tap.push('KeyK'); m.k = st.t; }
    if (st.t - (m.p ?? -9) >= 0.649) { tap.push('Space'); m.p = st.t; }
    if (st.flying && up === null) up = st.t;
    return { lean: st.v > 2.6 ? 'KeyS' : null, tap };
  };
  let r = await drive(page, 12, steady);
  const peakDingCombo = Math.max(...r.trace.map(x => x.dingCombo));
  const peakPumpCombo = Math.max(...r.trace.map(x => x.pumpCombo));
  check('a steady keyed rhythm gets up on foil', r.s.takeoffs >= 1, 'takeoff at ' + (up == null ? 'never' : up.toFixed(2) + ' s'));
  check('…within 4–11 s (it takes some work)', up !== null && up > 4 && up < 11, up && up.toFixed(2) + ' s');
  check('…at a believable takeoff speed (6–9 knots)', (() => {
    const at = r.trace.find(x => x.flying); return at && at.v * 1.944 > 6 && at.v * 1.944 < 9;
  })(), (() => { const at = r.trace.find(x => x.flying); return at ? f2(at.v * 1.944) + ' kn' : '—'; })());
  check('steady wing strokes build the rhythm meter', peakDingCombo === 5, String(peakDingCombo));
  check('steady board strokes build the rhythm meter', peakPumpCombo === 5, String(peakPumpCombo));
  const rhythmV = Math.max(...r.trace.filter(x => x.t < 4).map(x => x.v));

  // mashing the same keys 10× a second
  await startManual(page);
  r = await drive(page, 12, (st) => ({ lean: st.v > 2.6 ? 'KeyS' : null, tap: ['KeyK', 'Space'] }), 0.1);
  const mashV = Math.max(...r.trace.filter(x => x.t < 4).map(x => x.v));
  check('mashing never gets up', r.s.takeoffs === 0, 'v ' + f2(r.s.v));
  check('mashing is slower than rhythm', mashV < rhythmV * 0.75, 'first 4 s: mash ' + f2(mashV) + ' vs rhythm ' + f2(rhythmV) + ' m/s');
  check('mashing builds no rhythm', Math.max(...r.trace.map(x => x.dingCombo)) === 0);
  check('mashing burns stamina', Math.min(...r.trace.map(x => x.stamina)) < 0.3, f2(Math.min(...r.trace.map(x => x.stamina))));
  check('…and the HUD says why', await page.evaluate(() => wingding.warning) !== null,
        String(await page.evaluate(() => wingding.warning)));
  check('no page errors', errs.length === 0, errs.join(' | '));
  await page.close();
}

// ---------------------------------------------------------------------------
section('W4 — balance on the foil: height, pitch and roll');
{
  const { page, errs } = await open(browser);

  // helper: get up on foil with the rider, then hand over to `then`
  async function airborne(diffKey = 'Digit2') {
    await startManual(page, diffKey);
    const { s } = await drive(page, 20, (st, m) => (st.flying && st.h > 0.3 ? { tap: [] } : rider()(st, m)));
    return s;
  }

  let s = await airborne();
  check('the rider gets up and settles at ride height', s.flying && s.h > 0.3, 'h ' + f2(s.h));

  // fly on with the rider for a while: balance holds
  let r = await drive(page, 15, rider());
  check('balanced riding stays up for 15 s', r.trace.every(x => x.flying && !x.crash),
        r.s.reasons.join(',') || 'touched down');
  const hs = r.trace.map(x => x.h);
  check('…in the safe band of the mast', Math.min(...hs) > 0.12 && Math.max(...hs) < 0.72, f2(Math.min(...hs)) + '–' + f2(Math.max(...hs)) + ' m');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, '4-flying.png') });
  check('…keeping roll small', Math.max(...r.trace.map(x => Math.abs(x.phi))) < 0.25,
        f2(Math.max(...r.trace.map(x => Math.abs(x.phi)))) + ' rad');

  // lean back and hold it: the foil climbs out of the water
  r = await drive(page, 6, (st) => ({ lean: 'KeyS', roll: rider()(st, {}).roll, tap: [] }));
  check('holding S climbs until the foil breaches', r.s.reasons.includes('breach'), r.s.reasons.join(','));
  check('…and the HUD warned first', r.trace.some(x => x.flying && x.depth < 0.16));

  // pumping hard with no forward lean: speed raises the nose until it breaches
  await airborne();
  r = await drive(page, 20, (st, m) => {
    const o = rider({ cruise: 99 })(st, m);
    if (o.lean === 'KeyW') o.lean = null;
    return o;
  });
  check('over-pumping without leaning forward breaches', r.s.reasons.includes('breach'), r.s.reasons.join(',') || 'no crash');

  // lean forward gently: it comes down and touches down without a wipeout
  await airborne();
  r = await drive(page, 8, (st, m) => {
    const o = rider()(st, m);
    // feather W on and off: about a third of full lean
    o.lean = st.flying ? (Math.floor(st.t / 0.05) % 3 === 0 ? 'KeyW' : null) : null;
    o.tap = [];
    return o;
  });
  const td = r.trace.find(x => !x.flying);
  check('feathering forward brings it down to a touchdown', td && !td.crash, td ? 'touchdown, no crash' : 'still flying');

  // shove the nose down hard at speed: it catches
  await airborne();
  r = await drive(page, 6, (st, m) => ({ lean: 'KeyW', roll: rider()(st, m).roll, tap: [] }));
  check('holding W at speed nose-dives', r.s.reasons.includes('nosedive'), r.s.reasons.join(',') || 'no crash');

  // let go of roll balance on Normal: it falls over
  await airborne();
  r = await drive(page, 12, rider({ noRoll: true }), 0.05, (x) => x.crash);
  check('without roll balance it rolls over on Normal', r.s.crash === 'roll', r.s.crash || 'no crash');

  // keys pressed while swimming back to the board do nothing
  const crashAt = r.s;
  r = await drive(page, 0.5, () => ({ tap: ['KeyK', 'Space'] }));
  check('strokes are ignored while in the water', r.s.crash && r.s.dings === crashAt.dings && r.s.pumps === crashAt.pumps,
        crashAt.dings + ' → ' + r.s.dings);

  // after a wipeout you are back on the board after the pause
  r = await drive(page, 2, () => ({ tap: [] }));
  check('the rider is back on the board after a wipeout', !r.s.crash && r.s.h === 0 && Math.abs(r.s.phi) < 0.2);

  // Chill's roll assist: the same hands-off roll survives
  await airborne('Digit1');
  r = await drive(page, 12, rider({ noRoll: true }));
  check('Chill steadies roll on its own', !r.s.reasons.includes('roll'), r.s.reasons.join(',') || 'no crash');
  check('no page errors', errs.length === 0, errs.join(' | '));
  await page.close();
}

// ---------------------------------------------------------------------------
section('W5 — a whole session played on the keyboard');
{
  const { page, errs } = await open(browser);
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} wingding.CONFIG.sessionSeconds = 60; });
  await startManual(page);
  const r = await drive(page, 61, rider());
  const s = r.s;
  check('the session ends on time', s.state === 'RESULTS', s.state);
  const res = await page.evaluate(() => wingding.lastResult);
  check('the keyboard rider scores over 250 m in 60 s on Normal', res.score > 250, res.score + ' m');
  check('…with a long flight among them', res.longest > 100, res.longest + ' m');
  check('the results screen shows the score', await page.locator('#results').isVisible() &&
        (await page.locator('#rScore').textContent()) === res.score + ' m');
  check('a first score is a record', res.record && (await page.locator('#resultLine').textContent()).includes('New Normal record'));
  if (SHOTS) await page.screenshot({ path: join(SHOTS, '5-results.png') });
  check('the record is saved', await page.evaluate(() => JSON.parse(localStorage.getItem('wingding.best.v1')).normal) === res.score);
  await page.reload();
  await page.waitForTimeout(200);
  check('the record survives a reload', await page.evaluate(() => wingding.best.normal) === res.score);

  // play again from results, then leave to the title
  await page.evaluate(() => { wingding.CONFIG.sessionSeconds = 1; });
  await page.keyboard.press('Enter');
  await page.evaluate(() => { wingding.manual = true; });
  await steps(page, 130);
  check('a 1 s session ends with no score', await page.evaluate(() => wingding.state) === 'RESULTS' &&
        (await page.evaluate(() => wingding.lastResult)).score === 0);
  check('a worse score is not a record', !(await page.evaluate(() => wingding.lastResult)).record &&
        (await page.evaluate(() => wingding.best.normal)) === res.score);
  await page.keyboard.press('Enter');
  check('Enter rides again from the results', await page.evaluate(() => wingding.state) === 'PLAYING');
  await steps(page, 130);
  await page.keyboard.press('Escape');
  check('Esc on the results goes back to the title', await page.evaluate(() => wingding.state) === 'TITLE' &&
        await page.locator('#title').isVisible());
  check('no page errors', errs.length === 0, errs.join(' | '));
  await page.close();
}

// ---------------------------------------------------------------------------
section('W6 — the real-time loop, with real key timing');
{
  const { page, errs } = await open(browser);
  await page.evaluate((sd) => wingding.setSeed(sd), SEED);
  await page.keyboard.press('Enter');
  const t0 = Date.now();
  // pump in rhythm in real time for ~4 s, leaning back once moving
  let k = 0;
  while (Date.now() - t0 < 4000) {
    await page.keyboard.press(k % 6 < 3 ? 'KeyK' : 'Space');
    if (k === 6) await page.keyboard.down('KeyS');
    k++;
    await page.waitForTimeout(270);
  }
  await page.keyboard.up('KeyS');
  const s = await snap(page);
  const wall = (Date.now() - t0) / 1000;
  check('simulation time tracks the wall clock', Math.abs(s.t - wall) < 0.5, 'sim ' + f2(s.t) + ' s vs wall ' + f2(wall) + ' s');
  check('real-time key presses pump the rig', s.dings >= 6 && s.pumps >= 6, s.dings + ' dings, ' + s.pumps + ' pumps');
  check('…and the board picks up speed', s.v > 2, f2(s.v) + ' m/s');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, '6-riding.png') });

  // the frame actually renders: a varied canvas, not a blank fill
  const colours = await page.evaluate(() => {
    const c = document.getElementById('game');
    const g = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const set = new Set();
    for (let i = 0; i < g.length; i += 4 * 997) set.add((g[i] >> 4) + ',' + (g[i + 1] >> 4) + ',' + (g[i + 2] >> 4));
    return set.size;
  });
  check('the canvas draws a scene', colours > 20, colours + ' colour buckets');
  check('no page errors', errs.length === 0, errs.join(' | '));
  await page.close();
}

// ---------------------------------------------------------------------------
section('W7 — phone: touch pads and a narrow screen');
{
  const { page, errs } = await open(browser, { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  check('touch pads appear on a touch screen', await page.locator('#touch').isVisible());
  check('no horizontal scroll', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.locator('#startBtn').tap();
  await page.evaluate(() => { wingding.manual = true; });
  check('tapping Ride starts', await page.evaluate(() => wingding.state) === 'PLAYING');
  await page.locator('[data-tap=ding]').tap();
  await page.locator('[data-tap=pump]').tap();
  await steps(page, 1);
  const s = await snap(page);
  check('PUMP and DING pads stroke', s.dings === 1 && s.pumps === 1, s.dings + '/' + s.pumps);
  const box = await page.locator('[data-hold=back]').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  check('holding BACK leans back', await page.evaluate(() => wingding.held.back));
  await page.mouse.up();
  check('releasing it lets go', await page.evaluate(() => !wingding.held.back));
  if (SHOTS) {
    await page.evaluate(() => { wingding.manual = false; });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, '7-phone.png') });
  }
  check('no page errors', errs.length === 0, errs.join(' | '));
  await page.close();
}

await browser.close();
const failed = results.filter(function (r) { return !r; }).length;
console.log('\n' + (results.length - failed) + '/' + results.length + ' checks passed');
process.exit(failed ? 1 : 0);
