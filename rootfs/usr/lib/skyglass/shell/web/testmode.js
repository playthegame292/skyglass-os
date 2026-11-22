/* Skyglass hardware test mode — dial *#0*# in Phone. Loaded only when opened.
   Every tile is one test. Automatic tests judge themselves; for the ones only a person can judge
   (colours, sound, LED…) you answer "Works" or "Problem". Results colour the tiles green or red. */
'use strict';
(() => {
  const RES = {};   // test id -> true (works) / false (problem)
  let root = null, grid = null;

  // ---- small building blocks
  const layer = (cls, ...kids) => { const el = h('div', { class: 'tm-layer ' + (cls || '') }, ...kids); root.append(el); return el; };
  function verdict(id, el, question = 'Did it work?') {
    return new Promise(res => {
      const bar = h('div', { class: 'tm-verdict' }, h('span', {}, question),
        h('button', { class: 'tm-bad', onclick: e => { e.stopPropagation(); done(false); } }, '✘ Problem'),
        h('button', { class: 'tm-good', onclick: e => { e.stopPropagation(); done(true); } }, '✔ Works'));
      const done = ok => { mark(id, ok); el.remove(); res(ok); };
      el.append(bar);
    });
  }
  function mark(id, ok) {
    if (ok == null) return;
    RES[id] = ok;
    const t = grid && grid.querySelector(`[data-t="${id}"]`);
    if (t) { t.classList.toggle('pass', ok); t.classList.toggle('fail', !ok); }
    tone(ok ? 'chime' : 'click');
  }
  const post = (name, extra = {}) => api('/api/test', { name, ...extra });
  function sheet(id, title, r, extra) {
    const el = layer('tm-sheet-bg');
    const ok = r.ok === true ? h('b', { class: 'tm-ok' }, '✔ Works') : r.ok === false ? h('b', { class: 'tm-no' }, '✘ Problem') : h('b', { class: 'tm-na' }, 'Info');
    el.append(h('div', { class: 'tm-sheet' }, h('div', { class: 'tm-sheet-h' }, h('span', {}, title), ok),
      h('div', { class: 'tm-rows' }, (r.rows || []).map(([k, v]) => h('div', { class: 'tm-row' }, h('span', {}, k), h('b', {}, v)))),
      extra || null,
      h('button', { class: 'btn primary tm-close', onclick: () => el.remove() }, 'Close')));
    mark(id, r.ok);
    return el;
  }
  async function auto(id, title, wait) {
    const el = layer('tm-sheet-bg', h('div', { class: 'tm-sheet' }, h('div', { class: 'sky-loading' }, h('span', { class: 'sky-orb spin' }), wait || 'Testing…')));
    const r = await post(id);
    el.remove();
    return sheet(id, title, r.error ? { ok: false, rows: [['Error', r.error]] } : r);
  }

  // ---- the tests
  const TESTS = [
    // screen
    { id: 'colours', label: 'Colours', group: 'Screen', run() {
      // tap to step: dead pixels show on plain colours, banding on the gradient, blur on the fine lines
      const steps = ['#f00', '#0f0', '#00f', '#fff', '#000', '#808080', 'linear-gradient(90deg,#000,#fff)',
        'linear-gradient(90deg,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)', 'repeating-conic-gradient(#000 0 25%, #fff 0 50%) 0 0 / 2px 2px'];
      let i = 0; const el = layer('tm-full'); const hint = h('div', { class: 'tm-hint' }, 'Tap to go on');
      const show = () => { el.style.background = steps[i]; }; show(); el.append(hint);
      el.onclick = () => { if (++i < steps.length) return show(); el.onclick = null; hint.remove(); el.style.background = '#123'; verdict('colours', el, 'Clean colours: no dead pixels, stripes or tints?'); };
    } },
    { id: 'touchdraw', label: 'Touch draw', group: 'Screen', run() {
      const cv = h('canvas', { class: 'tm-cv' }), el = layer('tm-full tm-white', cv, h('div', { class: 'tm-hint dark' }, 'Draw with one or more fingers. Lines should follow your fingers exactly.'));
      const ctx = fitCanvas(cv), last = {}, colors = ['#e33', '#19f', '#2b2', '#f90', '#a3f', '#0cc'];
      ctx.strokeStyle = '#dde'; for (let x = 0; x < cv.width; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, cv.height); ctx.stroke(); }
      for (let y = 0; y < cv.height; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cv.width, y); ctx.stroke(); }
      cv.onpointerdown = e => { last[e.pointerId] = pos(cv, e); };
      cv.onpointermove = e => { const l = last[e.pointerId]; if (!l) return; const p = pos(cv, e);
        ctx.strokeStyle = colors[Object.keys(last).indexOf(String(e.pointerId)) % colors.length]; ctx.lineWidth = 5; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(...l); ctx.lineTo(...p); ctx.stroke(); last[e.pointerId] = p; };
      cv.onpointerup = cv.onpointercancel = e => delete last[e.pointerId];
      verdict('touchdraw', el, 'Did the lines follow your fingers?');
    } },
    { id: 'touchgrid', label: 'Touch grid', group: 'Screen', run() {
      // every cell must be touched: finds dead zones on the panel (passes by itself)
      const C = 10, R = 6, el = layer('tm-full tm-white tm-cells'), cells = [];
      el.style.gridTemplateColumns = `repeat(${C}, 1fr)`;
      for (let i = 0; i < C * R; i++) { const c = h('div', { class: 'tm-cell' }); cells.push(c); el.append(c); }
      let left = C * R; const hint = h('div', { class: 'tm-hint dark' }, 'Swipe over every square'); el.append(hint);
      const hit = e => { const t = document.elementFromPoint(e.clientX, e.clientY); if (t && t.classList.contains('tm-cell') && !t.classList.contains('on')) { t.classList.add('on'); if (--left === 0) { mark('touchgrid', true); setTimeout(() => el.remove(), 400); } } };
      el.addEventListener('pointerdown', hit); el.addEventListener('pointermove', e => e.buttons || e.pointerType === 'touch' ? hit(e) : 0);
      el.append(h('button', { class: 'tm-giveup', onclick: () => { mark('touchgrid', false); el.remove(); } }, 'Some squares won’t light up'));
    } },
    { id: 'multitouch', label: 'Multi-touch', group: 'Screen', run() {
      const el = layer('tm-full tm-dark'), info = h('div', { class: 'tm-hint' }, 'Put several fingers on the screen'), dots = {};
      let max = 0; el.append(info);
      const upd = () => { const n = Object.keys(dots).length; max = Math.max(max, n); info.textContent = `${n} finger${n === 1 ? '' : 's'} now · most at once: ${max}`; };
      el.onpointerdown = e => { const d = h('div', { class: 'tm-dot' }, String(Object.keys(dots).length + 1)); dots[e.pointerId] = d; el.append(d); place(d, e); upd(); };
      el.onpointermove = e => dots[e.pointerId] && place(dots[e.pointerId], e);
      el.onpointerup = el.onpointercancel = e => { if (dots[e.pointerId]) { dots[e.pointerId].remove(); delete dots[e.pointerId]; upd(); } };
      verdict('multitouch', el, 'Did every finger get its own circle?');
    } },
    { id: 'brightness', label: 'Brightness', group: 'Screen', async run() {
      const el = layer('tm-full tm-white', h('div', { class: 'tm-big dark' }, 'Brightness')), keep = S.brightness;
      for (const v of [10, 40, 70, 100, 10, 100]) { if (!el.isConnected) break; el.firstChild.textContent = v + ' %'; await api('/api/brightness', { percent: v }); await sleep(900); }
      setBrightness(keep);
      verdict('brightness', el, 'Did the screen get darker and brighter?');
    } },
    { id: 'fps', label: 'Frame rate', group: 'Screen', async run() {
      const el = layer('tm-full tm-dark'), ball = h('div', { class: 'tm-ball' }), info = h('div', { class: 'tm-hint' }, 'Measuring…'); el.append(ball, info);
      let n = 0, t0 = 0; const W = el.clientWidth - 60;
      await new Promise(res => { const f = t => { if (!t0) t0 = t; n++; ball.style.transform = `translateX(${(Math.sin((t - t0) / 300) * .5 + .5) * W}px)`; t - t0 < 2500 && el.isConnected ? requestAnimationFrame(f) : res(); }; requestAnimationFrame(f); });
      const fps = Math.round(n / 2.5);
      info.textContent = `${fps} frames per second`;
      mark('fps', fps >= 45);
      el.append(h('button', { class: 'btn primary tm-close', onclick: () => el.remove() }, 'Close'));
    } },
    // sound
    { id: 'speaker', label: 'Speaker', group: 'Sound', async run() {
      const el = layer('tm-full tm-dark'), info = h('div', { class: 'tm-big' }, ''); el.append(info);
      const ac = new AudioContext(), beep = async (pan, label, f0 = 660, f1 = 660) => {
        info.textContent = label; const o = ac.createOscillator(), g = ac.createGain(), p = ac.createStereoPanner(), t = ac.currentTime;
        o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + 1.2); p.pan.value = pan;
        g.gain.setValueAtTime(.001, t); g.gain.exponentialRampToValueAtTime(.4, t + .05); g.gain.setValueAtTime(.4, t + 1.1); g.gain.exponentialRampToValueAtTime(.001, t + 1.25);
        o.connect(g).connect(p).connect(ac.destination); o.start(t); o.stop(t + 1.3); await sleep(1500);
      };
      await beep(-1, '◀ Left'); await beep(1, 'Right ▶'); await beep(0, 'Both'); await beep(0, 'Low → high', 80, 8000);
      ac.close(); info.textContent = '🔊';
      verdict('speaker', el, 'Did you hear left, right, both and the sweep?');
    } },
    { id: 'mic', label: 'Microphone', group: 'Sound', async run() {
      const el = layer('tm-full tm-dark'), info = h('div', { class: 'tm-big' }, 'Say something… (3 s)'); el.append(info);
      const r = await post('mic');
      if (!r.wav) { el.remove(); return sheet('mic', 'Microphone', r); }
      info.textContent = 'Playing it back…';
      const a = new Audio(r.wav); a.play().catch(() => {}); await new Promise(res => { a.onended = res; setTimeout(res, 4000); });
      el.remove(); sheet('mic', 'Microphone', r);
    } },
    { id: 'audio', label: 'Audio devices', group: 'Sound', run: () => auto('audio', 'Audio devices') },
    // hardware
    { id: 'sensors', label: 'Sensors', group: 'Hardware', run: () => auto('sensors', 'Temperature, clocks & voltage') },
    { id: 'power', label: 'Power supply', group: 'Hardware', run: () => auto('power', 'Power supply') },
    { id: 'stress', label: 'CPU stress', group: 'Hardware', run: () => auto('stress', 'CPU stress (10 s, all cores)', 'All cores at full power for 10 s…') },
    { id: 'storage', label: 'Storage speed', group: 'Hardware', run: () => auto('storage', 'Storage speed', 'Writing and reading 64 MB…') },
    { id: 'camera', label: 'Camera', group: 'Hardware', async run() {
      const r = await post('camera');
      if (!r.camera) return sheet('camera', 'Camera', r);
      const img = h('img', { class: 'tm-cam', src: '/api/camera/stream?t=' + Date.now() }), el = layer('tm-full tm-dark', img);
      await verdict('camera', el, 'Do you see a sharp, live picture?');
      img.src = '';   // closing the stream stops the camera
    } },
    { id: 'led', label: 'LED', group: 'Hardware', async run() {
      await post('led', { on: true });
      const el = layer('tm-full tm-dark', h('div', { class: 'tm-big' }, 'The green LED on the Pi should blink now'));
      await verdict('led', el, 'Is the green LED blinking?');
      post('led', { on: false });
    } },
    { id: 'rgb', label: 'RGB LED', group: 'Hardware', async run() {
      const r = await api('/api/led', { cmd: 'test' });
      if (!r.ok) return toast((r.message || 'LED service not running') + '. Fix: sudo systemctl start skyglass-led, pins in /etc/skyglass/led.conf', 6000);
      const el = layer('tm-full tm-dark', h('div', { class: 'tm-big' }, 'The RGB LED should light red, green, blue, then white'));
      await verdict('rgb', el, 'Did every colour light up, in that order?');
    } },
    { id: 'buttons', label: 'Buttons & keys', group: 'Hardware', run() {
      const el = layer('tm-full tm-dark'), info = h('div', { class: 'tm-big' }, 'Press the power button (short and long), or keys on a keyboard'), log = h('div', { class: 'tm-keys' });
      el.append(info, log);
      const add = t => { log.prepend(h('span', {}, t)); tone('click'); };
      window.SG_KEYHOOK = type => { if (type === 'power-short') add('⏻ short press'); else if (type === 'power-long') add('⏻ long press'); else return false; return true; };
      const kd = e => { e.preventDefault(); e.stopPropagation(); add(e.key === ' ' ? 'Space' : e.key); };
      addEventListener('keydown', kd, true);
      verdict('buttons', el, 'Did every press show up?').then(() => { window.SG_KEYHOOK = null; removeEventListener('keydown', kd, true); });
    } },
    // radios
    { id: 'wifi', label: 'Wi-Fi', group: 'Radios', run: () => auto('wifi', 'Wi-Fi & internet', 'Pinging the router and the internet…') },
    { id: 'bluetooth', label: 'Bluetooth', group: 'Radios', run: () => auto('bluetooth', 'Bluetooth', 'Looking for devices nearby (6 s)…') },
    { id: 'modem', label: '4G modem', group: 'Radios', run: () => auto('modem', '4G modem & SIM') },
    { id: 'usb', label: 'USB', group: 'Radios', run: () => auto('usb', 'USB devices') },
    { id: 'info', label: 'Version & IDs', group: 'Radios', run: () => auto('info', 'Version & IDs') },
  ];
  const AUTO_ALL = ['sensors', 'power', 'audio', 'storage', 'wifi', 'bluetooth', 'modem', 'camera', 'usb'];

  function fitCanvas(cv) { const r = root.getBoundingClientRect(); cv.width = r.width; cv.height = r.height; return cv.getContext('2d'); }
  function pos(cv, e) { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * cv.width / r.width, (e.clientY - r.top) * cv.height / r.height]; }
  function place(d, e) { const r = d.parentNode.getBoundingClientRect(), z = r.width / d.parentNode.offsetWidth || 1; d.style.left = (e.clientX - r.left) / z + 'px'; d.style.top = (e.clientY - r.top) / z + 'px'; }

  async function runAll(btn) {
    btn.disabled = true;
    for (const id of AUTO_ALL) {
      btn.textContent = 'Testing ' + TESTS.find(t => t.id === id).label + '…';
      const r = await post(id); mark(id, r.ok);
      if (!root) return;
    }
    const good = AUTO_ALL.filter(id => RES[id] === true).length, bad = AUTO_ALL.filter(id => RES[id] === false);
    btn.disabled = false; btn.textContent = 'Run automatic tests';
    sheet('all', 'Automatic tests', { ok: bad.length ? false : true, rows: [['Works', String(good)], ['Problems', bad.length ? bad.map(id => TESTS.find(t => t.id === id).label).join(', ') : 'none'],
      ['Not judged', String(AUTO_ALL.length - good - bad.length) + ' (not fitted or info only)']] });
  }

  function close() {
    if (!root) return;
    window.SG_KEYHOOK = null; post('led', { on: false }).catch(() => {});
    root.remove(); root = grid = null; removeEventListener('keydown', esc, true);
  }
  const esc = e => { if (e.key === 'Escape' && root) { e.stopPropagation(); const layers = root.querySelectorAll('.tm-layer'); layers.length ? layers[layers.length - 1].remove() : close(); } };

  window.SG_TESTMODE = function open() {
    if (root) return;
    OSK.hide(); closeQuick();
    const groups = [...new Set(TESTS.map(t => t.group))];
    grid = h('div', { class: 'tm-grid' }, groups.flatMap(g => [h('div', { class: 'tm-group' }, g),
      ...TESTS.filter(t => t.group === g).map(t => h('button', { class: 'tm-tile' + (RES[t.id] === true ? ' pass' : RES[t.id] === false ? ' fail' : ''), 'data-t': t.id,
        onclick: () => { try { const p = t.run(); if (p && p.catch) p.catch(e => toast('Test failed: ' + e.message)); } catch (e) { toast('Test failed: ' + e.message); } } }, t.label))]));
    const allBtn = h('button', { class: 'btn primary', onclick: e => runAll(e.currentTarget) }, 'Run automatic tests');
    root = h('div', { class: 'tm' },
      h('div', { class: 'tm-head' }, h('b', {}, 'Test mode'), h('span', {}, '*#0*#'), allBtn, h('button', { class: 'orb close', html: svg('close'), onclick: close })),
      h('div', { class: 'tm-scroll' }, grid));
    $('#phone').append(root);
    addEventListener('keydown', esc, true);
  };
})();
