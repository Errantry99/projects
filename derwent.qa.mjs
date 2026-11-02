/*
 * derwent — acceptance checks for derwent.html
 *
 * Requires Playwright (the Chromium bundled with it) — no other dependency,
 * and the page itself makes zero network requests.
 *
 *   node derwent.qa.mjs                 # run every check
 *   SHOTS=dir node derwent.qa.mjs       # also save screenshots into dir
 *
 * Every input in the browser goes through real keyboard events. Most sections
 * stop the page's real-time clock (derwent.manual = true) and advance the
 * fixed-step simulation themselves, so keyed sequences land on exact
 * simulation times and every run is identical.
 *
 * D0 also lifts the simulation block out of the page and runs it in node: the
 * physics has no DOM in it, which is what makes it portable (to C++, later).
 */
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

// Playwright may be installed locally or globally; find it either way.
const chromium = await (async function () {
  for (const spec of ['playwright', 'playwright-core']) {
    try { return (await import(spec)).chromium; } catch (e) { /* keep looking */ }
  }
  const root = execSync('npm root -g').toString().trim();
  return (await import(pathToFileURL(resolve(root, 'playwright/index.mjs')).href)).chromium;
})();

const PATH = resolve(process.argv[2] || 'derwent.html');
const FILE = pathToFileURL(PATH).href;
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

// the simulation, headless
const simSrc = readFileSync(PATH, 'utf8').match(/<script id="derwent-sim">([\s\S]*?)<\/script>/)[1];
const Sim = new Function(simSrc + '\nreturn DerwentSim;')();
const C = Sim.CONFIG;

async function open(browser, opts = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, ...opts });
  const net = [], errs = [];
  page.on('request', r => { if (!r.url().startsWith('file://')) net.push(r.url()); });
  page.on('pageerror', e => errs.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto(FILE);
  await page.waitForTimeout(400);
  return { page, net, errs };
}

// start a session from the title screen with the keyboard, then stop the clock
async function startManual(page, eventKey = 'Digit1', condKey = 'Digit4', seed = SEED) {
  await page.evaluate((sd) => { derwent.setSeed(sd); }, seed);
  const state = await page.evaluate(() => derwent.state);
  if (state === 'PLAYING') { await page.keyboard.press('KeyP'); await page.keyboard.press('KeyQ'); }
  else if (state === 'PAUSED') await page.keyboard.press('KeyQ');
  else if (state === 'RESULTS') await page.keyboard.press('Escape');
  await page.keyboard.press(eventKey);
  await page.keyboard.press(condKey);
  await page.keyboard.press('Enter');
  await page.evaluate(() => { derwent.manual = true; });
  // the real clock may have run a frame or two between Enter and manual; restart cleanly
  await page.keyboard.press('KeyR');
}

const snap = (page) => page.evaluate(() => {
  const s = derwent.sim;
  return { t: s.t, e: s.e, n: s.n, psi: s.psi, v: s.v, h: s.h, hdAvg: s.hdAvg, th: s.th, phi: s.phi, phid: s.phid,
           lean: s.lean, rollIn: s.rollIn, stamina: s.stamina, mode: s.mode, popT: s.popT, flying: s.flying,
           crash: s.crash && s.crash.reason, reasons: s.crashReasons.slice(), total: s.total, longest: s.longest,
           takeoffs: s.takeoffs, popups: s.popups, crashes: s.crashes, push: s.push, slope: s.slope,
           paddleCombo: s.paddle.combo, pumpCombo: s.pump.combo, paddles: s.paddle.count, pumps: s.pump.count,
           npk: s.npk, finished: s.finished, over: s.over, elapsed: s.elapsed,
           state: derwent.state, warning: derwent.warning, hint: derwent.hint, cue: derwent.cue };
});
const steps = (page, n) => page.evaluate((k) => { derwent.step(k); }, n);
const secs = (page, t) => page.evaluate((k) => { derwent.seconds(k); }, t);

/*
 * The keyboard rider. `keys(s, mem)` returns what to hold ({ lean: 'KeyW'|'KeyS'|null,
 * roll: 'KeyA'|'KeyD'|null, pop: bool }) and whether to tap Space this tick. The
 * driver turns that into keydown/keyup events, then advances the simulation one tick.
 */
function riderKeys(s, m, g = {}) {
  const out = { lean: null, roll: null, pop: false, tap: false };
  if (s.crash) return out;
  if (s.mode === 'prone') {
    if (s.t - (m.last ?? -9) >= 0.6) { out.tap = true; m.last = s.t; }
    if (s.v >= C.popMinSpeed) { out.pop = true; m.popT = s.t; }
    if (m.steer) out.roll = m.steer(s);
  } else if (s.mode === 'popup') {
    out.pop = s.t - m.popT < 0.35;
  } else {
    if (s.t - (m.last ?? -9) >= 0.55) { out.tap = true; m.last = s.t; }
    if (!s.flying) out.lean = 'KeyS';
    else {
      const x = (s.h + s.hdAvg * 0.35 - 0.3) * 3 + s.th * 9 + s.hdAvg * 0.6;
      out.lean = x > 0.3 ? 'KeyW' : x < -0.3 ? 'KeyS' : null;
    }
    const pa = s.phi + 0.4 * s.phid - (m.phiCmd ? m.phiCmd(s) : 0);
    out.roll = pa > 0.03 ? 'KeyA' : pa < -0.03 ? 'KeyD' : null;
  }
  return out;
}
async function drive(page, seconds, policy, tick = 0.05, until = null) {
  const n = Math.round(tick / C.dt);
  const down = new Set(), mem = {};
  let s = await snap(page);
  for (let t = 0; t < seconds; t += tick) {
    const k = policy(s, mem);
    const want = new Set([k.lean, k.roll, k.pop ? 'KeyE' : null].filter(Boolean));
    for (const key of [...down]) if (!want.has(key)) { await page.keyboard.up(key); down.delete(key); }
    for (const key of want) if (!down.has(key)) { await page.keyboard.down(key); down.add(key); }
    if (k.tap) await page.keyboard.press('Space');
    await steps(page, n);
    s = await snap(page);
    if (s.state !== 'PLAYING' || (until && until(s))) break;
  }
  for (const key of down) await page.keyboard.up(key);
  return s;
}

// ride the headless sim with the same rider (no browser): used for the physics checks
function rideHeadless(ev, cond, seconds, seed = 1, hook = null, g = {}) {
  const s = Sim.newSim(ev, cond, seed), m = {};
  let k = riderKeys(s, m, g);
  for (let i = 0; i < seconds / C.dt && !s.over; i++) {
    if (i % 6 === 0) { k = riderKeys(s, m, g); if (hook) hook(s, m); }
    const lean = k.lean === 'KeyW' ? 1 : k.lean === 'KeyS' ? -1 : 0;
    const roll = k.roll === 'KeyD' ? 1 : k.roll === 'KeyA' ? -1 : 0;
    Sim.stepSim(s, { lean, roll, strokes: i % 6 === 0 && k.tap ? 1 : 0, pop: k.pop }, C.dt);
    s.events.length = 0;
  }
  return s;
}

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

// ---------------------------------------------------------------------------
section('D0 — the simulation runs headless');
{
  check('the sim block has no DOM in it', !/document|window\.|localStorage|requestAnimationFrame/.test(simSrc));
  const a = rideHeadless('practice', 'glassy', 30, 7), b = rideHeadless('practice', 'glassy', 30, 7);
  check('same seed, same inputs, same ride', a.e === b.e && a.n === b.n && a.v === b.v && a.total === b.total, f2(a.total) + ' m');
  const s = Sim.newSim('crossing', 'seabreeze', 1);
  check('a crossing starts on the water, off Sandy Bay', Sim.shoreDist(s.e, s.n) > 20 && Sim.waterDepth(s.e, s.n) > 2,
        Math.round(Sim.shoreDist(s.e, s.n)) + ' m offshore');
  const dist = Math.hypot(Sim.MAP.finishMark[0] - s.n, Sim.MAP.finishMark[1] - s.e);
  check('…about 1.9 km from Bellerive', dist > 1500 && dist < 2300, Math.round(dist) + ' m');
  check('the river already has ferry wake on it', s.npk > 10, s.npk + ' packets');
  const f0 = Sim.ferryAt(0, 0), f1 = Sim.ferryAt(0, Sim.FERRY.cycle / 4 + 10);
  check('the ferry runs between its piers on a timetable', Math.hypot(f0.e - Sim.MAP.ferryA[1], f0.n - Sim.MAP.ferryA[0]) < 1 &&
        f1.running && f1.v > 6, 'v ' + f2(f1.v) + ' m/s mid-crossing');
}

// ---------------------------------------------------------------------------
section('D1 — loads, renders, makes no requests');
{
  const { page, net, errs } = await open(browser);
  await page.waitForTimeout(600);
  check('loads with no page errors', errs.length === 0, errs.join(' | '));
  check('zero network requests', net.length === 0, net.join(','));
  check('the title screen is the first thing shown', await page.locator('#title').isVisible());
  const r = await page.evaluate(() => derwent.render);
  check('WebGL 2 initialises and the shaders compile', r.ok && !r.error, r.error || 'ok');
  check('frames are drawn behind the title', r.frames > 3 && r.drawCalls > 10, r.frames + ' frames, ' + r.drawCalls + ' draws');
  const px = await page.evaluate(() => derwent.probe([[0.5, 0.1], [0.5, 0.95]]));
  const blue = (p) => p[2] > p[0];
  check('water below, sky above (the frame is not blank)', px[0].join() !== px[1].join() && blue(px[0]) && blue(px[1]) && px[1][0] > 20,
        'sky ' + px[1].slice(0, 3).join(',') + ' / water ' + px[0].slice(0, 3).join(','));
  check('the canvases fill the viewport', await page.evaluate(() => {
    const g = document.getElementById('gl').getBoundingClientRect(), h = document.getElementById('hud').getBoundingClientRect();
    return g.width === innerWidth && g.height === innerHeight && h.width === innerWidth && h.height === innerHeight;
  }));
  if (SHOTS) await page.screenshot({ path: join(SHOTS, '1-title.png') });
  await page.close();
}

// ---------------------------------------------------------------------------
section('D2 — menus and keys');
{
  const { page, errs } = await open(browser);
  await page.keyboard.press('Space');
  await page.keyboard.press('KeyW');
  check('ride keys on the title do not start a session', await page.evaluate(() => derwent.state) === 'TITLE');
  await page.keyboard.press('Digit2');
  check('2 picks Ferry Wake', await page.evaluate(() => derwent.event) === 'wake' &&
        await page.locator('[data-event="wake"]').getAttribute('aria-pressed') === 'true');
  await page.keyboard.press('Digit6');
  check('6 picks the westerly', await page.evaluate(() => derwent.cond) === 'westerly');
  await page.keyboard.press('Digit3');
  check('3 picks Paddle-up, on glassy water', await page.evaluate(() => derwent.event + '/' + derwent.cond) === 'practice/glassy');
  await page.keyboard.press('Digit1');
  await page.keyboard.press('Digit5');
  await page.focus('[data-cond="westerly"]');
  await page.keyboard.press('Space');
  check('Tab + Space picks conditions from the keyboard', await page.evaluate(() => derwent.cond) === 'westerly' &&
        await page.evaluate(() => document.activeElement.id) === 'startBtn');
  await page.keyboard.press('Digit5');
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('Enter');
  check('Enter starts a session', await page.evaluate(() => derwent.state) === 'PLAYING');
  check('…the crossing, in the sea breeze', await page.evaluate(() => derwent.sim.event + '/' + derwent.sim.cond) === 'crossing/seabreeze');
  check('you start lying on the board', await page.evaluate(() => derwent.sim.mode) === 'prone');
  check('sound starts with the session', ['running', 'suspended'].includes(await page.evaluate(() => derwent.audio)),
        await page.evaluate(() => derwent.audio));
  const wasMuted = await page.evaluate(() => derwent.muted);
  await page.keyboard.press('KeyM');
  check('M toggles sound, and remembers it', await page.evaluate(() => derwent.muted) === !wasMuted &&
        await page.evaluate(() => localStorage.getItem('derwent.best.v1.muted')) === (!wasMuted ? '1' : '0'));
  await page.keyboard.press('KeyM');
  const prevented = await page.evaluate(() => {
    const out = [];
    for (const code of ['Space', 'ArrowUp', 'ArrowLeft', 'KeyE']) {
      const e = new KeyboardEvent('keydown', { code, cancelable: true, bubbles: true });
      window.dispatchEvent(e); out.push(e.defaultPrevented);
      window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
    }
    return out;
  });
  check('Space, arrows and E have their default prevented', prevented.every(Boolean), prevented.join(','));
  await page.keyboard.press('KeyC');
  check('C switches to the underwater cutaway', await page.evaluate(() => derwent.camera) === 1);
  await page.evaluate(() => derwent.probe([]));
  check('…and the camera is under the surface', await page.evaluate(() => derwent.render.under));
  if (SHOTS) await page.screenshot({ path: join(SHOTS, '2-cutaway.png') });
  await page.keyboard.press('KeyC');
  check('C again: the drone camera', await page.evaluate(() => derwent.camera) === 2);
  await page.keyboard.press('KeyC');
  check('…and back to the chase camera', await page.evaluate(() => derwent.camera) === 0);
  await page.keyboard.press('KeyP');
  const tp = await page.evaluate(() => derwent.sim.t);
  await page.waitForTimeout(250);
  check('P pauses, and the clock is frozen', await page.evaluate(() => derwent.state) === 'PAUSED' &&
        await page.evaluate(() => derwent.sim.t) === tp);
  await page.keyboard.press('Escape');
  const ran = await page.waitForFunction((t) => derwent.sim.t > t, tp, { timeout: 5000 }).then(() => true, () => false);
  check('Esc resumes, and the clock runs again', await page.evaluate(() => derwent.state) === 'PLAYING' && ran);
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => derwent.sim.t);
  await page.keyboard.press('KeyR');
  check('R restarts the session', await page.evaluate(() => derwent.sim.t) < before);
  await page.keyboard.down('KeyS');
  await page.keyboard.down('KeyE');
  check('held keys register', await page.evaluate(() => derwent.held.back && derwent.held.pop));
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  check('blur releases every held key and pauses', await page.evaluate(() => Object.values(derwent.held).every(v => !v)) &&
        await page.evaluate(() => derwent.state) === 'PAUSED');
  await page.keyboard.up('KeyS'); await page.keyboard.up('KeyE');
  await page.keyboard.press('KeyQ');
  check('Q on the pause screen quits to the title', await page.evaluate(() => derwent.state) === 'TITLE' &&
        await page.locator('#title').isVisible());
  check('no page errors', errs.length === 0, errs.join(' | '));
  await page.close();
}

// ---------------------------------------------------------------------------
section('D3 — paddling');
{
  const { page, errs } = await open(browser);
  await startManual(page, 'Digit3', 'Digit4');
  let s = await snap(page);
  check('manual mode holds the clock', s.t === 0 && (await page.waitForTimeout(200), (await snap(page)).t === 0));
  await page.keyboard.press('Space');
  await steps(page, 1);
  s = await snap(page);
  check('a Space press is one paddle stroke', s.paddles === 1, s.paddles + ' strokes');
  let reached = null;
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('Space');
    await secs(page, 0.6);
    s = await snap(page);
    if (reached == null && s.v >= C.popMinSpeed) reached = s.t;
  }
  check('steady strokes every 0.6 s reach pop-up speed', reached != null && reached < 9, reached != null ? f2(reached) + ' s' : 'top ' + f2(s.v) + ' m/s');
  check('…and build a rhythm streak', s.paddleCombo === C.comboMax, 'streak ' + s.paddleCombo);
  check('the coach says when you are fast enough', /Fast enough/.test(s.hint || ''), s.hint);
  check('paddling costs a little stamina', s.stamina < 1 && s.stamina > 0.8, f2(s.stamina));

  await page.keyboard.press('KeyR');
  for (let i = 0; i < 60; i++) { await page.keyboard.press('Space'); await secs(page, 0.2); }
  s = await snap(page);
  check('mashing (every 0.2 s) never reaches pop-up speed', s.v < C.popMinSpeed - 0.3, f2(s.v) + ' m/s');
  check('…and builds no rhythm', s.paddleCombo === 0);

  await page.keyboard.press('KeyR');
  for (let i = 0; i < 14; i++) { await page.keyboard.press('Space'); await secs(page, 0.95); }
  s = await snap(page);
  check('lazy strokes (every 0.95 s) fall short too', s.v < C.popMinSpeed, f2(s.v) + ' m/s');

  await page.keyboard.press('KeyR');
  const psi0 = (await snap(page)).psi;
  await page.keyboard.down('KeyD');
  for (let i = 0; i < 6; i++) { await page.keyboard.press('Space'); await secs(page, 0.6); }
  await page.keyboard.up('KeyD');
  s = await snap(page);
  check('D steers right while paddling', s.psi - psi0 > 0.5, f2(s.psi - psi0) + ' rad');
  check('no page errors', errs.length === 0, errs.join(' | '));
  await page.close();
}

// ---------------------------------------------------------------------------
section('D4 — the pop-up');
{
  const { page, errs } = await open(browser);
  await startManual(page, 'Digit3', 'Digit4');
  async function paddleUp(n) { for (let i = 0; i < n; i++) { await page.keyboard.press('Space'); await secs(page, 0.6); } }

  await paddleUp(12);
  await page.keyboard.down('KeyE');
  await secs(page, 0.08);
  check('holding E gets you to your knees', (await snap(page)).mode === 'popup');
  await page.keyboard.up('KeyE');
  await steps(page, 2);
  let s = await snap(page);
  check('released too soon, you slip off', s.crash === 'slip', s.crash || s.mode);
  await secs(page, C.crashPause + 0.1);
  s = await snap(page);
  check('…and you are back on your belly, to paddle up again', s.mode === 'prone' && !s.crash, s.mode);

  await page.keyboard.press('KeyR');
  await paddleUp(12);
  const v0 = (await snap(page)).v;
  await page.keyboard.down('KeyE');
  await secs(page, 0.35);
  await page.keyboard.up('KeyE');
  await steps(page, 2);
  s = await snap(page);
  check('hold, then release at speed: you stand up', s.mode === 'stand' && s.popups === 1, f2(v0) + ' m/s');
  check('a clean pop-up keeps your speed', s.v > C.popMinSpeed, f2(s.v) + ' m/s');
  check('the coach says to pump and lean back', /pump/i.test(s.hint || ''), s.hint);

  await page.keyboard.press('KeyR');
  await paddleUp(3);
  await page.keyboard.down('KeyE');
  await secs(page, 1.2);
  s = await snap(page);
  check('held too long, you stand up anyway, late', s.mode === 'stand');
  await page.keyboard.up('KeyE');
  await secs(page, 0.4);
  const w = (await snap(page)).warning;
  await secs(page, 2.1);
  s = await snap(page);
  check('the coach warns you are too slow', /Too slow/.test(w || ''), w);
  check('…and the board sinks', s.reasons.includes('sank'), s.reasons.join(',') || s.mode);
  check('no page errors', errs.length === 0, errs.join(' | '));
  await page.close();
}

// ---------------------------------------------------------------------------
section('D5 — pumping onto the foil, and staying up');
{
  const { page, errs } = await open(browser);
  await startManual(page, 'Digit3', 'Digit4');
  let firstWarn = null, breachT = null;
  const s = await drive(page, 60, (st, m) => riderKeys(st, m));
  check('a keyboard rider paddles up, pops up and takes off', s.popups >= 1 && s.takeoffs >= 1, s.popups + ' pop-ups, ' + s.takeoffs + ' takeoffs');
  check('…and pumps along on the foil for 150 m or more', s.total >= 150, Math.round(s.total) + ' m, longest ' + Math.round(s.longest));
  check('every stroke cost stamina, and it shows', s.stamina < 0.95, f2(s.stamina));
  if (SHOTS) {
    await page.evaluate(() => { derwent.manual = false; });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(SHOTS, '5-flying.png') });
    await page.evaluate(() => { derwent.manual = true; });
  }

  // lean back and keep pumping once airborne: the breach warning comes before the breach
  await page.keyboard.press('KeyR');
  const t = await drive(page, 40, (st, m) => {
    const k = riderKeys(st, m);
    if (st.flying && st.v > 3.6) k.lean = 'KeyS';
    if (st.warning && /Too high/.test(st.warning) && firstWarn == null) firstWarn = st.t;
    return k;
  }, 0.05, st => st.crash === 'breach');
  breachT = t.crash === 'breach' ? t.t : null;
  check('leaning back on the foil breaches it', breachT != null, t.reasons.join(',') || 'no breach');
  check('…and "Too high" warns first', firstWarn != null && breachT - firstWarn >= 0.2, firstWarn != null ? f2(breachT - firstWarn) + ' s ahead' : 'no warning');
  check('no page errors', errs.length === 0, errs.join(' | '));
  await page.close();
}

// ---------------------------------------------------------------------------
section('D6 — waves are free energy');
{
  // prone, paddling in rhythm, pointed down the chop: a bump carries you past pop-up speed
  function proneTop(cond) {
    const s = Sim.newSim('practice', cond, 3);
    s.psi = cond === 'westerly' ? Sim.deg(80) : Sim.deg(315);
    let top = 0, last = -9;
    for (let i = 0; i < 25 / C.dt; i++) {
      const tapNow = s.t - last >= 0.6;
      if (tapNow) last = s.t;
      Sim.stepSim(s, { lean: 0.3, roll: 0, strokes: tapNow ? 1 : 0, pop: false }, C.dt);
      s.events.length = 0;
      top = Math.max(top, s.v);
    }
    return top;
  }
  const flat = proneTop('glassy'), sea = proneTop('seabreeze'), west = proneTop('westerly');
  check('paddling flat out on glassy water tops out near pop-up speed', flat > C.popMinSpeed && flat < C.popMinSpeed + 0.3, f2(flat) + ' m/s');
  check('a sea-breeze bump carries you well past it', sea > flat + 0.3, f2(sea) + ' m/s');
  check('so does westerly chop', west > flat + 0.3, f2(west) + ' m/s');

  // the push comes from the face: downhill ahead pushes you on
  const s = Sim.newSim('practice', 'seabreeze', 3);
  s.psi = Sim.deg(315);           // pointed the way the chop runs
  let pos = 0, neg = 0;
  for (let i = 0; i < 6 / C.dt; i++) {
    Sim.stepSim(s, { lean: 0, roll: 0, strokes: 0, pop: false }, C.dt); s.events.length = 0;
    if (s.slope < -0.02) pos += s.push > 0 ? 1 : 0, neg += s.push > 0 ? 0 : 1;
  }
  check('on a face sloping down ahead, gravity pushes you forward', pos > 0 && neg === 0, pos + ' steps');

  // flying with the pumping stopped: glide on flat water, then on the ferry's wake
  function glide(withWave) {
    const g = Sim.newSim('practice', 'glassy', 3), m = {};
    let t0 = null, x0 = 0;
    let k = riderKeys(g, m);
    for (let i = 0; i < 90 / C.dt; i++) {
      if (i % 6 === 0) k = riderKeys(g, m);
      if (t0 === null && g.flying && g.t > 12 && g.h > 0.3 && Math.abs(g.v - 5.7) < 0.4) {
        t0 = g.t; x0 = g.total;
        g.ferries = [];             // just this one wave
        g.packets = [];
        if (withWave) {
          const c = 5.7, kk = C.gravity / (c * c), back = 4;
          // a packet that has already run 1.5 s (so it is at full height), centred `back` m behind you
          const run = c * 1.5;
          g.packets.push({ n0: g.n - Math.cos(g.psi) * (back + run), e0: g.e - Math.sin(g.psi) * (back + run), dn: Math.cos(g.psi), de: Math.sin(g.psi),
                           t0: g.t - 1.5, A0: C.wakeAmp, k: kk, c });
        }
      }
      const lean = k.lean === 'KeyW' ? 1 : k.lean === 'KeyS' ? -1 : 0;
      if (t0 !== null) { k.tap = false; g.phi = 0; g.phid = 0; }
      Sim.stepSim(g, { lean, roll: 0, strokes: i % 6 === 0 && k.tap ? 1 : 0, pop: k.pop }, C.dt);
      g.events.length = 0;
      if (t0 !== null && (!g.flying || g.crash)) return g.total - x0;
    }
    return g.total - x0;
  }
  const gFlat = glide(false), gWake = glide(true);
  check('stop pumping on flat water and you glide a short way', gFlat > 5 && gFlat < 40, f2(gFlat) + ' m');
  check('stop pumping on the ferry wake and you glide 3× as far', gWake > 3 * gFlat, f2(gWake) + ' m');

  // the Ferry Wake event: the cue tells you it's coming
  const { page, errs } = await open(browser);
  await startManual(page, 'Digit2', 'Digit4');
  let cueSeen = null;
  for (let i = 0; i < 60 && !cueSeen; i++) { await secs(page, 0.5); const c = await page.evaluate(() => derwent.cue); if (c && /Ferry wake/.test(c)) cueSeen = c; }
  check('in Ferry Wake, the HUD calls the wake before it arrives', !!cueSeen, cueSeen || 'no cue');
  if (SHOTS) {
    await page.keyboard.press('KeyC'); await page.keyboard.press('KeyC');
    await page.evaluate(() => { derwent.manual = false; });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(SHOTS, '6-wake-drone.png') });
  }
  check('no page errors', errs.length === 0, errs.join(' | '));
  await page.close();
}

// ---------------------------------------------------------------------------
section('D7 — carving');
{
  function carve(dir) {
    let psi0 = null, psi1 = null;
    rideHeadless('practice', 'glassy', 40, 5, (s, m) => {
      if (psi0 == null && s.flying && s.t > 14 && s.v > 4.5) { psi0 = s.psi; m.phiCmd = () => 0.25 * dir; m.t0 = s.t; }
      if (psi0 != null && psi1 == null && s.t - m.t0 > 3) psi1 = s.psi;
    });
    return psi1 == null ? null : Math.atan2(Math.sin(psi1 - psi0), Math.cos(psi1 - psi0));
  }
  const right = carve(1), left = carve(-1);
  check('banking right on the foil carves right', right != null && right > 0.3, right != null ? f2(right) + ' rad in 3 s' : 'never flew');
  check('banking left carves left', left != null && left < -0.3, left != null ? f2(left) + ' rad in 3 s' : 'never flew');
}

// ---------------------------------------------------------------------------
section('D8 — the river');
{
  const { page, errs } = await open(browser);
  await startManual(page, 'Digit1', 'Digit4');
  // put the board in the ferry's path
  await page.evaluate(() => {
    const s = derwent.sim, f = derwent.Sim.ferryAt(s.ferries[0].offset, s.t + 0.3);
    s.e = f.e; s.n = f.n;
  });
  await secs(page, 0.4);
  let s = await snap(page);
  check('the ferry runs you down', s.reasons.includes('ferry'), s.reasons.join(','));
  await secs(page, C.crashPause + 0.2);
  s = await snap(page);
  const f = await page.evaluate(() => { const s = derwent.sim, f = derwent.Sim.ferryAt(s.ferries[0].offset, s.t); return Math.hypot(f.e - s.e, f.n - s.n); });
  check('…and you come up clear of it', !s.crash && f > 10, f2(f) + ' m away');

  // drift into the shallows off Sandy Bay
  await page.keyboard.press('KeyR');
  await page.evaluate(() => {
    const s = derwent.sim, S = derwent.Sim;
    s.e = S.shoreAt(S.MAP.west, s.n) + 30; s.psi = -Math.PI / 2;
  });
  for (let i = 0; i < 16 && !(await snap(page)).reasons.includes('grounded'); i++) { await page.keyboard.press('Space'); await secs(page, 0.6); }
  await secs(page, C.crashPause + 0.2);
  s = await snap(page);
  check('the foil hits the bottom near the shore', s.reasons.includes('grounded'), s.reasons.join(','));
  check('…and you come back up where it is deep enough', !s.crash && Sim.waterDepth(s.e, s.n) > C.mastLength, f2(Sim.waterDepth(s.e, s.n)) + ' m deep');

  // finish the crossing: start just off Bellerive Beach and paddle in
  await page.keyboard.press('KeyR');
  await page.evaluate(() => {
    const s = derwent.sim, S = derwent.Sim, n = S.MAP.finishMark[0];
    s.n = n; s.e = S.shoreAt(S.MAP.east, n) - 90; s.psi = Math.PI / 2;
  });
  for (let i = 0; i < 60 && (await page.evaluate(() => derwent.state)) === 'PLAYING'; i++) { await page.keyboard.press('Space'); await secs(page, 0.6); }
  check('reaching Bellerive ends the crossing', await page.evaluate(() => derwent.state) === 'RESULTS' &&
        await page.locator('#results').isVisible());
  const res = await page.evaluate(() => derwent.lastResult);
  check('…with a time, and it is a record', res && res.finished && res.time > 0 && res.record, res && (Math.round(res.time) + ' s'));
  check('the record is saved per conditions', await page.evaluate(() => JSON.parse(localStorage.getItem('derwent.best.v1'))['crossing.glassy']) === res.score);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, '8-results.png') });
  await page.keyboard.press('Enter');
  check('Enter goes again', await page.evaluate(() => derwent.state) === 'PLAYING');
  check('no page errors', errs.length === 0, errs.join(' | '));
  await page.close();
}

// ---------------------------------------------------------------------------
section('D9 — the same keys give the same ride');
{
  const rides = [];
  for (let k = 0; k < 2; k++) {
    const { page } = await open(browser);
    await startManual(page, 'Digit3', 'Digit5', 77);
    rides.push(await drive(page, 20, (st, m) => riderKeys(st, m)));
    await page.close();
  }
  check('two keyboard rides with one seed match exactly', rides[0].e === rides[1].e && rides[0].v === rides[1].v && rides[0].total === rides[1].total,
        f2(rides[0].total) + ' m on foil');
}

// ---------------------------------------------------------------------------
section('D10 — HUD layout across screens');
{
  const screens = [
    ['laptop', { width: 1280, height: 800 }],
    ['desktop', { width: 1920, height: 1080 }],
    ['small laptop', { width: 1024, height: 600 }],
    ['phone on its side', { width: 844, height: 390 }],
    ['phone', { width: 390, height: 844 }],
  ];
  const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  for (const [name, viewport] of screens) {
    const { page, errs } = await open(browser, { viewport });
    await page.evaluate(() => { derwent.start('crossing', 'seabreeze', 1); derwent.manual = true; });
    const hud = await page.evaluate(() => derwent.hud);
    const names = Object.keys(hud), clashes = [];
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) if (overlap(hud[names[i]], hud[names[j]])) clashes.push(names[i] + '/' + names[j]);
    const off = names.filter(k => { const r = hud[k]; return r.x < 0 || r.y < 0 || r.x + r.w > viewport.width + 0.5 || r.y + r.h > viewport.height + 0.5; });
    check(name + ': HUD panels sit on screen without overlapping', clashes.length === 0 && off.length === 0,
          [...clashes, ...off.map(k => k + ' off screen')].join(', ') || names.length + ' panels');
    if (SHOTS) {
      await page.evaluate(() => { derwent.manual = false; });
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(SHOTS, '10-' + name.replace(/ /g, '-') + '.png') });
    }
    check(name + ': no page errors', errs.length === 0, errs.join(' | '));
    await page.close();
  }
}

await browser.close();
const failed = results.filter(function (r) { return !r; }).length;
console.log('\n' + (results.length - failed) + '/' + results.length + ' checks passed');
process.exit(failed ? 1 : 0);
