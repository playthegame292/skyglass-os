/* Bubble Hop — a little Skyglass platformer. Hop across three sky worlds as Blip the
   bubble: collect droplets, bounce on springs, stomp the spiky urchins, reach the ring.
   Touch: ◀ ▶ on the left, ⤒ jump on the right. Keyboard: arrows / A D + Space. */
'use strict';
(() => {
  // . air  # ground  = cloud (jump up through it)  ^ spikes  o droplet  E urchin  S spring
  // C checkpoint  P start  F finish ring
  const LEVELS = [
    { name: 'Meadow Skies', sky: ['#5cc3ff', '#d9f3ff'], rows: [
      '................................................................................................',
      '................................................................................................',
      '................................................................................................',
      '............................ooo.......................................................o.o.....',
      '...........................=====..................ooo.................................=====....',
      '..................o.o..........................................ooo.............................F',
      '.................=====.......................=====.............=====..........................#',
      '..........ooo...............o.o.o....................................................ooo.....###',
      '.........=====.............=======.............................C.....................===....####',
      '.P................E....................E.........^^....E....#####.....E.....S...............#####',
      '#########...###########...#############...##################...#############....###....#########',
      '#########...###########...#############...##################...#############....###....#########',
    ] },
    { name: 'Cloud Steps', sky: ['#7ab6ff', '#f3e6ff'], rows: [
      '................................................................................................................',
      '..........................................ooo...................................................................',
      '.........................................=====...........................ooo....................................',
      '...................................o.................o.o...............=====................ooo..........o.....',
      '..................................===...............=====..............................=====..............===...F',
      '...........................o..............................................o.o.................................#',
      '..........................===.........................................C..=====...................o.o.........##',
      '..................o.o..........................ooo.................=======..................=====.........====##',
      '...............=======.......................=====............................................................#',
      '.P......S.................E..........................E....^^..............E.........S.....E.....^^^.......E....#',
      '#############..........###########....#########...######################...######......############...#########',
      '#############..........###########....#########...######################...######......############...#########',
    ] },
    { name: 'Urchin Reef', sky: ['#3f8fd8', '#a8f0ff'], rows: [
      '..............................................................................................................................',
      '...........................................................ooo..........................................................ooo..',
      '..........................................................=====..................................o.o...................=====.',
      '.............................ooo......................................................ooo........=====.......................',
      '............................=====.............o.o.............................S......=====...............................F',
      '...................................................=====..............ooo..........................................ooo.....#',
      '.........o.o.................................=====...........................=====.........C.........................=====.##',
      '........=====..........................................................................=======..........................###',
      '...................E.....................................^^^...........................................E........^^.......###',
      '.P.........................S......E.....E......................E.......E.........................E.....................####',
      '##########...######....################...########..#################...#######..#######..##############...##############',
      '##########...######....################...########..#################...#######..#######..##############...##############',
    ] },
  ];

  const G = 62, JUMP = 21.5, RUN = 7.2, ACC = 60, FRICTION = 40, SPRING = 30;

  function hopReal(body) {
    body.style.padding = '0';
    const cv = document.createElement('canvas');
    cv.className = 'hop-canvas';
    const hud = document.createElement('div'); hud.className = 'hop-hud';
    const over = document.createElement('div'); over.className = 'gp-over';
    const ctrls = document.createElement('div'); ctrls.className = 'hop-ctrls';
    ctrls.innerHTML = '<button data-c="L">◀</button><button data-c="R">▶</button><span></span><button data-c="J" class="j">⤒</button>';
    const wrap = document.createElement('div'); wrap.className = 'hop-wrap';
    wrap.append(cv, hud, ctrls, over); body.append(wrap);

    const keys = { L: false, R: false, J: false };
    const pointerKeys = new Map();
    ctrls.addEventListener('pointerdown', e => {
      const b = e.target.closest('button'); if (!b) return;
      e.preventDefault(); b.setPointerCapture(e.pointerId); pointerKeys.set(e.pointerId, b.dataset.c); keys[b.dataset.c] = true;
      if (b.dataset.c === 'J') jumpPressed = true;
    });
    const release = e => { const k = pointerKeys.get(e.pointerId); if (k) { keys[k] = [...pointerKeys.entries()].some(([id, v]) => v === k && id !== e.pointerId); pointerKeys.delete(e.pointerId); } };
    ctrls.addEventListener('pointerup', release); ctrls.addEventListener('pointercancel', release);
    const keyMap = { ArrowLeft: 'L', a: 'L', A: 'L', ArrowRight: 'R', d: 'R', D: 'R', ' ': 'J', ArrowUp: 'J', w: 'J', W: 'J' };
    const kd = e => { const k = keyMap[e.key]; if (!k || !body.isConnected) return; e.preventDefault(); if (k === 'J' && !keys.J) jumpPressed = true; keys[k] = true; };
    const ku = e => { const k = keyMap[e.key]; if (k) keys[k] = false; };
    addEventListener('keydown', kd); addEventListener('keyup', ku);

    let W = 0, H = 0, T = 40, ctx = null, raf = 0, last = 0;
    let level = 0, map = [], cols = 0, rows = 0, ents = [], drops = 0, totalDrops = 0, deaths = 0, startTime = 0, runTime = 0, playing = false;
    let p, spawn, camX = 0, jumpPressed = false, coyote = 0, jumpBuf = 0, particles = [];

    const tile = (c, r) => (r < 0 || c < 0 || c >= cols) ? '.' : r >= rows ? '.' : map[r][c];
    const solid = (c, r) => tile(c, r) === '#';

    function loadLevel(n) {
      level = n;
      const L = LEVELS[n];
      rows = L.rows.length; cols = Math.max(...L.rows.map(r => r.length));
      map = L.rows.map(r => r.padEnd(cols, '.').split(''));
      ents = []; drops = 0; totalDrops = 0;
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const ch = map[r][c];
        if (ch === 'P') { spawn = { x: c + .5, y: r + 1 }; map[r][c] = '.'; }
        else if (ch === 'E') {
          let y = r + 1; while (y < rows && L.rows[y] && L.rows[y][c] !== '#' && L.rows[y][c] !== '=') y++; // urchins stand on the ground
          ents.push({ t: 'urchin', x: c + .5, y, vx: -1.6, alive: true }); map[r][c] = '.';
        }
        else if (ch === 'o') totalDrops++;
      }
      respawn(true);
      showBanner(L.name, `World ${n + 1} of ${LEVELS.length}`);
    }
    function respawn(fresh) {
      p = { x: spawn.x, y: spawn.y, vx: 0, vy: 0, w: .7, h: .78, onGround: false, face: 1, squash: 0, dead: 0 };
      if (fresh) camX = 0;
    }
    function showBanner(title, sub) {
      const b = document.createElement('div'); b.className = 'hop-banner'; b.innerHTML = `<b>${title}</b><span>${sub}</span>`;
      wrap.append(b); setTimeout(() => b.remove(), 2200);
    }
    function burst(x, y, color, n = 10) {
      for (let i = 0; i < n; i++) particles.push({ x, y, vx: (Math.random() - .5) * 8, vy: -Math.random() * 8, life: 1, color });
    }
    function die() {
      if (p.dead) return;
      p.dead = 1; deaths++; burst(p.x, p.y - .4, '#bfe8ff', 18);
      if (window.tone) tone('pop');
    }

    // ---- physics: move on one axis, then resolve against solid tiles
    function moveX(dt) {
      p.x += p.vx * dt;
      const top = Math.floor(p.y - p.h + .02), bot = Math.floor(p.y - .02);
      if (p.vx > 0) { const c = Math.floor(p.x + p.w / 2); for (let r = top; r <= bot; r++) if (solid(c, r)) { p.x = c - p.w / 2 - .001; p.vx = 0; } }
      if (p.vx < 0) { const c = Math.floor(p.x - p.w / 2); for (let r = top; r <= bot; r++) if (solid(c, r)) { p.x = c + 1 + p.w / 2 + .001; p.vx = 0; } }
    }
    function moveY(dt) {
      const prevBottom = p.y;
      p.y += p.vy * dt; p.onGround = false;
      const left = Math.floor(p.x - p.w / 2 + .02), right = Math.floor(p.x + p.w / 2 - .02);
      if (p.vy > 0) {
        const r = Math.floor(p.y);
        for (let c = left; c <= right; c++) {
          const t = tile(c, r);
          if (t === '#' || (t === '=' && prevBottom <= r + .01)) { p.y = r; if (p.vy > 12) p.squash = .25; p.vy = 0; p.onGround = true; }
          if (t === 'S' && prevBottom <= r + .3) { p.y = r; p.vy = -SPRING; burst(c + .5, r, '#ffd34a', 8); if (window.tone) tone('click'); }
        }
      } else if (p.vy < 0) {
        const r = Math.floor(p.y - p.h);
        for (let c = left; c <= right; c++) if (solid(c, r)) { p.y = r + 1 + p.h; p.vy = 0; }
      }
    }
    function update(dt) {
      if (!playing) return;
      runTime = (performance.now() - startTime) / 1000;
      if (p.dead) {
        p.dead += dt;
        if (p.dead > .8) respawn(false);
      } else {
        const dir = (keys.R ? 1 : 0) - (keys.L ? 1 : 0);
        if (dir) { p.vx += dir * ACC * dt; p.face = dir; } else { const f = FRICTION * dt; p.vx = Math.abs(p.vx) < f ? 0 : p.vx - Math.sign(p.vx) * f; }
        p.vx = Math.max(-RUN, Math.min(RUN, p.vx));
        coyote = p.onGround ? .1 : coyote - dt;
        if (jumpPressed) jumpBuf = .12; jumpPressed = false; jumpBuf -= dt;
        if (jumpBuf > 0 && coyote > 0) { p.vy = -JUMP; coyote = 0; jumpBuf = 0; p.squash = -.2; if (window.tone) tone('click'); }
        if (!keys.J && p.vy < -8) p.vy += G * 1.4 * dt; // short hop when you let go early
        p.vy = Math.min(26, p.vy + G * dt);
        moveX(dt); moveY(dt);
        p.squash *= .85;
        // tiles you touch
        for (let r = Math.floor(p.y - p.h); r <= Math.floor(p.y - .01); r++) for (let c = Math.floor(p.x - p.w / 2); c <= Math.floor(p.x + p.w / 2); c++) {
          const t = tile(c, r);
          if (t === 'o') { map[r][c] = '.'; drops++; burst(c + .5, r + .5, '#7fd8ff', 6); if (window.tone) tone('pop'); }
          else if (t === '^' && p.y - r > .45) die();
          else if (t === 'C') { map[r][c] = 'c'; spawn = { x: c + .5, y: r + 1 }; burst(c + .5, r + .5, '#7dff9a', 12); showBanner('Checkpoint!', 'You will come back here'); }
          else if (t === 'F') return finish();
        }
        if (p.y - p.h > rows + 1) die();
        // urchins
        for (const e of ents) {
          if (!e.alive) continue;
          if (Math.abs(p.x - e.x) < .75 && Math.abs((p.y - p.h / 2) - (e.y - .4)) < .75) {
            if (p.vy > 2 && p.y < e.y - .25) { e.alive = false; p.vy = -JUMP * .7; burst(e.x, e.y - .4, '#c58bff', 14); if (window.tone) tone('pop'); }
            else die();
          }
        }
      }
      for (const e of ents) {
        if (!e.alive) continue;
        const nx = e.x + e.vx * dt, ahead = Math.floor(nx + Math.sign(e.vx) * .45);
        if (solid(ahead, Math.floor(e.y - .5)) || !solid(ahead, Math.floor(e.y + .1)) && tile(ahead, Math.floor(e.y + .1)) !== '=') e.vx *= -1; else e.x = nx;
      }
      particles = particles.filter(q => { q.x += q.vx * dt; q.y += q.vy * dt; q.vy += 20 * dt; q.life -= dt * 1.6; return q.life > 0; });
      const target = p.x - W / T * .4;
      camX += (Math.max(0, Math.min(cols - W / T, target)) - camX) * Math.min(1, dt * 8);
    }
    function finish() {
      playing = false;
      burst(p.x, p.y - .5, '#ffd34a', 30);
      if (window.tone) tone('chime');
      if (level + 1 < LEVELS.length) {
        setTimeout(() => { loadLevel(level + 1); playing = true; }, 1200);
        showBanner('World clear! 🎉', `${drops}/${totalDrops} droplets`);
        return;
      }
      const secs = Math.round(runTime);
      const best = JSON.parse(localStorage.getItem('sg.best') || '{}');
      const nb = !best.hop || secs < best.hop; if (nb) { best.hop = secs; localStorage.setItem('sg.best', JSON.stringify(best)); }
      over.innerHTML = `<div class="gp-big">You did it! 🫧</div><p>All ${LEVELS.length} worlds in ${secs}s with ${deaths} pops.${nb ? '<br>🏆 New best time!' : ''}${deaths === 0 ? '<br>✨ Flawless — not a single pop!' : ''}</p><button class="btn primary">Play again</button>`;
      over.classList.remove('hidden');
      over.querySelector('button').onclick = start;
    }
    function start() {
      over.classList.add('hidden'); deaths = 0; loadLevel(0); startTime = performance.now(); playing = true;
    }

    // ---- drawing
    function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
    function draw(t) {
      const L = LEVELS[level];
      const sky = ctx.createLinearGradient(0, 0, 0, H); sky.addColorStop(0, L.sky[0]); sky.addColorStop(1, L.sky[1]);
      ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
      // parallax hills + clouds
      for (let layer = 0; layer < 2; layer++) {
        const k = layer ? .5 : .25, y0 = H * (layer ? .78 : .7);
        ctx.fillStyle = layer ? 'rgba(90,200,120,.55)' : 'rgba(150,220,255,.6)';
        ctx.beginPath(); ctx.moveTo(0, H);
        for (let x = 0; x <= W; x += 16) { const wx = x + camX * T * k; ctx.lineTo(x, y0 + Math.sin(wx / (layer ? 140 : 230)) * 30 + Math.sin(wx / 61) * 8); }
        ctx.lineTo(W, H); ctx.fill();
      }
      for (let i = 0; i < 6; i++) {
        const x = ((i * 260 - camX * T * .15) % (W + 300) + W + 300) % (W + 300) - 150, y = 40 + (i * 53) % 160;
        ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.beginPath(); ctx.ellipse(x, y, 60, 20, 0, 0, 7); ctx.ellipse(x + 35, y - 12, 38, 22, 0, 0, 7); ctx.fill();
      }
      ctx.save(); ctx.translate(-Math.round(camX * T), 0);
      const c0 = Math.max(0, Math.floor(camX) - 1), c1 = Math.min(cols, Math.ceil(camX + W / T) + 1);
      for (let r = 0; r < rows; r++) for (let c = c0; c < c1; c++) {
        const ch = map[r][c], x = c * T, y = r * T;
        if (ch === '#') {
          const g = ctx.createLinearGradient(0, y, 0, y + T); g.addColorStop(0, '#b98a5a'); g.addColorStop(1, '#8a5f38');
          ctx.fillStyle = g; ctx.fillRect(x, y, T + 1, T + 1);
          if (tile(c, r - 1) !== '#') {
            const gg = ctx.createLinearGradient(0, y, 0, y + T * .35); gg.addColorStop(0, '#9dff7a'); gg.addColorStop(1, '#3fb83a');
            ctx.fillStyle = gg; roundRect(x - 1, y, T + 2, T * .35, 6); ctx.fill();
            ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.fillRect(x, y + 2, T, 3);
          }
        } else if (ch === '=') {
          const g = ctx.createLinearGradient(0, y, 0, y + T * .5); g.addColorStop(0, '#ffffff'); g.addColorStop(1, '#cfe9ff');
          ctx.fillStyle = g; roundRect(x + 1, y + 2, T - 2, T * .45, T * .22); ctx.fill();
        } else if (ch === '^') {
          ctx.fillStyle = '#c7d3e0';
          for (let k = 0; k < 3; k++) { ctx.beginPath(); ctx.moveTo(x + k * T / 3, y + T); ctx.lineTo(x + (k + .5) * T / 3, y + T * .45); ctx.lineTo(x + (k + 1) * T / 3, y + T); ctx.fill(); }
        } else if (ch === 'o') {
          const bob = Math.sin(t / 300 + c) * T * .06, cx = x + T / 2, cy = y + T / 2 + bob;
          const g = ctx.createRadialGradient(cx - T * .08, cy - T * .1, 1, cx, cy, T * .22); g.addColorStop(0, '#fff'); g.addColorStop(.4, '#7fd8ff'); g.addColorStop(1, '#1a8cff');
          ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(cx, cy - T * .3); ctx.quadraticCurveTo(cx + T * .22, cy, cx, cy + T * .2); ctx.quadraticCurveTo(cx - T * .22, cy, cx, cy - T * .3); ctx.fill();
        } else if (ch === 'S') {
          ctx.fillStyle = '#ff9a1c'; roundRect(x + T * .1, y + T * .55, T * .8, T * .45, 6); ctx.fill();
          ctx.fillStyle = '#ffd34a'; roundRect(x + T * .05, y + T * .45, T * .9, T * .16, 5); ctx.fill();
        } else if (ch === 'C' || ch === 'c') {
          ctx.fillStyle = '#e6eef5'; ctx.fillRect(x + T * .45, y, T * .1, T);
          ctx.fillStyle = ch === 'c' ? '#3fd16a' : '#ff5a3c';
          ctx.beginPath(); ctx.moveTo(x + T * .55, y + T * .05); ctx.lineTo(x + T * .95, y + T * .22); ctx.lineTo(x + T * .55, y + T * .4); ctx.fill();
        } else if (ch === 'F') {
          ctx.save(); ctx.translate(x + T / 2, y + T * .1); ctx.rotate(t / 900);
          for (let k = 0; k < 7; k++) { ctx.strokeStyle = `hsl(${k * 50 + t / 10},90%,65%)`; ctx.lineWidth = T * .12; ctx.beginPath(); ctx.arc(0, 0, T * .75, k * .9, k * .9 + .8); ctx.stroke(); }
          ctx.restore();
        }
      }
      // urchins
      for (const e of ents) {
        if (!e.alive) continue;
        const cx = e.x * T, cy = (e.y - .38) * T, r = T * .32;
        ctx.strokeStyle = '#5a2a8a'; ctx.lineWidth = 3;
        for (let k = 0; k < 12; k++) { const a = k / 12 * 6.28 + t / 400; ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); ctx.lineTo(cx + Math.cos(a) * r * 1.55, cy + Math.sin(a) * r * 1.55); ctx.stroke(); }
        const g = ctx.createRadialGradient(cx - r * .3, cy - r * .3, 1, cx, cy, r); g.addColorStop(0, '#e6c2ff'); g.addColorStop(1, '#7a3fc0');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(cx - r * .3 * Math.sign(-e.vx || 1), cy - r * .1, r * .22, 0, 7); ctx.fill();
      }
      // Blip
      if (!p.dead) {
        const cx = p.x * T, r = T * .4, sq = p.squash, rx = r * (1 + sq), ry = r * (1 - sq), cy = p.y * T - ry;
        const g = ctx.createRadialGradient(cx - rx * .35, cy - ry * .4, r * .05, cx, cy, r);
        g.addColorStop(0, 'rgba(255,255,255,.98)'); g.addColorStop(.3, 'rgba(170,225,255,.75)'); g.addColorStop(.9, 'rgba(40,140,240,.85)'); g.addColorStop(1, 'rgba(255,255,255,.9)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, 7); ctx.fill();
        ctx.fillStyle = '#0b2a4a';
        const blink = (t % 3200) < 120 ? .15 : 1;
        for (const ex of [-.18, .18]) { ctx.beginPath(); ctx.ellipse(cx + (ex + p.face * .14) * r * 1.4, cy - ry * .05, r * .09, r * .16 * blink, 0, 0, 7); ctx.fill(); }
      }
      for (const q of particles) { ctx.globalAlpha = Math.max(0, q.life); ctx.fillStyle = q.color; ctx.beginPath(); ctx.arc(q.x * T, q.y * T, T * .09, 0, 7); ctx.fill(); }
      ctx.globalAlpha = 1; ctx.restore();
      hud.textContent = playing || p ? `💧 ${drops}/${totalDrops}    ⏱ ${Math.floor(runTime)}s    🫧 ${deaths}` : '';
    }
    function loop(t) {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(.033, (t - (last || t)) / 1000); last = t;
      // two physics steps per frame keeps fast falls from skipping through floors
      update(dt / 2); update(dt / 2);
      draw(t);
    }
    requestAnimationFrame(() => {
      const r = cv.getBoundingClientRect();
      W = cv.width = Math.round(r.width); H = cv.height = Math.round(r.height);
      T = Math.floor(H / 12.5); ctx = cv.getContext('2d');
      loadLevel(0);
      over.innerHTML = '<div class="gp-big">🫧 Bubble Hop</div><p>Help Blip hop across 3 sky worlds. Collect droplets, bounce on springs and stomp the urchins from above. Watch out for spikes!</p><button class="btn primary">Start</button>';
      over.querySelector('button').onclick = start;
      raf = requestAnimationFrame(loop);
    });
    return () => { cancelAnimationFrame(raf); removeEventListener('keydown', kd); removeEventListener('keyup', ku); };
  }
  GAMES.hopReal = hopReal; // GAMES is a global from app.js
})();
