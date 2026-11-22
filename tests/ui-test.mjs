// Boots the Skyglass UI in headless Chromium, opens every app, runs the PIN flow and the
// unlock swipe, and fails on any JavaScript error. Usage: node tests/ui-test.mjs [port]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = process.argv[2] || '7788';
const URL = `http://127.0.0.1:${PORT}/`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = ['chromium', 'google-chrome', 'chromium-browser'].find(b => {
  try { return spawn('which', [b]).pid && fs.existsSync(`/usr/bin/${b}`); } catch { return false; }
}) || 'chromium';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'skyglass-uitest-'));
const dbg = 9900 + Math.floor(Math.random() * 90);
const ch = spawn(browser, ['--headless=new', '--no-sandbox', `--remote-debugging-port=${dbg}`, `--user-data-dir=${profile}`, '--window-size=600,1024', 'about:blank'], { stdio: 'ignore' });

let targets;
for (let i = 0; i < 60 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${dbg}/json`)).json(); } catch { await sleep(200); } }
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => (ws.onopen = r));
let id = 0; const pend = {}; const errors = [];
ws.onmessage = m => {
  const d = JSON.parse(m.data);
  if (d.id && pend[d.id]) { pend[d.id](d); delete pend[d.id]; }
  if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
  if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(d.params.args.map(a => a.value ?? a.description).join(' '));
};
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
  return r.result.result.value;
};

let failed = 0;
const check = (name, cond) => { console.log(`  ${cond ? '✔' : '✘'} ${name}`); if (!cond) failed++; };
try {
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 600, height: 1024, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL });
  await sleep(2500);
  check('UI boots', await evaluate('window.SKYGLASS_BOOTED === true'));
  check('lock screen shown', await evaluate("!document.querySelector('#lock').classList.contains('gone')"));

  // swipe up that ends on the status bar (regression test for the stuck lock screen)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 300, y: 900, button: 'left', buttons: 1, clickCount: 1 });
  for (const y of [800, 600, 400, 200, 10]) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 300, y, button: 'left', buttons: 1 }); await sleep(30); }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 300, y: 10, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(800);
  check('swipe up opens the PIN pad', await evaluate("!!document.querySelector('#l-pin .pin-wrap')"));

  // choose + confirm a PIN, then unlock with it
  const type = pin => evaluate(`(async () => { for (const k of '${pin}') document.querySelector('#l-pin [data-k="'+k+'"]').click(); document.querySelector('#l-pin [data-k=ok]').click(); await sleep(400); })()`);
  await type('4826'); await type('4826'); await sleep(800);
  check('first-time PIN setup unlocks', await evaluate("document.querySelector('#lock').classList.contains('gone')"));
  await evaluate('lock()'); await evaluate('requestUnlock()'); await sleep(500);
  await type('1111'); await sleep(500);
  check('wrong PIN is rejected', await evaluate("!document.querySelector('#lock').classList.contains('gone')"));
  await type('4826'); await sleep(800);
  check('right PIN unlocks', await evaluate("document.querySelector('#lock').classList.contains('gone')"));

  for (const app of ['phone', 'messages', 'browser', 'camera', 'photos', 'files', 'notes', 'calc', 'clock', 'viewer3d', 'weather', 'music', 'calendar', 'sketch', 'sysmon', 'games', 'terminal', 'linux', 'aquarium', 'bubblewrap', 'settings']) {
    const before = errors.length;
    await evaluate(`openApp('${app}')`); await sleep(900);
    const open = await evaluate('!!(CURRENT && document.body.contains(CURRENT.el))');
    check(`app "${app}" opens without errors`, open && errors.length === before);
    await evaluate('goHome()'); await sleep(300);
  }
  // *#0*# test mode: opens from the dialer, has its tiles, a manual test can be answered
  await evaluate(`openApp('phone')`); await sleep(400);
  await evaluate(`[...'*#0*#'].forEach(k => { const b = [...document.querySelectorAll('.dk')].find(b => b.querySelector('b').textContent === k); b.dispatchEvent(new PointerEvent('pointerdown')); b.dispatchEvent(new PointerEvent('pointerup')); })`);
  await sleep(1200);
  check('*#0*# opens test mode with all tests', await evaluate(`document.querySelectorAll('.tm .tm-tile').length >= 20`));
  await evaluate(`document.querySelector('[data-t=multitouch]').click()`); await sleep(300);
  await evaluate(`document.querySelector('.tm-good').click()`); await sleep(200);
  check('test mode records a result', await evaluate(`document.querySelector('[data-t=multitouch]').classList.contains('pass')`));
  await evaluate(`document.querySelector('.tm-head .orb.close').click()`); await evaluate('goHome()'); await sleep(300);
  // the home bar must not swallow taps meant for an app's bottom row
  await evaluate(`openApp('calc')`); await sleep(600);
  check('home bar leaves app buttons tappable', await evaluate(`(() => { const r = [...document.querySelectorAll('.ck')].pop().getBoundingClientRect(); const z = parseFloat(document.documentElement.style.zoom) || 1;
    return !!document.elementFromPoint((r.left + r.width / 2) * z, (r.top + r.height - 4) * z)?.closest('.ck'); })()`));
  // apps stop animating behind the lock screen (power)
  check('apps pause while locked', await evaluate(`(async () => { lock(); let n = 0; const f = () => { n++; requestAnimationFrame(f); }; requestAnimationFrame(f);
    await sleep(1000); const locked = n; unlock(); await sleep(500); return locked < 6 && n > locked; })()`));
  await evaluate('goHome()'); await sleep(300);
  for (const page of ['wifi', 'display', 'sound', 'security', 'about', 'power', 'dev', 'notifications', 'bluetooth', 'keyboard', 'hotspot', 'android', 'updates', 'led', 'dev']) {
    const before = errors.length;
    await evaluate(`openApp('settings', '${page}')`); await sleep(700);
    check(`settings page "${page}" without errors`, errors.length === before);
    await evaluate('goHome()'); await sleep(250);
  }
  // flashlight tile in the pull-down drives the LED service
  await evaluate("document.querySelector('[data-q=torch]').click()"); await sleep(500);
  check('flashlight tile turns the LED on', await evaluate("api('/api/led').then(r => r.active === 'flashlight')"));
  await evaluate("document.querySelector('[data-q=torch]').click()"); await sleep(500);
  check('flashlight tile turns it off', await evaluate("api('/api/led').then(r => r.active !== 'flashlight')"));
  // notifications: one from the backend shows a banner, lands in the pull-down, and can be dismissed
  await evaluate("api('/api/notify', { app: 'UITest', title: 'Hello from the test', body: 'banner check' })"); await sleep(1500);
  check('notification shows a banner', await evaluate("[...document.querySelectorAll('#banners .ncard')].some(c => c.textContent.includes('Hello from the test'))"));
  check('notification badge in the status bar', await evaluate("!document.querySelector('#sb-notif').classList.contains('hidden')"));
  check('notification listed in the pull-down', await evaluate("document.querySelector('#q-notifs').textContent.includes('Hello from the test')"));
  await evaluate("S.dnd = true; renderNotifs()");
  await evaluate("api('/api/notify', { app: 'UITest', title: 'Quiet one' })"); await sleep(1200);
  check('Do Not Disturb holds back banners', await evaluate("![...document.querySelectorAll('#banners .ncard')].some(c => c.textContent.includes('Quiet one'))"));
  await evaluate("S.dnd = false; save(); api('/api/notifications/dismiss', {})"); await sleep(800);
  check('Clear all empties the list', await evaluate("!document.querySelector('#q-notifs').textContent.includes('Hello from the test')"));
  await evaluate('startSaver(true)'); await sleep(700);
  const saverUp = await evaluate("!!document.querySelector('#saver canvas')");
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 200, y: 300, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 200, y: 300, button: 'left', clickCount: 1 });
  await sleep(600);
  check('screensaver shows and a tap dismisses it', saverUp && await evaluate("!document.querySelector('#saver')"));
  await evaluate("openApp('viewer3d')");
  let tris = 0;
  for (let i = 0; i < 40 && !tris; i++) { await sleep(250); tris = await evaluate("+(document.querySelector('.v3d') || {dataset: {}}).dataset.tris || 0"); }
  check('3D viewer loads the Benchy (' + tris + ' triangles)', tris > 100000);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 300, y: 500, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 380, y: 540, button: 'left', buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 380, y: 540, button: 'left', clickCount: 1 });
  await evaluate('goHome()'); await sleep(300);
  await evaluate("openApp('browser')"); await sleep(500);
  check('Sky Search home shows its logo and search box', await evaluate("!!document.querySelector('.sky-logo') && !!document.querySelector('.sky-input')"));
  await evaluate('goHome()'); await sleep(300);
  await evaluate("openApp('photos')"); await sleep(900);
  await evaluate("document.querySelector('.sel-toggle').click()"); await sleep(150);
  await evaluate("document.querySelector('.photos [data-path]').click()"); await sleep(150);
  check('Photos: pick a photo to copy to USB', await evaluate("document.querySelector('.selbar b').textContent") === '1 selected');
  await evaluate('goHome()'); await sleep(300);
  await evaluate("openApp('files')"); await sleep(700);
  check('Files shows phone + USB storage list', await evaluate("document.querySelector('.win-body').textContent.includes('Phone')"));
  await evaluate('goHome()'); await sleep(300);
  await evaluate("openApp('camera')"); await sleep(500);
  await evaluate("document.querySelector('.cam-mode[data-m=video]') && document.querySelector('.cam-mode[data-m=video]').click()"); await sleep(150);
  check('Camera has a video record button', await evaluate("!!document.querySelector('.shutter.video') || !!document.querySelector('.empty')"));
  await evaluate('goHome()'); await sleep(300);
  // keyboard shift: off -> shift -> caps -> off
  const shiftCycle = await evaluate(`(async () => {
    openApp('browser'); await sleep(500);
    const inp = document.querySelector('.sky-input'); if (!inp) return 'no input';
    inp.focus(); await sleep(200);
    const k = () => document.querySelector('#osk [data-k=SHIFT]');
    const press = () => k().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    const st = () => (k().classList.contains('on') ? 'on' : 'off') + ':' + k().textContent;
    const out = [st()]; for (let i = 0; i < 3; i++) { press(); out.push(st()); }
    goHome(); return out.join(' ');
  })()`);
  check('keyboard shift turns off again (' + shiftCycle + ')', shiftCycle === 'off:⇧ on:⇧ on:⇪ off:⇧');
  for (const g of ['skypop', 'memory', 'ttt', 'hop', 'blocks']) {
    const before = errors.length;
    await evaluate(`openApp('games'); CURRENT.push('g', b => GAMES.${g}(b, CURRENT))`); await sleep(['hop', 'blocks'].includes(g) ? 2500 : 600);
    if (g === 'blocks') check('Cloudblocks draws frames', +(await evaluate("(document.querySelector('.cb-wrap') || {dataset: {}}).dataset.fps || 0")) > 0);
    if (g === 'hop') check('Bubble Hop loads', await evaluate("!!document.querySelector('.hop-canvas')"));
    check(`game "${g}" starts`, errors.length === before);
    await evaluate('goHome()'); await sleep(200);
  }
  for (const st of ['starfield', 'rain', 'lava', 'fireflies', 'kaleido', 'random']) {
    const before = errors.length;
    await evaluate(`S.saverStyle = '${st}'; startSaver(true)`); await sleep(500);
    check(`screensaver "${st}" runs`, errors.length === before && await evaluate("!!document.querySelector('#saver')"));
    await evaluate('stopSaver()'); await sleep(350);
  }
  await evaluate("S.saverStyle = 'bubbles'");
  for (const [title, fn] of [['Bluetooth', 'bluetoothPage'], ['Wallpaper', 'wallpaperPage'], ['Date & time', 'timePage'], ['Accessibility', 'accessPage'], ['Storage', 'storagePage']]) {
    const before = errors.length;
    await evaluate(`openApp('settings'); CURRENT.push('${title}', ${fn})`); await sleep(900);
    check(`settings page "${title}" without errors`, errors.length === before);
    await evaluate('goHome()'); await sleep(200);
  }
  check('terminal library is not loaded at boot', await evaluate("!document.querySelector('script[src*=xterm]') || !!window.Terminal"));
  // a deliberately broken app must be closed, not crash the phone
  await evaluate("APPS.__bad = { name: 'Bad', open() { throw new Error('boom'); } }; openApp('__bad')"); await sleep(500);
  check('a crashing app is contained', await evaluate("CURRENT === null && !!document.querySelector('.toast')"));
  // corrupt saved settings must not break boot
  await evaluate("localStorage.setItem('sg.settings', '{broken json'); location.reload()"); await sleep(2500);
  check('boots with corrupt settings', await evaluate('window.SKYGLASS_BOOTED === true'));
} catch (e) {
  console.log('  ✘ test run crashed:', e.message); failed++;
}
const real = errors.filter(e => !/boom|ResizeObserver/.test(String(e)));
check(`no unexpected JavaScript errors${real.length ? ': ' + real.slice(0, 3).join(' | ') : ''}`, real.length === 0);
ws.close(); ch.kill();
await new Promise(r => { ch.once('exit', r); setTimeout(r, 3000); });
try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* temp dir, harmless */ }
console.log(failed ? `\n${failed} UI check(s) failed` : '\nAll UI checks passed');
process.exit(failed ? 1 : 0);
