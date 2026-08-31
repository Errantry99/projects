/*
 * channel — acceptance checks for channel.html
 *
 * Requires Playwright (the Chromium bundled with it) — no other dependency,
 * and the page itself makes zero network requests.
 *
 *   node channel.qa.mjs            # run every check
 *
 * The checks drive the page through window.channel, the debug handle the page
 * exposes (CONFIG, session state, simulated keystrokes, live metrics).
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

// Playwright may be installed locally or globally; find it either way.
const chromium = await (async function () {
  for (const spec of ['playwright', 'playwright-core']) {
    try { return (await import(spec)).chromium; } catch (e) { /* keep looking */ }
  }
  const root = execSync('npm root -g').toString().trim();
  return (await import(pathToFileURL(resolve(root, 'playwright/index.mjs')).href)).chromium;
})();

const FILE = pathToFileURL(resolve(process.argv[2] || 'channel.html')).href;
const results = [];
function check(n, ok, i = '') {
  results.push(ok);
  console.log((ok ? 'PASS' : 'FAIL') + ' \u2014 ' + n + (i ? '  [' + i + ']' : ''));
}
function section(t) { console.log('\n\u2022 ' + t); }

section('T1-T3 — scaffold, editor core, depth model & state machine');
{

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const net = [];
  page.on('request', r => { if (!r.url().startsWith('file://')) net.push(r.url()); });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  page.on('console', m => { if (m.type()==='error') errs.push('console: '+m.text()); });

  await page.goto(FILE);
  await page.waitForTimeout(400);
  check('loads with no page errors', errs.length===0, errs.join(' | '));
  check('zero network requests', net.length===0, net.join(','));
  check('idle screen visible', await page.locator('#idle').isVisible());

  // T7: first keystroke begins and is not swallowed
  await page.keyboard.type('h');
  await page.waitForTimeout(120);
  check('first keystroke begins session', await page.evaluate(()=>channel.state)==='WRITING');
  check('first keystroke not swallowed', await page.evaluate(()=>document.getElementById('input').value)==='h');
  check('idle overlay hidden', await page.locator('#idle').isHidden());

  // T2: editing
  await page.keyboard.type('ello world');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('X');
  await page.waitForTimeout(120);
  const val = await page.evaluate(()=>document.getElementById('input').value);
  check('backspace + arrow editing', val==='hello woXrl', val);
  const mirrored = await page.evaluate(()=>document.getElementById('mirror').textContent);
  check('mirror matches text', mirrored.startsWith('hello woXrl'), JSON.stringify(mirrored));

  // caret centred vertically
  const centred = await page.evaluate(()=>{
    const r = document.getElementById('caret').getBoundingClientRect();
    return Math.abs((r.top+r.bottom)/2 - innerHeight/2);
  });
  check('caret vertically centred', centred < 2, 'off by '+centred.toFixed(2)+'px');

  // T3: state machine boundaries (time-scaled)
  await page.evaluate(()=>{ channel.CONFIG.timeScale = 10; });
  await page.keyboard.type('a');
  await page.waitForTimeout(120);
  check('WRITING before 2s boundary', await page.evaluate(()=>channel.state)==='WRITING');
  await page.waitForTimeout(200);
  check('THINKING after 2s boundary', await page.evaluate(()=>channel.state)==='THINKING');
  const dA = await page.evaluate(()=>channel.depth);
  await page.waitForTimeout(600);
  const dB = await page.evaluate(()=>channel.depth);
  check('THINKING freezes depth', dA===dB, dA+' -> '+dB);
  await page.waitForTimeout(2600);
  check('STOPPED after 30s boundary', await page.evaluate(()=>channel.state)==='STOPPED');
  const dC = await page.evaluate(()=>channel.depth);
  await page.waitForTimeout(500);
  const dD = await page.evaluate(()=>channel.depth);
  check('STOPPED decays depth', dD < dC, dC.toFixed(6)+' -> '+dD.toFixed(6));

  // recovery at 2x up to the high-water mark
  const rec = await page.evaluate(async ()=>{
    channel.CONFIG.timeScale = 1;
    const s = channel.session;
    s.depth = 0.2; s.highWater = 0.5; s.sinceKeyMs = 0;
    channel.key('a');
    const t0 = performance.now(), d0 = s.depth;
    await new Promise(r=>setTimeout(r,300));
    const dt = performance.now()-t0, d1 = s.depth;
    const base = 1/(channel.CONFIG.buildMinutes*60*1000);
    return { ratio: (d1-d0)/(base*dt) };
  });
  check('recovery runs at 2x below high-water', Math.abs(rec.ratio-2) < 0.25, 'ratio '+rec.ratio.toFixed(3));

  const norm = await page.evaluate(async ()=>{
    const s = channel.session;
    s.depth = 0.6; s.highWater = 0.5; s.sinceKeyMs = 0;
    channel.key('a');
    const t0 = performance.now(), d0 = s.depth;
    await new Promise(r=>setTimeout(r,300));
    const dt = performance.now()-t0, d1 = s.depth;
    const base = 1/(channel.CONFIG.buildMinutes*60*1000);
    return (d1-d0)/(base*dt);
  });
  check('build runs at 1x above high-water', Math.abs(norm-1) < 0.15, 'ratio '+norm.toFixed(3));

  // decay is 1/3 speed
  const dec = await page.evaluate(async ()=>{
    const s = channel.session;
    s.depth = 0.6; s.state = 'STOPPED';
    const t0 = performance.now(), d0 = s.depth;
    await new Promise(r=>setTimeout(r,400));
    const dt = performance.now()-t0, d1 = s.depth;
    const base = 1/(channel.CONFIG.buildMinutes*60*1000);
    return (d0-d1)/(base*dt);
  });
  check('decay runs at 1/3 speed', Math.abs(dec-1/3) < 0.06, 'ratio '+dec.toFixed(3));
  await browser.close();
}

section('T4 — visual system: zoom, colour, ember, chrome');
{
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = []; page.on('pageerror', e=>errs.push(String(e)));
  await page.goto(FILE);
  await page.keyboard.type('the quick brown fox');
  await page.waitForTimeout(150);

  // caret centring across a batch of edits and depths
  let worst = 0;
  for (const d of [0,0.15,0.3,0.5,0.7,0.85,1]) {
    await page.evaluate(dd=>{ channel.session.depth = dd; channel.session.highWater = dd; }, d);
    await page.keyboard.type(' more words here to wrap the line and keep going');
    await page.waitForTimeout(120);
    const m = await page.evaluate(()=>{
      const c = document.getElementById('caret').getBoundingClientRect();
      const mir = document.getElementById('mirror');
      const fs = parseFloat(getComputedStyle(mir).fontSize);
      return { off: Math.abs((c.top+c.bottom)/2 - innerHeight/2), inX: c.left > -1 && c.right < innerWidth+1, fs,
               across: innerWidth/ (parseFloat(getComputedStyle(mir).width)/60) };
    });
    worst = Math.max(worst, m.off);
    check('depth '+d+': caret visible & centred, font '+m.fs.toFixed(1)+'px', m.off < 2 && m.inX, 'off '+m.off.toFixed(2)+' inX '+m.inX);
  }
  // zoom endpoints
  const z0 = await page.evaluate(()=>{ channel.session.depth=0; const mir=document.getElementById('mirror');
    return new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(parseFloat(getComputedStyle(mir).width)/innerWidth)))); });
  const z1 = await page.evaluate(()=>{ channel.session.depth=1; const mir=document.getElementById('mirror');
    return new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(parseFloat(getComputedStyle(mir).width)/innerWidth)))); });
  check('depth 0 column ~= viewport width (60 chars across)', Math.abs(z0-0.9)<0.02, 'ratio '+z0.toFixed(3));
  check('depth 1 shows ~1.5 words across', Math.abs(z1 - 0.9*60/(1.5*6.6)) < 0.3, 'column/viewport '+z1.toFixed(2));

  // colours at depth 1
  const col = await page.evaluate(()=>{ channel.session.depth=1;
    return new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r({
      bg: getComputedStyle(document.body).backgroundColor,
      ink: getComputedStyle(document.getElementById('mirror')).color,
      bloom: getComputedStyle(document.documentElement).getPropertyValue('--bloom')})))); });
  check('background reaches black at depth 1', col.bg==='rgb(0, 0, 0)', col.bg);
  check('ink is ember at depth 1', col.ink==='rgb(140, 127, 107)', col.ink);
  check('bloom present at depth 1', /rgba/.test(col.bloom) && !/rgba\(0,0,0,0\)/.test(col.bloom), col.bloom.trim());
  const col0 = await page.evaluate(()=>{ channel.session.depth=0;
    return new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r({bg:getComputedStyle(document.body).backgroundColor, ink:getComputedStyle(document.getElementById('mirror')).color})))); });
  check('surface colours correct', col0.bg==='rgb(242, 232, 219)' && col0.ink==='rgb(26, 23, 20)', JSON.stringify(col0));

  // monotonic / no snapping across depth sweep
  const sweep = await page.evaluate(async ()=>{
    const out=[];
    for(let i=0;i<=100;i++){ const d=i/100; channel.session.depth=d;
      await new Promise(r=>requestAnimationFrame(r)); await new Promise(r=>requestAnimationFrame(r));
      out.push(parseFloat(getComputedStyle(document.getElementById('mirror')).fontSize)); }
    return out; });
  let mono=true, maxStep=0;
  for(let i=1;i<sweep.length;i++){ if(sweep[i] < sweep[i-1]-1e-6) mono=false; maxStep=Math.max(maxStep, sweep[i]/sweep[i-1]); }
  check('zoom is monotonic with depth', mono);
  check('no zoom snapping (max step < 6%)', maxStep < 1.06, 'max step '+((maxStep-1)*100).toFixed(2)+'%');
  check('all font sizes readable (>= 13px)', Math.min(...sweep) >= 13, 'min '+Math.min(...sweep).toFixed(1));

  // ---- legibility across the whole descent (guards the contrast fix) ----
  const legibility = await page.evaluate(async () => {
    const parse = s => s.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>v/255);
    const lin = c => c<=0.04045 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4);
    const lum = c => 0.2126*lin(c[0]) + 0.7152*lin(c[1]) + 0.0722*lin(c[2]);
    const ratio = (a,b) => { const hi=Math.max(a,b), lo=Math.min(a,b); return (hi+0.05)/(lo+0.05); };
    let worstInk = Infinity, worst = Infinity, worstAt = 0;
    for (let i = 0; i <= 100; i++) {
      const d = i/100;
      channel.session.depth = d; channel.session.highWater = d;
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      const bgY = lum(parse(getComputedStyle(document.body).backgroundColor));
      const inkR = ratio(lum(parse(getComputedStyle(document.getElementById('mirror')).color)), bgY);
      const sh = getComputedStyle(document.getElementById('mirror')).textShadow;
      let haloR = 1;
      const m = sh.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
      if (m && Number(m[1]) > 200) {
        const a = m[4]===undefined ? 1 : Number(m[4]);
        haloR = ratio(a*lum([m[1]/255,m[2]/255,m[3]/255]) + (1-a)*bgY, bgY);
      }
      worstInk = Math.min(worstInk, inkR);
      const best = Math.max(inkR, haloR);
      if (best < worst) { worst = best; worstAt = d; }
    }
    return { worstInk, worst, worstAt };
  });
  check('text stays legible at every depth (>= 3:1)', legibility.worst >= 3,
        'min '+legibility.worst.toFixed(2)+':1 @ depth '+legibility.worstAt.toFixed(2));
  check('the halo is what carries it, not the ink', legibility.worstInk < 1.5,
        'ink alone bottoms out at '+legibility.worstInk.toFixed(2)+':1');

  // ---- horizontal follow keeps a zoomed line off the frame edge ----
  const follow = await page.evaluate(async () => {
    channel.session.depth = 0.62; channel.session.highWater = 0.62;
    const mir = document.getElementById('mirror'), caret = document.getElementById('caret');
    let inBounds = true, caretOut = 0, maxLeft = -Infinity, zoomed = 0;
    for (let i = 0; i < 120; i++) {
      await new Promise(r=>requestAnimationFrame(r));
      const b = mir.getBoundingClientRect(), c = caret.getBoundingClientRect();
      const g = Math.max(18, innerWidth * 0.07);
      if (b.width > innerWidth) {
        zoomed++;
        maxLeft = Math.max(maxLeft, b.left);
        if (!(b.left <= g + 1 && b.left >= innerWidth - b.width - g - 1)) inBounds = false;
      }
      if (c.left < 0 || c.right > innerWidth) caretOut++;
    }
    return { inBounds, caretOut, zoomed, gutter: Math.max(18, innerWidth*0.07) };
  });
  check('a zoomed line never runs into the frame edge', follow.zoomed > 0 && follow.inBounds,
        follow.zoomed+' zoomed frames, gutter '+follow.gutter.toFixed(0)+'px');
  check('the glide never carries the caret off-frame', follow.caretOut === 0,
        follow.caretOut+' frames off-frame');

  check('no page errors', errs.length===0, errs.join('|'));
  await browser.close();
}

section('T5-T7 — rhythm engine, audio system, begin & surfacing');
{
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = []; page.on('pageerror', e=>errs.push(String(e)));
  await page.goto(FILE);

  // ---- T5 rhythm: constant IKI ----
  const reg = await page.evaluate(async ()=>{
    channel.begin();
    for (let i=0;i<40;i++){ channel.key('a'); await new Promise(r=>setTimeout(r,150)); }
    await new Promise(r=>setTimeout(r,1200));
    return channel.metrics();
  });
  check('constant IKI -> low CV', reg.cv < 0.2, 'cv '+reg.cv);
  check('constant IKI -> gain 1.0', reg.gain > 0.97, 'gain '+reg.gain);
  check('constant IKI -> BPM in 70..110 and snapped to 5', reg.bpmTarget>=70 && reg.bpmTarget<=110 && reg.bpmTarget%5===0, 'bpm '+reg.bpmTarget);
  const bpm1 = reg.bpmTarget;
  const reg2 = await page.evaluate(async ()=>{
    for (let i=0;i<30;i++){ channel.key('a'); await new Promise(r=>setTimeout(r,150)); }
    return channel.metrics(); });
  check('BPM stable under steady input', reg2.bpmTarget===bpm1, bpm1+' -> '+reg2.bpmTarget);

  // ---- jittered input degrades gain ----
  const jit = await page.evaluate(async ()=>{
    for (let i=0;i<40;i++){ channel.key('a'); await new Promise(r=>setTimeout(r, 40 + Math.random()*700)); }
    await new Promise(r=>setTimeout(r,300));
    return channel.metrics(); });
  check('jittered input -> higher CV', jit.cv > reg.cv, 'cv '+jit.cv);
  check('jittered input -> reduced gain', jit.gain < 0.9, 'gain '+jit.gain);

  // ---- pauses never pollute the buffer ----
  const pause = await page.evaluate(async ()=>{
    channel.rhythm.reset();
    for (let i=0;i<6;i++){ channel.key('a'); await new Promise(r=>setTimeout(r,120)); }
    await new Promise(r=>setTimeout(r,3000));
    channel.key('a');
    for (let i=0;i<4;i++){ await new Promise(r=>setTimeout(r,120)); channel.key('a'); }
    return { buf: channel.rhythm.buffer.slice(), max: Math.max.apply(null, channel.rhythm.buffer) }; });
  check('no interval > 2000ms in buffer', pause.max <= 2000, 'max '+Math.round(pause.max)+'ms, n='+pause.buf.length);
  check('buffer capped at 24', await page.evaluate(()=>channel.rhythm.buffer.length<=24));

  // ---- T6 audio graph ----
  const aud = await page.evaluate(()=>({ ready: channel.audio.ready, state: channel.audio.ctx && channel.audio.ctx.state }));
  check('AudioContext created on first keystroke', aud.ready===true, 'ctx '+aud.state);
  const gains = await page.evaluate(async ()=>{
    const a = channel.audio, out = {};
    channel.session.depth = 0;  await new Promise(r=>setTimeout(r,400)); out.d0 = a.droneGain.gain.value;
    channel.session.depth = 0.5; await new Promise(r=>setTimeout(r,600)); out.d5 = a.droneGain.gain.value; out.oct5 = a.octaveGain.gain.value;
    channel.session.depth = 0.95; await new Promise(r=>setTimeout(r,600)); out.d95 = a.droneGain.gain.value; out.oct95 = a.octaveGain.gain.value;
    return out; });
  check('silence at the surface', gains.d0 < 0.005, 'drone '+gains.d0.toFixed(5));
  check('drone emerges by mid depth', gains.d5 > 0.05, 'drone '+gains.d5.toFixed(4));
  check('octave fades in only above depth 0.7', gains.oct5 < 0.01 && gains.oct95 > 0.2, gains.oct5.toFixed(4)+' -> '+gains.oct95.toFixed(3));

  // ---- T7 esc behaviour ----
  await page.evaluate(()=>{ channel.session.depth = 0.9; });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('single Esc shows a hint, does not end', await page.evaluate(()=>channel.state)!=='SURFACING' && await page.locator('#hint').evaluate(e=>e.classList.contains('show')));
  await page.waitForTimeout(3400);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  check('Esc after the window re-arms instead of ending', await page.evaluate(()=>channel.state)!=='SURFACING');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  check('double Esc surfaces', await page.evaluate(()=>channel.state)==='SURFACING');
  const mid = await page.evaluate(()=>({ d: channel.session.depth, r: channel.audio.ready }));
  await page.waitForTimeout(4600);
  check('summary appears after the 4s cooling ramp', await page.locator('#summary').isVisible());
  const sum = await page.evaluate(()=>({
    phrase: document.getElementById('sumPhrase').textContent,
    stats: [...document.querySelectorAll('#sumStats .stat')].map(e=>e.querySelector('.k').textContent+': '+e.querySelector('.v').textContent.trim()),
    text: document.getElementById('sumText').textContent.length }));
  console.log('    summary:', JSON.stringify(sum.stats));
  check('deepest phrase reflects high-water depth', sum.phrase==='channel', sum.phrase+' hw='+mid.d.toFixed(2));
  check('summary shows all six metrics', sum.stats.length===6);
  check('summary carries the full text', sum.text>0, sum.text+' chars');
  check('audio closed after surfacing', await page.evaluate(()=>channel.audio.ready)===false);
  check('no page errors', errs.length===0, errs.join('|'));
  await browser.close();
}

section('T9 — integration: time-scaled full run, editing at depth, cooling');
{
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required','--js-flags=--expose-gc'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = []; page.on('pageerror', e=>errs.push(String(e)));
  await page.goto(FILE);

  // ---- depth reaches 1.0 after 20 scaled minutes of continuous WRITING ----
  const run = await page.evaluate(async ()=>{
    channel.CONFIG.timeScale = 20;             // the plan's test scale: 20 min of session in 60 s
    channel.begin();
    const words = 'the river runs under the floor of the house and no one hears it but you '.split(' ');
    let flicker = [], last = channel.state, i = 0, heap0 = performance.memory ? performance.memory.usedJSHeapSize : 0;
    const t0 = performance.now();
    await new Promise(done=>{
      (function tick(){
        channel.key(words[i++ % words.length] + ' ');
        if (channel.state !== last) { flicker.push(last+'->'+channel.state); last = channel.state; }
        if (channel.session.depth >= 1 || performance.now()-t0 > 90000) return done();
        requestAnimationFrame(tick);
      })();
    });
    return { depth: channel.session.depth, writingMin: channel.session.writingMs/60000,
             realSec: (performance.now()-t0)/1000, flicker, chars: document.getElementById('input').value.length,
             heapMB: performance.memory ? (performance.memory.usedJSHeapSize-heap0)/1048576 : null,
             state: channel.state };
  });
  check('depth reaches 1.0 after 20 scaled minutes of WRITING', run.depth >= 0.999,
        'depth '+run.depth.toFixed(4)+' after '+run.writingMin.toFixed(2)+' scaled min / '+run.realSec.toFixed(1)+'s real');
  check('no state flicker during continuous writing', run.flicker.length===0, run.flicker.join(', '));
  check('heap stable over the run', run.heapMB===null || run.heapMB < 12, run.heapMB===null?'n/a':run.heapMB.toFixed(1)+' MB, '+run.chars+' chars');

  // ---- mid-text editing at depth 1 ----
  await page.evaluate(()=>{ const t=document.getElementById('input'); t.focus(); t.selectionStart=t.selectionEnd=40; });
  await page.keyboard.type('ZZZ');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(200);
  const edit = await page.evaluate(()=>{
    const t=document.getElementById('input'); const c=document.getElementById('caret').getBoundingClientRect();
    return { has: t.value.slice(40,42)==='ZZ'.slice(0,2), depth: channel.session.depth,
             off: Math.abs((c.top+c.bottom)/2-innerHeight/2), inX: c.left>-1 && c.right<innerWidth+1, w: c.width };
  });
  check('mid-text edit lands at depth 1', edit.has, 'depth '+edit.depth.toFixed(3));
  check('caret never lost at max zoom', edit.off < 2 && edit.inX && edit.w > 0, 'off '+edit.off.toFixed(2)+' w '+edit.w.toFixed(0));

  // ---- chrome fade causes no layout jump ----
  const jump = await page.evaluate(async ()=>{
    channel.session.writingMs = 0; channel.CONFIG.timeScale = 1;
    channel.session.state = 'THINKING';              // freeze depth so only the chrome changes
    const mir = document.getElementById('mirror');
    // the horizontal follow glides toward its target, so let it settle before
    // sampling — otherwise this measures the glide, not the chrome
    for (let i = 0; i < 90; i++) await new Promise(r=>requestAnimationFrame(r));
    const before = mir.getBoundingClientRect();
    channel.session.writingMs = channel.CONFIG.chromeFadeMs;
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    const after = mir.getBoundingClientRect();
    return { dx: Math.abs(before.left-after.left), dy: Math.abs(before.top-after.top),
             op: parseFloat(getComputedStyle(document.getElementById('chrome')).opacity) };
  });
  check('chrome fully faded after 90s of writing', jump.op < 0.01, 'opacity '+jump.op);
  check('no layout jump when the chrome fades', jump.dx < 0.5 && jump.dy < 0.5, 'dx '+jump.dx+' dy '+jump.dy);

  // ---- surfacing cools visuals back to the surface ----
  const cool = await page.evaluate(async ()=>{
    channel.session.depth = 1; channel.surface();
    const samples = [];
    for (let i=0;i<9;i++){ await new Promise(r=>setTimeout(r,450));
      samples.push(parseFloat(getComputedStyle(document.getElementById('mirror')).fontSize)); }
    return samples; });
  let desc = true; for (let i=1;i<cool.length;i++) if (cool[i] > cool[i-1]+0.5) desc = false;
  check('surfacing cools the zoom back down monotonically', desc, cool.map(v=>v.toFixed(0)).join(','));
  check('no page errors', errs.length===0, errs.join('|'));
  await browser.close();
}

section('T8 — summary screen metrics & copy');
{
  const b = await chromium.launch({args:['--autoplay-policy=no-user-gesture-required']});
  const ctx = await b.newContext({viewport:{width:1100,height:700}, permissions:['clipboard-read','clipboard-write']});
  const p = await ctx.newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
  await p.goto(FILE);

  // scripted session: 30 keystrokes at 100ms, a 4s pause, then 20 more at 100ms
  const scripted = await p.evaluate(async ()=>{
    const words = 'one two three four five six seven eight nine ten '.split('');
    channel.begin();
    const t0 = performance.now();
    const text = 'the words that make up a scripted test session for the summary screen';
    let i = 0;
    const run1Start = performance.now();
    for (; i < 40; i++) { channel.key(text[i]); await new Promise(r=>setTimeout(r,100)); }
    const run1 = performance.now() - run1Start - 100;
    await new Promise(r=>setTimeout(r,4000));           // a pause breaks the run
    const run2Start = performance.now();
    for (; i < text.length; i++) { channel.key(text[i]); await new Promise(r=>setTimeout(r,100)); }
    const run2 = performance.now() - run2Start - 100;
    const total = performance.now() - t0;
    channel.surface();
    await new Promise(r=>setTimeout(r,4400));
    return { run1, run2, total, text,
             stats: Object.fromEntries([...document.querySelectorAll('#sumStats .stat')]
               .map(e=>[e.querySelector('.k').textContent, e.querySelector('.v').textContent.trim()])),
             shown: document.getElementById('sumText').textContent };
  });
  console.log('    ', JSON.stringify(scripted.stats));
  const words = scripted.text.trim().split(/\s+/).length;
  check('word count matches', scripted.stats.words === String(words), scripted.stats.words+' vs '+words);
  const durSec = Math.round(scripted.total/1000);
  check('duration matches the scripted session', Math.abs(parseInt(scripted.stats.duration)*60 + parseInt(scripted.stats.duration.split(' ')[1]) - durSec) <= 2,
        scripted.stats.duration+' vs '+durSec+'s');
  const wpmExpected = Math.round(words / (scripted.total/60000));
  check('avg wpm matches', Math.abs(parseInt(scripted.stats['avg wpm']) - wpmExpected) <= 1, scripted.stats['avg wpm']+' vs '+wpmExpected);
  const longestExpected = Math.max(scripted.run1, scripted.run2);
  check('longest unbroken run matches (pause breaks it)', Math.abs(parseInt(scripted.stats['longest run'].split(' ')[1]) - Math.round(longestExpected/1000)) <= 1,
        scripted.stats['longest run']+' vs '+(longestExpected/1000).toFixed(1)+'s');
  check('regularity is a 0..100 score', (()=>{const v=parseInt(scripted.stats.regularity); return v>=0&&v<=100;})(), scripted.stats.regularity);
  check('full text shown on the summary', scripted.shown === scripted.text);

  await p.click('#copyBtn');
  await p.waitForTimeout(300);
  const clip = await p.evaluate(()=>navigator.clipboard.readText());
  check('copy puts the full text on the clipboard', clip === scripted.text, JSON.stringify(clip.slice(0,30)+'…'));
  check('no page errors', errs.length===0, errs.join('|'));
  await b.close();
}


const failed = results.filter(function (r) { return !r; }).length;
console.log('\n' + (results.length - failed) + '/' + results.length + ' checks passed');
process.exit(failed ? 1 : 0);
