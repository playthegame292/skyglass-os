/* Skyglass OS shell — Frutiger Aero phone UI. No frameworks, no build step. */
'use strict';

// ============================================================ helpers
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}
async function api(path, body) {
  try {
    const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return await r.json();
  } catch (e) { return { error: String(e) }; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad2 = n => String(n).padStart(2, '0');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Power: touching the DOM makes Chromium restyle/repaint, so periodic updates only write what changed
function setText(el, v) { if (el && el.textContent !== v) el.textContent = v; }
function setStyle(el, prop, v) { if (el && el.style[prop] !== v) el.style[prop] = v; }
// Power: an app left open (clock, games, monitor, 3D viewer…) would keep drawing 60 frames a second
// behind the lock screen, the screensaver or a sleeping screen. While the phone is locked or asleep,
// animation frames requested by apps wait (checked every 300 ms) instead. The shell's own lock-screen
// bubbles and screensaver use RAF_SHELL, the untouched original.
const RAF_SHELL = window.requestAnimationFrame.bind(window), CAF_SHELL = window.cancelAnimationFrame.bind(window);
(function pauseAppsWhileLocked() {
  const held = new Map(); let seq = 1e7;   // our ids start far above the browser's own
  const paused = () => { let a = false; try { a = asleep; } catch (e) { } const ph = document.getElementById('phone'); return a || !!(ph && ph.classList.contains('locked')); };
  window.requestAnimationFrame = cb => {
    if (!paused()) return RAF_SHELL(cb);
    const id = ++seq;
    const check = () => { if (!held.has(id)) return; if (paused()) return held.set(id, setTimeout(check, 300)); held.delete(id); cb(performance.now()); };
    held.set(id, setTimeout(check, 300));
    return id;
  };
  window.cancelAnimationFrame = id => { if (held.has(id)) { clearTimeout(held.get(id)); held.delete(id); } else CAF_SHELL(id); };
})();

// ============================================================ fit to screen
// Skyglass is laid out for a 600x1024 phone; smaller panels (the 480x800 Freenove DSI) get zoomed down.
// Tablet (landscape) gets its own layout, sized for a ~1000x620 screen.
function fitZoom() {
  const forced = parseFloat(new URLSearchParams(location.search).get('scale'));
  const tablet = innerWidth > innerHeight * 1.1;
  document.documentElement.classList.toggle('tablet', tablet);
  const ts = window.SG_TEXT_SIZE || 1; // set by applySettings (settings load after this runs)
  const z = (forced > 0 ? forced : tablet ? Math.min(1, innerWidth / 1000, innerHeight / 620) : Math.min(1, innerWidth / 600, innerHeight / 1024)) * ts;
  setStyle(document.documentElement, 'zoom', String(z));  // same zoom again would relayout the whole page
}
fitZoom();
addEventListener('resize', fitZoom);

// ============================================================ settings
const DEFAULTS = { theme: 'sky', glass: null, bubbles: true, fish: true, brightness: 100, volume: 60, clicks: true,
  eggs: { aquarium: false, aurora: false }, rotation: 0, sleepAfter: 300, saverAfter: 60, saverStyle: 'bubbles', camTo: 'phone', camHQ: false, clock24: true, textSize: 1, reduceMotion: false, boldText: false, lockTips: true, wallpaper: 'hills',
  dnd: false, notifBanners: true, notifSound: true, notifWake: true, notifLock: true, notifLockContent: true, notifMuted: {}, torchColor: 'white', torchLevel: 1, partyFx: 'rainbow', partyColor: null, partySpeed: 1 };
function loadJSON(key, fallback) {  // corrupt storage must never stop the phone from booting
  try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch (e) { localStorage.removeItem(key); return fallback; }
}
// the backend's copy (window.SG_SAVED, from /api/settings.js) survives a killed browser; localStorage is the fallback
const SAVED = window.SG_SAVED && typeof window.SG_SAVED === 'object' ? window.SG_SAVED : null;
const S = Object.assign({}, DEFAULTS, SAVED || loadJSON('sg.settings', {}));
let ON_DEVICE = false;
S.eggs = Object.assign({}, DEFAULTS.eggs, S.eggs);
if (!SAVED) setTimeout(persist, 3000);  // first run with a backend copy: seed it from localStorage
let persistTimer = 0;
function persist() {  // localStorage now, the backend's disk copy half a second later (one write per burst)
  localStorage.setItem('sg.settings', JSON.stringify(S));
  clearTimeout(persistTimer); persistTimer = setTimeout(() => api('/api/settings', { settings: S }), 500);
}
function save() { persist(); applySettings(); }
function applySettings() {
  const glassOn = S.glass ?? !ON_DEVICE;
  const cls = 'theme-' + S.theme + ' wall-' + (S.wallpaper || 'hills') + (glassOn ? '' : ' no-glass') + (ON_DEVICE ? ' device' : '') + (S.boldText ? ' bold' : '');
  if (document.body.className !== cls) document.body.className = cls;   // rewriting it restyles every element
  const img = S.wallpaper === 'custom' ? `url("/api/wallpaper?v=${encodeURIComponent(S.wallV || 0)}")` : '';
  setStyle($('#wall'), 'backgroundImage', img);
  $('#phone').classList.toggle('still', !!S.reduceMotion);
  setStyle($('#l-card'), 'display', S.lockTips === false ? 'none' : '');
  window.SG_TEXT_SIZE = +S.textSize || 1; fitZoom();
  setStyle($('#bubbles'), 'display', S.bubbles ? '' : 'none');
  setStyle($('#fish'), 'display', S.eggs.aquarium && S.fish ? '' : 'none');
  $$('.qt').forEach(b => b.classList.toggle('on', !!{ glass: S.glass ?? !ON_DEVICE, bubbles: S.bubbles, wifi: STATUS.wifi && STATUS.wifi.connected }[b.dataset.q]));
}

// ============================================================ icons
const ICONS = {
  phone: '<path class="f" d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1z"/>',
  messages: '<path d="M21 11.5a8.4 8.4 0 0 1-12.3 7.4L3 20.5l1.6-5.2A8.5 8.5 0 1 1 21 11.5z"/>',
  browser: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3.5 9h17M3.5 15h17"/>',
  bluetooth: '<path d="M7 7l10 10-5 4V3l5 4L7 17"/>',
  access: '<circle cx="12" cy="4.5" r="2"/><path d="M4 8.5l8 1.5 8-1.5M12 10v4.5M12 14.5l-3.5 6.5M12 14.5l3.5 6.5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  trash: '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/><path d="M10 11v6M14 11v6"/>',
  sun: '<circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/>',
  music: '<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 17.5h.01M12 17.5h.01" stroke-width="2.6"/>',
  brush: '<path d="M14.5 4.5l5 5-8 8-5-5z"/><path d="M6.5 12.5c-2 0-3.5 1.5-3.5 4 0 1.5-.5 2.5-1 3 3 0 7-1 7-4.5"/>',
  chart: '<path d="M3 20h18"/><path d="M5 16l4-5 4 3 6-8"/>',
  games: '<rect x="2.5" y="7" width="19" height="11" rx="5.5"/><path d="M7.5 10.5v4M5.5 12.5h4"/><path d="M15.5 11.5h.01M18 13.5h.01" stroke-width="2.8"/>',
  play: '<path class="f" d="M7 4.5v15l13-7.5z"/>',
  pause: '<path class="f" d="M6 4.5h4v15H6zM14 4.5h4v15h-4z"/>',
  next: '<path class="f" d="M5 5v14l10-7z"/><path d="M18 5v14"/>',
  prev: '<path class="f" d="M19 5v14L9 12z"/><path d="M6 5v14"/>',
  shuffle: '<path d="M3 7h3.5c5 0 6 10 11 10H21M3 17h3.5c2 0 3.2-1.6 4.2-3.5M14 9.5c1-1.5 2-2.5 3.5-2.5H21"/><path d="M18.5 4.5L21 7l-2.5 2.5M18.5 14.5L21 17l-2.5 2.5"/>',
  rotate: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4.5V11h-6.5"/>',
  flip: '<path d="M12 3v18"/><path d="M8.5 7L3 17h5.5zM15.5 7L21 17h-5.5z"/>',
  crop: '<path d="M6 2.5V18h15.5"/><path d="M2.5 6H18v15.5"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M18.5 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
  mute: '<path d="M4 9.5h3.5L12 5v14l-4.5-4.5H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
  sound: '<path d="M4 9.5h3.5L12 5v14l-4.5-4.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  device: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>',
  usb: '<path d="M8 3h8v6H8zM6 9h12v6a6 6 0 0 1-12 0z"/><path d="M10.5 5.5h.01M13.5 5.5h.01" stroke-width="2.6"/>',
  video: '<rect x="2.5" y="6" width="13" height="12" rx="2.5"/><path d="M15.5 10.5l6-3.5v10l-6-3.5z"/>',
  eject: '<path d="M12 4l8 9H4z"/><path d="M4 18h16"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/>',
  cube: '<path d="M12 2.8l8 4.6v9.2l-8 4.6-8-4.6V7.4z"/><path d="M4 7.4l8 4.6 8-4.6M12 12v9.2"/>',
  camera: '<path d="M3 8.5a2 2 0 0 1 2-2h2.2l1.6-2.2h6.4l1.6 2.2H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="3.8"/>',
  settings: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  terminal: '<path d="M5 7l5 5-5 5M12 18h7"/>',
  files: '<path d="M3 7a2 2 0 0 1 2-2h4.5l2 2.5H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  file: '<path d="M6 3h8l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5"/>',
  photos: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="M21 16l-5.5-5.5L5 20"/>',
  notes: '<path d="M6 3h9l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M8.5 11h7M8.5 15h7M8.5 7h4"/>',
  calc: '<rect x="5" y="2.5" width="14" height="19" rx="2.5"/><rect x="8" y="5.5" width="8" height="3.5" rx=".8"/><path d="M8.5 13h.01M12 13h.01M15.5 13h.01M8.5 17h.01M12 17h.01M15.5 17h.01" stroke-width="2.8"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  torch: '<path d="M8 3h8l-1.5 6.5h-5zM9.5 9.5h5l-1 11h-3zM12 13v2.5"/>',
  party: '<path d="M4 20l5-13 8 8zM9 7l8 8"/><path d="M14 4.5l.01 0M19.5 9.5l.01 0M18 3.5l.01 0M20.5 5.5l.01 0M15.5 2.5l.01 0" stroke-width="2.6"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  battery: '<rect x="3" y="7" width="16" height="10" rx="2"/><path d="M21 10.5v3M6 10v4M9 10v4"/>',
  download: '<path d="M12 3.5v11M7.5 10l4.5 4.5 4.5-4.5M4.5 19.5h15"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 9.5h.01M9 9.5h.01M12 9.5h.01M15 9.5h.01M18 9.5h.01M6 12.5h.01M18 12.5h.01M8 15h8" stroke-width="2.2"/>',
  hotspot: '<circle class="f" cx="12" cy="12" r="1.8"/><path d="M8.5 15.5a5 5 0 0 1 0-7M15.5 8.5a5 5 0 0 1 0 7M5.5 18.5a9.2 9.2 0 0 1 0-13M18.5 5.5a9.2 9.2 0 0 1 0 13"/>',
  android: '<path d="M5 17V11a7 7 0 0 1 14 0v6a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 17zM7.5 5.5 6 3.5M16.5 5.5 18 3.5M5 13h14"/><circle class="f" cx="9.5" cy="9.5" r="1"/><circle class="f" cx="14.5" cy="9.5" r="1"/>',
  linux: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
  fish: '<path d="M2.5 12c3-4.5 9-6 13.5-2L21 6.5v11L16 14c-4.5 4-10.5 2.5-13.5-2z"/><circle class="f" cx="7" cy="11" r="1.1"/>',
  wifi: '<path d="M2 9a15 15 0 0 1 20 0M5 12.5a10.5 10.5 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0"/><circle class="f" cx="12" cy="19.5" r="1.3"/>',
  drop: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
  bubble: '<circle cx="10" cy="13" r="6"/><circle cx="17.5" cy="6.5" r="3"/><path d="M7.5 11a3 3 0 0 1 2.5-2"/>',
  rotate: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  speaker: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  power: '<path d="M12 3v9"/><path d="M6.3 6.3a8 8 0 1 0 11.4 0"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  backspace: '<path d="M9 5h11a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H9l-6-7z"/><path d="M12 9.5l5 5M17 9.5l-5 5"/>',
  send: '<path d="M3 11l18-8-8 18-2-8z"/>',
  display: '<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>',
  code: '<path d="M8 7l-5 5 5 5M16 7l5 5-5 5"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/>',
};
const svg = (name, extra = '') => `<svg viewBox="0 0 24 24" ${extra}>${ICONS[name] || ''}</svg>`;
$$('[data-icon]').forEach(i => (i.innerHTML = svg(i.dataset.icon, 'fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"')));

// ============================================================ sound (tiny synths, no audio files)
let AC;
function tone(kind) {
  try {
    AC = AC || new AudioContext();
    const o = AC.createOscillator(), g = AC.createGain(), t = AC.currentTime;
    o.connect(g); g.connect(AC.destination);
    if (kind === 'pop') { o.frequency.setValueAtTime(900 + Math.random() * 500, t); o.frequency.exponentialRampToValueAtTime(120, t + .08); g.gain.setValueAtTime(.35, t); g.gain.exponentialRampToValueAtTime(.001, t + .1); o.stop(t + .12); }
    else if (kind === 'click') { o.type = 'triangle'; o.frequency.setValueAtTime(1600, t); g.gain.setValueAtTime(.05, t); g.gain.exponentialRampToValueAtTime(.001, t + .03); o.stop(t + .04); }
    else { // bloop / chime
      o.type = 'sine'; o.frequency.setValueAtTime(520, t); o.frequency.exponentialRampToValueAtTime(1040, t + .18);
      g.gain.setValueAtTime(.001, t); g.gain.exponentialRampToValueAtTime(.2, t + .03); g.gain.exponentialRampToValueAtTime(.001, t + .5); o.stop(t + .55);
    }
    o.start(t);
  } catch (e) { /* audio is optional */ }
}

// ---------------------------------------------------------------- RGB LED: flashlight, notification light, party
// skyglass-ledd drives the LED; the backend passes our commands on (/api/led).
const LIGHT = (() => {
  const NOTIFY_COLORS = { Messages: 'green', Battery: 'red', Updates: 'blue', Android: '#9be000' };
  let torchOn = false, notifyOn = false, partyOn = false, beatTimer = null;
  const led = b => api('/api/led', b);
  function torch(on) {
    torchOn = on;
    $$('.qt').forEach(q => q.dataset.q === 'torch' && q.classList.toggle('on', on));
    dispatchEvent(new Event('sg-light'));
    return on ? led({ cmd: 'set', layer: 'flashlight', effect: 'solid', color: S.torchColor, brightness: S.torchLevel })
              : led({ cmd: 'clear', layer: 'flashlight' });
  }
  function party(fx) {
    partyOn = !!fx;
    clearInterval(beatTimer); beatTimer = null;
    if (!fx) { dispatchEvent(new Event('sg-light')); return led({ cmd: 'clear', layer: 'party' }); }
    S.partyFx = fx; save();
    if (fx === 'music') beatTimer = setInterval(() => {   // the Music app's analyser drives the LED
      const a = MUSIC.levels(); if (!a || MUSIC.audio.paused) return led({ cmd: 'beat', level: 0 });
      let bass = 0; for (let i = 0; i < 6; i++) bass = Math.max(bass, a[i]);
      led({ cmd: 'beat', level: Math.pow(bass / 255, 1.6) });
    }, 60);
    dispatchEvent(new Event('sg-light'));
    return led({ cmd: 'set', layer: 'party', effect: fx, color: S.partyColor || undefined, speed: S.partySpeed });
  }
  return {
    get torchOn() { return torchOn; }, get notifyOn() { return notifyOn; }, get partyOn() { return partyOn; },
    torch, party,
    sos() { torchOn = true; $$('.qt').forEach(q => q.dataset.q === 'torch' && q.classList.toggle('on', true)); dispatchEvent(new Event('sg-light'));
      return led({ cmd: 'set', layer: 'flashlight', effect: 'sos', color: S.torchColor }); },
    notify(n) {
      if (S.dnd && n.urgency !== 'critical') return;
      if (n.urgency === 'low') return;   // quiet info ("update installed"): list only, no light
      notifyOn = true;
      led({ cmd: 'set', layer: 'notify', effect: 'flash', color: NOTIFY_COLORS[n.app] || 'aqua' });
    },
    notifyOff() { notifyOn = false; led({ cmd: 'clear', layer: 'notify' }); },
    egg(fx, secs) { led({ cmd: 'set', layer: 'egg', effect: fx, ttl: secs, speed: 1.5 }); },
    async sync() {   // after a UI restart: show what the LED is really doing
      const r = await api('/api/led');
      if (r && r.layers) { torchOn = !!r.layers.flashlight; partyOn = !!r.layers.party; notifyOn = !!r.layers.notify; if (notifyOn) setTimeout(renderNotifs, 0); $$('.qt').forEach(q => q.dataset.q === 'torch' && q.classList.toggle('on', torchOn)); }
      return r;
    },
  };
})();
setTimeout(() => LIGHT.sync(), 1500);

// ============================================================ toast / modal
function toast(msg, ms) {
  const t = h('div', { class: 'toast glass' }, msg);
  if (ms) t.style.animationDuration = ms + 'ms';
  $('#toasts').append(t);
  setTimeout(() => t.remove(), ms || 3200);
}
function modal(title, content, buttons = [{ label: 'OK', primary: true }]) {
  return new Promise(resolve => {
    const bg = h('div', { class: 'modal-bg' });
    const close = v => { bg.remove(); OSK.hide(); resolve(v); };
    const box = h('div', { class: 'modal glass' }, h('h2', {}, title), content,
      h('div', { class: 'row-btns' }, buttons.map(b => h('button', { class: 'btn ' + (b.primary ? 'primary' : '') + (b.danger ? ' danger' : ''), onclick: () => close(b.value ?? b.label) }, b.label))));
    bg.addEventListener('pointerdown', e => { if (e.target === bg) close(null); });
    bg.append(box);
    $('#modal-root').append(bg);
  });
}
function kv(obj) { return h('div', { class: 'kv' }, Object.entries(obj).flatMap(([k, v]) => [h('b', {}, k), h('span', {}, String(v))])); }

// ============================================================ clock & status
let STATUS = {};
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function tick() {
  const d = new Date();
  const hm = S.clock24 === false ? `${d.getHours() % 12 || 12}:${pad2(d.getMinutes())}${d.getHours() < 12 ? ' AM' : ' PM'}` : `${d.getHours()}:${pad2(d.getMinutes())}`;
  const date = `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
  // easter egg: at 3:14 the status bar clock turns into pi
  setText($('#sb-time'), (d.getHours() % 12 === 3 && d.getMinutes() === 14) ? 'π' : hm);
  setText($('#l-time'), hm); setText($('#w-clock'), hm);
  setText($('#l-date'), date); setText($('#w-date'), date); setText($('#q-date'), date);
}
// wake up once per minute (on the minute) instead of every second: the clock shows no seconds
function clockLoop() { tick(); setTimeout(clockLoop, 60000 - Date.now() % 60000 + 30); }
async function pollStatus() {
  tick();  // cheap (writes only on change); catches time zone changes and NTP jumps
  const s = await api('/api/status');
  if (s.error) return;
  STATUS = s;
  const w = $('#sb-wifi'), off = !s.wifi || !s.wifi.connected;
  w.classList.toggle('off', off);
  w.classList.toggle('s1', !off && s.wifi.signal < 40);
  w.classList.toggle('s2', !off && s.wifi.signal >= 40 && s.wifi.signal < 70);
  const b = s.battery || {};
  setStyle($('#sb-batt .fill'), 'width', (b.percent ?? 100) + '%');
  setText($('#sb-batt-pct'), b.present && b.percent != null ? b.percent + '%' : '');
  // the charging shimmer repaints every frame: only when a real battery is charging (not on mains power)
  $('#sb-batt').classList.toggle('charging', !!(b.present && b.charging && b.percent !== 100));
  $('#sb-modem').classList.toggle('hidden', !s.modem);
  setText($('#w-info'), s.wifi && s.wifi.connected ? s.wifi.ssid : 'Offline');
  $$('.qt').forEach(q => q.dataset.q === 'wifi' && q.classList.toggle('on', !off));
}
async function pollAbout() {
  const a = await api('/api/about');
  if (a.cpu_temp != null) $('#q-temp').textContent = a.cpu_temp + ' °C';
}

// events from the backend (hardware power button, native apps)
async function eventLoop() {
  let since = 0;
  const first = await api('/api/events?since=999999999');
  since = first.last || 0;
  for (;;) {
    const r = await api('/api/events?since=' + since);
    if (r.error) { await sleep(2000); continue; }
    since = r.last;
    for (const e of r.events) {
      if (e.type === 'home') goHome();
      else if ((e.type === 'power-short' || e.type === 'power-long') && window.SG_KEYHOOK && !asleep && window.SG_KEYHOOK(e.type)) continue;  // test mode's button test
      else if (e.type === 'power-short') { asleep ? wake() : sleepScreen(); }
      else if (e.type === 'power-long') powerMenu();
      else if (e.type === 'calibrate') touchCalibrate();
      else if (e.type === 'wallpaper' && S.wallV !== e.v) { S.wallpaper = 'custom'; S.wallV = e.v; S.wallSrc = e.path; save(); }
      else if (e.type === 'usb-added') { toast(e.ok ? `💾 USB drive “${e.label}” connected` : `USB drive “${e.label}”: ${e.message}`, 4000); dispatchEvent(new Event('sg-usb')); }
      else if (e.type === 'rec-stopped') toast('⚠️ ' + e.message, 5000);
      else if (e.type === 'notify') onNotify(e.n);
      else if (e.type === 'notify-dismiss') refreshNotifs();
      else if (e.type === 'usb-removed') { toast(`USB drive “${e.label}” removed`); dispatchEvent(new Event('sg-usb')); }
    }
  }
}

// ============================================================ notifications
// The backend keeps the list (SMS, battery, updates, Android, Linux apps over D-Bus, skyglass-notify).
// Here: banners, the list in the pull-down, the lock screen, the badge, Do Not Disturb.
let NOTIFS = [];
const notifShown = n => !(S.notifMuted || {})[n.app];
function agoText(t) {
  const d = Math.max(0, Date.now() / 1000 - t);
  if (d < 60) return 'now';
  if (d < 3600) return Math.floor(d / 60) + ' min';
  if (d < 86400) return Math.floor(d / 3600) + ' h';
  return new Date(t * 1000).toLocaleDateString([], { day: 'numeric', month: 'short' });
}
function notifCard(n, { hideContent = false, banner = false } = {}) {
  const ic = ICONS[n.icon] ? n.icon : ICONS[(n.app || '').toLowerCase()] ? n.app.toLowerCase() : 'bell';
  const x = h('button', { class: 'n-x', html: svg('close'), onclick: e => { e.stopPropagation(); dismissNotif(n, card); } });
  const card = h('div', { class: 'ncard glass' + (n.urgency === 'critical' ? ' critical' : ''), onclick: () => openNotif(n, card) },
    h('span', { class: 'n-ic', html: svg(ic) }),
    h('div', { class: 'n-main' },
      h('div', { class: 'n-top' }, h('span', {}, n.app), h('span', { class: 'n-time' }, agoText(n.time))),
      h('div', { class: 'n-title' }, hideContent ? n.app : n.title || n.app),
      !hideContent && n.body ? h('div', { class: 'n-body' }, n.body) : hideContent ? h('div', { class: 'n-body' }, 'Unlock to see') : null),
    banner ? null : x);
  if (banner) {  // swipe a banner up to put it away
    let y0 = null;
    card.addEventListener('pointerdown', e => (y0 = e.clientY));
    card.addEventListener('pointerup', e => { if (y0 != null && y0 - e.clientY > 25) { e.stopPropagation(); hideBanner(card); } y0 = null; });
  }
  return card;
}
function hideBanner(card) { card.classList.add('out'); setTimeout(() => card.remove(), 320); }
async function dismissNotif(n, card) {
  if (card) card.remove();
  NOTIFS = NOTIFS.filter(x => x.id !== n.id); renderNotifs();
  api('/api/notifications/dismiss', { id: n.id });
}
function openNotif(n, card) {
  if (card && card.parentNode && card.parentNode.id === 'banners') hideBanner(card);
  const go = () => { closeQuick(); if (n.open && APPS[n.open]) openApp(n.open); dismissNotif(n); };
  if (!lockEl.classList.contains('gone')) { AFTER_UNLOCK = go; requestUnlock(); } else go();
}
function renderNotifs() {
  const list = NOTIFS.filter(notifShown);
  const unread = list.filter(n => !n.read).length;
  // the LED blips only for unread notifications that may light it (quiet "low" ones never do)
  if (LIGHT.notifyOn && !list.some(n => !n.read && n.urgency !== 'low')) LIGHT.notifyOff();
  const badge = $('#sb-notif');
  badge.classList.toggle('hidden', !unread); badge.textContent = unread > 9 ? '9+' : unread;
  $('#sb-dnd').classList.toggle('hidden', !S.dnd);
  $$('.qt').forEach(q => q.dataset.q === 'dnd' && q.classList.toggle('on', !!S.dnd));
  const q = $('#q-notifs'); q.innerHTML = '';
  if (list.length) q.append(h('div', { class: 'n-head' }, h('span', {}, 'Notifications'),
    h('button', { class: 'pill', onclick: () => { NOTIFS = []; renderNotifs(); api('/api/notifications/dismiss', {}); } }, 'Clear all')),
    ...list.slice(0, 30).map(n => notifCard(n)));
  const l = $('#l-notifs'); l.innerHTML = '';
  if (S.notifLock) l.append(...list.filter(n => !n.read).slice(0, 3).map(n => notifCard(n, { hideContent: !S.notifLockContent })));
  setStyle($('#l-card'), 'display', S.lockTips === false || (S.notifLock && list.some(n => !n.read)) ? 'none' : '');
}
async function refreshNotifs() {
  const r = await api('/api/notifications');
  if (r.items) { NOTIFS = r.items; renderNotifs(); }
}
function onNotify(n) {
  if (!n) return;
  NOTIFS = [n, ...NOTIFS.filter(x => x.id !== n.id && !(n.key && x.key === n.key))];
  renderNotifs();
  if (!notifShown(n)) return;
  const quiet = S.dnd && n.urgency !== 'critical';   // critical ones (battery almost empty) get through
  if (quiet) return;
  if (asleep && S.notifWake) wake();
  if (S.notifSound) tone('chime');
  LIGHT.notify(n);
  if (S.notifBanners && lockEl.classList.contains('gone') && !quick.classList.contains('open')) {
    const card = notifCard(n, { banner: true });
    $('#banners').append(card);
    while ($('#banners').children.length > 2) $('#banners').firstChild.remove();
    setTimeout(() => card.isConnected && hideBanner(card), n.urgency === 'critical' ? 9000 : 5000);
  }
}
function markNotifsRead() {
  if (!NOTIFS.some(n => !n.read)) return;
  NOTIFS.forEach(n => (n.read = true)); renderNotifs(); api('/api/notifications/read', {});
}
setInterval(() => { if (!asleep && quick.classList.contains('open')) renderNotifs(); }, 60000);  // keeps "5 min" fresh

// ============================================================ wallpaper life: bubbles + fish
const bubbleCv = $('#bubbles'), fishCv = $('#fish');
let bubbles = [], fishes = [], food = [], bubbleBoost = 1;
function resizeCanvases() {
  for (const c of [bubbleCv, fishCv]) { c.width = innerWidth; c.height = innerHeight; }
}
function makeBubble(y) {
  const r = 6 + Math.random() * 26;
  return { x: Math.random() * innerWidth, y: y ?? innerHeight + r, r, v: .25 + Math.random() * .6, w: Math.random() * 6.28 };
}
function makeFish() {
  const dir = Math.random() < .5 ? 1 : -1;
  return { x: Math.random() * innerWidth, y: innerHeight * (.25 + Math.random() * .5), dir, v: .6 + Math.random() * .9, s: 14 + Math.random() * 16,
    hue: [18, 35, 200, 280, 50][Math.floor(Math.random() * 5)], ph: Math.random() * 6 };
}
// The bubble look is the same at any size, so it is painted once into a sprite and stamped with
// drawImage (one cheap blit per bubble instead of building a radial gradient every frame).
let BUBBLE_SPRITE = null;
function bubbleSprite() {
  if (BUBBLE_SPRITE) return BUBBLE_SPRITE;
  const R = 64, c = document.createElement('canvas'); c.width = c.height = R * 2;
  const x = c.getContext('2d'), g = x.createRadialGradient(R - R * .35, R - R * .4, R * .1, R, R, R);
  g.addColorStop(0, 'rgba(255,255,255,.9)'); g.addColorStop(.25, 'rgba(255,255,255,.25)');
  g.addColorStop(.85, 'rgba(180,230,255,.15)'); g.addColorStop(1, 'rgba(255,255,255,.6)');
  x.fillStyle = g; x.beginPath(); x.arc(R, R, R, 0, 7); x.fill();
  return (BUBBLE_SPRITE = c);
}
function drawBubble(ctx, b) { ctx.drawImage(bubbleSprite(), b.x - b.r, b.y - b.r, b.r * 2, b.r * 2); }
function drawFish(ctx, f, t) {
  ctx.save(); ctx.translate(f.x, f.y + Math.sin(t / 600 + f.ph) * 6); ctx.scale(f.dir, 1);
  const s = f.s, wag = Math.sin(t / 120 + f.ph) * .25;
  const g = ctx.createLinearGradient(0, -s, 0, s);
  g.addColorStop(0, `hsl(${f.hue} 100% 75%)`); g.addColorStop(.5, `hsl(${f.hue} 95% 55%)`); g.addColorStop(1, `hsl(${f.hue} 90% 38%)`);
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.moveTo(-s * .9, 0); ctx.lineTo(-s * 1.7, -s * .6 + wag * s); ctx.lineTo(-s * 1.7, s * .6 + wag * s); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.ellipse(0, 0, s, s * .58, 0, 0, 7); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.beginPath(); ctx.ellipse(s * .1, -s * .25, s * .6, s * .18, 0, 0, 7); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(s * .55, -s * .1, s * .16, 0, 7); ctx.fill();
  ctx.fillStyle = '#012'; ctx.beginPath(); ctx.arc(s * .6, -s * .1, s * .08, 0, 7); ctx.fill();
  ctx.restore();
}
function stepFish(list, W, t, foodList, k = 1) {  // k: how many 30 fps frames this step covers
  for (const f of list) {
    const target = foodList && foodList[0];
    if (target) {
      const dx = target.x - f.x, dy = target.y - f.y, d = Math.hypot(dx, dy);
      f.dir = dx > 0 ? 1 : -1; f.x += dx / d * 2.2 * k; f.y += dy / d * 2.2 * k;
      if (d < f.s) { foodList.shift(); f.s = Math.min(f.s + 1.5, 46); tone('pop'); }
    } else {
      f.x += f.v * f.dir * k;
      if (f.x > W + 60) f.dir = -1; if (f.x < -60) f.dir = 1;
    }
  }
}
// Paced by a timer, not by requestAnimationFrame: an idle rAF loop still wakes the renderer and GPU
// 60 times a second. While nothing can be seen it only checks back twice a second.
const WALL_FPS = () => (ON_DEVICE ? 20 : 30);
let lastWall = 0;
function wallVisible() {
  const covered = CURRENT && !$('#phone').classList.contains('locked');
  return !covered && !document.hidden && !asleep && !saverOn && (S.bubbles || (S.eggs.aquarium && S.fish));
}
function wallLoop() {
  if (!wallVisible()) { lastWall = 0; return setTimeout(wallLoop, 500); }
  RAF_SHELL(t => {
    wallFrame(t);
    setTimeout(wallLoop, Math.max(0, 1000 / WALL_FPS() - (performance.now() - t) - 2));
  });
}
function wallFrame(t) {
  const k = lastWall ? Math.min(3, (t - lastWall) / 33.3) : 1;   // speeds are tuned per 30 fps frame
  lastWall = t;
  if (S.bubbles) {
    const bc = bubbleCv.getContext('2d');
    bc.clearRect(0, 0, bubbleCv.width, bubbleCv.height);
    const want = Math.round((ON_DEVICE ? 9 : 16) * bubbleBoost);
    while (bubbles.length < want) bubbles.push(makeBubble(Math.random() * innerHeight));
    for (const b of bubbles) { b.y -= b.v * k * (bubbleBoost > 1 ? 2.5 : 1); b.x += Math.sin(t / 900 + b.w) * .3 * k; if (b.y < -b.r) Object.assign(b, makeBubble()); drawBubble(bc, b); }
    if (bubbles.length > want) bubbles.length = want;
  }
  if (S.eggs.aquarium && S.fish) {
    const fc = fishCv.getContext('2d');
    fc.clearRect(0, 0, fishCv.width, fishCv.height);
    while (fishes.length < 5) fishes.push(makeFish());
    stepFish(fishes, innerWidth, t, null, k);
    for (const f of fishes) drawFish(fc, f, t);
  }
}

// ============================================================ lock screen + konami
const lockEl = $('#lock');
const LOCK_TIPS = [
  ['Welcome to Skyglass', 'Your phone. Your Linux. No ads, no tracking.'],
  ['Pro tip', 'The power button always brings you home.'],
  ['Fun fact', 'Every app here is running on real Debian. Open the Terminal and look around.'],
  ['Weather report', 'Partly glossy with a 100% chance of bubbles.'],
  ['Did you know?', 'Some things on this phone only show up if you are curious enough.'],
];
function lock() {
  OSK.hide(); closeQuick();
  const [b, s] = LOCK_TIPS[Math.floor(Math.random() * LOCK_TIPS.length)];
  $('#l-card').innerHTML = `<b>${esc(b)}</b><span>${esc(s)}</span>`;
  lockEl.style.transform = ''; lockEl.classList.remove('gone', 'pin-mode'); $('#phone').classList.add('locked');
  $('#l-pin').innerHTML = '';
  renderNotifs();
  restartShimmer();
}
function restartShimmer() { const hint = $('#l-hint'); hint.classList.add('restart'); void hint.offsetWidth; hint.classList.remove('restart'); }
let AFTER_UNLOCK = null;  // e.g. open the app of a notification tapped on the lock screen
function unlock() { if (AFTER_UNLOCK) { const f = AFTER_UNLOCK; AFTER_UNLOCK = null; setTimeout(f, 350); } lockEl.classList.add('gone'); lockEl.classList.remove('pin-mode'); $('#l-pin').innerHTML = ''; $('#phone').classList.remove('locked'); lockEl.style.transform = ''; tone('chime'); }
const KONAMI = ['U', 'U', 'D', 'D', 'L', 'R', 'L', 'R'];
let konamiSeq = [];
function konamiPush(dir) {
  konamiSeq = [...konamiSeq, dir].slice(-KONAMI.length);
  if (konamiSeq.join() === KONAMI.join()) { konamiSeq = []; unlockAurora(); }
}
function unlockAurora() {
  bubbleBoost = 4; setTimeout(() => (bubbleBoost = 1), 6000); LIGHT.egg('rainbow', 6);
  if (!S.eggs.aurora) { S.eggs.aurora = true; S.theme = 'aurora'; save(); toast('Aurora theme unlocked. The northern lights are yours.', 5000); }
  else { S.theme = S.theme === 'aurora' ? 'sky' : 'aurora'; save(); toast('Theme: ' + S.theme); }
  tone('chime');
}
(function lockGestures() {
  let sx = 0, sy = 0, st = 0, down = false;
  lockEl.addEventListener('pointerdown', e => {
    if (lockEl.classList.contains('pin-mode')) return;
    down = true; sx = e.clientX; sy = e.clientY; st = performance.now(); lockEl.style.transition = 'none';
    // keep getting events even if the finger/mouse ends over the status bar or leaves the window
    try { lockEl.setPointerCapture(e.pointerId); } catch (err) { }
  });
  lockEl.addEventListener('pointermove', e => { if (down) { const dy = Math.min(0, e.clientY - sy); lockEl.style.transform = `translateY(${dy}px)`; } });
  const end = e => {
    if (!down) return; down = false; lockEl.style.transition = ''; lockEl.style.transform = '';
    const dx = e.clientX - sx, dy = e.clientY - sy, speed = -dy / Math.max(1, performance.now() - st);
    // unlock on a long drag (20% of the screen) or a quick upward flick
    if (-dy > innerHeight * .2 || (-dy > 150 && speed > .6)) return requestUnlock();
    // tap the "swipe up" pill also works (handy with a mouse)
    if (Math.hypot(dx, dy) < 10 && e.target.closest && e.target.closest('#l-hint')) return requestUnlock();
    // short flicks feed the konami detector
    if (Math.max(Math.abs(dx), Math.abs(dy)) > 40) konamiPush(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'R' : 'L') : (dy > 0 ? 'D' : 'U'));
  };
  lockEl.addEventListener('pointerup', end);
  lockEl.addEventListener('pointercancel', end);
  lockEl.addEventListener('lostpointercapture', e => { if (down) end(e); });
  // keyboard: Enter or Space opens the PIN pad
  addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && !lockEl.classList.contains('gone') && !lockEl.classList.contains('pin-mode')) { e.preventDefault(); requestUnlock(); }
  });
})();
const KEYMAP = { ArrowUp: 'U', ArrowDown: 'D', ArrowLeft: 'L', ArrowRight: 'R' };
let keySeq = [];
addEventListener('keydown', e => {
  keySeq = [...keySeq, KEYMAP[e.key] || e.key.toLowerCase()].slice(-10);
  if (keySeq.join() === [...KONAMI.map(x => x), 'b', 'a'].join()) unlockAurora();
  if (e.key === 'Escape' && !e.defaultPrevented) { if (CURRENT) CURRENT.back(); }
});

// ============================================================ PIN
// pinPad(): glossy number pad. onSubmit(pin, pad) is called when OK is pressed.
let ACTIVE_PAD = null;
function pinPad({ title, sub = '', onSubmit, onCancel, light = false, cancelLabel = 'Cancel' }) {
  let pin = '', busy = false;
  const titleEl = h('div', { class: 'pin-title' }, title), subEl = h('div', { class: 'pin-sub' }, sub);
  const dots = h('div', { class: 'pin-dots' });
  const draw = () => { dots.innerHTML = ''; for (let i = 0; i < Math.max(4, pin.length); i++) dots.append(h('i', { class: i < pin.length ? 'on' : '' })); };
  const press = k => {
    if (busy) return;
    if (S.clicks) tone('click');
    dots.classList.remove('bad');
    if (k === 'del') pin = pin.slice(0, -1);
    else if (k === 'ok') { if (pin.length >= 4) { busy = true; Promise.resolve(onSubmit(pin, pad)).finally(() => (busy = false)); } else pad.error('At least 4 digits'); }
    else if (pin.length < 8) pin += k;
    draw();
  };
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok'];
  const grid = h('div', { class: 'pinpad' }, keys.map(k => h('button', { class: 'pk' + (k.length > 1 ? ' txt' : ''), 'data-k': k, onclick: k === 'del' ? null : () => press(k) },
    k === 'del' ? (onCancel ? '' : 'Delete') : k === 'ok' ? 'OK' : k)));
  const delBtn = $('[data-k=del]', grid);
  // "del" doubles as Cancel while nothing is typed
  const syncDel = () => { if (onCancel) delBtn.textContent = pin ? 'Delete' : cancelLabel; };
  grid.addEventListener('click', syncDel);
  delBtn.onclick = () => { if (!pin && onCancel) onCancel(); else press('del'); syncDel(); };
  const el = h('div', { class: 'pin-wrap' + (light ? ' light' : '') }, titleEl, subEl, dots, grid);
  const pad = {
    el,
    error(msg) { pin = ''; draw(); syncDel(); dots.classList.remove('bad'); void dots.offsetWidth; dots.classList.add('bad'); subEl.textContent = msg; if (navigator.vibrate) navigator.vibrate(200); },
    reset(t, s) { pin = ''; draw(); syncDel(); if (t) titleEl.textContent = t; subEl.textContent = s || ''; },
    disable(sec) {
      $$('.pk', grid).forEach(b => (b.disabled = true));
      const iv = setInterval(() => {
        subEl.textContent = `Too many tries. Try again in ${sec}s`;
        if (--sec < 0) { clearInterval(iv); $$('.pk', grid).forEach(b => (b.disabled = false)); subEl.textContent = 'Enter your PIN'; }
      }, 1000);
    },
    key: e => { if (/^[0-9]$/.test(e.key)) press(e.key); else if (e.key === 'Backspace') press('del'); else if (e.key === 'Enter') press('ok'); else return false; },
  };
  draw(); syncDel();
  ACTIVE_PAD = pad;
  return pad;
}
addEventListener('keydown', e => { if (ACTIVE_PAD && document.body.contains(ACTIVE_PAD.el) && ACTIVE_PAD.key(e) !== false) e.preventDefault(); });

const WEAK_PINS = ['0000', '1111', '1234', '12345', '123456', '2580', '4321', '6969', '1337'];
async function requestUnlock() {
  const r = await api('/api/pin');
  if (r.error) return unlock(); // backend down: never brick the phone
  lockEl.classList.add('pin-mode');
  const host = $('#l-pin');
  host.innerHTML = '';
  const back = () => { host.innerHTML = ''; lockEl.classList.remove('pin-mode'); };
  if (!r.set) return host.append(choosePin({ onDone: unlock, onCancel: back }).el);
  const pad = pinPad({
    title: 'Enter PIN', onCancel: back,
    async onSubmit(pin, p) {
      const v = await api('/api/pin/verify', { pin });
      if (v.ok) return unlock();
      if (v.locked_for) return (p.error('Too many tries'), p.disable(v.locked_for));
      p.error(v.tries_left != null ? `Wrong PIN · ${v.tries_left} ${v.tries_left === 1 ? 'try' : 'tries'} left` : 'Wrong PIN');
    },
  });
  host.append(pad.el);
  if (r.locked_for) pad.disable(r.locked_for);
}
// choose + confirm a new PIN. `old` = current PIN when changing it.
function choosePin({ onDone, onCancel, light = false, old = null, first = !old }) {
  let firstPin = null;
  const pad = pinPad({
    light, onCancel,
    title: first ? 'Choose your PIN' : 'New PIN',
    sub: first ? '4–8 digits. You will need it every time you unlock.' : '4–8 digits',
    async onSubmit(pin, p) {
      if (firstPin == null) { firstPin = pin; return p.reset('Confirm your PIN', 'Type it once more'); }
      if (pin !== firstPin) { firstPin = null; p.error('PINs did not match — start again'); return p.reset(first ? 'Choose your PIN' : 'New PIN', 'PINs did not match — start again'); }
      const r = await api('/api/pin/set', { old, new: pin });
      if (!r.ok) { firstPin = null; return p.error(r.message || 'Could not save PIN'); }
      toast(WEAK_PINS.includes(pin) ? 'PIN saved. Bold choice — even the fish could guess that one.' : 'PIN saved. Your phone is locked tight.', 4000);
      onDone(pin);
    },
  });
  return pad;
}

// ============================================================ quick settings (pull down the status bar)
const quick = $('#quick');
function closeQuick() { quick.classList.remove('open'); }
(function quickGestures() {
  let sy = null;
  $('#statusbar').addEventListener('pointerdown', e => (sy = e.clientY));
  addEventListener('pointerup', e => { if (sy != null && e.clientY - sy > 30) { quick.classList.add('open'); pollAbout(); renderNotifs(); setTimeout(markNotifsRead, 1500); } sy = null; });
  $('#statusbar').addEventListener('click', () => { quick.classList.toggle('open'); pollAbout(); if (quick.classList.contains('open')) { renderNotifs(); setTimeout(markNotifsRead, 1500); } });
  let qy = null;
  quick.addEventListener('pointerdown', e => { if (!e.target.closest('input,button')) qy = e.clientY; });
  quick.addEventListener('pointerup', e => { if (qy != null && qy - e.clientY > 30) closeQuick(); qy = null; });
  $('.q-grip').addEventListener('click', closeQuick);
})();
quick.addEventListener('click', async e => {
  const b = e.target.closest('[data-q]'); if (!b) return;
  const q = b.dataset.q;
  if (q === 'glass') { S.glass = !(S.glass ?? !ON_DEVICE); save(); }
  else if (q === 'bubbles') { S.bubbles = !S.bubbles; save(); }
  else if (q === 'wifi') { closeQuick(); openApp('settings', 'wifi'); }
  else if (q === 'rotate') { closeQuick(); api('/api/rotate').then(r => rotateFlow(r.rotation % 180 ? (r.rotation === 90 ? 0 : 180) : (r.rotation === 0 ? 90 : 270))); }
  else if (q === 'torch') LIGHT.torch(!LIGHT.torchOn);
  else if (q === 'dnd') { S.dnd = !S.dnd; save(); renderNotifs(); toast(S.dnd ? 'Do Not Disturb on' : 'Do Not Disturb off'); }
  else if (q === 'lock') lock();
  else if (q === 'power') { closeQuick(); powerMenu(); }
});
function setBrightness(v) {
  S.brightness = +v; persist();
  api('/api/brightness', { percent: S.brightness }).then(r => { $('#dimmer').style.opacity = r.hw ? 0 : (1 - S.brightness / 100) * .85; });
}
$('#q-bright').value = S.brightness; $('#q-bright').addEventListener('input', e => setBrightness(e.target.value));
$('#q-vol').value = S.volume; $('#q-vol').addEventListener('change', e => { S.volume = +e.target.value; save(); api('/api/volume', { percent: S.volume }); });

async function powerMenu() {
  const v = await modal('Power', h('p', {}, 'What would you like to do?'), [
    { label: 'Cancel' }, { label: 'Restart shell', value: 'restart-shell' }, { label: 'Reboot', value: 'reboot', primary: true }, { label: 'Shut down', value: 'shutdown', danger: true }]);
  if (!v || v === 'Cancel') return;
  const r = await api('/api/power', { action: v });
  toast(r.ok ? (v === 'shutdown' ? 'Goodbye! See you on the other side of the sky.' : 'Be right back…') : (r.message || 'Failed'));
}
// The panel is wide by nature: 0° = tablet, 90° = phone (tall). 180/270 = the same, upside down.
const ORIENTATIONS = [[90, '📱', 'Phone', 'Tall, like a phone'], [0, '💻', 'Tablet', 'Wide, like a tablet'],
  [270, '📱', 'Phone, upside down', 'Tall, flipped over'], [180, '💻', 'Tablet, upside down', 'Wide, flipped over']];
async function rotateFlow(deg) {
  const cur = (await api('/api/rotate')).rotation;
  if (deg === cur) return toast('Already like that');
  const o = ORIENTATIONS.find(x => x[0] === deg);
  toast(`Switching to ${o[2]}… the screen restarts for a few seconds`, 4000);
  const r = await api('/api/rotate', { deg });
  if (!r.ok) toast('Rotation failed: ' + (r.message || 'unknown'));
}
async function orientationPicker(host) {
  const cur = (await api('/api/rotate')).rotation;
  host.innerHTML = '';
  host.append(h('div', { class: 'orient' }, ORIENTATIONS.map(([deg, emo, name, sub]) =>
    h('button', { class: 'orient-btn' + (deg === cur ? ' on' : '') + (deg % 180 ? '' : ' wide') + (deg >= 180 ? ' flipped' : ''), onclick: () => rotateFlow(deg) },
      h('span', { class: 'orient-shape' }, h('i', {}, emo)), h('b', {}, name), h('small', {}, sub)))));
}

// ============================================================ on-screen keyboard
const OSK = (() => {
  const el = $('#osk');
  let target = null, shift = false, caps = false, mode = 'abc';
  const LAYOUTS = {
    abc: [['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'], ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'], ['SHIFT', 'z', 'x', 'c', 'v', 'b', 'n', 'm', 'BKSP'], ['MODE', ',', 'SPACE', '.', 'ENTER']],
    sym: [['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'], ['@', '#', '$', '_', '&', '-', '+', '(', ')', '/'], ['*', '"', "'", ':', ';', '!', '?', '=', 'BKSP'], ['MODE', '~', '|', 'SPACE', '\\', '<', '>', 'ENTER']],
  };
  const LABEL = { BKSP: '⌫', SPACE: ' ', ENTER: '⏎' };
  function render() {
    el.innerHTML = '';
    for (const row of LAYOUTS[mode]) {
      el.append(h('div', { class: 'krow' }, row.map(k => {
        const special = k.length > 1;
        const label = k === 'MODE' ? (mode === 'abc' ? '?123' : 'ABC') : k === 'SHIFT' ? (caps ? '⇪' : '⇧') : LABEL[k] ?? (shift || caps ? k.toUpperCase() : k);
        return h('button', { class: 'key' + (special ? ' wide' : '') + (k === 'SPACE' ? ' space' : '') + (k === 'SHIFT' && (shift || caps) ? ' on' : '') + (k === 'MODE' ? ' small' : ''), 'data-k': k }, label);
      })));
    }
  }
  el.addEventListener('pointerdown', e => {
    e.preventDefault(); // keep focus in the text field
    const b = e.target.closest('.key'); if (!b || !target) return;
    const k = b.dataset.k;
    if (S.clicks) tone('click');
    if (k === 'SHIFT') { if (caps) caps = false; else if (shift) { caps = true; shift = false; } else shift = true; render(); return; }
    if (k === 'MODE') { mode = mode === 'abc' ? 'sym' : 'abc'; render(); return; }
    if (k === 'BKSP') return target.key('Backspace');
    if (k === 'ENTER') return target.key('Enter');
    const ch = k === 'SPACE' ? ' ' : (shift || caps ? k.toUpperCase() : k);
    target.insert(ch);
    if (shift) { shift = false; render(); }
  });
  function inputTarget(input) {
    return {
      el: input,
      insert(t) {
        const s = input.selectionStart ?? input.value.length, e2 = input.selectionEnd ?? s;
        input.setRangeText(t, s, e2, 'end'); input.dispatchEvent(new Event('input', { bubbles: true }));
      },
      key(k) {
        if (k === 'Backspace') {
          const s = input.selectionStart, e2 = input.selectionEnd;
          if (s !== e2) input.setRangeText('', s, e2, 'end'); else if (s > 0) input.setRangeText('', s - 1, s, 'end');
          input.dispatchEvent(new Event('input', { bubbles: true }));
        } else if (k === 'Enter') {
          if (input.tagName === 'TEXTAREA') this.insert('\n');
          else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        }
      },
    };
  }
  function show(t) {
    target = t; mode = 'abc'; shift = false; render(); el.classList.remove('hidden');
    document.documentElement.style.setProperty('--osk-h', el.offsetHeight + 'px');
    $('#windows').style.bottom = el.offsetHeight + 'px';
    const m = $('.modal'); if (m) m.style.marginBottom = el.offsetHeight + 'px';
    if (t.el) setTimeout(() => t.el.scrollIntoView({ block: 'nearest' }), 50);
  }
  function hide() {
    if (el.classList.contains('hidden')) return;
    el.classList.add('hidden'); target = null; $('#windows').style.bottom = '';
    const m = $('.modal'); if (m) m.style.marginBottom = '';
    setTimeout(fitTerms, 50);
  }
  document.addEventListener('focusin', e => {
    const t = e.target;
    if (t.classList.contains('xterm-helper-textarea')) return;
    if ((t.tagName === 'INPUT' && /^(text|password|search|tel|url|email)$/.test(t.type)) || t.tagName === 'TEXTAREA') {
      t.setAttribute('inputmode', 'none'); show(inputTarget(t));
    }
  });
  document.addEventListener('focusout', e => { setTimeout(() => { const a = document.activeElement; if (target && target.el && a !== target.el) hide(); }, 120); });
  return { show, hide, get open() { return !el.classList.contains('hidden'); } };
})();

// ============================================================ window manager
let CURRENT = null;
class Win {
  constructor(app) {
    this.app = app; this.stack = []; this.cleanup = null;
    this.backBtn = h('button', { class: 'orb back hidden', html: svg('back'), onclick: () => this.back() });
    this.titleEl = h('span', { class: 't' });
    this.body = h('div', { class: 'win-body' });
    this.el = h('div', { class: 'win' },
      h('div', { class: 'win-title' }, this.backBtn, this.titleEl, h('button', { class: 'orb close', html: svg('close'), onclick: () => goHome() })),
      this.body);
    $('#windows').append(this.el);
  }
  push(title, render) { this.stack.push({ title, render }); this.show(); }
  replace(title, render) { this.stack.pop(); this.push(title, render); }
  show() {
    if (this.cleanup) { try { this.cleanup(); } catch (e) { } this.cleanup = null; }
    OSK.hide();
    const page = this.stack[this.stack.length - 1];
    this.titleEl.textContent = page.title;
    this.backBtn.classList.toggle('hidden', this.stack.length < 2);
    this.body.innerHTML = ''; this.body.scrollTop = 0; this.body.style.padding = '';
    this.el.querySelectorAll(':scope > .selbar').forEach(b => b.remove());
    let c;
    try { c = page.render(this.body, this); } catch (e) { return appCrashed(this.app, e); }
    if (c && typeof c.then === 'function') c.catch(e => appCrashed(this.app, e));
    else this.cleanup = typeof c === 'function' ? c : null;
  }
  back() {
    if (OSK.open) return OSK.hide();
    if (this.stack.length > 1) { this.stack.pop(); this.show(); } else goHome();
  }
  close() {
    if (this.cleanup) { try { this.cleanup(); } catch (e) { } }
    this.el.classList.add('closing'); setTimeout(() => this.el.remove(), 250);
  }
}
function openApp(id, arg) {
  const app = APPS[id]; if (!app) return;
  closeQuick();
  try {
    if (app.launch) return app.launch(arg);
    if (CURRENT) CURRENT.close();
    CURRENT = new Win(app);
    $('#home').classList.add('behind');
    app.open(CURRENT, arg);
  } catch (e) { appCrashed(app, e); }
}
function appCrashed(app, e) {
  console.error('[skyglass] app crashed:', app && app.name, e);
  goHome();
  toast(`${app ? app.name : 'An app'} hit a bug and was closed. Everything else is fine.`, 4500);
}
function goHome() {
  OSK.hide(); closeQuick();
  $$('.modal-bg').forEach(m => m.remove());
  if (CURRENT) { CURRENT.close(); CURRENT = null; }
  $('#home').classList.remove('behind');
}
// home bar: tap or swipe up
(function homebar() {
  const hb = $('#homebar'); let sy = null;
  hb.addEventListener('pointerdown', e => (sy = e.clientY));
  hb.addEventListener('pointerup', e => { if (sy != null) { OSK.open ? OSK.hide() : goHome(); } sy = null; });
})();

// ============================================================ home screen
function iconEl(app) {
  const i = h('div', { class: 'icon', html: svg(app.icon) });
  i.style.background = `linear-gradient(180deg, ${app.color[0]}, ${app.color[1]})`;
  return i;
}
const DOCK = ['phone', 'messages', 'browser', 'camera'];
const GRID = ['settings', 'files', 'photos', 'music', 'weather', 'calendar', 'notes', 'calc', 'clock', 'sketch', 'games', 'viewer3d', 'sysmon', 'terminal', 'linux', 'android', 'light', 'aquarium'];
function renderHome() {
  const grid = $('#grid'), dock = $('#dock');
  grid.innerHTML = ''; dock.innerHTML = '';
  for (const id of GRID) {
    const a = APPS[id];
    if (a.hidden && !a.hidden()) continue;
    grid.append(h('button', { class: 'app', onclick: () => openApp(id) }, iconEl(a), h('span', { class: 'label' }, a.name)));
  }
  for (const id of DOCK) dock.append(h('button', { class: 'app', onclick: () => openApp(id) }, iconEl(APPS[id]), h('span', { class: 'label' }, APPS[id].name)));
}
// easter egg: long-press empty wallpaper -> bubble wrap
(function wallpaperHold() {
  let timer = null, sx = 0, sy = 0;
  $('#home').addEventListener('pointerdown', e => {
    if (e.target.closest('.app, #widget, #dock')) return;
    sx = e.clientX; sy = e.clientY;
    timer = setTimeout(() => { timer = null; openApp('bubblewrap'); }, 1200);
  });
  const cancel = () => { clearTimeout(timer); timer = null; };
  $('#home').addEventListener('pointerup', cancel);
  $('#home').addEventListener('pointermove', e => { if (Math.hypot(e.clientX - sx, e.clientY - sy) > 12) cancel(); });
})();

// ============================================================ shared UI pieces
function listItem({ icon, title, sub, onclick, right }) {
  return h('div', { class: 'li', onclick }, icon ? h('span', { html: svg(icon) }) : null,
    h('div', { class: 'grow' }, h('div', {}, title), sub ? h('div', { class: 'sub' }, sub) : null), right || null);
}
function emptyState(icon, text) { return h('div', { class: 'empty', html: svg(icon) + `<p>${esc(text)}</p>` }); }
function switchEl(on, onchange) {
  const s = h('button', { class: 'switch' + (on ? ' on' : '') });
  s.addEventListener('click', e => { e.stopPropagation(); s.classList.toggle('on'); onchange(s.classList.contains('on')); });
  return s;
}
function seg(options, value, onchange) {
  const el = h('div', { class: 'seg' });
  for (const [v, label] of options) {
    el.append(h('button', { class: v === value ? 'on' : '', onclick: e => { const b = e.currentTarget; $$('button', el).forEach(x => x.classList.remove('on')); b.classList.add('on'); onchange(v); } }, label));
  }
  return el;
}
function fmtSize(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(1) + ' GB'; }
function fmtDur(s) { s = Math.floor(s); const d = Math.floor(s / 86400), hh = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return (d ? d + 'd ' : '') + (hh ? hh + 'h ' : '') + m + 'm'; }
function imageViewer(path) {
  const v = h('div', { class: 'viewer', onclick: () => v.remove() }, h('img', { src: '/api/file?path=' + encodeURIComponent(path) }));
  $('#windows .win:last-child .win-body').append(v);
  v.style.top = $('#windows .win:last-child .win-body').scrollTop + 'px';
}

const VIDEO_RE = /\.(mp4|webm|mov|mkv)$/i;
const fileUrl = p => '/api/file?path=' + encodeURIComponent(p) + '&v=' + Date.now();
const thumbUrl = (p, size = 320) => '/api/thumb?size=' + size + '&path=' + encodeURIComponent(p);
function videoViewer(path, onChange) { mediaViewer(path, onChange); }
// full-screen photo/video viewer with Edit · Copy to… · Delete
function mediaViewer(path, onChange) {
  const isVid = VIDEO_RE.test(path);
  // photos: a screen-sized preview (fast); videos: the real file
  const media = isVid ? h('video', { src: fileUrl(path), controls: true, autoplay: true, playsinline: true, preload: 'metadata' })
    : h('img', { src: thumbUrl(path, 1280) + '&v=' + Date.now(), decoding: 'async' });
  const close = () => { if (isVid) media.pause(); v.remove(); };
  const btn = (icon, label, fn, cls = '') => h('button', { class: 'mv-btn ' + cls, onclick: fn }, h('span', { html: svg(icon) }), label);
  const v = h('div', { class: 'mviewer' },
    h('div', { class: 'mv-top' }, h('span', {}, path.split('/').pop()), h('button', { class: 'orb close', html: svg('close'), onclick: close })),
    h('div', { class: 'mv-stage' }, media),
    h('div', { class: 'mv-bar' },
      btn('edit', 'Edit', () => { close(); (isVid ? videoEditor : photoEditor)(path, onChange); }),
      btn('usb', 'Copy to…', async () => { const d = await pickDestination(); if (d) copyFiles([path], d, false); }),
      !isVid && /\.(jpe?g|png|webp)$/i.test(path) && btn('photos', 'Wallpaper', () => setWallpaperFrom(path)),
      btn('trash', 'Delete', async () => { if (await confirmDelete([path])) { close(); onChange && onChange(); } }, 'danger')));
  $('#phone').append(v);
}
async function confirmDelete(paths) {
  const what = paths.length === 1 ? '“' + paths[0].split('/').pop() + '”' : paths.length + ' files';
  const ok = await modal('Delete ' + what + '?', h('p', {}, 'This can’t be undone.'), [{ label: 'Cancel' }, { label: 'Delete', danger: true, value: 'del' }]);
  if (ok !== 'del') return false;
  const r = await api('/api/files/delete', { paths });
  toast(r.ok ? `🗑 Deleted ${r.deleted} ${r.deleted === 1 ? 'file' : 'files'}` : 'Some files could not be deleted: ' + r.message, 3500);
  return (r.deleted || 0) > 0;
}

// ---------------------------------------------------------------- photo editor
const PHOTO_FILTERS = [['none', 'Original', ''], ['aero', 'Aero', 'saturate(1.3) contrast(1.06) brightness(1.06) hue-rotate(-6deg)'],
  ['vivid', 'Vivid', 'saturate(1.7) contrast(1.15)'], ['mono', 'Mono', 'grayscale(1) contrast(1.12)'], ['sepia', 'Sepia', 'sepia(.85) contrast(1.05)'],
  ['cool', 'Cool', 'hue-rotate(14deg) saturate(1.15)'], ['fade', 'Fade', 'contrast(.82) brightness(1.12) saturate(.75)'], ['noir', 'Noir', 'grayscale(1) contrast(1.6) brightness(.9)']];
function photoEditor(path, onChange) {
  const img = new Image();
  const st = { rot: 0, flip: false, crop: [0, 0, 1, 1], aspect: null, b: 100, c: 100, s: 100, warm: 0, filter: 'none', tab: 'adjust' };
  const cv = h('canvas', { class: 'ed-canvas' }), box = h('div', { class: 'ed-crop hidden' }, h('i', { class: 'ed-handle' }));
  const frame = h('div', { class: 'ed-frame' }, cv, box), stage = h('div', { class: 'ed-stage' }, frame);
  const panel = h('div', { class: 'ed-panel' });
  const tabs = h('div', { class: 'ed-tabs' }, [['adjust', 'sliders', 'Adjust'], ['filters', 'sparkle', 'Filters'], ['crop', 'crop', 'Crop'], ['rotate', 'rotate', 'Rotate']].map(([id, ic, label]) =>
    h('button', { 'data-t': id, onclick: () => { st.tab = id; draw(); } }, h('span', { html: svg(ic) }), label)));
  const ed = h('div', { class: 'editor' },
    h('div', { class: 'ed-top' }, h('button', { class: 'pill', onclick: () => ed.remove() }, 'Cancel'), h('b', {}, 'Edit photo'), h('button', { class: 'pill primary', onclick: saveIt }, 'Save')),
    stage, panel, tabs);
  $('#phone').append(ed);
  let small = null;  // a preview-sized copy of the photo, for speed
  img.onload = () => {
    const k = Math.min(1, 1400 / Math.max(img.width, img.height));
    small = h('canvas'); small.width = Math.round(img.width * k); small.height = Math.round(img.height * k);
    small.getContext('2d').drawImage(img, 0, 0, small.width, small.height);
    draw();
  };
  img.onerror = () => { ed.remove(); toast('Could not open this photo'); };
  img.src = fileUrl(path);
  const filterStr = () => `brightness(${st.b}%) contrast(${st.c}%) saturate(${st.s}%) ` + PHOTO_FILTERS.find(f => f[0] === st.filter)[2];
  function oriented(src) {
    const o = h('canvas'), odd = st.rot % 2;
    o.width = odd ? src.height : src.width; o.height = odd ? src.width : src.height;
    const x = o.getContext('2d');
    x.translate(o.width / 2, o.height / 2); x.rotate(st.rot * Math.PI / 2); x.scale(st.flip ? -1 : 1, 1);
    x.drawImage(src, -src.width / 2, -src.height / 2);
    return o;
  }
  function render(src, out, crop = true) {
    const o = oriented(src);
    const [cx, cy, cw, ch] = crop ? st.crop : [0, 0, 1, 1];
    const sx = cx * o.width, sy = cy * o.height, sw = Math.max(1, cw * o.width), sh = Math.max(1, ch * o.height);
    out.width = Math.round(sw); out.height = Math.round(sh);
    const x = out.getContext('2d');
    x.filter = filterStr(); x.drawImage(o, sx, sy, sw, sh, 0, 0, out.width, out.height); x.filter = 'none';
    if (st.warm) {
      x.globalCompositeOperation = 'soft-light';
      x.fillStyle = st.warm > 0 ? `rgba(255,150,40,${st.warm / 100 * .7})` : `rgba(50,140,255,${-st.warm / 100 * .7})`;
      x.fillRect(0, 0, out.width, out.height); x.globalCompositeOperation = 'source-over';
    }
    return out;
  }
  function fitCanvas() {
    const maxW = stage.clientWidth - 20, maxH = stage.clientHeight - 20, r = Math.min(maxW / cv.width, maxH / cv.height);
    cv.style.width = Math.floor(cv.width * r) + 'px'; cv.style.height = Math.floor(cv.height * r) + 'px';
  }
  function draw() {
    if (!small) return;
    $$('button', tabs).forEach(b => b.classList.toggle('on', b.dataset.t === st.tab));
    const cropping = st.tab === 'crop';
    render(small, cv, !cropping); fitCanvas();
    box.classList.toggle('hidden', !cropping);
    if (cropping) Object.assign(box.style, { left: st.crop[0] * 100 + '%', top: st.crop[1] * 100 + '%', width: st.crop[2] * 100 + '%', height: st.crop[3] * 100 + '%' });
    drawPanel();
  }
  let panelTab = '';
  function drawPanel() {
    if (panelTab === st.tab && st.tab === 'adjust') return; // keep sliders alive while dragging
    panelTab = st.tab; panel.innerHTML = '';
    if (st.tab === 'adjust') {
      const slider = (label, key, min, max) => {
        const val = h('span', {}, ''), inp = h('input', { type: 'range', min, max, value: st[key] });
        const show = () => (val.textContent = key === 'warm' ? (st.warm > 0 ? '+' : '') + st.warm : st[key] - 100 > 0 ? '+' + (st[key] - 100) : st[key] - 100);
        inp.addEventListener('input', () => { st[key] = +inp.value; show(); draw(); }); show();
        return h('label', { class: 'ed-slider' }, h('b', {}, label), inp, val);
      };
      panel.append(slider('Brightness', 'b', 40, 160), slider('Contrast', 'c', 40, 160), slider('Saturation', 's', 0, 200), slider('Warmth', 'warm', -100, 100));
    } else if (st.tab === 'filters') {
      panel.append(h('div', { class: 'ed-filters' }, PHOTO_FILTERS.map(([id, name, f]) => {
        const t = h('canvas', { class: 'ed-fthumb' + (st.filter === id ? ' on' : '') });
        const k = 120 / Math.max(small.width, small.height); t.width = small.width * k; t.height = small.height * k;
        const x = t.getContext('2d'); x.filter = f || 'none'; x.drawImage(small, 0, 0, t.width, t.height);
        return h('button', { class: 'ed-filter', onclick: () => { st.filter = id; panelTab = ''; draw(); } }, t, name);
      })));
    } else if (st.tab === 'crop') {
      const ow = st.rot % 2 ? small.height : small.width, oh = st.rot % 2 ? small.width : small.height;
      const set = ar => {
        st.aspect = ar;
        if (!ar) { st.crop = [0, 0, 1, 1]; } else {
          let w = 1, hh = (ow / ar) / oh; if (hh > 1) { hh = 1; w = (oh * ar) / ow; }
          st.crop = [(1 - w) / 2, (1 - hh) / 2, w, hh];
        }
        panelTab = ''; draw();
      };
      panel.append(h('p', { class: 'ed-hint' }, 'Drag the box to move it · drag the corner to resize'),
        h('div', { class: 'ed-row' }, [['Full', null], ['Square', 1], ['4:3', 4 / 3], ['3:4', 3 / 4], ['16:9', 16 / 9], ['9:16', 9 / 16]].map(([n, ar]) =>
          h('button', { class: 'pill' + (st.aspect === ar ? ' primary' : ''), onclick: () => set(ar) }, n))));
    } else {
      panel.append(h('div', { class: 'ed-row big' },
        h('button', { class: 'pill', onclick: () => { st.rot = (st.rot + 3) % 4; st.crop = [0, 0, 1, 1]; st.aspect = null; draw(); } }, '↺ Left'),
        h('button', { class: 'pill', onclick: () => { st.rot = (st.rot + 1) % 4; st.crop = [0, 0, 1, 1]; st.aspect = null; draw(); } }, '↻ Right'),
        h('button', { class: 'pill', onclick: () => { st.flip = !st.flip; draw(); } }, '⇋ Mirror')));
    }
  }
  // crop box dragging (move, or resize from the corner handle)
  let drag = null;
  box.addEventListener('pointerdown', e => {
    e.preventDefault(); box.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, c: [...st.crop], resize: e.target.classList.contains('ed-handle') };
  });
  box.addEventListener('pointermove', e => {
    if (!drag) return;
    const r = cv.getBoundingClientRect(), dx = (e.clientX - drag.x) / r.width, dy = (e.clientY - drag.y) / r.height;
    let [x, y, w, hh] = drag.c;
    if (drag.resize) {
      w = Math.max(.08, Math.min(1 - x, w + dx));
      hh = st.aspect ? w * r.width / st.aspect / r.height : Math.max(.08, Math.min(1 - y, hh + dy));
      if (y + hh > 1) { hh = 1 - y; if (st.aspect) w = hh * r.height * st.aspect / r.width; }
    } else { x = Math.max(0, Math.min(1 - w, x + dx)); y = Math.max(0, Math.min(1 - hh, y + dy)); }
    st.crop = [x, y, w, hh];
    Object.assign(box.style, { left: x * 100 + '%', top: y * 100 + '%', width: w * 100 + '%', height: hh * 100 + '%' });
  });
  box.addEventListener('pointerup', () => (drag = null));
  async function saveIt() {
    const how = await modal('Save photo', h('p', {}, 'Keep the original, or replace it?'), [{ label: 'Cancel' }, { label: 'Replace', value: 'replace' }, { label: 'Save copy', primary: true, value: 'copy' }]);
    if (!how || how === 'Cancel') return;
    toast('Saving…', 1500);
    const out = render(img, h('canvas'));
    const png = /\.png$/i.test(path);
    const r = await api('/api/photo/save', { path, replace: how === 'replace', data: out.toDataURL(png ? 'image/png' : 'image/jpeg', .93) });
    if (!r.ok) return toast(r.message || 'Could not save', 4000);
    tone('pop'); toast(how === 'replace' ? 'Photo saved ✔' : 'Saved as ' + r.path.split('/').pop(), 3000);
    ed.remove(); onChange && onChange();
  }
}

// ---------------------------------------------------------------- video editor (trim · rotate · mute)
function videoEditor(path, onChange) {
  const vid = h('video', { src: fileUrl(path), playsinline: true, preload: 'auto' });
  const st = { start: 0, end: 0, dur: 0, rotate: 0, mute: false };
  const range = h('i', { class: 've-range' }), head = h('i', { class: 've-head' });
  const hs = h('b', { class: 've-h' }), he = h('b', { class: 've-h' });
  const track = h('div', { class: 've-track' }, range, head, hs, he);
  const times = h('div', { class: 've-times' });
  const playBtn = h('button', { class: 'orb', html: svg('play'), onclick: () => { if (vid.paused) { if (vid.currentTime < st.start || vid.currentTime >= st.end - .05) vid.currentTime = st.start; vid.play(); } else vid.pause(); } });
  const muteBtn = h('button', { class: 'pill', onclick: () => { st.mute = !st.mute; vid.muted = st.mute; ui(); } });
  const rotBtn = h('button', { class: 'pill', onclick: () => { st.rotate = (st.rotate + 90) % 360; ui(); } });
  const ed = h('div', { class: 'editor' },
    h('div', { class: 'ed-top' }, h('button', { class: 'pill', onclick: () => { vid.pause(); ed.remove(); } }, 'Cancel'), h('b', {}, 'Edit video'), h('button', { class: 'pill primary', onclick: saveIt }, 'Save')),
    h('div', { class: 'ed-stage' }, vid),
    h('div', { class: 'ed-panel' }, h('p', { class: 'ed-hint' }, 'Drag the white handles to trim'), track, times,
      h('div', { class: 'ed-row' }, playBtn, rotBtn, muteBtn)));
  $('#phone').append(ed);
  const fmt = t => Math.floor(t / 60) + ':' + pad2(Math.floor(t % 60)) + '.' + Math.floor(t * 10 % 10);
  function ui() {
    if (!st.dur) return;
    const p = t => (t / st.dur * 100) + '%';
    hs.style.left = p(st.start); he.style.left = p(st.end); range.style.left = p(st.start); range.style.width = ((st.end - st.start) / st.dur * 100) + '%';
    head.style.left = p(vid.currentTime || 0);
    times.textContent = `${fmt(st.start)}  →  ${fmt(st.end)}   (${fmt(st.end - st.start)})`;
    muteBtn.innerHTML = svg(st.mute ? 'mute' : 'sound') + (st.mute ? ' Muted' : ' Sound');
    rotBtn.innerHTML = svg('rotate') + ' ' + st.rotate + '°';
    const odd = st.rotate % 180;
    vid.style.transform = `rotate(${st.rotate}deg)` + (odd ? ` scale(${Math.min(1, (vid.videoHeight || 9) / (vid.videoWidth || 16))})` : '');
    playBtn.innerHTML = svg(vid.paused ? 'play' : 'pause');
  }
  vid.addEventListener('loadedmetadata', () => { st.dur = vid.duration || 0; st.end = st.dur; ui(); });
  vid.addEventListener('timeupdate', () => { if (vid.currentTime >= st.end) { vid.pause(); vid.currentTime = st.start; } ui(); });
  vid.addEventListener('play', ui); vid.addEventListener('pause', ui);
  let dragging = null;
  track.addEventListener('pointerdown', e => {
    if (!st.dur) return;
    track.setPointerCapture(e.pointerId);
    const r = track.getBoundingClientRect(), t = (e.clientX - r.left) / r.width * st.dur;
    dragging = Math.abs(t - st.start) < Math.abs(t - st.end) ? 'start' : 'end';
    move(e);
  });
  const move = e => {
    if (!dragging) return;
    const r = track.getBoundingClientRect(), t = Math.max(0, Math.min(st.dur, (e.clientX - r.left) / r.width * st.dur));
    if (dragging === 'start') st.start = Math.min(t, st.end - .3); else st.end = Math.max(t, st.start + .3);
    vid.currentTime = dragging === 'start' ? st.start : st.end; ui();
  };
  track.addEventListener('pointermove', move);
  track.addEventListener('pointerup', () => (dragging = null));
  async function saveIt() {
    if (!st.dur) return;
    const how = await modal('Save video', h('p', {}, 'Keep the original, or replace it?'), [{ label: 'Cancel' }, { label: 'Replace', value: 'replace' }, { label: 'Save copy', primary: true, value: 'copy' }]);
    if (!how || how === 'Cancel') return;
    vid.pause();
    const r = await api('/api/video/edit', { path, start: st.start, end: st.end, rotate: st.rotate, mute: st.mute, replace: how === 'replace' });
    if (!r.ok) return toast(r.message || 'Could not edit the video', 5000);
    const bar = h('i'), label = h('p', {}, 'Encoding…');
    const bg = h('div', { class: 'modal-bg' }, h('div', { class: 'modal glass' }, h('h2', {}, 'Saving video'), h('div', { class: 'copy-prog' }, label, h('div', { class: 'progress' }, bar))));
    $('#modal-root').append(bg);
    let s2 = r;
    while (!s2.finished) { await sleep(400); s2 = await api('/api/video/edit?id=' + r.id); if (s2.error && !s2.finished) break; bar.style.width = (s2.progress || 0) * 100 + '%'; label.textContent = Math.round((s2.progress || 0) * 100) + '%'; }
    bg.remove();
    if (s2.error) return toast('Video edit failed: ' + s2.error, 6000);
    tone('pop'); toast(how === 'replace' ? 'Video saved ✔' : 'Saved as ' + s2.path.split('/').pop(), 3000);
    ed.remove(); onChange && onChange();
  }
}
// ---- copying files around (phone <-> USB) with a progress dialog
async function copyFiles(paths, dest, move) {
  const r = await api('/api/files/copy', { paths, dest, move });
  if (!r.ok) { toast(r.message || 'Copy failed', 4000); return false; }
  const bar = h('i'), label = h('p', {}, 'Starting…');
  const box = h('div', { class: 'copy-prog' }, label, h('div', { class: 'progress' }, bar));
  const bg = h('div', { class: 'modal-bg' }, h('div', { class: 'modal glass' }, h('h2', {}, (move ? 'Moving ' : 'Copying ') + paths.length + (paths.length === 1 ? ' file' : ' files')), box));
  $('#modal-root').append(bg);
  let st = r;
  while (!st.finished && !st.error) {
    await sleep(300);
    st = await api('/api/files/copy?id=' + r.id);
    if (st.error && !st.finished) break;
    bar.style.width = (st.total ? st.done * 100 / st.total : 0) + '%';
    label.textContent = `${st.current || ''}  ·  ${fmtSize(st.done || 0)} of ${fmtSize(st.total || 0)}`;
  }
  bg.remove();
  if (st.error) { toast((st.count ? st.count + ' copied, then: ' : '') + st.error, 5000); return false; }
  tone('pop');
  toast(`${move ? 'Moved' : 'Copied'} ${st.count} ${st.count === 1 ? 'file' : 'files'} ✔`, 3000);
  return true;
}
// where can files go? mounted USB drives + the phone's own folders
async function pickDestination(excludePrefix) {
  const r = await api('/api/usb');
  const usb = (r.drives || []).filter(d => d.mounted);
  const opts = [...usb.map(d => ({ icon: 'usb', title: d.label, sub: 'USB · ' + (d.free != null ? fmtSize(d.free) + ' free' : d.fstype), dest: d.mountpoint + '/Skyglass' })),
    { icon: 'photos', title: 'Phone · Pictures', dest: '~/Pictures' }, { icon: 'video', title: 'Phone · Videos', dest: '~/Videos' },
    { icon: 'files', title: 'Phone · Documents', dest: '~/Documents' }].filter(o => !excludePrefix || !o.dest.startsWith(excludePrefix));
  if (!usb.length) opts.unshift({ icon: 'usb', title: 'No USB drive', sub: 'Plug one in — it appears here in a second', dest: null });
  return new Promise(resolve => {
    let done = false;
    const list = h('div', { class: 'list' }, opts.map(o => listItem({ icon: o.icon, title: o.title, sub: o.sub, onclick: () => { if (!o.dest) return; done = true; $$('.modal-bg').forEach(m => m.remove()); resolve(o.dest); } })));
    modal('Save to…', list, [{ label: 'Cancel' }]).then(() => { if (!done) resolve(null); });
  });
}
// a "Select" mode for any list/grid of files: tap to tick, then Copy / Move
function selector(host, onChange) {
  const sel = new Set();
  const count = h('b', {}, '');
  const bar = h('div', { class: 'selbar glass hidden' }, count,
    h('button', { class: 'btn primary', onclick: () => run(false) }, 'Copy to…'),
    h('button', { class: 'btn', onclick: () => run(true) }, 'Move to…'),
    h('button', { class: 'btn danger icon-only', html: svg('trash'), onclick: async () => {
      if (!sel.size) return toast('Tap some files first');
      if (await confirmDelete([...sel])) { api_.setOn(false); onChange && onChange(true); }
    } }));
  const toggleBtn = h('button', { class: 'pill sel-toggle', onclick: () => api_.setOn(!api_.on) }, 'Select');
  (host.closest('.win') || host).append(bar); // floats at the bottom of the window
  async function run(move) {
    if (!sel.size) return toast('Tap some files first');
    const dest = await pickDestination(); if (!dest) return;
    if (await copyFiles([...sel], dest, move)) { api_.setOn(false); if (move) onChange && onChange(true); }
  }
  const api_ = {
    on: false, button: toggleBtn, has: p => sel.has(p),
    setOn(v) { api_.on = v; sel.clear(); toggleBtn.textContent = v ? 'Cancel' : 'Select'; bar.classList.toggle('hidden', !v); api_.refresh(); onChange && onChange(false); },
    toggle(p) { sel.has(p) ? sel.delete(p) : sel.add(p); api_.refresh(); },
    refresh() { count.textContent = sel.size + ' selected'; $$('[data-path]', host).forEach(el => el.classList.toggle('picked', sel.has(el.dataset.path))); host.classList.toggle('selecting', api_.on); },
  };
  return api_;
}

// touch calibration — works even when touch is misaligned: any tap counts, the backend
// reads the raw touch position, and the matrix is fitted from 5 crosses.
async function touchCalibrate() {
  if ($('.calib')) return;
  const r = await api('/api/touch/calibrate/start', {});
  if (!r.ok) return toast(r.message || 'No touchscreen found');
  const targets = [[.12, .1], [.88, .1], [.88, .9], [.12, .9], [.5, .5]];
  const cross = h('div', { class: 'calib-cross' });
  const info = h('div', { class: 'info' });
  const ov = h('div', { class: 'calib' }, cross, info);
  $('#phone').append(ov);
  const points = [];
  let i = 0, seen = 0, done = false;
  const show = () => {
    cross.style.left = targets[i][0] * 100 + '%'; cross.style.top = targets[i][1] * 100 + '%';
    info.innerHTML = `<b>Touch calibration</b><br>Tap the centre of the cross (${i + 1} of ${targets.length}).<br><small>Taps anywhere count — it reads the raw touch position.</small>`;
  };
  show();
  const quit = msg => { done = true; ov.remove(); api('/api/touch/calibrate/cancel', {}); if (msg) toast(msg); removeEventListener('keydown', onKey, true); };
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); quit('Calibration cancelled'); } };
  addEventListener('keydown', onKey, true);
  const timeout = setTimeout(() => !done && quit('Calibration timed out'), 120000);
  while (!done) {
    await sleep(80);
    const s = await api('/api/touch/samples');
    if (!s.samples) continue;
    if (s.samples.length > seen) {
      const [rx, ry] = s.samples[s.samples.length - 1];
      seen = s.samples.length;
      points.push([targets[i][0], targets[i][1], rx, ry]);
      tone('click');
      cross.classList.add('hit'); setTimeout(() => cross.classList.remove('hit'), 150);
      if (++i < targets.length) { show(); continue; }
      info.innerHTML = '<b>Saving…</b>';
      const res = await api('/api/touch/calibrate/finish', { points });
      clearTimeout(timeout);
      if (res.ok) { info.innerHTML = '<b>Touch calibrated!</b><br>Restarting the screen for a second…'; done = true; setTimeout(() => ov.remove(), 6000); }
      else {
        done = true; clearTimeout(timeout); api('/api/touch/calibrate/cancel', {});
        info.innerHTML = `<b>${esc(res.message || 'Calibration failed')}</b>`;
        cross.remove();
        const btns = h('div', { class: 'row-btns', style: { display: 'flex', gap: '14px', justifyContent: 'center', marginTop: '22px', pointerEvents: 'auto' } },
          h('button', { class: 'btn', onclick: () => ov.remove() }, 'Close'),
          h('button', { class: 'btn primary', onclick: () => { ov.remove(); touchCalibrate(); } }, 'Try again'));
        info.append(btns); info.style.pointerEvents = 'auto';
      }
    }
  }
}

// touch test — dial *#0*#
function touchTest() {
  const cv = h('canvas'), ov = h('div', { class: 'touchtest' }, cv, h('div', { class: 'info' }, 'Touch test — draw with any number of fingers. Tap the corners to check alignment.'),
    h('button', { class: 'btn primary', style: { position: 'absolute', bottom: '60px', left: '50%', transform: 'translateX(-50%)' }, onclick: () => ov.remove() }, 'Done'));
  $('#phone').append(ov);
  cv.width = innerWidth; cv.height = innerHeight;
  const ctx = cv.getContext('2d'), last = {};
  ctx.strokeStyle = '#ccd'; for (let x = 0; x < cv.width; x += 50) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, cv.height); ctx.stroke(); }
  for (let y = 0; y < cv.height; y += 50) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cv.width, y); ctx.stroke(); }
  const colors = ['#e33', '#19f', '#2b2', '#f90', '#a3f'];
  cv.addEventListener('pointerdown', e => { last[e.pointerId] = [e.clientX, e.clientY]; });
  cv.addEventListener('pointermove', e => {
    const l = last[e.pointerId]; if (!l) return;
    ctx.strokeStyle = colors[e.pointerId % colors.length]; ctx.lineWidth = 5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(...l); ctx.lineTo(e.clientX, e.clientY); ctx.stroke(); last[e.pointerId] = [e.clientX, e.clientY];
    $('.info', ov).textContent = `x ${Math.round(e.clientX)}  y ${Math.round(e.clientY)}  fingers ${Object.keys(last).length}`;
  });
  const up = e => delete last[e.pointerId];
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
}

// ============================================================ apps
const APPS = {};

// ---------------------------------------------------------------- Phone
APPS.phone = {
  name: 'Phone', icon: 'phone', color: ['#a6f584', '#1f9e18'],
  open(win) { win.push('Phone', body => {
    let num = '';
    const disp = h('div', { class: 'dial-num' }, '');
    const set = v => { num = v; disp.textContent = num; checkCodes(); };
    const keys = [['1', ''], ['2', 'ABC'], ['3', 'DEF'], ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'], ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'], ['*', ''], ['0', '+'], ['#', '']];
    const pad = h('div', { class: 'dialpad' }, keys.map(([d, l]) => {
      let t;
      const b = h('button', { class: 'dk' }, h('b', {}, d), h('small', {}, l || ' '));
      b.addEventListener('pointerdown', () => { tone('click'); if (d === '0') t = setTimeout(() => { t = 'plus'; set(num + '+'); }, 600); });
      b.addEventListener('pointerup', () => { if (t === 'plus') return (t = null); clearTimeout(t); set(num + d); });
      return b;
    }));
    async function checkCodes() {
      if (num === '*#06#') { set(''); const a = await api('/api/about'); modal('Device ID', kv({ Serial: a.serial, MAC: a.mac, Model: a.model })); }
      else if (num === '*#0*#') { set(''); loadScript('testmode.js').then(() => window.SG_TESTMODE()).catch(e => toast(e.message)); }
      else if (num === '*#0*0#') { set(''); touchCalibrate(); }
      else if (num === '*#*#4636#*#*') { set(''); const a = await api('/api/about'); modal('Testing', kv({ OS: a.os, Kernel: a.kernel, 'CPU temp': (a.cpu_temp ?? '?') + ' °C', Uptime: fmtDur(a.uptime), Memory: `${a.mem_free_mb} / ${a.mem_total_mb} MB free` })); }
      else if (num === '*#7777#') { set(''); bubbleBoost = bubbleBoost > 1 ? 1 : 3; toast(bubbleBoost > 1 ? 'Bubble storm activated.' : 'Bubble storm over.'); if (bubbleBoost > 1) LIGHT.egg('disco', 8); }
    }
    const call = h('button', { class: 'call-orb', html: '<svg viewBox="0 0 24 24">' + ICONS.phone.replace('class="f" ', '') + '</svg>', onclick: () => dial(num) });
    const del = h('button', { class: 'orb back', style: { width: '56px', height: '56px' }, html: svg('backspace'), onclick: () => set(num.slice(0, -1)) });
    body.append(disp, pad, h('div', { class: 'dial-actions' }, h('span', { style: { width: '56px' } }), call, del));
    const onKey = e => { if (/^[0-9*#+]$/.test(e.key)) set(num + e.key); else if (e.key === 'Backspace') set(num.slice(0, -1)); else if (e.key === 'Enter') dial(num); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }); },
};
async function dial(num) {
  if (!num) return;
  if (num === '42') return toast('The Answer is busy right now. Try again in 7.5 million years.');
  const r = await api('/api/call', { number: num });
  if (!r.ok) return modal('Can’t call', h('p', {}, r.message || 'Call failed.'));
  const started = Date.now();
  const timer = h('div', {}, 'Calling…');
  const scr = h('div', { class: 'callscreen' }, h('div', { style: { textAlign: 'center' } }, h('div', { class: 'num' }, num), timer),
    h('button', { class: 'call-orb end', html: '<svg viewBox="0 0 24 24">' + ICONS.phone.replace('class="f" ', '') + '</svg>', onclick: hang }));
  const iv = setInterval(() => { const s = Math.floor((Date.now() - started) / 1000); timer.textContent = `${Math.floor(s / 60)}:${pad2(s % 60)}`; }, 1000);
  function hang() { clearInterval(iv); api('/api/hangup', { call: r.call }); scr.remove(); }
  CURRENT.body.append(scr);
}

// ---------------------------------------------------------------- Messages
APPS.messages = {
  name: 'Messages', icon: 'messages', color: ['#9af2ff', '#0f9bd4'],
  open(win) { win.push('Messages', async body => {
    const r = await api('/api/sms');
    const threads = {};
    for (const m of r.messages || []) (threads[m.number] = threads[m.number] || []).push(m);
    body.append(h('div', { class: 'pad' }, h('button', { class: 'btn primary', onclick: () => newMsg(win) }, '+ New message')));
    if (!r.modem) body.append(emptyState('messages', 'No modem detected. Add a 4G HAT with a SIM card and your texts will show up here.'));
    else if (!Object.keys(threads).length) body.append(emptyState('messages', 'No messages yet.'));
    else body.append(h('div', { class: 'list' }, Object.entries(threads).map(([n, ms]) =>
      listItem({ icon: 'messages', title: n, sub: ms[ms.length - 1].text, onclick: () => win.push(n, b => thread(b, n, ms)) }))));
  }); },
};
function newMsg(win) {
  win.push('New message', body => {
    const n = h('input', { class: 'field', type: 'text', placeholder: 'Phone number' });
    body.append(h('div', { class: 'pad' }, n, h('div', { style: { height: '12px' } }),
      h('button', { class: 'btn primary', onclick: () => n.value && win.replace(n.value, b => thread(b, n.value, [])) }, 'Next')));
    setTimeout(() => n.focus(), 300);
  });
}
function thread(body, number, msgs) {
  const list = h('div', { class: 'pad', style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
  const bubble = m => h('div', { class: m.out ? 'btn primary' : 'btn', style: { alignSelf: m.out ? 'flex-end' : 'flex-start', borderRadius: '18px', maxWidth: '80%', fontWeight: 400, textAlign: 'left' } }, m.text);
  msgs.forEach(m => list.append(bubble(m)));
  const input = h('input', { class: 'field', type: 'text', placeholder: 'Message' });
  const send = async () => {
    if (!input.value) return;
    const text = input.value; input.value = '';
    list.append(bubble({ text, out: true }));
    const r = await api('/api/sms/send', { number, text });
    if (!r.ok) toast(r.message || 'Not sent');
  };
  input.addEventListener('keydown', e => e.key === 'Enter' && send());
  body.append(list, h('div', { class: 'pad', style: { display: 'flex', gap: '8px', position: 'sticky', bottom: 0 } }, input, h('button', { class: 'orb back', html: svg('send'), onclick: send })));
}

// ---------------------------------------------------------------- Sky Search (DuckDuckGo, in Aero)
// Suggestions + instant answers inside the shell; full web results / sites open in the real
// browser, which gets a Close · Home · Back bar at the bottom (built-in extension).
const DDG_THEME = '&kae=-1&k7=%23eaf6ff&k9=%230a58b5&kaa=%236a3fb0&kx=%23178a3c&k8=%2317324f&kak=-1&kax=-1&kaq=-1&kap=-1&kao=-1&kau=-1';
const ddgUrl = (q, extra = '') => 'https://duckduckgo.com/?q=' + encodeURIComponent(q) + extra + DDG_THEME;
const looksLikeUrl = s => /^(https?:\/\/)?([\w-]+\.)+[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(s) && !/\s/.test(s);
async function openWeb(url) {
  toast('Opening… use ✕ / ○ at the bottom (or the power button) to come back.', 3500);
  const r = await api('/api/browser', { url });
  if (!r.ok) toast(r.message || 'Could not start the browser');
}
APPS.browser = {
  name: 'Sky Search', icon: 'search', color: ['#bff0ff', '#1677e0'],
  open(win, q) { win.push('Sky Search', body => skyHome(body, win, q)); },
};
function skyLogo(small) {
  return h('div', { class: 'sky-logo' + (small ? ' small' : '') }, h('span', { class: 'sky-orb' }), h('b', {}, 'Sky'), h('span', {}, 'Search'));
}
function skyBox(win, value = '') {
  const input = h('input', { type: 'search', class: 'sky-input', placeholder: 'Search privately or type a web address', value, autocomplete: 'off', spellcheck: 'false' });
  const sugg = h('div', { class: 'sky-sugg' });
  let timer = 0, seq = 0;
  const go = text => {
    text = (text ?? input.value).trim(); if (!text) return;
    OSK.hide(); input.blur();
    if (looksLikeUrl(text)) return openWeb(/^https?:/i.test(text) ? text : 'https://' + text);
    const hist = loadJSON('sg.skyhist', []).filter(x => x !== text); hist.unshift(text);
    localStorage.setItem('sg.skyhist', JSON.stringify(hist.slice(0, 8)));
    win.push(text, body => skyResults(body, win, text));
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const v = input.value.trim();
    if (!v) { sugg.innerHTML = ''; return; }
    timer = setTimeout(async () => {
      const my = ++seq, r = await api('/api/search/suggest?q=' + encodeURIComponent(v));
      if (my !== seq || !input.isConnected) return;
      sugg.innerHTML = '';
      for (const s of r.suggestions || []) sugg.append(h('button', { class: 'sky-sug', onclick: () => go(s) }, h('span', { html: svg('search') }), s));
    }, 220);
  });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  const bar = h('div', { class: 'sky-bar' }, input, h('button', { class: 'sky-go', html: svg('search'), onclick: () => go() }));
  return { el: h('div', { class: 'sky-boxwrap' }, bar, sugg), input, go };
}
function skyHome(body, win, q) {
  body.classList.add('sky-page');
  const box = skyBox(win, q || '');
  const tiles = [
    ['Images', 'photos', t => ddgUrl(t || 'sky', '&iax=images&ia=images')],
    ['News', 'messages', t => ddgUrl(t || 'news', '&iar=news&ia=news')],
    ['Videos', 'camera', t => ddgUrl(t || 'videos', '&iax=videos&ia=videos')],
    ['Maps', 'drop', t => ddgUrl(t || 'map', '&iaxm=maps')],
    ['Weather', 'bubble', () => ddgUrl('weather')],
    ['Wikipedia', 'file', t => t ? ddgUrl('!w ' + t) : 'https://en.m.wikipedia.org/'],
  ];
  const hist = loadJSON('sg.skyhist', []);
  body.append(...[h('div', { class: 'sky-hero' }, skyLogo(), h('p', { class: 'sky-tag' }, 'Private search · powered by DuckDuckGo')), box.el,
    h('div', { class: 'sky-tiles' }, tiles.map(([name, icon, url]) => h('button', { class: 'sky-tile', onclick: () => openWeb(url(box.input.value.trim())) },
      h('span', { class: 'sky-bub', html: svg(icon) }), name))),
    hist.length ? h('div', { class: 'section' }, 'RECENT SEARCHES') : null,
    hist.length ? h('div', { class: 'list' }, hist.map(t => listItem({ icon: 'clock', title: t, onclick: () => box.go(t) })),
      listItem({ icon: 'close', title: 'Clear history', onclick: () => { localStorage.removeItem('sg.skyhist'); win.replace('Sky Search', b => skyHome(b, win)); } })) : null,
    h('p', { class: 'sky-foot' }, 'Sky Search doesn\'t track you. Neither does DuckDuckGo.')].filter(Boolean));
  if (q) box.go(q);
}
async function skyResults(body, win, q) {
  body.classList.add('sky-page');
  const box = skyBox(win, q);
  const out = h('div', { class: 'sky-results' }, h('div', { class: 'sky-loading' }, h('span', { class: 'sky-orb spin' }), 'Searching the sky…'));
  body.append(h('div', { class: 'sky-top' }, skyLogo(true)), box.el, out);
  if (skyEgg(q, win)) return out.remove();
  const r = await api('/api/search/answer?q=' + encodeURIComponent(q));
  if (!out.isConnected) return;
  out.innerHTML = '';
  const web = h('button', { class: 'btn primary sky-web', onclick: () => openWeb(ddgUrl(q)) }, 'All web results for “' + q + '” ›');
  if (r.offline) { out.append(emptyState('wifi', 'You\'re offline. Connect to Wi-Fi in Settings to search.')); return; }
  const text = r.answer || r.abstract || r.definition;
  if (text) {
    out.append(h('div', { class: 'sky-card' },
      r.image ? h('img', { class: 'sky-img', src: r.image, alt: '', onerror: e => e.target.remove() }) : null,
      r.heading ? h('h3', {}, r.heading) : null, h('p', {}, text),
      r.url ? h('a', { class: 'sky-src', onclick: () => openWeb(r.url) }, (r.source || 'Source') + ' ›') : null));
  }
  out.append(web);
  if (r.related && r.related.length) {
    out.append(h('div', { class: 'section' }, 'RELATED'), h('div', { class: 'list' }, r.related.map(x =>
      listItem({ icon: 'search', title: x.text.split(' - ')[0], sub: x.text.includes(' - ') ? x.text.split(' - ').slice(1).join(' - ') : '', onclick: () => openWeb(x.url) }))));
  }
  if (!text && !(r.related && r.related.length)) {
    out.prepend(h('p', { class: 'sky-none' }, 'No instant answer — opening the full results…'));
    setTimeout(() => out.isConnected && openWeb(ddgUrl(q)), 900);
  }
}
// easter eggs for Sky Search
function skyEgg(q, win) {
  const t = q.toLowerCase().trim();
  if (t === 'do a barrel roll' || t === 'z or r twice') { win.el.classList.add('sky-roll'); setTimeout(() => win.el.classList.remove('sky-roll'), 2100); return false; }
  if (t === 'askew' || t === 'tilt') { win.el.classList.toggle('sky-askew'); return false; }
  if (t === 'frutiger aero' || t === 'aero') { burstBubbles(); toast('🫧 Peak 2007 achieved. Welcome home.', 3500); return false; }
  if (t === 'sudo make me a sandwich') { toast('🥪 Okay.', 2500); return false; }
  return false;
}
function burstBubbles() {
  const layer = h('div', { class: 'sky-burst' });
  for (let i = 0; i < 26; i++) {
    const s = 14 + Math.random() * 46;
    layer.append(h('span', { style: { left: Math.random() * 100 + '%', width: s + 'px', height: s + 'px', animationDelay: Math.random() * .9 + 's', animationDuration: 2 + Math.random() * 1.6 + 's' } }));
  }
  $('#phone').append(layer); setTimeout(() => layer.remove(), 4200);
}

// ---------------------------------------------------------------- 3D Viewer (WebGL, no libraries)
// Drag to orbit, pinch / scroll to zoom, two fingers to pan, double-tap to reset.
APPS.viewer3d = {
  name: '3D Viewer', icon: 'cube', color: ['#ffd9a8', '#e8641c'],
  open(win, path) {
    const name = path ? path.split('/').pop() : '3DBenchy.stl';
    win.push(name, body => viewer3d(body, path ? '/api/file?path=' + encodeURIComponent(path) : 'assets/3DBenchy.stl.gz', !path));
  },
};
function parseSTL(buf) {
  const dv = new DataView(buf);
  const binary = buf.byteLength >= 84 && 84 + dv.getUint32(80, true) * 50 === buf.byteLength;
  let pos;
  if (binary) {
    const n = dv.getUint32(80, true); pos = new Float32Array(n * 9);
    for (let i = 0, o = 84; i < n; i++, o += 50) for (let j = 0; j < 9; j++) pos[i * 9 + j] = dv.getFloat32(o + 12 + j * 4, true);
  } else {
    const txt = new TextDecoder().decode(buf), v = [];
    const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g; let m;
    while ((m = re.exec(txt))) v.push(+m[1], +m[2], +m[3]);
    pos = new Float32Array(v.length - v.length % 9 ? v.slice(0, v.length - v.length % 9) : v);
  }
  const tris = pos.length / 9; if (!tris) throw new Error('no triangles in this file');
  // bounding box -> centre on the origin, fit in a unit sphere, Z-up (printer) -> Y-up (screen)
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], pos[i + k]); mx[k] = Math.max(mx[k], pos[i + k]); }
  const c = mn.map((v, k) => (v + mx[k]) / 2), r = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) / 2 || 1;
  const out = new Float32Array(tris * 18); // xyz + normal, 3 vertices
  const p = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let t = 0; t < tris; t++) {
    for (let v = 0; v < 3; v++) {
      const i = t * 9 + v * 3;
      p[v * 3] = (pos[i] - c[0]) / r; p[v * 3 + 1] = (pos[i + 2] - c[2]) / r; p[v * 3 + 2] = -(pos[i + 1] - c[1]) / r;
    }
    const ux = p[3] - p[0], uy = p[4] - p[1], uz = p[5] - p[2], vx = p[6] - p[0], vy = p[7] - p[1], vz = p[8] - p[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    for (let v = 0; v < 3; v++) { const o = t * 18 + v * 6; out[o] = p[v * 3]; out[o + 1] = p[v * 3 + 1]; out[o + 2] = p[v * 3 + 2]; out[o + 3] = nx; out[o + 4] = ny; out[o + 5] = nz; }
  }
  return { data: out, tris, size: [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]] };
}
function viewer3d(body, url, isBenchy) {
  body.style.padding = '0';
  const cv = h('canvas', { class: 'v3d-canvas' });
  const info = h('div', { class: 'v3d-info' }, 'Loading model…');
  const MATS = { orange: [1, .45, .12], aero: [.35, .75, 1], white: [.92, .94, .96], green: [.3, .85, .45] };
  let mat = 'orange', spin = true;
  const btn = (label, fn) => h('button', { class: 'v3d-btn', onclick: fn }, label);
  const spinBtn = btn('⟳ Spin: on', () => { spin = !spin; spinBtn.textContent = '⟳ Spin: ' + (spin ? 'on' : 'off'); kick(); });
  const tools = h('div', { class: 'v3d-tools' }, spinBtn,
    btn('🎨 Colour', () => { const k = Object.keys(MATS); mat = k[(k.indexOf(mat) + 1) % k.length]; kick(); }),
    btn('⤢ Reset', () => { reset(); kick(); }));
  const credit = isBenchy ? h('div', { class: 'v3d-credit' }, '#3DBenchy by Creative Tools · 3dbenchy.com · CC BY-ND 4.0') : null;
  const wrap = h('div', { class: 'v3d' }, cv, info, tools, credit);
  body.append(wrap);
  const gl = cv.getContext('webgl', { antialias: true, alpha: true, premultipliedAlpha: true });
  if (!gl) { wrap.replaceWith(emptyState('cube', 'This screen has no 3D graphics (WebGL) right now — it may be in safe mode.')); return; }
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, `attribute vec3 p, n; uniform mat4 mv, pr; varying vec3 vn, vp;
    void main() { vec4 e = mv * vec4(p, 1.0); vp = e.xyz; vn = mat3(mv) * n; gl_Position = pr * e; }`));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, `precision mediump float; varying vec3 vn, vp; uniform vec3 col;
    void main() {
      vec3 N = normalize(vn); if (!gl_FrontFacing) N = -N;
      vec3 V = normalize(-vp), L1 = normalize(vec3(.5, .8, .6)), L2 = normalize(vec3(-.7, .2, -.4));
      float d = max(dot(N, L1), 0.0) * .75 + max(dot(N, L2), 0.0) * .25;
      float s = pow(max(dot(N, normalize(L1 + V)), 0.0), 48.0) * .6;
      float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0) * .45;
      vec3 c = col * (.28 + d) + vec3(s) + vec3(.55, .8, 1.0) * rim;
      gl_FragColor = vec4(c, 1.0);
    }`));
  gl.linkProgram(prog); gl.useProgram(prog);
  const U = n => gl.getUniformLocation(prog, n), aP = gl.getAttribLocation(prog, 'p'), aN = gl.getAttribLocation(prog, 'n');
  let tris = 0, yaw, pitch, dist, panX, panY;
  const reset = () => { yaw = -.6; pitch = .35; dist = 3.1; panX = 0; panY = 0; };
  reset();
  // ---- tiny matrix helpers (column-major)
  const mul = (a, b) => { const o = new Float32Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; };
  const persp = (fov, asp, n, f) => { const t = 1 / Math.tan(fov / 2); return new Float32Array([t / asp, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, 2 * f * n / (n - f), 0]); };
  const rotX = a => new Float32Array([1, 0, 0, 0, 0, Math.cos(a), Math.sin(a), 0, 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 0, 1]);
  const rotY = a => new Float32Array([Math.cos(a), 0, -Math.sin(a), 0, 0, 1, 0, 0, Math.sin(a), 0, Math.cos(a), 0, 0, 0, 0, 1]);
  const trans = (x, y, z) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
  // ---- render loop: only runs while spinning or being touched (saves battery)
  let raf = 0, alive = true, frames = 0, fpsT = performance.now(), fps = 0, lastT = 0, statText = '';
  const draw = t => {
    raf = 0; if (!alive) return;
    const r = cv.getBoundingClientRect(), w = Math.max(1, Math.round(r.width)), hh = Math.max(1, Math.round(r.height));
    if (cv.width !== w || cv.height !== hh) { cv.width = w; cv.height = hh; }
    if (spin && !drag.size) yaw += Math.min(50, t - (lastT || t)) * .0006;
    lastT = t;
    gl.viewport(0, 0, w, hh); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (tris) {
      gl.uniformMatrix4fv(U('pr'), false, persp(.8, w / hh, .05, 50));
      gl.uniformMatrix4fv(U('mv'), false, mul(trans(panX, panY, -dist), mul(rotX(pitch), rotY(yaw))));
      gl.uniform3fv(U('col'), MATS[mat]);
      gl.drawArrays(gl.TRIANGLES, 0, tris * 3);
    }
    frames++;
    if (t - fpsT > 1000) { fps = Math.round(frames * 1000 / (t - fpsT)); frames = 0; fpsT = t; info.textContent = statText + ' · ' + fps + ' fps'; }
    if (spin || drag.size) kick();
  };
  const kick = () => { if (!raf && alive) raf = requestAnimationFrame(draw); };
  // ---- touch / mouse
  const drag = new Map(); let pinch0 = 0, mid0 = null, lastTap = 0;
  const mid = () => { const p = [...drag.values()]; return [(p[0].x + p[1].x) / 2, (p[0].y + p[1].y) / 2]; };
  const spread = () => { const p = [...drag.values()]; return Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); };
  cv.addEventListener('pointerdown', e => {
    cv.setPointerCapture(e.pointerId); drag.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (drag.size === 2) { pinch0 = spread(); mid0 = mid(); }
    if (drag.size === 1) { if (performance.now() - lastTap < 300) reset(); lastTap = performance.now(); }
    kick();
  });
  cv.addEventListener('pointermove', e => {
    const d = drag.get(e.pointerId); if (!d) return;
    if (drag.size === 1) {
      yaw += (e.clientX - d.x) * .01; pitch = Math.max(-1.5, Math.min(1.5, pitch + (e.clientY - d.y) * .01));
      d.x = e.clientX; d.y = e.clientY;
    } else if (drag.size === 2) {
      d.x = e.clientX; d.y = e.clientY;
      const s = spread(), m = mid();
      if (pinch0) dist = Math.max(1.2, Math.min(12, dist * pinch0 / s));
      const k = dist / cv.getBoundingClientRect().height * .85;
      panX += (m[0] - mid0[0]) * k; panY -= (m[1] - mid0[1]) * k;
      pinch0 = s; mid0 = m;
    }
    kick();
  });
  const up = e => { drag.delete(e.pointerId); pinch0 = 0; if (drag.size === 2) { pinch0 = spread(); mid0 = mid(); } };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  cv.addEventListener('wheel', e => { e.preventDefault(); dist = Math.max(1.2, Math.min(12, dist * Math.exp(e.deltaY * .0015))); kick(); }, { passive: false });
  // ---- load the model
  (async () => {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('could not read the file');
      const m = parseSTL(url.endsWith('.gz') ? await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer() : await res.arrayBuffer());
      if (!alive) return;
      const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, m.data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(aP); gl.vertexAttribPointer(aP, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(aN); gl.vertexAttribPointer(aN, 3, gl.FLOAT, false, 24, 12);
      gl.enable(gl.DEPTH_TEST);
      tris = m.tris;
      statText = tris.toLocaleString() + ' triangles · ' + m.size.map(v => v.toFixed(1)).join(' × ') + ' mm';
      info.textContent = statText;
      wrap.dataset.tris = tris;
      kick();
    } catch (e) { info.textContent = 'Could not open this model: ' + e.message; }
  })();
  return () => { alive = false; if (raf) cancelAnimationFrame(raf); const ext = gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext(); };
}

// ---------------------------------------------------------------- Camera (photo + video, save to phone or USB)
APPS.camera = {
  name: 'Camera', icon: 'camera', color: ['#d4dde5', '#46566a'],
  open(win) { win.push('Camera', body => {
    let mode = 'photo', recStart = 0, recTick = 0;
    const view = h('img', { class: 'view', src: '/api/camera/stream?' + Date.now() });
    const thumb = h('button', { class: 'thumb', onclick: () => openApp('photos') });
    const shutter = h('button', { class: 'shutter', onclick: () => mode === 'photo' ? snap() : (recStart ? stopRec() : startRec()) });
    const recBadge = h('div', { class: 'rec-badge hidden' }, h('i'), h('b', {}, '0:00'));
    const paused = h('div', { class: 'rec-paused hidden' }, '● Recording', h('small', {}, 'Preview pauses while recording'));
    const saveBtn = h('button', { class: 'cam-save', onclick: toggleSave });
    const hqBtn = h('button', { class: 'cam-hq', onclick: () => { S.camHQ = !S.camHQ; save(); hqBtn.textContent = S.camHQ ? 'HQ 12MP' : 'Std 3MP'; toast(S.camHQ ? 'High quality: about 5 MB a photo' : 'Standard: about 1 MB a photo, saves space'); } }, S.camHQ ? 'HQ 12MP' : 'Std 3MP');
    const modeBtns = ['photo', 'video'].map(m => h('button', { class: 'cam-mode', 'data-m': m, onclick: () => setMode(m) }, m === 'photo' ? 'PHOTO' : 'VIDEO'));
    const wrap = h('div', { class: 'cam' }, h('div', { class: 'cam-view' }, view, recBadge, paused, saveBtn, hqBtn),
      h('div', { class: 'cam-modes' }, modeBtns),
      h('div', { class: 'cam-bar' }, thumb, shutter, h('span', { style: { width: '62px' } })));
    view.addEventListener('error', () => { if (!recStart) wrap.replaceWith(emptyState('camera', 'No camera found. Connect a Raspberry Pi camera module to the CAM port and reboot.')); });
    body.append(wrap);
    const setMode = m => { if (recStart) return; mode = m; shutter.classList.toggle('video', m === 'video'); modeBtns.forEach(b => b.classList.toggle('on', b.dataset.m === m)); };
    setMode('photo');
    async function showSave() {
      if (S.camTo === 'usb') {
        const r = await api('/api/usb');
        if (!(r.drives || []).some(d => d.mounted)) { S.camTo = 'phone'; save(); toast('USB drive not found — saving to the phone'); }
      }
      saveBtn.innerHTML = svg(S.camTo === 'usb' ? 'usb' : 'device') + (S.camTo === 'usb' ? 'Saving to USB' : 'Saving to phone');
    }
    async function toggleSave() {
      if (S.camTo === 'usb') S.camTo = 'phone';
      else {
        const r = await api('/api/usb');
        if (!(r.drives || []).some(d => d.mounted)) return toast('Plug in a USB drive first', 3000);
        S.camTo = 'usb';
      }
      save(); showSave();
    }
    showSave();
    const onUsb = () => showSave(); addEventListener('sg-usb', onUsb);
    const setThumb = path => {
      thumb.innerHTML = ''; thumb.style.backgroundImage = '';
      thumb.style.backgroundImage = `url("${thumbUrl(path)}&v=${Date.now()}")`;
    };
    async function snap() {
      wrap.style.filter = 'brightness(3)'; setTimeout(() => (wrap.style.filter = ''), 120); tone('pop');
      const r = await api('/api/camera/snap', { to: S.camTo, hq: !!S.camHQ });
      if (r.ok) setThumb(r.path); else toast(r.message || 'Snap failed');
      view.src = '/api/camera/stream?' + Date.now();
    }
    function recUI(on) {
      shutter.classList.toggle('rec', on); recBadge.classList.toggle('hidden', !on); paused.classList.toggle('hidden', !on);
      modeBtns.forEach(b => (b.disabled = on)); saveBtn.disabled = on;
      clearInterval(recTick);
      if (on) recTick = setInterval(() => { const s = Math.floor(Date.now() / 1000 - recStart); recBadge.lastChild.textContent = Math.floor(s / 60) + ':' + pad2(s % 60); }, 500);
    }
    async function startRec() {
      shutter.disabled = true;
      const r = await api('/api/camera/record/start', { to: S.camTo });
      shutter.disabled = false;
      if (!r.ok) return toast(r.message || 'Could not record', 5000);
      tone('click'); recStart = r.started; view.src = ''; recUI(true);
    }
    async function stopRec() {
      shutter.disabled = true;
      const r = await api('/api/camera/record/stop', {});
      shutter.disabled = false; recStart = 0; recUI(false);
      view.src = '/api/camera/stream?' + Date.now();
      if (r.ok) { setThumb(r.path); toast(`Video saved (${Math.floor(r.seconds / 60)}:${pad2(r.seconds % 60)})`); } else toast(r.message || 'Video was not saved');
    }
    api('/api/camera/record').then(r => { if (r.recording) { setMode('video'); recStart = r.started; view.src = ''; recUI(true); } });
    return () => {
      view.src = ''; clearInterval(recTick); removeEventListener('sg-usb', onUsb);
      if (recStart) api('/api/camera/record/stop', {}).then(r => r.ok && toast('Recording stopped and saved'));
    };
  }); },
};

// ---------------------------------------------------------------- Photos
APPS.photos = {
  name: 'Photos', icon: 'photos', color: ['#ffbdd8', '#dc2c6c'],
  open(win) { const page = () => win.push('Photos', async body => {
    const r = await api('/api/photos');
    if (!r.photos || !r.photos.length) return body.append(emptyState('photos', 'No photos or videos yet. Anything in ~/Pictures and ~/Videos shows up here.'));
    const sel = selector(body, moved => { if (moved) CURRENT && CURRENT.show(); });
    body.prepend(h('div', { class: 'photos-top' }, h('span', {}, r.photos.length + ' items'), sel.button));
    body.append(h('div', { class: 'photos' }, r.photos.map(p => {
      const cell = h('div', { 'data-path': p.path,
        onclick: () => sel.on ? sel.toggle(p.path) : mediaViewer(p.path, () => CURRENT && CURRENT.show()) },
        h('img', { src: thumbUrl(p.path) + '&m=' + Math.round(p.mtime), loading: 'lazy', decoding: 'async', alt: '' }),
        p.video ? h('span', { class: 'play', html: svg('video') }) : null,
        h('span', { class: 'tick', html: svg('check') }));
      return cell;
    })));
  }); page(); },
};

// ---------------------------------------------------------------- Files
APPS.files = {
  name: 'Files', icon: 'files', color: ['#ffe58f', '#e0940c'],
  open(win) {
    const go = path => win.push(path === '~' ? 'Phone' : path.split('/').pop() || '/', body => folder(body, path, go));
    win.push('Files', body => storageList(body, win, go));
  },
};
async function usbCheck() {
  const pre = h('pre', { class: 'usb-debug' }, 'Checking…');
  modal('USB check', pre, [{ label: 'Close' }]);
  const r = await api('/api/usb/debug');
  pre.textContent = (r.text || r.error || 'No answer') + '\n\nTips: use a USB-A stick in a blue USB 3 port, formatted FAT32 or exFAT. If the stick is not under "Disks" above, the Pi does not see it at all: try another port, another stick, or a powered hub.';
}
async function storageList(body, win, go) {
  const draw = async () => {
    const r = await api('/api/usb');
    if (!body.isConnected) return;
    body.innerHTML = '';
    const drives = r.drives || [];
    body.append(h('div', { class: 'section' }, 'STORAGE'), h('div', { class: 'list' },
      listItem({ icon: 'device', title: 'Phone', sub: 'Your photos, videos and files', onclick: () => go('~') }),
      drives.map(d => listItem({ icon: 'usb', title: d.label,
        sub: d.mounted ? `USB · ${d.free != null ? fmtSize(d.free) + ' free of ' : ''}${fmtSize(d.size)}` : `USB · ${fmtSize(d.size)} · tap to open`,
        onclick: async () => {
          if (!d.mounted) { const m = await api('/api/usb/mount', { dev: d.dev }); if (!m.ok) return toast(m.message, 4000); d.mountpoint = m.mountpoint; }
          go(d.mountpoint);
        },
        right: d.mounted ? h('button', { class: 'pill eject', html: svg('eject') + 'Eject', onclick: async e => {
          e.stopPropagation();
          const x = await api('/api/usb/eject', { dev: d.dev });
          toast(x.ok ? `“${d.label}” is safe to remove ✔` : x.message, 4000); draw();
        } }) : null }))),
      drives.length ? null : h('p', { class: 'hint' }, 'Plug in a USB drive and it shows up here. Use “Select” in any folder (or in Photos) to copy photos and videos to it.'),
      h('div', { class: 'list' }, listItem({ icon: 'usb', title: 'USB drive not showing?', sub: 'Check what the phone can see', onclick: usbCheck })));
  };
  await draw();
  const onUsb = () => draw(); addEventListener('sg-usb', onUsb);
  return () => removeEventListener('sg-usb', onUsb);
}
async function folder(body, path, go) {
  const r = await api('/api/files?path=' + encodeURIComponent(path));
  if (r.error) return body.append(h('div', { class: 'section' }, r.path), emptyState('files', r.error));
  const sel = selector(body, moved => { if (moved) CURRENT && CURRENT.show(); });
  body.append(h('div', { class: 'section folder-head' }, h('span', {}, r.path), r.entries.some(e => !e.dir) ? sel.button : null));
  if (!r.entries.length) return body.append(emptyState('files', 'This folder is empty.'));
  body.append(h('div', { class: 'list' }, r.entries.map(e => {
    const full = r.path.replace(/\/$/, '') + '/' + e.name;
    const it = listItem({
      icon: e.dir ? 'files' : VIDEO_RE.test(e.name) ? 'video' : /\.(jpe?g|png|gif|webp)$/i.test(e.name) ? 'photos' : 'file', title: e.name, sub: e.dir ? 'Folder' : fmtSize(e.size),
      onclick: () => sel.on ? (!e.dir && sel.toggle(full)) : e.dir ? go(full) : openFile(full, e),
      right: e.dir ? null : h('span', { class: 'tick', html: svg('check') }),
    });
    if (!e.dir) it.dataset.path = full;
    return it;
  })));
}
async function openFile(path, e) {
  if (/\.(jpe?g|png|gif|webp)$/i.test(path)) return mediaViewer(path, () => CURRENT && CURRENT.show());
  if (/\.svg$/i.test(path)) return imageViewer(path);
  if (/\.stl$/i.test(path)) return openApp('viewer3d', path);
  if (/\.apk$/i.test(path)) {
    const name = path.split('/').pop();
    if (await modal('Install “' + name + '”?', h('p', {}, 'It installs into Android (Waydroid). Only install apps you trust.'), [{ label: 'Cancel' }, { label: 'Install', value: 'y', primary: true }]) !== 'y') return;
    const x = await api('/api/android', { action: 'install', path });
    return toast(x.ok ? 'Installing ' + name + '… you get a notification when it is done' : x.message || 'Failed', 4500);
  }
  if (VIDEO_RE.test(path)) return mediaViewer(path, () => CURRENT && CURRENT.show());
  if (/\.(mp3|ogg|oga|flac|wav|m4a|aac|opus)$/i.test(path)) return MUSIC.playFile(path);
  if (e.size > 512 * 1024) return toast('Too big to preview here. Try the Terminal.');
  const txt = await (await fetch('/api/file?path=' + encodeURIComponent(path))).text();
  if (/[\x00-\x08]/.test(txt.slice(0, 2000))) return toast('Binary file — no preview.');
  CURRENT.push(path.split('/').pop(), body => body.append(h('div', { class: 'textview' }, txt)));
}

// ---------------------------------------------------------------- Notes
APPS.notes = {
  name: 'Notes', icon: 'notes', color: ['#fff6a0', '#e4bd12'],
  open(win) {
    const load = () => { const n = loadJSON('sg.notes', []); return Array.isArray(n) ? n : []; };
    const store = n => localStorage.setItem('sg.notes', JSON.stringify(n));
    const edit = id => win.push('Note', body => {
      const notes = load(); let n = notes.find(x => x.id === id);
      if (!n) { n = { id, text: '', t: Date.now() }; notes.unshift(n); store(notes); }
      const ta = h('textarea', { class: 'note-edit', placeholder: 'Write something lovely…' });
      ta.value = n.text;
      ta.addEventListener('input', () => { const all = load(); const x = all.find(y => y.id === id); if (x) { x.text = ta.value; x.t = Date.now(); store(all); } });
      body.style.padding = '0'; body.append(ta); setTimeout(() => ta.focus(), 300);
      return () => { const all = load().filter(x => x.text.trim()); store(all); };
    });
    win.push('Notes', body => {
      const notes = load();
      body.append(h('div', { class: 'pad' }, h('button', { class: 'btn primary', onclick: () => edit(Date.now()) }, '+ New note')));
      if (!notes.length) return body.append(emptyState('notes', 'No notes yet.'));
      body.append(h('div', { class: 'list' }, notes.map(n => listItem({ icon: 'notes', title: n.text.split('\n')[0].slice(0, 60) || 'Untitled', sub: new Date(n.t).toLocaleString(), onclick: () => edit(n.id) }))));
    });
  },
};

// ---------------------------------------------------------------- Calculator
APPS.calc = {
  name: 'Calculator', icon: 'calc', color: ['#ffc794', '#ee6410'],
  open(win) { win.push('Calculator', body => {
    let expr = '', justEvaluated = false;
    const exprEl = h('div', { class: 'expr' }), resEl = h('div', { class: 'res' }, '0');
    const root = h('div', { class: 'calc' }, h('div', { class: 'calc-screen' }, exprEl, resEl));
    const keys = ['C', '(', ')', '÷', '7', '8', '9', '×', '4', '5', '6', '−', '1', '2', '3', '+', '0', '.', '⌫', '='];
    const pressK = k => {
      if (k === 'C') { expr = ''; exprEl.textContent = ''; resEl.textContent = '0'; root.classList.remove('leet'); return; }
      if (k === '⌫') { expr = expr.slice(0, -1); }
      else if (k === '=') return evaluate();
      else { if (justEvaluated && /[0-9.]/.test(k)) expr = ''; expr += k; }
      justEvaluated = false;
      resEl.textContent = expr || '0';
      if (expr === '1337') { root.classList.toggle('leet'); exprEl.textContent = 'h4x0r m0d3'; }
    };
    function evaluate() {
      const js = expr.replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-');
      if (!js || !/^[0-9+\-*/(). ]+$/.test(js)) return;
      let v;
      try { v = Function('"use strict";return (' + js + ')')(); } catch (e) { resEl.textContent = 'Oops'; return; }
      exprEl.textContent = expr + ' =';
      if (!isFinite(v)) { // easter egg: divide by zero
        root.append(h('div', { class: 'blackhole' })); resEl.textContent = '∞';
        setTimeout(() => { exprEl.textContent = 'You broke the universe. Rebuilding…'; }, 900);
        setTimeout(() => { $$('.blackhole', root).forEach(b => b.remove()); exprEl.textContent = 'Universe restored. Please don’t do that again.'; resEl.textContent = '0'; expr = ''; }, 2600);
        return;
      }
      v = +parseFloat(v.toPrecision(12));
      if (js.replace(/ /g, '') === '0.1+0.2') exprEl.textContent = '0.1 + 0.2 = (we fixed floating point)';
      if (v === 42) exprEl.textContent = 'The answer to life, the universe and everything';
      resEl.textContent = String(v); expr = String(v); justEvaluated = true;
    }
    root.append(h('div', { class: 'calc-keys' }, keys.map(k => h('button', { class: 'ck' + ('÷×−+'.includes(k) ? ' op' : '') + (k === '=' ? ' eq' : ''), onclick: () => { tone('click'); pressK(k); } }, k))));
    body.style.padding = '0'; body.append(root);
    const onKey = e => { const m = { '*': '×', '/': '÷', '-': '−', Enter: '=', Backspace: '⌫', Escape: null }; const k = e.key in m ? m[e.key] : e.key; if (k && (keys.includes(k))) { e.preventDefault(); pressK(k); } };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }); },
};

// ---------------------------------------------------------------- Clock
APPS.clock = {
  name: 'Clock', icon: 'clock', color: ['#cdbfff', '#5536d2'],
  open(win) { win.push('Clock', body => {
    const face = h('div', { class: 'aero-clock' });
    for (let i = 0; i < 12; i++) face.append(h('div', { class: 'tick', style: { transform: `rotate(${i * 30}deg)` } }));
    const hh = h('div', { class: 'hand h' }), mm = h('div', { class: 'hand m' }), ss = h('div', { class: 'hand s' });
    face.append(hh, mm, ss);
    let swStart = 0, swAcc = 0, running = false;
    const sw = h('div', { class: 'stopwatch' }, '0:00.0');
    const startBtn = h('button', { class: 'btn go', onclick: () => { if (running) { swAcc += Date.now() - swStart; running = false; startBtn.textContent = 'Start'; } else { swStart = Date.now(); running = true; startBtn.textContent = 'Stop'; } } }, 'Start');
    const reset = h('button', { class: 'btn', onclick: () => { swAcc = 0; swStart = Date.now(); if (!running) sw.textContent = '0:00.0'; } }, 'Reset');
    body.append(face, h('div', { class: 'section', style: { textAlign: 'center' } }, 'STOPWATCH'), sw, h('div', { class: 'row-btns', style: { display: 'flex', gap: '12px', justifyContent: 'center', marginTop: '12px' } }, reset, startBtn));
    let raf;
    const loop = () => {
      const d = new Date(), s = d.getSeconds() + d.getMilliseconds() / 1000, m = d.getMinutes() + s / 60, hr = d.getHours() % 12 + m / 60;
      hh.style.transform = `rotate(${hr * 30}deg)`; mm.style.transform = `rotate(${m * 6}deg)`; ss.style.transform = `rotate(${s * 6}deg)`;
      if (running) { const t = (swAcc + Date.now() - swStart) / 1000; sw.textContent = `${Math.floor(t / 60)}:${pad2(Math.floor(t % 60))}.${Math.floor(t * 10 % 10)}`; }
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }); },
};

// ---------------------------------------------------------------- Terminal (xterm.js on a real bash pty)
const TERM_INSTANCES = new Set();
function fitTerms() { TERM_INSTANCES.forEach(f => f()); }
APPS.terminal = {
  name: 'Terminal', icon: 'terminal', color: ['#55687a', '#0b141c'],
  open(win, arg) { if (arg && arg.cmd) TERM_CMD = arg.cmd; win.push('Terminal', body => {
    body.style.padding = '0';
    if (!window.Terminal) {  // xterm.js (~0.5 MB) is loaded the first time it's needed, not at boot
      body.append(h('div', { class: 'sky-loading' }, h('span', { class: 'sky-orb spin' }), 'Starting terminal…'));
      loadScript('vendor/xterm.js').then(() => loadScript('vendor/addon-fit.js')).then(() => CURRENT && CURRENT.app === APPS.terminal && CURRENT.show())
        .catch(e => { body.innerHTML = ''; body.append(emptyState('terminal', e.message)); });
      return;
    }
    const host = h('div', { class: 'term-host' });
    let ctrl = false;
    const ctrlBtn = h('button', {}, 'Ctrl');
    const extra = [['Esc', '\x1b'], ['Tab', '\t'], ['Ctrl', null], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C'], ['|', '|'], ['~', '~'], ['/', '/'], ['-', '-'], ['⌨', 'kbd']];
    const keysRow = h('div', { class: 'term-keys' }, extra.map(([l, seq]) => {
      const b = l === 'Ctrl' ? ctrlBtn : h('button', {}, l);
      b.addEventListener('pointerdown', e => e.preventDefault());
      b.addEventListener('click', () => {
        if (l === 'Ctrl') { ctrl = !ctrl; b.classList.toggle('on', ctrl); return; }
        if (seq === 'kbd') return OSK.open ? OSK.hide() : showKbd();
        send(seq);
      });
      return b;
    }));
    body.append(h('div', { class: 'term-wrap' }, host, keysRow));
    const term = new Terminal({ fontFamily: '"DejaVu Sans Mono", "Noto Sans Mono", monospace', fontSize: 15, cursorBlink: true,
      theme: { background: '#06121e', foreground: '#d6ecff', cursor: '#5fd0ff', selectionBackground: '#1c5a8a', blue: '#4aa8ff', green: '#6bdc5a', cyan: '#5fe0ff' } });
    const fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open(host);
    let id = null, pos = 0, alive = true;
    const send = data => {
      if (ctrl && data.length === 1) { const c = data.toUpperCase().charCodeAt(0); if (c >= 64 && c <= 95) data = String.fromCharCode(c - 64); ctrl = false; ctrlBtn.classList.remove('on'); }
      if (id) api('/api/term/write', { id, data });
    };
    const doFit = () => { try { fit.fit(); if (id) api('/api/term/resize', { id, cols: term.cols, rows: term.rows }); } catch (e) { } };
    TERM_INSTANCES.add(doFit);
    term.onData(send);
    const showKbd = () => { OSK.show({ insert: t => send(t), key: k => send(k === 'Enter' ? '\r' : '\x7f') }); setTimeout(doFit, 60); };
    host.addEventListener('click', () => { if (!OSK.open) showKbd(); });
    (async () => {
      await sleep(80); doFit();
      const r = await api('/api/term/start', {});
      if (!r.id) { term.write('Could not start a shell: ' + (r.error || '?')); return; }
      id = r.id; doFit();
      if (TERM_CMD) { const c = TERM_CMD; TERM_CMD = null; setTimeout(() => api('/api/term/write', { id, data: c + '\r' }), 600); }
      while (alive) {
        const o = await api(`/api/term/read?id=${id}&pos=${pos}`);
        if (o.error && !('data' in o)) { if (o.error === 'gone') break; await sleep(500); continue; }
        if (o.data) term.write(o.data);
        pos = o.pos;
        if (!o.alive) { term.write('\r\n\x1b[36m[session ended — reopen Terminal for a new one]\x1b[0m\r\n'); break; }
      }
    })();
    let fitQueued = false;
    const ro = new ResizeObserver(() => { if (!fitQueued) { fitQueued = true; requestAnimationFrame(() => { fitQueued = false; doFit(); }); } });
    ro.observe(host);
    return () => { alive = false; ro.disconnect(); TERM_INSTANCES.delete(doFit); if (id) api('/api/term/write', { id, data: 'exit\r' }); term.dispose(); };
  }); },
};

let TERM_CMD = null;  // a command for the next Terminal to run (e.g. the Android setup)


const PARTY_FX = [
  ['rainbow', 'Rainbow', 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)'],
  ['disco', 'Disco', 'radial-gradient(circle at 30% 30%, #ff4fd8, #6a00ff 45%, #00e1ff)'],
  ['music', 'Music sync', 'radial-gradient(circle at 50% 30%, #fff, #ffb0e0 40%, #b52fd0)'],
  ['candle', 'Candle', 'radial-gradient(circle at 50% 60%, #fff3b0, #ff9a1f 45%, #a83a00)'],
  ['pulse', 'Breathe', 'radial-gradient(circle at 50% 30%, #fff, #8fdcff 45%, #0a7ad6)'],
  ['chase', 'Chase', 'linear-gradient(90deg, #00e1ff, #0a3a8a, #00e1ff, #0a3a8a)'],
  ['police', 'Police', 'linear-gradient(90deg, #ff2a2a 50%, #2a5bff 50%)'],
  ['strobe', 'Strobe', 'radial-gradient(circle, #fff 30%, #9aa 70%)'],
];
const LIGHT_COLORS = [null, 'white', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink'];
const SWATCH = { white: '#fff', red: '#f22', orange: '#ff7a1a', yellow: '#ffd21a', green: '#2ad23a', cyan: '#1ae0ff', blue: '#2a6bff', purple: '#9a2aff', pink: '#ff4fa0' };

APPS.light = {
  name: 'Light', icon: 'torch', color: ['#fff3b0', '#e8a000'],
  open(win) { win.push('Light', async body => {
    const st = await LIGHT.sync();
    if (st && st.offline) body.append(h('p', { class: 'hint' }, 'The LED service isn\'t running. Wire up the LED and check Settings › LED light.'));
    else if (st && st.leds === 0) body.append(h('p', { class: 'hint' }, 'No LED pins set. See Settings › LED light.'));
    else if (st && st.backend === 'sim') body.append(h('p', { class: 'hint' }, 'No GPIO here (preview). On the phone this drives the RGB LED.'));
    // flashlight
    const orb = h('button', { class: 'lt-orb', html: svg('torch'), onclick: async () => { await LIGHT.torch(!LIGHT.torchOn); draw(); } });
    const tones = [['white', 'White', '#fff'], ['red', 'Red', '#f22'], ['blue', 'Blue', '#2a6bff'], ['green', 'Green', '#2ad23a'],
      ['warm', 'Warm', '#ffc37a'], ['cold', 'Cold', '#cfe6ff']];
    // tapping a colour also switches the light on in that colour
    const toneRow = h('div', { class: 'lt-row' }, tones.map(([c, t, dot]) => h('button', { class: 'pill' + (S.torchColor === c ? ' primary' : ''), onclick: async e => {
      S.torchColor = c; save(); $$('button', toneRow).forEach(b => b.classList.remove('primary')); e.currentTarget.classList.add('primary'); await LIGHT.torch(true); draw();
    } }, h('span', { class: 'lt-dot', style: { background: dot } }), t)),
      h('button', { class: 'pill lt-off', onclick: async () => { await LIGHT.torch(false); draw(); } }, h('span', { class: 'lt-dot', style: { background: '#223' } }), 'Off'), h('button', { class: 'pill', onclick: () => { LIGHT.sos(); toast('SOS: tap the light to stop'); } }, 'SOS'));
    const level = h('input', { type: 'range', min: 10, max: 100, value: Math.round(S.torchLevel * 100), onchange: e => { S.torchLevel = e.target.value / 100; save(); if (LIGHT.torchOn) LIGHT.torch(true); } });
    // party
    const fxGrid = h('div', { class: 'lt-fx' });
    const drawFx = () => { fxGrid.innerHTML = ''; fxGrid.append(...PARTY_FX.map(([id, name, bg]) => h('button', { class: LIGHT.partyOn && S.partyFx === id ? 'on' : '', onclick: async () => {
      if (id === 'strobe' && !S.strobeOk) {
        if (await modal('Strobe light', h('p', {}, 'Fast flashing light can trigger seizures in people with photosensitive epilepsy. Use it with care.'), [{ label: 'Cancel' }, { label: 'I understand', value: 'y', primary: true }]) !== 'y') return;
        S.strobeOk = true; save();
      }
      if (id === 'music' && (!MUSIC.track || MUSIC.audio.paused)) toast('Play something in Music: the light follows the beat', 3500);
      await (LIGHT.partyOn && S.partyFx === id ? LIGHT.party(null) : LIGHT.party(id)); drawFx();
    } }, h('i', { style: { background: bg } }), name))); };
    const sw = h('div', { class: 'lt-sw' }, LIGHT_COLORS.map(c => h('button', { class: S.partyColor === c ? 'on' : '', title: c || 'Auto colours',
      style: { background: c ? SWATCH[c] : 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)' },
      onclick: e => { S.partyColor = c; save(); $$('button', sw).forEach(b => b.classList.remove('on')); e.currentTarget.classList.add('on'); if (LIGHT.partyOn) LIGHT.party(S.partyFx); } })));
    const speed = h('input', { type: 'range', min: 2, max: 40, value: Math.round(S.partySpeed * 10), onchange: e => { S.partySpeed = e.target.value / 10; save(); if (LIGHT.partyOn) LIGHT.party(S.partyFx); } });
    const offBtn = h('button', { class: 'btn primary lt-offbig', onclick: async () => { await LIGHT.torch(false); draw(); } }, 'Turn the flashlight off');
    const draw = () => { orb.classList.toggle('on', LIGHT.torchOn); offBtn.style.display = LIGHT.torchOn ? '' : 'none'; drawFx(); };
    addEventListener('sg-light', draw);
    body.append(h('div', { class: 'section' }, 'FLASHLIGHT'), h('div', { class: 'lt-torch' }, orb), h('div', { class: 'pad', style: { textAlign: 'center', paddingTop: '0' } }, offBtn), toneRow,
      h('label', { class: 'q-slider pad' }, h('i', { html: svg('sun') }), level),
      h('div', { class: 'section' }, 'PARTY'), fxGrid,
      h('div', { class: 'section' }, 'COLOUR'), sw,
      h('div', { class: 'section' }, 'SPEED'), h('label', { class: 'q-slider pad' }, speed),
      h('div', { class: 'pad' }, h('button', { class: 'btn', onclick: () => LIGHT.party(null).then(drawFx) }, 'Party off')));
    draw();
    return () => removeEventListener('sg-light', draw);
  }); },
};

// ---------------------------------------------------------------- Android (Waydroid: runs only while open)
APPS.android = {
  name: 'Android', icon: 'android', color: ['#c8ffb0', '#2f9e3a'],
  open(win) { win.push('Android', async body => {
    body.append(h('div', { class: 'sky-loading' }, h('span', { class: 'sky-orb spin' }), 'Checking Android…'));
    const r = await api('/api/android');
    body.innerHTML = '';
    const note = t => h('div', { class: 'pad sub', style: { color: 'var(--ink-soft)' } }, t);
    const row = (ok, title, sub) => listItem({ icon: ok ? 'check' : 'close', title, sub });
    if (!r.ready) {
      body.append(note('Android apps run in Waydroid, a real Android system in a container (not an emulator). Setting it up downloads about 1 GB and needs one reboot.'),
        h('div', { class: 'list' },
          row(r.kernel_ok, '4K-page kernel', r.kernel_ok ? 'OK' : `This kernel uses ${r.pagesize}-byte pages. Setup switches to kernel8.img`),
          row(r.binder, 'Binder in the kernel', r.binder ? 'OK' : 'Missing: needs the Raspberry Pi kernel'),
          row(r.installed, 'Waydroid installed', r.installed ? 'OK' : 'Setup adds repo.waydro.id and installs it')),
        h('div', { class: 'pad' }, h('button', { class: 'btn primary', onclick: () => openApp('terminal', { cmd: 'skyglass-android setup' }) }, 'Set up Android')));
      return;
    }
    body.append(note('Android starts when you open it and stops when you leave (short press on the power button), so it never runs in the background.'),
      h('div', { class: 'pad', style: { display: 'flex', gap: '10px' } },
        h('button', { class: 'btn primary', onclick: async () => { toast('Starting Android… (the first start takes a minute)'); const x = await api('/api/android', { action: 'open' }); if (!x.ok) toast(x.message || 'Failed'); } }, 'Open Android'),
        r.running ? h('button', { class: 'btn', onclick: async () => { await api('/api/android', { action: 'stop' }); toast('Android stopped'); CURRENT && CURRENT.show && CURRENT.show(); } }, 'Stop') : null));
    if (r.apps.length) {
      body.append(h('div', { class: 'section' }, 'ANDROID APPS'), h('div', { class: 'list' }, r.apps.map(a => {
        const img = h('img', { src: '/api/icon?name=' + encodeURIComponent(a.icon), style: { width: '40px', height: '40px', objectFit: 'contain' } });
        img.addEventListener('error', () => img.replaceWith(h('span', { html: svg('android') })));
        return h('div', { class: 'li', onclick: async () => { toast('Opening ' + a.name + '…'); const x = await api('/api/apps/launch', { id: a.id }); if (!x.ok) toast(x.message || 'Failed'); } },
          img, h('div', { class: 'grow' }, h('div', {}, a.name)));
      })));
    } else body.append(note('Apps you install inside Android (F-Droid, APKs) show up here and in Linux Apps.'));
  }); },
};

// ---------------------------------------------------------------- Linux apps (any .desktop app, fullscreen under labwc/cage)
APPS.linux = {
  name: 'Linux Apps', icon: 'linux', color: ['#b6ffe0', '#0f9c74'],
  open(win) { win.push('Linux Apps', async body => {
    body.append(h('div', { class: 'pad sub', style: { color: 'var(--ink-soft)' } }, 'Real desktop Linux apps from Debian. They open fullscreen — press the power button to come back. Install more with apt in the Terminal.'));
    const r = await api('/api/apps');
    if (!r.apps || !r.apps.length) return body.append(emptyState('linux', 'No graphical apps installed yet. Try: sudo apt install gnome-calculator'));
    body.append(h('div', { class: 'list' }, r.apps.map(a => {
      const img = h('img', { src: '/api/icon?name=' + encodeURIComponent(a.icon), style: { width: '40px', height: '40px', objectFit: 'contain' } });
      img.addEventListener('error', () => img.replaceWith(h('span', { html: svg('linux') })));
      return h('div', { class: 'li', onclick: async () => { toast('Launching ' + a.name + '…'); const x = await api('/api/apps/launch', { id: a.id }); if (!x.ok) toast(x.message || 'Failed'); } },
        img, h('div', { class: 'grow' }, h('div', {}, a.name), a.comment ? h('div', { class: 'sub' }, a.comment) : null));
    })));
  }); },
};

// ---------------------------------------------------------------- Aquarium (hidden: tap "Version" in About 7 times)
APPS.aquarium = {
  name: 'Aquarium', icon: 'fish', color: ['#86f2ff', '#0a6ad2'], hidden: () => S.eggs.aquarium,
  open(win) { win.push('Aquarium', body => {
    body.style.padding = '0';
    const cv = h('canvas', { style: { width: '100%', height: '100%', display: 'block', background: 'linear-gradient(180deg,#38c8f0,#0a5aa8 70%,#063a70)' } });
    body.append(cv);
    const W = cv.width = body.clientWidth, H = cv.height = body.clientHeight;
    const ctx = cv.getContext('2d');
    const fish = Array.from({ length: 7 }, () => { const f = makeFish(); f.x = Math.random() * W; f.y = H * (.15 + Math.random() * .7); return f; });
    const food = [], bub = Array.from({ length: 20 }, () => ({ x: Math.random() * W, y: Math.random() * H, r: 2 + Math.random() * 6, v: .5 + Math.random() }));
    cv.addEventListener('pointerdown', e => { const b = cv.getBoundingClientRect(), sx = W / b.width, sy = H / b.height; for (let i = 0; i < 4; i++) food.push({ x: (e.clientX - b.left) * sx + (Math.random() - .5) * 30, y: (e.clientY - b.top) * sy, vy: .6 + Math.random() * .5 }); });
    let raf;
    const loop = t => {
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#e9d39a'; ctx.beginPath(); ctx.moveTo(0, H); ctx.quadraticCurveTo(W * .3, H - 50, W * .6, H - 25); ctx.quadraticCurveTo(W * .85, H - 10, W, H - 40); ctx.lineTo(W, H); ctx.fill();
      for (const b of bub) { b.y -= b.v; if (b.y < -10) { b.y = H + 10; b.x = Math.random() * W; } drawBubble(ctx, b); }
      for (const f of food) { f.y = Math.min(f.y + f.vy, H - 30); ctx.fillStyle = '#a5532a'; ctx.beginPath(); ctx.arc(f.x, f.y, 4, 0, 7); ctx.fill(); }
      stepFish(fish, W, t, food);
      for (const f of fish) { f.y = Math.max(20, Math.min(H - 50, f.y)); drawFish(ctx, f, t); }
      ctx.fillStyle = 'rgba(255,255,255,.8)'; ctx.font = '600 15px sans-serif'; ctx.fillText('Tap to feed the fish', 14, 26);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }); },
};

// ---------------------------------------------------------------- Bubble wrap (hidden: long-press the wallpaper)
APPS.bubblewrap = {
  name: 'Bubble Wrap', icon: 'bubble', color: ['#e6f8ff', '#7cc6ef'],
  open(win) { win.push('Bubble Wrap', body => {
    let popped = +(localStorage.getItem('sg.popped') || 0);
    const count = h('div', { class: 'section', style: { textAlign: 'center' } }, `LIFETIME POPS: ${popped}`);
    const grid = h('div', { class: 'wrap-grid' });
    const fill = () => { grid.innerHTML = ''; for (let i = 0; i < 54; i++) grid.append(h('div', { class: 'bw' })); };
    const pop = b => {
      if (!b || !b.classList.contains('bw') || b.classList.contains('popped')) return;
      b.classList.add('popped'); tone('pop'); popped++; localStorage.setItem('sg.popped', popped);
      count.textContent = `LIFETIME POPS: ${popped}` + (popped % 1000 === 0 ? ' — legendary!' : '');
      if (!$$('.bw:not(.popped)', grid).length) { toast('Fresh sheet incoming.'); setTimeout(fill, 600); }
    };
    grid.style.touchAction = 'none';
    grid.addEventListener('pointerdown', e => pop(e.target));
    grid.addEventListener('pointermove', e => { if (e.buttons || e.pointerType === 'touch') pop(document.elementFromPoint(e.clientX, e.clientY)); });
    fill(); body.append(count, grid);
  }); },
};

// ---------------------------------------------------------------- Settings
// ---------------------------------------------------------------- Weather (Open-Meteo: free, no account)
const WMO = { 0: ['☀️', 'Clear'], 1: ['🌤️', 'Mostly clear'], 2: ['⛅', 'Partly cloudy'], 3: ['☁️', 'Cloudy'], 45: ['🌫️', 'Fog'], 48: ['🌫️', 'Icy fog'],
  51: ['🌦️', 'Light drizzle'], 53: ['🌦️', 'Drizzle'], 55: ['🌧️', 'Heavy drizzle'], 56: ['🌧️', 'Freezing drizzle'], 57: ['🌧️', 'Freezing drizzle'],
  61: ['🌦️', 'Light rain'], 63: ['🌧️', 'Rain'], 65: ['🌧️', 'Heavy rain'], 66: ['🌧️', 'Freezing rain'], 67: ['🌧️', 'Freezing rain'],
  71: ['🌨️', 'Light snow'], 73: ['🌨️', 'Snow'], 75: ['❄️', 'Heavy snow'], 77: ['🌨️', 'Snow grains'], 80: ['🌦️', 'Showers'], 81: ['🌧️', 'Showers'],
  82: ['⛈️', 'Violent showers'], 85: ['🌨️', 'Snow showers'], 86: ['❄️', 'Snow showers'], 95: ['⛈️', 'Thunderstorm'], 96: ['⛈️', 'Hail storm'], 99: ['⛈️', 'Hail storm'] };
const wmo = c => WMO[c] || ['🌡️', '—'];
APPS.weather = {
  name: 'Weather', icon: 'sun', color: ['#ffe68a', '#f39a0b'],
  open(win) { win.push('Weather', body => S.weatherLoc ? weatherPage(body, win) : weatherSearch(body, win)); },
};
async function weatherPage(body, win) {
  const L = S.weatherLoc;
  body.classList.add('wx-page');
  body.append(h('div', { class: 'sky-loading' }, h('span', { class: 'sky-orb spin' }), 'Looking at the sky…'));
  let d;
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${L.lat}&longitude=${L.lon}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m,is_day&hourly=temperature_2m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max&timezone=auto&forecast_days=7`);
    d = await r.json();
  } catch (e) { body.innerHTML = ''; return body.append(emptyState('wifi', 'No internet — connect to Wi-Fi to see the weather.')); }
  if (!body.isConnected) return;
  body.innerHTML = '';
  const c = d.current, [emo, label] = wmo(c.weather_code);
  body.classList.toggle('night', !c.is_day);
  const nowIdx = Math.max(0, d.hourly.time.findIndex(t => t >= c.time.slice(0, 13)));
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  body.append(
    h('div', { class: 'wx-hero' }, h('div', { class: 'wx-city' }, L.name), h('div', { class: 'wx-emo' }, emo), h('div', { class: 'wx-temp' }, Math.round(c.temperature_2m) + '°'),
      h('div', { class: 'wx-label' }, label), h('div', { class: 'wx-sub' }, `Feels like ${Math.round(c.apparent_temperature)}° · 💧 ${c.relative_humidity_2m}% · 💨 ${Math.round(c.wind_speed_10m)} km/h`)),
    h('div', { class: 'wx-hours glass' }, d.hourly.time.slice(nowIdx, nowIdx + 24).map((t, i) => h('div', {},
      h('small', {}, i ? t.slice(11, 13) + 'h' : 'Now'), h('span', {}, wmo(d.hourly.weather_code[nowIdx + i])[0]), h('b', {}, Math.round(d.hourly.temperature_2m[nowIdx + i]) + '°')))),
    h('div', { class: 'wx-days glass' }, d.daily.time.map((t, i) => h('div', { class: 'wx-day' },
      h('span', { class: 'n' }, i ? days[new Date(t + 'T12:00').getDay()] : 'Today'), h('span', {}, wmo(d.daily.weather_code[i])[0]),
      h('small', {}, (d.daily.precipitation_probability_max[i] ?? 0) + '% 💧'),
      h('span', { class: 'lo' }, Math.round(d.daily.temperature_2m_min[i]) + '°'), h('span', { class: 'hi' }, Math.round(d.daily.temperature_2m_max[i]) + '°')))),
    h('div', { class: 'pad' }, h('button', { class: 'btn', style: { width: '100%' }, onclick: () => win.push('Change city', b => weatherSearch(b, win)) }, '📍 Change city')),
    h('p', { class: 'hint', style: { textAlign: 'center' } }, `Sunrise ${d.daily.sunrise[0].slice(11)} · Sunset ${d.daily.sunset[0].slice(11)} · Open-Meteo.com`));
}
function weatherSearch(body, win) {
  const input = h('input', { type: 'search', class: 'sky-input', placeholder: 'Type your city…' });
  const list = h('div', { class: 'list' });
  let timer = 0;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim(); if (q.length < 2) return;
      try {
        const r = await (await fetch('https://geocoding-api.open-meteo.com/v1/search?count=8&name=' + encodeURIComponent(q))).json();
        list.innerHTML = '';
        for (const p of r.results || []) list.append(listItem({ icon: 'sun', title: p.name, sub: [p.admin1, p.country].filter(Boolean).join(', '),
          onclick: () => { S.weatherLoc = { name: p.name, lat: p.latitude, lon: p.longitude }; save(); OSK.hide(); win.stack = []; win.push('Weather', b => weatherPage(b, win)); } }));
      } catch (e) { list.innerHTML = ''; list.append(emptyState('wifi', 'No internet connection.')); }
    }, 300);
  });
  body.append(h('div', { class: 'sky-boxwrap' }, h('div', { class: 'sky-bar' }, input)), list);
  setTimeout(() => input.focus(), 200);
}

// ---------------------------------------------------------------- Music (keeps playing when you leave the app)
const MUSIC = (() => {
  const audio = new Audio(); audio.preload = 'auto';
  let list = [], idx = -1, shuffle = false, ctx = null, analyser = null;
  const listeners = new Set(), emit = () => listeners.forEach(f => f());
  function wire() {
    if (ctx) return;
    try { ctx = new AudioContext(); const src = ctx.createMediaElementSource(audio); analyser = ctx.createAnalyser(); analyser.fftSize = 64; src.connect(analyser); analyser.connect(ctx.destination); } catch (e) { }
  }
  function play(i) {
    if (!list.length) return;
    idx = (i + list.length) % list.length; wire(); if (ctx && ctx.state === 'suspended') ctx.resume();
    audio.src = '/api/file?path=' + encodeURIComponent(list[idx].path); audio.play().catch(() => toast('Can\'t play this file')); emit();
  }
  audio.addEventListener('ended', () => play(shuffle ? Math.floor(Math.random() * list.length) : idx + 1));
  ['play', 'pause', 'timeupdate'].forEach(ev => audio.addEventListener(ev, emit));
  return {
    audio, listeners, get list() { return list; }, set list(l) { list = l; }, get idx() { return idx; }, get track() { return list[idx]; }, get shuffle() { return shuffle; },
    play, toggle() { if (idx < 0) return play(0); audio.paused ? audio.play() : audio.pause(); }, next() { play(shuffle ? Math.floor(Math.random() * list.length) : idx + 1); }, prev() { audio.currentTime > 3 ? (audio.currentTime = 0) : play(idx - 1); },
    setShuffle(v) { shuffle = v; emit(); }, levels() { if (!analyser) return null; const a = new Uint8Array(analyser.frequencyBinCount); analyser.getByteFrequencyData(a); return a; },
    playFile(path) { list = [{ path, name: path.split('/').pop().replace(/\.[^.]+$/, ''), folder: '' }]; play(0); openApp('music'); },
  };
})();
APPS.music = {
  name: 'Music', icon: 'music', color: ['#ffb0e0', '#b52fd0'],
  open(win) { win.push('Music', async body => {
    body.classList.add('mu-page');
    const viz = h('canvas', { class: 'mu-viz' }), title = h('div', { class: 'mu-title' }), sub = h('div', { class: 'mu-sub' });
    const seek = h('input', { type: 'range', min: 0, max: 1000, value: 0, class: 'mu-seek' }), tcur = h('small', {}), tdur = h('small', {});
    const playBtn = h('button', { class: 'mu-play', onclick: () => MUSIC.toggle() });
    const shufBtn = h('button', { class: 'mu-small', html: svg('shuffle'), onclick: () => MUSIC.setShuffle(!MUSIC.shuffle) });
    const listEl = h('div', { class: 'list mu-list' });
    body.append(h('div', { class: 'mu-card glass' }, viz, title, sub, h('div', { class: 'mu-time' }, tcur, seek, tdur),
      h('div', { class: 'mu-ctrls' }, shufBtn, h('button', { class: 'mu-small', html: svg('prev'), onclick: () => MUSIC.prev() }), playBtn,
        h('button', { class: 'mu-small', html: svg('next'), onclick: () => MUSIC.next() }), h('span', { style: { width: '46px' } }))), listEl);
    seek.addEventListener('input', () => { if (MUSIC.audio.duration) MUSIC.audio.currentTime = seek.value / 1000 * MUSIC.audio.duration; });
    const t = s => isFinite(s) ? Math.floor(s / 60) + ':' + pad2(Math.floor(s % 60)) : '0:00';
    const ui = () => {
      const tr = MUSIC.track;
      title.textContent = tr ? tr.name : 'Nothing playing'; sub.textContent = tr ? (tr.folder || '') : 'Put songs in ~/Music or on a USB drive';
      playBtn.innerHTML = svg(MUSIC.audio.paused ? 'play' : 'pause'); shufBtn.classList.toggle('on', MUSIC.shuffle);
      tcur.textContent = t(MUSIC.audio.currentTime); tdur.textContent = t(MUSIC.audio.duration);
      if (MUSIC.audio.duration && document.activeElement !== seek) seek.value = MUSIC.audio.currentTime / MUSIC.audio.duration * 1000;
      $$('.li', listEl).forEach((li, i) => li.classList.toggle('playing', MUSIC.list[i] && tr && MUSIC.list[i].path === tr.path));
    };
    MUSIC.listeners.add(ui);
    const r = await api('/api/music');
    const tracks = r.tracks || [];
    if (!tracks.length) listEl.append(emptyState('music', 'No music yet. Copy .mp3 / .flac / .ogg files into ~/Music, or plug in a USB drive with music on it.'));
    tracks.forEach((tr, i) => listEl.append(listItem({ icon: 'music', title: tr.name, sub: (tr.usb ? 'USB · ' : '') + tr.folder, onclick: () => { MUSIC.list = tracks; MUSIC.play(i); } })));
    ui();
    // bubbly visualizer
    let raf = 0; const bubbles = Array.from({ length: 16 }, (_, i) => ({ i, y: 0 }));
    let lastViz = 0;
    const loop = t => {
      raf = requestAnimationFrame(loop);
      if (ON_DEVICE && t - lastViz < 33) return; lastViz = t;
      const rc = viz.getBoundingClientRect(); if (viz.width !== Math.round(rc.width)) { viz.width = Math.round(rc.width); viz.height = Math.round(rc.height); }
      const x = viz.getContext('2d'), lv = MUSIC.levels(); x.clearRect(0, 0, viz.width, viz.height);
      bubbles.forEach((b, i) => {
        const v = lv && !MUSIC.audio.paused ? lv[i + 1] / 255 : .08 + .05 * Math.sin(performance.now() / 700 + i);
        const r0 = 4 + v * viz.height * .22, cx = (i + .5) * viz.width / bubbles.length, cy = viz.height - r0 - v * viz.height * .5;
        const g = x.createRadialGradient(cx - r0 * .35, cy - r0 * .4, 1, cx, cy, r0);
        g.addColorStop(0, 'rgba(255,255,255,.95)'); g.addColorStop(.3, `hsla(${280 + i * 6},90%,80%,.5)`); g.addColorStop(1, `hsla(${200 + i * 8},90%,60%,.35)`);
        x.fillStyle = g; x.beginPath(); x.arc(cx, cy, r0, 0, 7); x.fill();
      });
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); MUSIC.listeners.delete(ui); };
  }); },
};

// ---------------------------------------------------------------- Calendar
APPS.calendar = {
  name: 'Calendar', icon: 'calendar', color: ['#ff9a8a', '#d8262c'],
  open(win) {
    let view = new Date(); view.setDate(1);
    const key = d => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    const page = () => win.push('Calendar', body => {
      const ev = loadJSON('sg.cal', {}), today = key(new Date());
      const y = view.getFullYear(), m = view.getMonth(), first = (new Date(y, m, 1).getDay() + 6) % 7, days = new Date(y, m + 1, 0).getDate();
      const grid = h('div', { class: 'cal-grid' }, ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(d => h('div', { class: 'cal-dow' }, d)));
      for (let i = 0; i < first; i++) grid.append(h('div'));
      for (let d = 1; d <= days; d++) {
        const k = key(new Date(y, m, d));
        grid.append(h('button', { class: 'cal-day' + (k === today ? ' today' : '') + (ev[k] && ev[k].length ? ' has' : ''), onclick: () => dayPage(k) }, String(d)));
      }
      const upcoming = Object.keys(ev).filter(k => k >= today && ev[k].length).sort().slice(0, 8);
      body.append(h('div', { class: 'cal-head' },
        h('button', { class: 'orb', html: svg('back'), onclick: () => { view.setMonth(view.getMonth() - 1); win.stack.pop(); page(); } }),
        h('b', {}, MONTHS_LONG[m] + ' ' + y),
        h('button', { class: 'orb flip-x', html: svg('back'), onclick: () => { view.setMonth(view.getMonth() + 1); win.stack.pop(); page(); } })),
        grid, h('div', { class: 'section' }, 'UPCOMING'),
        upcoming.length ? h('div', { class: 'list' }, upcoming.flatMap(k => ev[k].map(e => listItem({ icon: 'calendar', title: e.text, sub: k + (e.time ? ' · ' + e.time : ''), onclick: () => dayPage(k) }))))
          : h('p', { class: 'hint' }, 'Nothing planned. Tap a day to add something.'));
    });
    function dayPage(k) {
      win.push(new Date(k + 'T12:00').toDateString(), body => {
        const ev = loadJSON('sg.cal', {}), items = ev[k] || [];
        const text = h('input', { type: 'text', placeholder: 'What’s happening?' }), time = h('input', { type: 'text', placeholder: 'Time (optional, e.g. 14:30)', class: 'cal-time' });
        const add = () => {
          if (!text.value.trim()) return;
          items.push({ text: text.value.trim(), time: time.value.trim() }); items.sort((a1, b1) => (a1.time || '').localeCompare(b1.time || ''));
          ev[k] = items; localStorage.setItem('sg.cal', JSON.stringify(ev)); OSK.hide(); win.replace(win.stack[win.stack.length - 1].title, win.stack[win.stack.length - 1].render);
        };
        text.addEventListener('keydown', e => e.key === 'Enter' && add());
        body.append(h('div', { class: 'pad cal-add' }, text, time, h('button', { class: 'btn primary', onclick: add }, 'Add')),
          items.length ? h('div', { class: 'list' }, items.map((e, i) => listItem({ icon: 'calendar', title: e.text, sub: e.time || 'All day',
            right: h('button', { class: 'pill', html: svg('trash'), onclick: ev2 => { ev2.stopPropagation(); items.splice(i, 1); ev[k] = items; localStorage.setItem('sg.cal', JSON.stringify(ev)); win.replace(win.stack[win.stack.length - 1].title, win.stack[win.stack.length - 1].render); } }) })))
            : h('p', { class: 'hint' }, 'No events on this day.'));
      });
    }
    page();
  },
};
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// ---------------------------------------------------------------- Sketch (draw, save to Photos)
APPS.sketch = {
  name: 'Sketch', icon: 'brush', color: ['#c2f5c4', '#1f9a4a'],
  open(win) { win.push('Sketch', body => {
    body.style.padding = '0';
    const cv = h('canvas', { class: 'sk-canvas' });
    const COLORS = ['#1b2a3a', '#e8331c', '#ff9a1c', '#ffd21c', '#2bb24c', '#1a8cff', '#8a3ff0', '#ff5fb4', '#ffffff'];
    let color = COLORS[5], size = 8, eraser = false;
    const undo = [];
    const tools = h('div', { class: 'sk-tools glass' },
      h('div', { class: 'sk-row' }, COLORS.map(c => h('button', { class: 'sk-color' + (c === color ? ' on' : ''), style: { background: c }, onclick: e => { color = c; eraser = false; $$('.sk-color', tools).forEach(b => b.classList.remove('on')); e.currentTarget.classList.add('on'); } }))),
      h('div', { class: 'sk-row' },
        [3, 8, 18, 34].map(s => h('button', { class: 'sk-size' + (s === size ? ' on' : ''), onclick: e => { size = s; $$('.sk-size', tools).forEach(b => b.classList.remove('on')); e.currentTarget.classList.add('on'); } }, h('i', { style: { width: Math.min(26, s) + 'px', height: Math.min(26, s) + 'px' } }))),
        h('button', { class: 'pill', onclick: () => { eraser = !eraser; toast(eraser ? 'Eraser on' : 'Brush on', 1200); } }, 'Eraser'),
        h('button', { class: 'pill', onclick: () => { if (undo.length) x.putImageData(undo.pop(), 0, 0); } }, 'Undo'),
        h('button', { class: 'pill', onclick: () => { push(); x.fillStyle = '#fff'; x.fillRect(0, 0, cv.width, cv.height); } }, 'Clear'),
        h('button', { class: 'pill primary', onclick: saveIt }, 'Save')));
    body.append(h('div', { class: 'sk-wrap' }, cv, tools));
    let x;
    requestAnimationFrame(() => {
      const r = cv.getBoundingClientRect(); cv.width = Math.round(r.width); cv.height = Math.round(r.height);
      x = cv.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, cv.width, cv.height); x.lineCap = x.lineJoin = 'round';
    });
    const push = () => { undo.push(x.getImageData(0, 0, cv.width, cv.height)); if (undo.length > 20) undo.shift(); };
    let last = null;
    const pos = e => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * cv.width / r.width, (e.clientY - r.top) * cv.height / r.height]; };
    cv.addEventListener('pointerdown', e => { cv.setPointerCapture(e.pointerId); push(); last = pos(e); stroke(last, last); });
    cv.addEventListener('pointermove', e => { if (!last) return; const p = pos(e); stroke(last, p); last = p; });
    cv.addEventListener('pointerup', () => (last = null));
    function stroke(a1, b1) { x.strokeStyle = eraser ? '#fff' : color; x.lineWidth = eraser ? size * 2.5 : size; x.beginPath(); x.moveTo(a1[0], a1[1]); x.lineTo(b1[0], b1[1]); x.stroke(); }
    async function saveIt() {
      const r = await api('/api/photo/save', { name: 'Sketch_' + new Date().toISOString().slice(0, 19).replace(/[-:T]/g, ''), data: cv.toDataURL('image/png') });
      if (r.ok) { tone('pop'); toast('Saved to Photos ✔'); } else toast(r.message || 'Could not save');
    }
  }); },
};

// ---------------------------------------------------------------- System Monitor
APPS.sysmon = {
  name: 'Monitor', icon: 'chart', color: ['#9bf0e6', '#0d8f86'],
  open(win) { win.push('System Monitor', body => {
    const chart = h('canvas', { class: 'sm-chart' }), cards = h('div', { class: 'sm-cards' }), cores = h('div', { class: 'sm-cores' }), procs = h('div', { class: 'list' });
    body.append(h('div', { class: 'sm-chartwrap glass' }, h('div', { class: 'section' }, 'CPU · LAST MINUTE'), chart), cards, h('div', { class: 'section' }, 'CORES'), cores, h('div', { class: 'section' }, 'TOP PROGRAMS'), procs);
    const hist = [];
    const card = (label, value, sub, pct) => h('div', { class: 'sm-card glass' }, h('small', {}, label), h('b', {}, value), h('span', {}, sub || ''),
      pct != null ? h('div', { class: 'progress' }, h('i', { style: { width: Math.min(100, pct) + '%' } })) : null);
    const tick = async () => {
      const d = await api('/api/sysmon'); if (!body.isConnected || d.error) return;
      hist.push(d.cpu); if (hist.length > 40) hist.shift();
      const memUsed = d.mem_total - d.mem_avail, diskUsed = d.disk_total - d.disk_free;
      cards.innerHTML = '';
      cards.append(card('CPU', Math.round(d.cpu) + '%', 'load ' + d.load.map(v => v.toFixed(2)).join(' '), d.cpu),
        card('Temperature', d.temp != null ? d.temp + ' °C' : '—', d.temp > 75 ? '🔥 hot' : d.temp > 60 ? 'warm' : 'cool', d.temp != null ? d.temp : null),
        card('Memory', fmtSize(memUsed), 'of ' + fmtSize(d.mem_total), memUsed / d.mem_total * 100),
        card('Storage', fmtSize(diskUsed), fmtSize(d.disk_free) + ' free', diskUsed / d.disk_total * 100),
        card('Uptime', fmtDur(d.uptime), 'since boot'));
      cores.innerHTML = '';
      d.cores.forEach((p, i) => cores.append(h('div', { class: 'sm-core' }, h('small', {}, 'Core ' + i), h('div', { class: 'progress' }, h('i', { style: { width: p + '%' } })), h('b', {}, Math.round(p) + '%'))));
      procs.innerHTML = '';
      d.procs.forEach(p => procs.append(listItem({ icon: 'chart', title: p.name, sub: `PID ${p.pid} · CPU ${p.cpu}% · RAM ${p.mem}%` })));
      const r = chart.getBoundingClientRect(); chart.width = Math.round(r.width); chart.height = Math.round(r.height);
      const x = chart.getContext('2d'), W = chart.width, H = chart.height;
      x.clearRect(0, 0, W, H); x.strokeStyle = 'rgba(0,80,140,.12)'; x.lineWidth = 1;
      for (let g = 1; g < 4; g++) { x.beginPath(); x.moveTo(0, H * g / 4); x.lineTo(W, H * g / 4); x.stroke(); }
      const pts = hist.map((v, i) => [W - (hist.length - 1 - i) * W / 39, H - v / 100 * (H - 6) - 3]);
      if (pts.length > 1) {
        const grad = x.createLinearGradient(0, 0, 0, H); grad.addColorStop(0, 'rgba(40,180,255,.5)'); grad.addColorStop(1, 'rgba(40,180,255,0)');
        x.beginPath(); x.moveTo(pts[0][0], H); pts.forEach(p => x.lineTo(p[0], p[1])); x.lineTo(pts[pts.length - 1][0], H); x.fillStyle = grad; x.fill();
        x.beginPath(); pts.forEach((p, i) => i ? x.lineTo(p[0], p[1]) : x.moveTo(p[0], p[1])); x.strokeStyle = '#0b7fd6'; x.lineWidth = 2.5; x.stroke();
      }
    };
    tick(); const iv = setInterval(tick, 1500);
    return () => clearInterval(iv);
  }); },
};

// ---------------------------------------------------------------- Games
APPS.games = {
  name: 'Games', icon: 'games', color: ['#ffcf8a', '#ff5a3c'],
  open(win) { win.push('Games', body => {
    const best = loadJSON('sg.best', {});
    body.append(h('div', { class: 'games-grid' }, [
      ['skypop', '🫧', 'Sky Pop', 'Pop rising bubbles. Golden ones are worth 5!', best.skypop ? 'Best: ' + best.skypop : 'New!'],
      ['memory', '🃏', 'Glass Memory', 'Find all the matching pairs', best.memory ? 'Best: ' + best.memory + ' moves' : 'New!'],
      ['ttt', '⭕', 'Bubble Tac Toe', 'Three in a row vs. the phone', best.ttt ? best.ttt + ' wins' : 'New!'],
      ['hop', '🫧', 'Bubble Hop', 'Hop across 3 sky worlds, dodge the urchins', best.hop ? 'Best: ' + best.hop + 's' : 'New!'],
      ['blocks', '🧊', 'Cloudblocks', 'Build anything in a 3D world of glass and clouds', 'Sandbox'],
    ].map(([id, emo, name, desc, sc]) => h('button', { class: 'game-card glass', onclick: () => win.push(name, b => GAMES[id](b, win)) },
      h('span', { class: 'game-emo' }, emo), h('b', {}, name), h('small', {}, desc), h('i', {}, sc)))));
  }); },
};
const loadedScripts = {}, BOOT_ID = Date.now();
function loadScript(src) {
  return loadedScripts[src] || (loadedScripts[src] = new Promise((res, rej) => {
    const s = h('script', { src: src + '?v=' + BOOT_ID }); s.onload = res; s.onerror = () => { delete loadedScripts[src]; rej(new Error('could not load ' + src)); };
    document.head.append(s);
  }));
}
function lazyGame(file, id) {
  return (body, win) => {
    body.append(h('div', { class: 'sky-loading' }, h('span', { class: 'sky-orb spin' }), 'Loading…'));
    let cleanup = null, gone = false;
    loadScript(file).then(() => { if (gone || !body.isConnected) return; body.innerHTML = ''; cleanup = GAMES[id + 'Real'](body, win); })
      .catch(e => { body.innerHTML = ''; body.append(emptyState('games', e.message)); });
    return () => { gone = true; if (typeof cleanup === 'function') cleanup(); };
  };
}
function saveBest(k, v, lowerIsBetter) {
  const b = loadJSON('sg.best', {});
  const better = b[k] == null || (lowerIsBetter ? v < b[k] : v > b[k]);
  if (better) { b[k] = v; localStorage.setItem('sg.best', JSON.stringify(b)); }
  return better;
}
const GAMES = {
  hop: lazyGame('games/hop.js', 'hop'),
  blocks: lazyGame('games/blocks.js', 'blocks'),
  // Sky Pop: bubbles float up; tap them before they escape. 45 seconds.
  skypop(body) {
    body.style.padding = '0';
    const cv = h('canvas', { class: 'gp-canvas' }), hud = h('div', { class: 'gp-hud' }), over = h('div', { class: 'gp-over' });
    body.append(h('div', { class: 'gp-wrap' }, cv, hud, over));
    let W, H, x, bubbles = [], pops = [], score = 0, missed = 0, combo = 0, t0 = 0, running = false, raf = 0, last = 0;
    const start = () => { score = 0; missed = 0; combo = 0; bubbles = []; pops = []; t0 = performance.now(); running = true; over.classList.add('hidden'); };
    const end = () => {
      running = false; const nb = saveBest('skypop', score);
      over.innerHTML = ''; over.classList.remove('hidden');
      over.append(h('div', { class: 'gp-big' }, score + ' points'), h('p', {}, nb ? '🏆 New best!' : 'Best: ' + loadJSON('sg.best', {}).skypop), h('button', { class: 'btn primary', onclick: start }, 'Play again'));
    };
    over.append(h('div', { class: 'gp-big' }, '🫧 Sky Pop'), h('p', {}, 'Tap bubbles before they float away. Pop them quickly in a row for a combo!'), h('button', { class: 'btn primary', onclick: start }, 'Start'));
    requestAnimationFrame(() => { const r = cv.getBoundingClientRect(); W = cv.width = Math.round(r.width); H = cv.height = Math.round(r.height); x = cv.getContext('2d'); loop(0); });
    function loop(t) {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(50, t - (last || t)) / 16.7; last = t;
      x.clearRect(0, 0, W, H);
      const left = running ? Math.max(0, 45 - (t - t0) / 1000) : 0;
      if (running) {
        const rate = .025 + (45 - left) * .0012;
        if (Math.random() < rate * dt) { const gold = Math.random() < .08, r0 = (gold ? .045 : .05 + Math.random() * .05) * W; bubbles.push({ x: r0 + Math.random() * (W - 2 * r0), y: H + r0, r: r0, v: (1.2 + Math.random() * 1.4 + (45 - left) * .04) * H / 900, gold, wob: Math.random() * 6 }); }
        if (left <= 0) end();
      }
      bubbles = bubbles.filter(b => { b.y -= b.v * dt * 3; if (b.y < -b.r) { if (running) { missed++; combo = 0; } return false; } return true; });
      for (const b of bubbles) {
        const bx = b.x + Math.sin(t / 500 + b.wob) * 6;
        const g = x.createRadialGradient(bx - b.r * .35, b.y - b.r * .4, b.r * .05, bx, b.y, b.r);
        g.addColorStop(0, 'rgba(255,255,255,.95)'); g.addColorStop(.25, b.gold ? 'rgba(255,220,90,.6)' : 'rgba(170,225,255,.3)');
        g.addColorStop(.85, b.gold ? 'rgba(255,170,0,.45)' : 'rgba(90,180,255,.22)'); g.addColorStop(1, 'rgba(255,255,255,.8)');
        x.fillStyle = g; x.beginPath(); x.arc(bx, b.y, b.r, 0, 7); x.fill(); b.dx = bx;
      }
      pops = pops.filter(p => (p.a -= .05 * dt) > 0);
      for (const p of pops) { x.strokeStyle = `rgba(255,255,255,${p.a})`; x.lineWidth = 3; x.beginPath(); x.arc(p.x, p.y, p.r * (1.6 - p.a * .6), 0, 7); x.stroke(); x.fillStyle = `rgba(20,70,130,${p.a})`; x.font = 'bold 26px sans-serif'; x.fillText(p.txt, p.x - 14, p.y - p.r * (1.4 - p.a)); }
      hud.textContent = running ? `⏱ ${Math.ceil(left)}s   ★ ${score}   ${combo > 2 ? '🔥x' + combo : ''}` : '';
    }
    cv.addEventListener('pointerdown', e => {
      if (!running) return;
      const r = cv.getBoundingClientRect(), px = (e.clientX - r.left) * W / r.width, py = (e.clientY - r.top) * H / r.height;
      for (let i = bubbles.length - 1; i >= 0; i--) {
        const b = bubbles[i];
        if (Math.hypot(px - (b.dx ?? b.x), py - b.y) < b.r * 1.15) {
          combo++; const pts = (b.gold ? 5 : 1) * (combo > 4 ? 2 : 1); score += pts;
          pops.push({ x: b.dx ?? b.x, y: b.y, r: b.r, a: 1, txt: '+' + pts }); bubbles.splice(i, 1); tone('pop'); return;
        }
      }
      combo = 0;
    });
    return () => cancelAnimationFrame(raf);
  },
  // Glass Memory: 16 glossy tiles, 8 pairs
  memory(body, win) {
    const SYMS = ['🐟', '🫧', '☀️', '🌈', '🍀', '💎', '🌙', '⭐'];
    let cards = [...SYMS, ...SYMS].sort(() => Math.random() - .5).map(s => ({ s, open: false, done: false }));
    let first = null, lock = false, moves = 0, found = 0;
    const info = h('div', { class: 'mem-info' }), grid = h('div', { class: 'mem-grid' });
    body.append(info, grid, h('div', { class: 'pad' }, h('button', { class: 'btn', style: { width: '100%' }, onclick: () => win.replace('Glass Memory', b => GAMES.memory(b, win)) }, 'New game')));
    const draw = () => {
      info.textContent = `Moves: ${moves}   ·   Pairs: ${found}/8`;
      grid.innerHTML = '';
      cards.forEach((c, i) => grid.append(h('button', { class: 'mem-card' + (c.open || c.done ? ' open' : '') + (c.done ? ' done' : ''), onclick: () => flip(i) }, h('span', {}, c.open || c.done ? c.s : ''))));
    };
    function flip(i) {
      const c = cards[i]; if (lock || c.open || c.done) return;
      c.open = true; tone('click');
      if (!first) { first = c; return draw(); }
      moves++; const a1 = first; first = null; draw();
      if (a1.s === c.s) { a1.done = c.done = true; found++; tone('pop'); draw();
        if (found === 8) { const nb = saveBest('memory', moves, true); setTimeout(() => modal(nb ? '🏆 New best!' : 'You did it!', h('p', {}, `All pairs in ${moves} moves.`)), 400); } }
      else { lock = true; setTimeout(() => { a1.open = c.open = false; lock = false; draw(); }, 750); }
    }
    draw();
  },
  // Bubble Tac Toe vs. a phone that plays well (but not perfectly)
  ttt(body, win) {
    let b = Array(9).fill(''), over = false;
    const L = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
    const winner = s => { for (const [p, q, r] of L) if (s[p] && s[p] === s[q] && s[p] === s[r]) return s[p]; return s.every(Boolean) ? 'draw' : null; };
    const info = h('div', { class: 'mem-info' }, 'You are 🫧 — tap a square'), grid = h('div', { class: 'ttt-grid' });
    body.append(info, grid, h('div', { class: 'pad' }, h('button', { class: 'btn', style: { width: '100%' }, onclick: () => win.replace('Bubble Tac Toe', bb => GAMES.ttt(bb, win)) }, 'New game')));
    const draw = () => { grid.innerHTML = ''; b.forEach((v, i) => grid.append(h('button', { class: 'ttt-cell', onclick: () => move(i) }, v === 'X' ? '🫧' : v === 'O' ? '🐟' : ''))); };
    function best(s, me) {
      const w = winner(s); if (w === 'O') return { score: 1 }; if (w === 'X') return { score: -1 }; if (w === 'draw') return { score: 0 };
      let bestM = null;
      s.forEach((v, i) => { if (v) return; s[i] = me; const r = best(s, me === 'O' ? 'X' : 'O'); s[i] = '';
        if (!bestM || (me === 'O' ? r.score > bestM.score : r.score < bestM.score)) bestM = { score: r.score, i }; });
      return bestM;
    }
    function finish() {
      const w = winner(b); if (!w) return false; over = true;
      if (w === 'X') { const s = loadJSON('sg.best', {}); s.ttt = (s.ttt || 0) + 1; localStorage.setItem('sg.best', JSON.stringify(s)); }
      info.textContent = w === 'X' ? '🎉 You win!' : w === 'O' ? '🐟 The phone wins!' : 'Draw — nobody wins'; tone('pop'); return true;
    }
    function move(i) {
      if (over || b[i]) return; b[i] = 'X'; tone('click'); draw(); if (finish()) return;
      info.textContent = 'Thinking…';
      setTimeout(() => {
        const free = b.map((v, k) => v ? -1 : k).filter(k => k >= 0);
        const m = Math.random() < .15 ? free[Math.floor(Math.random() * free.length)] : best(b, 'O').i; // 15% of the time it slips up
        b[m] = 'O'; draw(); if (!finish()) info.textContent = 'Your turn';
      }, 350);
    }
    draw();
  },
};

APPS.settings = {
  name: 'Settings', icon: 'settings', color: ['#e1e9ef', '#647d91'],
  open(win, page) {
    const pages = { security: securityPage, wifi: wifiPage, display: displayPage, sound: soundPage, about: aboutPage, power: powerPage, dev: devPage, wallpaper: wallpaperPage,
      notifications: notifPage, led: ledPage, bluetooth: bluetoothPage, updates: updatesPage, keyboard: keyboardPage, android: androidPage, hotspot: hotspotPage };
    const titles = { security: 'Lock screen & PIN', wifi: 'Wi-Fi', display: 'Display & Theme', sound: 'Sound', about: 'About', power: 'Power', dev: 'Developer', wallpaper: 'Wallpaper',
      notifications: 'Notifications', led: 'LED light', bluetooth: 'Bluetooth', updates: 'Software updates', keyboard: 'Keyboard', android: 'Android', hotspot: 'Hotspot' };
    win.push('Settings', body => {
      body.append(h('div', { class: 'list' },
        listItem({ icon: 'wifi', title: 'Wi-Fi', sub: STATUS.wifi && STATUS.wifi.connected ? 'Connected to ' + STATUS.wifi.ssid : 'Not connected', onclick: () => win.push('Wi-Fi', wifiPage) }),
        listItem({ icon: 'hotspot', title: 'Hotspot', sub: 'Share this phone\'s internet over Wi-Fi', onclick: () => win.push('Hotspot', hotspotPage) }),
        listItem({ icon: 'bluetooth', title: 'Bluetooth', sub: 'Pair headphones, speakers, keyboards', onclick: () => win.push('Bluetooth', bluetoothPage) }),
        listItem({ icon: 'display', title: 'Display & Theme', sub: 'Theme, glass, rotation, brightness, screensaver', onclick: () => win.push('Display & Theme', displayPage) }),
        listItem({ icon: 'photos', title: 'Wallpaper', sub: 'Skies, pictures or your own photo', onclick: () => win.push('Wallpaper', wallpaperPage) }),
        listItem({ icon: 'speaker', title: 'Sound', sub: 'Volume and clicks', onclick: () => win.push('Sound', soundPage) }),
        listItem({ icon: 'bell', title: 'Notifications', sub: S.dnd ? 'Do Not Disturb is on' : 'Banners, lock screen, Do Not Disturb', onclick: () => win.push('Notifications', notifPage) }),
        listItem({ icon: 'torch', title: 'LED light', sub: 'Notification, charging and error light, wiring', onclick: () => win.push('LED light', ledPage) }),
        listItem({ icon: 'keyboard', title: 'Keyboard', sub: 'On-screen keyboard for Linux apps, layout', onclick: () => win.push('Keyboard', keyboardPage) })),
        h('div', { class: 'list' },
        listItem({ icon: 'lock', title: 'Lock screen & PIN', sub: 'PIN, lock screen tips', onclick: () => win.push('Lock screen & PIN', securityPage) }),
        listItem({ icon: 'clock', title: 'Date & time', sub: '24-hour clock, time zone', onclick: () => win.push('Date & time', timePage) }),
        listItem({ icon: 'access', title: 'Accessibility', sub: 'Text size, bold text, less motion', onclick: () => win.push('Accessibility', accessPage) }),
        listItem({ icon: 'files', title: 'Storage', sub: 'What uses space, clean up, photo size', onclick: () => win.push('Storage', storagePage) })),
        h('div', { class: 'list' },
          listItem({ icon: 'android', title: 'Android', sub: 'Waydroid: windowed apps, install APKs', onclick: () => win.push('Android', androidPage) }),
          listItem({ icon: 'download', title: 'Software updates', sub: 'Check for and install updates', onclick: () => win.push('Software updates', updatesPage) }),
          listItem({ icon: 'code', title: 'Developer', sub: 'Root, terminal, reset', onclick: () => win.push('Developer', devPage) }),
          listItem({ icon: 'power', title: 'Power', onclick: () => win.push('Power', powerPage) }),
          listItem({ icon: 'info', title: 'About Skyglass', onclick: () => win.push('About', aboutPage) })));
    });
    if (page && pages[page]) win.push(titles[page], pages[page]);
  },
};
// ---- Bluetooth: on/off, scan, pair, connect, forget
async function bluetoothPage(body) {
  const r = await api('/api/bluetooth');
  if (!r.present) return body.append(emptyState('bluetooth', 'No Bluetooth found on this phone.'));
  const list = h('div', { class: 'list' });
  const status = h('div', { class: 'pad sub' });
  const show = d => {
    list.innerHTML = '';
    const devs = d.devices || [];
    status.textContent = d.message || (devs.length ? '' : 'No devices yet. Put your headphones or keyboard in pairing mode, then tap Scan.');
    for (const dev of devs) {
      const sub = dev.connected ? 'Connected' : dev.paired ? 'Paired · tap to connect' : 'Tap to pair';
      list.append(listItem({ icon: 'bluetooth', title: dev.name || dev.mac, sub, onclick: () => act(dev),
        right: dev.paired ? h('button', { class: 'pill', onclick: async e => { e.stopPropagation();
          if (await modal('Forget “' + (dev.name || dev.mac) + '”?', h('p', {}, 'You will have to pair it again.'), [{ label: 'Cancel' }, { label: 'Forget', value: 'y', primary: true }]) !== 'y') return;
          await api('/api/bluetooth/device', { action: 'forget', mac: dev.mac }); load(); } }, 'Forget') : null }));
    }
  };
  const load = async () => show(await api('/api/bluetooth/devices'));
  const act = async dev => {
    const action = dev.connected ? 'disconnect' : dev.paired ? 'connect' : 'pair';
    toast({ pair: 'Pairing with ', connect: 'Connecting to ', disconnect: 'Disconnecting ' }[action] + (dev.name || dev.mac) + '…', 2500);
    const x = await api('/api/bluetooth/device', { action, mac: dev.mac });
    toast(x.ok ? ({ pair: 'Paired ✔', connect: 'Connected ✔', disconnect: 'Disconnected' }[action]) : (x.message || 'Failed'), 4500);
    load();
  };
  const scanBtn = h('button', { class: 'btn primary', onclick: async () => {
    scanBtn.disabled = true; scanBtn.textContent = 'Scanning…'; status.textContent = 'Looking for devices nearby (8 s)…';
    show(await api('/api/bluetooth/device', { action: 'scan' })); scanBtn.disabled = false; scanBtn.textContent = 'Scan';
  } }, 'Scan');
  body.append(h('div', { class: 'list' }, listItem({ icon: 'bluetooth', title: 'Bluetooth', sub: r.on ? 'On' : 'Off',
    right: switchEl(r.on, async v => { const x = await api('/api/bluetooth', { on: v }); toast(x.ok ? (v ? 'Bluetooth on' : 'Bluetooth off') : x.message || 'Failed'); if (v) load(); }) })),
    h('div', { class: 'section' }, 'DEVICES'), list, status, h('div', { class: 'pad' }, scanBtn),
    h('p', { class: 'hint' }, 'Sound goes to the headphones or speaker you connect. A keyboard that shows a code: type it on the keyboard, then press Enter.'));
  if (r.on) load();
}
// ---- LED light: what the RGB LED may show, brightness, wiring
async function ledPage(body) {
  const r = await api('/api/led');
  if (!r || r.offline) {
    body.append(emptyState('torch', 'The LED service isn\'t running.'),
      h('p', { class: 'hint' }, 'Start it in the Terminal:  sudo systemctl enable --now skyglass-led'));
    return;
  }
  const p = r.prefs || {};
  const sw = (title, sub, key) => listItem({ title, sub, right: switchEl(p[key] !== false, v => api('/api/led', { cmd: 'prefs', prefs: { [key]: v } })) });
  const max = h('input', { type: 'range', min: 5, max: 100, value: Math.round((p.max || 1) * 100), onchange: e => api('/api/led', { cmd: 'prefs', prefs: { max: e.target.value / 100 } }) });
  const state = r.error ? 'Problem: ' + r.error : r.backend === 'sim' ? 'No GPIO found (preview / not a Pi)' : `${r.leds} LED${r.leds === 1 ? '' : 's'} on ${r.chip_label || r.chip}`;
  body.append(h('div', { class: 'list' }, listItem({ icon: 'torch', title: 'LED', sub: state + (r.active ? ' · now: ' + r.active : ''),
      right: h('button', { class: 'pill', onclick: () => api('/api/led', { cmd: 'test' }).then(x => toast(x.ok ? 'Red, green, blue, white…' : x.message || 'Failed')) }, 'Test') })),
    h('div', { class: 'section' }, 'SHOW ON THE LED'),
    h('div', { class: 'list' },
      sw('Notifications', 'A short blip in the app\'s colour until you read them', 'notify'),
      sw('Charging', 'Orange while charging, green when full', 'charge'),
      sw('Errors and warnings', 'Red: something broke (UI won\'t start, battery empty). Amber: too hot, weak power supply', 'alerts'),
      sw('Starting up', 'Soft blue breathing until the screen is ready', 'boot')),
    h('div', { class: 'section' }, 'MAXIMUM BRIGHTNESS'), h('label', { class: 'q-slider pad' }, h('i', { html: svg('sun') }), max),
    h('div', { class: 'section' }, 'WIRING'),
    h('p', { class: 'hint' }, `Pins (R,G,B per LED): ${r.pins || '17,27,22'}. HW-478 / KY-016: R → GPIO17 (pin 11), G → GPIO27 (pin 13), B → GPIO22 (pin 15), “-” → GND (pin 9). More LEDs, other pins or a common-anode module: /etc/skyglass/led.conf, then  sudo systemctl restart skyglass-led`),
    h('div', { class: 'pad' }, h('button', { class: 'btn', onclick: () => openApp('light') }, 'Open Light (flashlight & party)')));
}
// ---- Notifications
function notifPage(body) {
  const sw = (title, sub, key, after) => listItem({ title, sub, right: switchEl(!!S[key], v => { S[key] = v; save(); renderNotifs(); after && after(v); }) });
  body.append(h('div', { class: 'list' },
    sw('Do Not Disturb', 'No banners, sounds or waking up. Battery warnings still get through', 'dnd')),
    h('div', { class: 'section' }, 'HOW THEY SHOW UP'),
    h('div', { class: 'list' },
      sw('Banners', 'Slide in at the top while you use the phone', 'notifBanners'),
      sw('Sound', 'A soft chime', 'notifSound'),
      sw('Wake the screen', 'Light up the lock screen for a new notification', 'notifWake'),
      sw('On the lock screen', 'Show the latest ones before you unlock', 'notifLock'),
      sw('Show what they say', 'Off: the lock screen only shows which app it is', 'notifLockContent')));
  const apps = h('div', { class: 'list' });
  body.append(h('div', { class: 'section' }, 'APPS'), apps,
    h('div', { class: 'pad' }, h('button', { class: 'btn', onclick: () => { api('/api/notify', { app: 'Skyglass', title: 'Test notification', body: 'Notifications are working ✔', icon: 'bell', open: 'settings' }); } }, 'Send a test notification')),
    h('p', { class: 'hint' }, 'Linux apps notify through the standard desktop service. From a script or over SSH:  skyglass-notify "Title" "Text"'));
  const known = [...new Set(['Messages', 'Battery', 'Updates', 'Android', ...NOTIFS.map(n => n.app)])];
  for (const a of known) apps.append(listItem({ icon: ICONS[a.toLowerCase()] ? a.toLowerCase() : 'bell', title: a,
    right: switchEl(!(S.notifMuted || {})[a], v => { S.notifMuted = Object.assign({}, S.notifMuted); if (v) delete S.notifMuted[a]; else S.notifMuted[a] = true; save(); renderNotifs(); }) }));
}
// ---- Keyboard: squeekboard for Linux apps, hardware layout, compositor
async function keyboardPage(body) {
  const k = await api('/api/keyboard');
  if (k.error) return body.append(emptyState('keyboard', k.error));
  const set = async (b, msg) => { const x = await api('/api/keyboard', b); toast(x.ok ? msg : x.message || 'Failed'); return x.ok; };
  const restart = () => modal('Restart the screen?', h('p', {}, 'Open apps close. It takes a few seconds.'), [{ label: 'Later' }, { label: 'Restart', value: 'y', primary: true }])
    .then(v => v === 'y' && api('/api/ui/restart', {}));
  const layout = h('select', { class: 'field', onchange: async e => { if (await set({ layout: e.target.value }, 'Layout saved')) restart(); } },
    k.layouts.map(l => h('option', { value: l, selected: l === k.layout }, l.toUpperCase())));
  const comp = h('select', { class: 'field', onchange: async e => { if (await set({ compositor: e.target.value }, 'Saved')) restart(); } },
    [['auto', 'Automatic (labwc, cage if it fails)'], ['labwc', 'labwc'], ['cage', 'cage (no keyboard in Linux apps)']].map(([v, t]) => h('option', { value: v, selected: v === k.choice }, t)));
  const oskOk = k.compositor === 'labwc' && k.squeekboard;
  body.append(h('div', { class: 'section' }, 'ON-SCREEN KEYBOARD IN LINUX APPS'),
    h('div', { class: 'list' }, listItem({ icon: 'keyboard', title: 'Pop up on text fields', sub: oskOk ? 'Aero keyboard (squeekboard)' : !k.squeekboard ? 'squeekboard is not installed' : 'Needs labwc: now running on ' + (k.compositor || '?'),
      right: switchEl(k.osk, v => set({ osk: v }, v ? 'Keyboard on' : 'Keyboard off')) })),
    h('p', { class: 'hint' }, 'Skyglass apps always use their own keyboard. This one is for Linux apps and the web browser.'),
    h('div', { class: 'section' }, 'HARDWARE KEYBOARD LAYOUT'), h('div', { class: 'pad' }, layout),
    h('div', { class: 'section' }, 'SCREEN COMPOSITOR'), h('div', { class: 'pad' }, comp),
    h('p', { class: 'hint' }, 'Now running: ' + (k.compositor || 'unknown') + '. labwc lets the keyboard float above apps; cage is the simple fallback.'));
}
// ---- Hotspot
async function hotspotPage(body) {
  const st = await api('/api/hotspot');
  if (!st.ok) return body.append(emptyState('hotspot', 'NetworkManager is not available.'));
  const ssid = h('input', { class: 'field', type: 'text', value: st.ssid || 'Skyglass', maxlength: 32 });
  const pw = h('input', { class: 'field', type: 'text', value: st.password || Math.random().toString(36).slice(2, 12), maxlength: 63 });
  const sw = switchEl(st.on, async v => {
    toast(v ? 'Starting hotspot…' : 'Stopping hotspot…', 2000);
    const x = await api('/api/hotspot', { on: v, ssid: ssid.value, password: pw.value });
    toast(x.ok ? (v ? 'Hotspot on: ' + ssid.value : 'Hotspot off') : x.message || 'Failed', 4000); pollStatus();
  });
  body.append(h('div', { class: 'list' }, listItem({ icon: 'hotspot', title: 'Wi-Fi hotspot', sub: 'Other devices join this phone\'s network', right: sw })),
    h('div', { class: 'section' }, 'NETWORK NAME'), h('div', { class: 'pad' }, ssid),
    h('div', { class: 'section' }, 'PASSWORD (8+ CHARACTERS)'), h('div', { class: 'pad' }, pw),
    h('p', { class: 'hint' }, 'Turning the hotspot on disconnects this phone from Wi-Fi: it shares a 4G modem or an Ethernet/USB connection.'));
}
// ---- Android (Waydroid)
async function androidPage(body) {
  const r = await api('/api/android');
  if (!r.ready) return body.append(emptyState('android', 'Android is not set up yet.'), h('div', { class: 'pad' }, h('button', { class: 'btn primary', onclick: () => openApp('terminal', { cmd: 'skyglass-android setup' }) }, 'Set up Android')));
  body.append(h('div', { class: 'list' },
    listItem({ icon: 'android', title: 'Status', sub: r.running ? 'Running' : 'Stopped (starts when you open it)',
      right: r.running ? h('button', { class: 'pill', onclick: async () => { await api('/api/android', { action: 'stop' }); toast('Android stopped'); } }, 'Stop') : null }),
    listItem({ title: 'Apps in their own windows', sub: 'Off: one full Android screen with its own home screen',
      right: switchEl(r.windowed, async v => { const x = await api('/api/android', { action: 'windowed', on: v }); toast(x.ok ? 'Saved. Takes effect the next time Android starts' : x.message || 'Failed', 3500); }) }),
    listItem({ icon: 'settings', title: 'Android settings', sub: 'Accounts, languages, app permissions', onclick: async () => { toast('Opening Android settings…'); await api('/api/android', { action: 'settings' }); } })),
    h('p', { class: 'hint' }, 'Install apps: tap an .apk file in Files, or use an app store like F-Droid inside Android. Installed apps show up in the Android app and in Linux Apps.'),
    h('div', { class: 'pad' }, h('button', { class: 'btn', onclick: () => openApp('terminal', { cmd: 'skyglass-android status' }) }, 'Details in Terminal')));
}
// ---- Software updates (apt, with progress)
async function updatesPage(body) {
  // Skyglass itself, from its GitHub releases (skyglass-update)
  const sky = h('div', { class: 'list' }), skyLog = h('pre', { class: 'pad sub', style: { whiteSpace: 'pre-wrap', fontSize: '12px', maxHeight: '24vh', overflow: 'auto', display: 'none' } });
  const drawSky = async force => {
    sky.innerHTML = ''; sky.append(listItem({ icon: 'download', title: 'Skyglass', sub: 'Checking GitHub…' }));
    const u = await api('/api/skyglass-update' + (force ? '?force=1' : ''));
    sky.innerHTML = '';
    const sub = u.running ? 'Updating… the screen restarts when it\'s done'
      : !u.ok ? 'Couldn\'t check: ' + (u.message || 'offline?')
      : u.available ? `Version ${u.latest} is available (you have ${u.installed})` : `Version ${u.installed || '?'}: up to date`;
    const btn = u.running ? null : u.available
      ? h('button', { class: 'pill primary', onclick: async () => {
          if (await modal('Update Skyglass?', h('p', {}, `Installs Skyglass ${u.latest} from GitHub (${u.repo}). Keep the phone plugged in. The screen restarts at the end.`), [{ label: 'Later' }, { label: 'Update', value: 'y', primary: true }]) !== 'y') return;
          const x = await api('/api/skyglass-update', { action: 'update' }); if (!x.ok) toast(x.message || 'Failed'); drawSky(); } }, 'Update')
      : h('button', { class: 'pill', onclick: () => drawSky(true) }, 'Check');
    sky.append(listItem({ icon: 'download', title: 'Skyglass', sub, right: btn }),
      listItem({ title: 'Go back to the previous version', sub: 'If an update broke something', onclick: async () => {
        if (await modal('Go back?', h('p', {}, 'Reinstalls the Skyglass version you had before the last update.'), [{ label: 'Cancel' }, { label: 'Go back', value: 'y', primary: true }]) !== 'y') return;
        const x = await api('/api/skyglass-update', { action: 'rollback' }); toast(x.ok ? 'Going back…' : x.message || 'Failed'); drawSky(); } }));
    skyLog.style.display = u.log ? '' : 'none'; skyLog.textContent = u.log || ''; skyLog.scrollTop = skyLog.scrollHeight;
    if (u.running && body.isConnected) setTimeout(() => body.isConnected && drawSky(), 3000);
  };
  body.append(h('div', { class: 'section' }, 'SKYGLASS'), sky, skyLog, h('div', { class: 'section' }, 'DEBIAN PACKAGES'));
  drawSky();
  const state = h('div', { class: 'pad' }), log = h('pre', { class: 'pad sub', style: { whiteSpace: 'pre-wrap', fontSize: '12px', maxHeight: '36vh', overflow: 'auto' } });
  const check = h('button', { class: 'btn', onclick: () => start(false) }, 'Check now');
  const install = h('button', { class: 'btn primary', onclick: () => start(true) }, 'Install updates');
  let alive = true;
  const draw = u => {
    check.disabled = install.disabled = u.running;
    install.style.display = u.packages && u.packages.length && !u.running ? '' : 'none';
    state.innerHTML = '';
    state.append(h('b', {}, u.running ? u.phase : u.result || 'Tap “Check now” to look for updates.'),
      u.checked ? h('div', { class: 'sub' }, 'Last check: ' + new Date(u.checked * 1000).toLocaleString()) : null,
      u.packages && u.packages.length && !u.running ? h('div', { class: 'sub' }, u.packages.slice(0, 40).join(', ') + (u.packages.length > 40 ? ' …' : '')) : null);
    log.textContent = u.log || '';
    log.scrollTop = log.scrollHeight;
  };
  const poll = async () => { while (alive && body.isConnected) { const u = await api('/api/updates'); if (u.error) break; draw(u); if (!u.running) break; await sleep(1500); } };
  const start = async inst => { const x = await api('/api/updates', { install: inst }); if (!x.ok) toast(x.message || 'Failed'); await sleep(300); poll(); };
  body.append(state, h('div', { class: 'pad', style: { display: 'flex', gap: '10px' } }, check, install),
    h('p', { class: 'hint' }, 'Updates come from Debian and Raspberry Pi. Keep the phone plugged in while installing. Your settings and files stay as they are.'), log);
  poll();
  return () => { alive = false; };
}
// ---- Wallpaper: the four drawn skies, pictures shipped with Skyglass, or any JPG/PNG/WebP you have
async function setWallpaperFrom(path) {
  toast('Setting wallpaper…', 1500);
  const r = await api('/api/wallpaper', { path });
  if (!r.ok) { toast(r.message || r.error || 'Could not use that picture', 4000); return false; }
  S.wallpaper = 'custom'; S.wallV = r.v; S.wallSrc = path; save();
  toast('Wallpaper set ✔'); return true;
}
function wallpaperPage(body) {
  const walls = [['hills', 'Sky hills', 'linear-gradient(180deg,#1d8fff,#8fd3ff 55%,#4fbf3a 56%,#2f9b2a)'], ['sunset', 'Sunset', 'linear-gradient(180deg,#ff7a59,#ffc27a 55%,#c9763a 56%,#7a4a2a)'],
    ['night', 'Night', 'linear-gradient(180deg,#050b25,#1d3a74 55%,#1b3a2a 56%,#0e2416)'], ['ocean', 'Ocean', 'linear-gradient(180deg,#0a5fb8,#2fb4e6 50%,#0d7fbf 51%,#063f7a)']];
  const mark = el => { $$('.wall-opt', body).forEach(b => b.classList.remove('on')); el && el.classList.add('on'); };
  const isOn = id => S.wallpaper === id || (S.wallpaper === 'custom' && S.wallSrc === id);
  const pictureOpt = (path, name) => h('button', { class: 'wall-opt' + (isOn(path) ? ' on' : ''), onclick: async e => {
    const el = e.currentTarget; if (await setWallpaperFrom(path)) mark(el);
  } }, h('span', { class: 'wall-img', style: { backgroundImage: `url("${thumbUrl(path)}")` } }), name);
  body.append(h('div', {}, h('div', { class: 'section' }, 'SKIES'),
    h('div', { class: 'wall-pick' }, walls.map(([id, name, bg]) => h('button', { class: 'wall-opt' + (isOn(id) ? ' on' : ''), onclick: e => {
      S.wallpaper = id; save(); mark(e.currentTarget);
    } }, h('span', { style: { background: bg } }), name)))));
  const more = h('div', {}, h('div', { class: 'sky-loading' }, h('span', { class: 'sky-orb spin' }), 'Looking for pictures…'));
  body.append(more);
  api('/api/wallpapers').then(r => {
    if (!more.isConnected) return;
    more.innerHTML = '';
    const nice = p => p.split('/').pop().replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
    if ((r.shipped || []).length) more.append(h('div', { class: 'section' }, 'PICTURES'),
      h('div', { class: 'wall-pick' }, r.shipped.map(p => pictureOpt(p, nice(p)))));
    more.append(h('div', { class: 'section' }, 'YOUR PHOTOS'));
    if ((r.photos || []).length) more.append(h('div', { class: 'wall-pick small' }, r.photos.map(p => pictureOpt(p, ''))));
    else more.append(h('p', { class: 'hint' }, 'Put a JPG or PNG in Pictures or Downloads (or plug in a USB drive) and it shows up here. You can also open any photo and tap Wallpaper.'));
  });
}
// ---- Date & time
async function timePage(body) {
  const r = await api('/api/time');
  const tz = h('div', { class: 'list' });
  body.append(h('div', { class: 'list' },
    listItem({ icon: 'clock', title: '24-hour clock', sub: S.clock24 === false ? '1:30 PM' : '13:30', right: switchEl(S.clock24 !== false, v => { S.clock24 = v; save(); tick(); }) }),
    listItem({ icon: 'wifi', title: 'Set time automatically', sub: 'From the internet', right: switchEl(!!r.ntp, async v => { const x = await api('/api/time', { ntp: v }); if (!x.ok) toast(x.message || 'Failed'); }) })),
    h('div', { class: 'section' }, 'TIME ZONE'), tz);
  tz.append(listItem({ icon: 'sun', title: r.timezone || 'Unknown', sub: 'Tap to change', onclick: () => pickZone() }));
  async function pickZone() {
    const z = await api('/api/time/zones');
    const input = h('input', { type: 'search', placeholder: 'Search a city, e.g. Chisinau' }), list = h('div', { class: 'list zone-list' });
    const draw = () => { list.innerHTML = ''; const q = input.value.trim().toLowerCase().replace(/ /g, '_');
      (z.zones || []).filter(n => !q || n.toLowerCase().includes(q)).slice(0, 40).forEach(n => list.append(listItem({ title: n.replace(/_/g, ' '), onclick: async () => {
        const x = await api('/api/time', { timezone: n }); $$('.modal-bg').forEach(m => m.remove()); OSK.hide(); toast(x.ok ? 'Time zone: ' + n : x.message || 'Failed'); CURRENT && CURRENT.show(); } }))); };
    input.addEventListener('input', draw); draw();
    modal('Time zone', h('div', {}, input, list), [{ label: 'Cancel' }]);
  }
}
// ---- Accessibility
function accessPage(body) {
  body.append(h('div', { class: 'section' }, 'TEXT & ICON SIZE'),
    h('div', { class: 'pad' }, seg([[0.9, 'Small'], [1, 'Normal'], [1.12, 'Large'], [1.25, 'Huge']], S.textSize || 1, v => { S.textSize = v; save(); })),
    h('div', { class: 'list' },
      listItem({ title: 'Bold text', sub: 'Easier to read', right: switchEl(!!S.boldText, v => { S.boldText = v; save(); }) }),
      listItem({ title: 'Reduce motion', sub: 'Stops animations; also saves battery and CPU', right: switchEl(!!S.reduceMotion, v => { S.reduceMotion = v; save(); }) }),
      listItem({ title: 'Floating bubbles', sub: 'The bubbles on the wallpaper', right: switchEl(!!S.bubbles, v => { S.bubbles = v; save(); }) }),
      listItem({ title: 'Key clicks', sub: 'Sound when typing', right: switchEl(!!S.clicks, v => { S.clicks = v; save(); }) })));
}
// ---- Storage
async function storagePage(body) {
  body.append(h('div', { class: 'sky-loading' }, h('span', { class: 'sky-orb spin' }), 'Measuring…'));
  const r = await api('/api/storage');
  if (!body.isConnected) return;
  body.innerHTML = '';
  const used = r.total - r.free, colors = ['#1a8cff', '#e8331c', '#b52fd0', '#ff9a1c', '#2bb24c', '#0d8f86'];
  const parts = Object.entries(r.parts || {});
  const other = Math.max(0, used - parts.reduce((s, [, v]) => s + v, 0));
  body.append(h('div', { class: 'pad' },
    h('div', { class: 'st-head' }, h('b', {}, fmtSize(r.free) + ' free'), h('span', {}, 'of ' + fmtSize(r.total))),
    h('div', { class: 'st-bar' }, parts.map(([, v], i) => h('i', { style: { width: v / r.total * 100 + '%', background: colors[i] } })), h('i', { style: { width: other / r.total * 100 + '%', background: '#8a9bb0' } }))),
    h('div', { class: 'list' }, parts.map(([k, v], i) => listItem({ title: k, sub: fmtSize(v), right: h('span', { class: 'st-dot', style: { background: colors[i] } }) })),
      listItem({ title: 'System & apps', sub: fmtSize(other), right: h('span', { class: 'st-dot', style: { background: '#8a9bb0' } }) })),
    h('div', { class: 'section' }, 'SAVE SPACE'),
    h('div', { class: 'list' },
      listItem({ icon: 'trash', title: 'Clean up caches', sub: 'Previews, browser cache, old logs, downloaded updates', onclick: async () => {
        toast('Cleaning…', 1500); const x = await api('/api/storage/clean', {}); toast('Freed ' + fmtSize(x.freed || 0) + ' ✔', 3000); CURRENT && CURRENT.show(); } }),
      listItem({ icon: 'camera', title: 'Photo size', sub: S.camHQ ? 'High quality (12 MP, about 5 MB each)' : 'Standard (3 MP, about 1 MB each) — recommended',
        right: switchEl(!!S.camHQ, v => { S.camHQ = v; save(); }) }),
      listItem({ icon: 'usb', title: 'Move photos & videos to USB', sub: 'Select them in Photos, then “Move to…”', onclick: () => openApp('photos') })),
    h('p', { class: 'hint' }, 'Skyglass refuses to take photos or start a video when the card is nearly full, and stops a recording safely before it runs out.'));
}
async function wifiPage(body) {
  const status = h('div', { class: 'pad' }, 'Scanning for networks…');
  const list = h('div', { class: 'list' });
  body.append(status, list);
  const scan = async () => {
    const r = await api('/api/wifi/scan');
    status.textContent = r.error ? r.error : `${r.networks.length} networks nearby`;
    status.append(' ', h('button', { class: 'pill', onclick: () => { status.textContent = 'Scanning…'; scan(); } }, 'Rescan'));
    list.innerHTML = '';
    for (const n of r.networks || []) list.append(listItem({ icon: n.secure ? 'lock' : 'wifi', title: n.ssid, sub: (n.active ? 'Connected · ' : '') + `Signal ${n.signal}%`, onclick: () => connect(n) }));
  };
  const connect = async n => {
    let pw = null;
    if (n.secure && !n.active) {
      const f = h('input', { class: 'field', type: 'password', placeholder: 'Password' });
      setTimeout(() => f.focus(), 250);
      f.addEventListener('keydown', e => e.key === 'Enter' && $('.modal .btn.primary').click());
      if (await modal('Join “' + n.ssid + '”', f, [{ label: 'Cancel' }, { label: 'Join', value: 'y', primary: true }]) !== 'y') return;
      pw = f.value;
    }
    toast('Connecting to ' + n.ssid + '…');
    const r = await api('/api/wifi/connect', { ssid: n.ssid, password: pw });
    toast(r.ok ? 'Connected to ' + n.ssid : 'Could not connect: ' + (r.message || ''), 4000);
    pollStatus(); scan();
  };
  scan();
}
function displayPage(body) {
  const themes = [['sky', 'Sky'], ['aqua', 'Aqua'], ['aurora', S.eggs.aurora ? 'Aurora' : '???']];
  body.append(
    h('div', { class: 'section' }, 'THEME'),
    h('div', { class: 'pad' }, seg(themes, S.theme, v => { if (v === 'aurora' && !S.eggs.aurora) return toast('Locked. Some say it appears to those who know the code…'); S.theme = v; save(); })),
    h('div', { class: 'list' },
      listItem({ title: 'Glass effects', sub: 'Blur behind panels (heavy on the Pi — off by default there)', right: switchEl(S.glass ?? !ON_DEVICE, v => { S.glass = v; save(); }) }),
      listItem({ title: 'Floating bubbles', right: switchEl(S.bubbles, v => { S.bubbles = v; save(); }) }),
      S.eggs.aquarium ? listItem({ title: 'Fish on home screen', right: switchEl(S.fish, v => { S.fish = v; save(); }) }) : null),
    h('div', { class: 'section' }, 'BRIGHTNESS'),
    h('label', { class: 'q-slider pad' }, h('input', { type: 'range', min: 10, max: 100, value: S.brightness, oninput: e => { setBrightness(e.target.value); $('#q-bright').value = e.target.value; } })),
    h('div', { class: 'section' }, 'SCREENSAVER'),
    h('div', { class: 'pad' }, seg([[0, 'Off'], [30, '30 s'], [60, '1 min'], [120, '2 min']], S.saverAfter, v => { S.saverAfter = v; save(); })),
    h('div', { class: 'pad saver-pick' }, [...SAVER_LIST, ...(S.eggs.aquarium ? [['aquarium', 'Aquarium']] : []), ['random', '🎲 Random']].map(([v, label]) =>
      h('button', { class: 'pill' + (S.saverStyle === v ? ' primary' : ''), onclick: e => { S.saverStyle = v; save(); $$('.saver-pick .pill').forEach(b => b.classList.remove('primary')); e.currentTarget.classList.add('primary'); } }, label))),
    h('div', { class: 'list' }, listItem({ title: 'Preview screensaver', sub: 'Tap anywhere to stop', onclick: () => startSaver(true) })),
    h('div', { class: 'section' }, 'SCREEN OFF'),
    h('div', { class: 'pad' }, seg([[30, '30 s'], [90, '90 s'], [300, '5 min'], [0, 'Never']], S.sleepAfter, v => { S.sleepAfter = v; save(); })),
    h('div', { class: 'section' }, 'SCREEN ORIENTATION'),
    (() => { const host = h('div', { class: 'pad' }); orientationPicker(host); return host; })(),
    h('div', { class: 'list' }, listItem({ title: 'Calibrate touch', sub: 'Taps landing in the wrong place? Fix it here', onclick: touchCalibrate }),
      listItem({ title: 'Touchscreen test', sub: 'Check that touch lines up with the picture', onclick: touchTest })));
}
async function securityPage(body, win) {
  const r = await api('/api/pin');
  body.append(h('div', { class: 'list' },
    listItem({ icon: 'lock', title: r.set ? 'Change PIN' : 'Set a PIN', sub: r.set ? 'You will confirm your current PIN first' : 'Protect the lock screen', onclick: () => win.push(r.set ? 'Change PIN' : 'Set a PIN', changePinPage) }),
    listItem({ icon: 'info', title: 'Tips on the lock screen', sub: 'Fun facts and pro tips under the clock', right: switchEl(S.lockTips !== false, v => { S.lockTips = v; save(); }) }),
    listItem({ icon: 'power', title: 'Lock now', onclick: () => { goHome(); lock(); } })),
    h('div', { class: 'pad', style: { color: 'var(--ink-soft)', fontSize: '14px' } },
      'Forgot it? Plug in a keyboard or SSH in and run: skyglass-pin reset — you are root, after all.'));
}
async function changePinPage(body, win) {
  const r = await api('/api/pin');
  const done = () => win.back();
  const ask = old => { body.innerHTML = ''; body.append(choosePin({ light: true, old, first: false, onDone: done, onCancel: done }).el); };
  if (!r.set) return ask(null);
  const pad = pinPad({
    light: true, title: 'Current PIN', onCancel: done,
    async onSubmit(pin, p) {
      const v = await api('/api/pin/verify', { pin });
      if (v.ok) return ask(pin);
      if (v.locked_for) return (p.error('Too many tries'), p.disable(v.locked_for));
      p.error('Wrong PIN');
    },
  });
  body.append(pad.el);
}
function soundPage(body) {
  body.append(h('div', { class: 'section' }, 'VOLUME'),
    h('label', { class: 'q-slider pad' }, h('input', { type: 'range', min: 0, max: 100, value: S.volume, onchange: e => { S.volume = +e.target.value; save(); api('/api/volume', { percent: S.volume }); $('#q-vol').value = S.volume; } })),
    h('div', { class: 'list' }, listItem({ title: 'Keyboard clicks', right: switchEl(S.clicks, v => { S.clicks = v; save(); }) }),
      listItem({ title: 'Play test sound', onclick: () => tone('chime') })));
}
async function aboutPage(body) {
  const a = await api('/api/about');
  let taps = 0;
  const row = (k, v, onclick) => listItem({ title: k, sub: String(v), onclick });
  body.append(h('div', { class: 'pad', style: { textAlign: 'center' } },
    h('div', { class: 'icon', style: { margin: '10px auto', width: '110px', height: '110px', borderRadius: '50%', background: 'radial-gradient(circle at 50% 30%, #fff, #8fd8ff 40%, #0a6fd6)' }, html: svg('drop') }),
    h('h2', { style: { margin: '6px 0 0' } }, 'Skyglass OS'), h('div', { style: { color: 'var(--ink-soft)' } }, 'Built on Debian. Made by you.')));
  body.append(h('div', { class: 'list' },
    row('Version', a.os, () => {
      taps++;
      if (S.eggs.aquarium) return taps === 1 && toast('You are already a Bubble Developer.');
      if (taps >= 7) { S.eggs.aquarium = true; save(); renderHome(); toast('You are now a Bubble Developer! Check your home screen.', 5000); tone('chime'); }
      else if (taps >= 3) toast(`${7 - taps} taps away from being a Bubble Developer.`, 1200);
    }),
    row('Device name', a.hostname + '  ✎', async () => {
      const inp = h('input', { type: 'text', value: a.hostname });
      const v = await modal('Device name', h('div', {}, h('p', {}, 'How the phone shows up on your network.'), inp), [{ label: 'Cancel' }, { label: 'Save', primary: true, value: 'ok' }]);
      if (v !== 'ok') return; const x = await api('/api/hostname', { name: inp.value.trim() }); toast(x.ok ? 'Renamed ✔' : x.message || 'Failed'); CURRENT && CURRENT.show();
    }),
    row('Based on', a.base), row('Model', a.model), row('Kernel', a.kernel), row('Uptime', fmtDur(a.uptime || 0)),
    row('Memory', `${a.mem_free_mb} MB free of ${a.mem_total_mb} MB`), row('Storage', `${a.disk_free_gb} GB free of ${a.disk_total_gb} GB`),
    row('CPU temperature', a.cpu_temp != null ? a.cpu_temp + ' °C' : 'n/a')));
}
function powerPage(body) {
  const act = a => async () => { const r = await api('/api/power', { action: a }); toast(r.ok ? 'OK' : (r.message || 'Failed')); };
  body.append(h('div', { class: 'list' },
    listItem({ icon: 'lock', title: 'Lock now', onclick: () => { goHome(); lock(); } }),
    listItem({ icon: 'rotate', title: 'Restart shell', sub: 'Reloads the UI, keeps Linux running', onclick: act('restart-shell') }),
    listItem({ icon: 'rotate', title: 'Reboot', onclick: act('reboot') }),
    listItem({ icon: 'power', title: 'Shut down', onclick: act('shutdown') })));
}
async function devPage(body, win) {
  const a = await api('/api/about');
  body.append(h('div', { class: 'list' },
    listItem({ icon: 'code', title: 'Root access', sub: a.sudo ? 'Passwordless sudo is active. You own this phone.' : 'sudo needs a password (dev host?)' }),
    listItem({ icon: 'terminal', title: 'Open Terminal', onclick: () => openApp('terminal') }),
    listItem({ icon: 'display', title: 'Display config', sub: (a.display || 'not set').replace(/\n/g, ' · ') }),
    listItem({ icon: 'close', title: 'Reset Skyglass settings', sub: 'Theme, toggles and unlocked secrets', onclick: async () => {
      if (await modal('Reset?', h('p', {}, 'This resets settings and re-locks the secrets. Notes are kept.'), [{ label: 'Cancel' }, { label: 'Reset', value: 'y', danger: true }]) === 'y') {
        clearTimeout(persistTimer); localStorage.removeItem('sg.settings'); await api('/api/settings', { settings: null }); location.reload();
      } } })));
}

// ============================================================ screensaver
// Glossy bubbles (or aurora / aquarium) with a slowly drifting clock — drifting so the
// panel never burns in. Any touch dismisses it and leaves you on the (PIN) lock screen.
let saverOn = false, saverGen = 0;
// Each extra style: (ctx, W, H) => step(t). The step paints the whole frame.
const SAVER_STYLES = {
  // flying through space
  starfield(ctx, W, H) {
    const stars = Array.from({ length: 260 }, () => ({ x: (Math.random() - .5) * W * 2, y: (Math.random() - .5) * H * 2, z: Math.random() * W }));
    return () => {
      ctx.fillStyle = 'rgba(2,6,20,.45)'; ctx.fillRect(0, 0, W, H);
      for (const s of stars) {
        const pz = s.z; s.z -= W * .012;
        if (s.z < 1) { s.x = (Math.random() - .5) * W * 2; s.y = (Math.random() - .5) * H * 2; s.z = W; continue; }
        const k = W * .5, x1 = W / 2 + s.x / s.z * k, y1 = H / 2 + s.y / s.z * k, x0 = W / 2 + s.x / pz * k, y0 = H / 2 + s.y / pz * k;
        const b = 1 - s.z / W;
        ctx.strokeStyle = `rgba(${180 + b * 75},${210 + b * 45},255,${b})`; ctx.lineWidth = b * 3;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      }
    };
  },
  // raindrops running down a window, city lights blurred behind
  rain(ctx, W, H) {
    const bg = h('canvas'); bg.width = W; bg.height = H; const b = bg.getContext('2d');
    const g = b.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#0b1830'); g.addColorStop(1, '#2a3f66'); b.fillStyle = g; b.fillRect(0, 0, W, H);
    for (let i = 0; i < 60; i++) {
      const x = Math.random() * W, y = H * (.35 + Math.random() * .65), r = 10 + Math.random() * 40, hue = [40, 30, 200, 330, 180][i % 5];
      const rg = b.createRadialGradient(x, y, 0, x, y, r); rg.addColorStop(0, `hsla(${hue},90%,70%,.35)`); rg.addColorStop(1, 'transparent');
      b.fillStyle = rg; b.fillRect(x - r, y - r, r * 2, r * 2);
    }
    const still = Array.from({ length: 140 }, () => ({ x: Math.random() * W, y: Math.random() * H, r: 1 + Math.random() * 3 }));
    const runs = [];
    const drop = (x, y, r) => {
      const rg = ctx.createRadialGradient(x - r * .3, y - r * .3, r * .1, x, y, r);
      rg.addColorStop(0, 'rgba(255,255,255,.75)'); rg.addColorStop(.5, 'rgba(170,200,255,.25)'); rg.addColorStop(1, 'rgba(255,255,255,.45)');
      ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
    };
    return () => {
      ctx.drawImage(bg, 0, 0);
      if (runs.length < 9 && Math.random() < .05) runs.push({ x: Math.random() * W, y: -10, r: 4 + Math.random() * 4, v: 0, trail: [] });
      for (const s of still) drop(s.x, s.y, s.r);
      for (let i = runs.length - 1; i >= 0; i--) {
        const d = runs[i];
        d.v = Math.random() < .08 ? 0 : Math.min(9, d.v + .25); d.y += d.v; d.x += (Math.random() - .5) * 1.2;
        d.trail.push([d.x, d.y]); if (d.trail.length > 40) d.trail.shift();
        ctx.strokeStyle = 'rgba(200,225,255,.18)'; ctx.lineWidth = d.r * .9; ctx.beginPath(); d.trail.forEach(([x, y], k) => k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.stroke();
        drop(d.x, d.y, d.r);
        if (d.y > H + 20) runs.splice(i, 1);
      }
    };
  },
  // glowing blobs that merge and split (metaballs, drawn small and scaled up smoothly)
  lava(ctx, W, H) {
    const s = 6, w = Math.ceil(W / s), hh = Math.ceil(H / s);
    const small = h('canvas'); small.width = w; small.height = hh; const sc = small.getContext('2d'), img = sc.createImageData(w, hh);
    const blobs = Array.from({ length: 7 }, (_, i) => ({ x: Math.random() * w, y: Math.random() * hh, r: w * (.12 + Math.random() * .1), vx: (Math.random() - .5) * .25, vy: (Math.random() - .5) * .35, ph: i }));
    return t => {
      for (const b of blobs) { b.x += b.vx; b.y += b.vy + Math.sin(t / 2000 + b.ph) * .15; if (b.x < 0 || b.x > w) b.vx *= -1; if (b.y < 0 || b.y > hh) b.vy *= -1; }
      const d = img.data;
      for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
        let f = 0; for (const b of blobs) { const dx = x - b.x, dy = y - b.y; f += b.r * b.r / (dx * dx + dy * dy + 1); }
        const i = (y * w + x) * 4, v = Math.min(1, f / 2.2), inside = f > 1;
        d[i] = inside ? 255 : 40 + v * 90; d[i + 1] = inside ? 80 + Math.min(1, f - 1) * 150 : 10 + v * 30; d[i + 2] = inside ? 120 - Math.min(1, f - 1) * 100 : 70 + v * 100; d[i + 3] = 255;
      }
      sc.putImageData(img, 0, 0); ctx.imageSmoothingEnabled = true; ctx.drawImage(small, 0, 0, W, H);
    };
  },
  // fireflies over a dusk meadow
  fireflies(ctx, W, H) {
    const flies = Array.from({ length: 46 }, () => ({ x: Math.random() * W, y: H * (.2 + Math.random() * .75), a: Math.random() * 6.28, sp: .4 + Math.random() * .8, ph: Math.random() * 6.28 }));
    const sky = ctx.createLinearGradient(0, 0, 0, H); sky.addColorStop(0, '#0a1030'); sky.addColorStop(.6, '#1b2f4a'); sky.addColorStop(1, '#13301f');
    return t => {
      ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#0b1f12'; ctx.beginPath(); ctx.moveTo(0, H);
      for (let x = 0; x <= W; x += 20) ctx.lineTo(x, H * .86 + Math.sin(x / 90) * 18 + Math.sin(x / 23) * 6);
      ctx.lineTo(W, H); ctx.fill();
      ctx.globalCompositeOperation = 'lighter';
      for (const f of flies) {
        f.a += (Math.random() - .5) * .3; f.x += Math.cos(f.a) * f.sp; f.y += Math.sin(f.a) * f.sp * .6;
        if (f.x < 0) f.x = W; if (f.x > W) f.x = 0; if (f.y < H * .15 || f.y > H * .95) f.a += Math.PI;
        const glow = Math.max(0, Math.sin(t / 600 + f.ph)) ** 2, r = 4 + glow * 16;
        const g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, r); g.addColorStop(0, `rgba(230,255,140,${.3 + glow * .7})`); g.addColorStop(1, 'transparent');
        ctx.fillStyle = g; ctx.fillRect(f.x - r, f.y - r, r * 2, r * 2);
      }
      ctx.globalCompositeOperation = 'source-over';
    };
  },
  // six-fold mirrored glass shapes
  kaleido(ctx, W, H) {
    const shapes = Array.from({ length: 9 }, (_, i) => ({ r: 30 + i * 25, a: Math.random() * 6.28, s: (Math.random() - .5) * .02, size: 10 + Math.random() * 26, hue: i * 40 }));
    return t => {
      ctx.fillStyle = 'rgba(3,6,18,.12)'; ctx.fillRect(0, 0, W, H);
      ctx.save(); ctx.translate(W / 2, H / 2); ctx.globalCompositeOperation = 'lighter';
      for (let k = 0; k < 12; k++) {
        ctx.save(); ctx.rotate(k * Math.PI / 6 + t / 9000); if (k % 2) ctx.scale(1, -1);
        for (const s of shapes) {
          s.a += s.s / 12; const x = Math.cos(s.a) * s.r * (1 + .3 * Math.sin(t / 3000)), y = Math.sin(s.a) * s.r * .5;
          const g = ctx.createRadialGradient(x, y, 0, x, y, s.size); g.addColorStop(0, `hsla(${(s.hue + t / 40) % 360},95%,70%,.55)`); g.addColorStop(1, 'transparent');
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, s.size, 0, 7); ctx.fill();
        }
        ctx.restore();
      }
      ctx.restore(); ctx.globalCompositeOperation = 'source-over';
    };
  },
};
const SAVER_LIST = [['bubbles', 'Bubbles'], ['aurora', 'Aurora'], ['starfield', 'Starfield'], ['rain', 'Rainy window'], ['lava', 'Lava lamp'], ['fireflies', 'Fireflies'], ['kaleido', 'Kaleidoscope']];
function startSaver(preview = false) {
  if (saverOn) return;
  saverOn = true;
  if (!preview) lock();
  OSK.hide(); closeQuick();
  let style = S.saverStyle;
  if (style === 'random') { const all = [...SAVER_LIST.map(s => s[0]), ...(S.eggs.aquarium ? ['aquarium'] : [])]; style = all[Math.floor(Math.random() * all.length)]; }
  const cv = h('canvas'), clock = h('div', { class: 'saver-clock' }), el = h('div', { id: 'saver', class: 'saver-' + style }, cv, clock);
  $('#phone').append(el);
  const W = cv.width = innerWidth, H = cv.height = innerHeight, ctx = cv.getContext('2d');
  const R = Math.min(W, H);
  const custom = SAVER_STYLES[style] ? SAVER_STYLES[style](ctx, W, H) : null;
  const balls = Array.from({ length: style === 'bubbles' ? 7 : 0 }, () => ({
    x: Math.random() * W, y: Math.random() * H, r: R * (.07 + Math.random() * .1),
    vx: (Math.random() - .5) * 1.2, vy: (Math.random() - .5) * 1.2, hue: Math.random() * 360 }));
  const fish = style === 'aquarium' || (style === 'bubbles' && Math.random() < .08) ? Array.from({ length: style === 'aquarium' ? 6 : 1 }, makeFish) : [];
  let cx = W * .2, cy = H * .3, cvx = .35, cvy = .25, lastMin = '';
  const gen = ++saverGen;
  // 30 fps, paced by a timer so the renderer sleeps between frames (rAF alone would wake it 60x/s)
  const next = () => setTimeout(() => saverOn && gen === saverGen && RAF_SHELL(loop), 30);
  const loop = t => {
    if (!saverOn || gen !== saverGen) return;
    next();
    if (custom) custom(t); else ctx.clearRect(0, 0, W, H);
    for (const b of balls) {
      b.x += b.vx; b.y += b.vy; b.hue = (b.hue + .3) % 360;
      if (b.x < b.r || b.x > W - b.r) b.vx *= -1;
      if (b.y < b.r || b.y > H - b.r) b.vy *= -1;
      const g = ctx.createRadialGradient(b.x - b.r * .35, b.y - b.r * .4, b.r * .05, b.x, b.y, b.r);
      g.addColorStop(0, 'rgba(255,255,255,.95)'); g.addColorStop(.2, `hsla(${b.hue},90%,85%,.35)`);
      g.addColorStop(.8, `hsla(${(b.hue + 60) % 360},90%,70%,.18)`); g.addColorStop(1, 'rgba(255,255,255,.75)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, 7); ctx.fill();
    }
    if (fish.length) { stepFish(fish, W, t); for (const f of fish) drawFish(ctx, f, t); }
    // drifting clock (anti burn-in)
    const cw = clock.offsetWidth, ch = clock.offsetHeight;
    cx += cvx; cy += cvy;
    if (cx < 0 || cx + cw > W) cvx *= -1;
    if (cy < 0 || cy + ch > H) cvy *= -1;
    cx = Math.max(0, Math.min(W - cw, cx)); cy = Math.max(0, Math.min(H - ch, cy));
    clock.style.transform = `translate(${cx}px, ${cy}px)`;
    const d = new Date(), min = `${d.getHours()}:${pad2(d.getMinutes())}`;
    if (min !== lastMin) { lastMin = min; clock.innerHTML = `<b>${min}</b><span>${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}</span>`; }
  };
  RAF_SHELL(loop);
}
function stopSaver() {
  if (!saverOn) return;
  saverOn = false; saverGen++;
  const el = $('#saver'); if (el) { el.classList.add('out'); setTimeout(() => el.remove(), 300); }
  lastActivity = Date.now();
}

// ============================================================ screen sleep (phone-style)
let lastActivity = Date.now(), asleep = false;
for (const ev of ['pointerdown', 'keydown']) addEventListener(ev, e => {
  lastActivity = Date.now();
  if (asleep) { e.stopPropagation(); e.preventDefault(); wake(); }
  else if (saverOn) { e.stopPropagation(); e.preventDefault(); stopSaver(); }
}, true);
function sleepScreen() { stopSaver(); asleep = true; lock(); $('#dimmer').style.opacity = 1; api('/api/screen', { on: false }); }
function wake() { asleep = false; lastActivity = Date.now(); setBrightness(S.brightness); api('/api/screen', { on: true }); tick(); restartShimmer(); pollStatus(); }
setInterval(() => {
  if (asleep || !ON_DEVICE || STATUS.native || $('.touchtest') || $('.tm')) return;   // never sleep in the middle of a test
  if (CURRENT && CURRENT.app === APPS.camera) return;
  if ($('.calib')) return;
  const idle = Date.now() - lastActivity;
  if (S.sleepAfter && idle > S.sleepAfter * 1000) return sleepScreen();
  if (S.saverAfter && !saverOn && idle > S.saverAfter * 1000 && (!S.sleepAfter || S.saverAfter < S.sleepAfter)) startSaver();
}, 5000);
api('/api/about').then(a => { ON_DEVICE = !!a.on_device; applySettings(); });

// ============================================================ self-healing
// stray errors get logged and shrugged off; a burst of them reloads the UI cleanly
let errBurst = [];
function onStrayError(e) {
  if (/ResizeObserver loop/.test(String(e && e.message || e))) return; // harmless browser warning
  console.error('[skyglass] recovered from:', e);
  errBurst = [...errBurst.filter(t => Date.now() - t < 10000), Date.now()];
  if (errBurst.length >= 8) { sessionStorage.setItem('sg.reloaded', '1'); location.reload(); }
}
addEventListener('error', e => onStrayError(e.error || e.message));
addEventListener('unhandledrejection', e => { e.preventDefault(); onStrayError(e.reason); });
// tell the backend we're alive; if this stops, its watchdog restarts the UI
setInterval(() => api('/api/heartbeat', {}), 5000);
api('/api/heartbeat', {});

// ============================================================ boot
addEventListener('resize', resizeCanvases);
addEventListener('contextmenu', e => e.preventDefault());
resizeCanvases(); renderHome(); applySettings(); clockLoop();
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
// status: every 6 s while someone looks at the screen, every 30 s while it sleeps
(function statusLoop() { pollStatus(); setTimeout(statusLoop, asleep ? 30000 : 6000); })();
setBrightness(S.brightness);
wallLoop();
eventLoop();
refreshNotifs();
// dev helpers: #home skips the lock screen, #app=<id> opens an app
const devHash = new URLSearchParams(location.hash.slice(1));
if (devHash.has('still')) $('#phone').classList.add('still');
lock();
if (devHash.has('home') || devHash.has('app')) api('/api/about').then(a => {
  if (a.on_device) return; // never skip the PIN on the real phone
  unlock(); if (devHash.get('app')) openApp(devHash.get('app'), devHash.get('page'));
});
console.log('%cSkyglass OS', 'font-size:28px;color:#19a8ff;text-shadow:0 2px 6px #9cf', '\nHi there, explorer. Try the Konami code on the lock screen.');
// after a rotation: "Keep this?" — if touch is broken you can't press Keep, and it goes back by itself
(async function rotationCheck() {
  const r = await api('/api/rotate');
  if (!r.pending) return;
  let left = r.left;
  const msg = h('p', {}, ''), upd = () => (msg.textContent = `Going back to the old rotation in ${left} s…`); upd();
  const iv = setInterval(() => { left--; upd(); if (left <= 0) clearInterval(iv); }, 1000);
  const v = await modal('Keep this screen rotation?', msg, [{ label: 'Undo', value: 'undo' }, { label: 'Keep', primary: true, value: 'keep' }]);
  clearInterval(iv);
  if (v === 'keep') { await api('/api/rotate/confirm', {}); toast('Rotation kept ✔'); }
  else { toast('Going back…'); api('/api/rotate/revert', {}); }
})();
window.SKYGLASS_BOOTED = true;
if (sessionStorage.getItem('sg.reloaded')) { sessionStorage.removeItem('sg.reloaded'); setTimeout(() => toast('Skyglass recovered from a glitch.'), 1500); }
