/* Cloudblocks — a little 3D block sandbox for Skyglass. Original world style: grassy
   islands, sky-glass blocks, clouds you can stand on. WebGL1, no libraries.
   Touch: left stick walks, drag on the right to look, buttons to jump / break / place.
   Keyboard + mouse in the preview: WASD, Space, drag to look, click break, right-click place. */
'use strict';
(() => {
  const SX = 64, SY = 40, SZ = 64, CH = 16;      // world size and chunk width
  const SEA = 12;
  // id: [name, colours, transparent, solid]
  const BLOCKS = [
    null,
    ['Grass', [0.38, 0.78, 0.28], false, true],     // 1
    ['Dirt', [0.55, 0.38, 0.24], false, true],      // 2
    ['Stone', [0.58, 0.6, 0.64], false, true],      // 3
    ['Sand', [0.93, 0.86, 0.6], false, true],       // 4
    ['Log', [0.5, 0.35, 0.2], false, true],         // 5
    ['Leaves', [0.25, 0.62, 0.3], false, true],     // 6
    ['Planks', [0.8, 0.62, 0.38], false, true],     // 7
    ['Sky glass', [0.55, 0.85, 1.0], true, true],   // 8
    ['Cloud', [0.97, 0.98, 1.0], false, true],      // 9
    ['Water', [0.2, 0.5, 0.95], true, false],       // 10
    ['Sunstone', [1.0, 0.85, 0.35], false, true],   // 11
    ['Brick', [0.78, 0.33, 0.27], false, true],     // 12
    ['Bubble', [0.85, 0.6, 1.0], true, true],       // 13
  ];
  const HOTBAR = [1, 2, 3, 4, 5, 7, 8, 9, 11, 12, 13, 6];

  // ---- seeded noise for the terrain
  function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function noise2(seed) {
    const r = rng(seed), P = new Float32Array(256 * 256); for (let i = 0; i < P.length; i++) P[i] = r();
    const v = (x, y) => P[((y & 255) << 8) | (x & 255)];
    const sm = t => t * t * (3 - 2 * t);
    return (x, y) => { const xi = Math.floor(x), yi = Math.floor(y), xf = sm(x - xi), yf = sm(y - yi);
      const a = v(xi, yi), b = v(xi + 1, yi), c = v(xi, yi + 1), d = v(xi + 1, yi + 1);
      return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf; };
  }

  function blocksReal(body) {
    body.style.padding = '0';
    const wrap = document.createElement('div'); wrap.className = 'cb-wrap';
    const cv = document.createElement('canvas'); cv.className = 'cb-canvas';
    const ui = document.createElement('div'); ui.className = 'cb-ui';
    ui.innerHTML = `<div class="cb-cross"></div><div class="cb-info"></div>
      <div class="cb-stick"><i></i></div>
      <div class="cb-btns"><button data-a="break">⛏</button><button data-a="place">▣</button><button data-a="jump" class="big">⤒</button><button data-a="fly" class="small">🕊</button><button data-a="down" class="small">⤓</button></div>
      <div class="cb-bar"></div><div class="cb-top"><button data-a="new">New world</button></div>`;
    wrap.append(cv, ui); body.append(wrap);
    const info = ui.querySelector('.cb-info'), bar = ui.querySelector('.cb-bar'), stick = ui.querySelector('.cb-stick'), knob = stick.querySelector('i');

    const gl = cv.getContext('webgl', { antialias: false, alpha: false });
    if (!gl) { wrap.innerHTML = '<div class="empty"><p>Cloudblocks needs 3D graphics (WebGL), which is off right now (safe mode?).</p></div>'; return; }

    // ---- world data
    let save = JSON.parse(localStorage.getItem('sg.blocks') || 'null');
    if (!save || !save.seed) save = { seed: Math.floor(Math.random() * 1e9), edits: {} };
    const world = new Uint8Array(SX * SY * SZ);
    const I = (x, y, z) => (y * SZ + z) * SX + x;
    const get = (x, y, z) => (x < 0 || z < 0 || x >= SX || z >= SZ || y < 0) ? 3 : y >= SY ? 0 : world[I(x, y, z)];
    function generate() {
      world.fill(0);
      const n1 = noise2(save.seed), n2 = noise2(save.seed + 1), r = rng(save.seed + 2);
      const hmap = [];
      for (let z = 0; z < SZ; z++) for (let x = 0; x < SX; x++) {
        // islands: higher in the middle, sea around the edges
        const dx = (x - SX / 2) / (SX / 2), dz = (z - SZ / 2) / (SZ / 2), edge = Math.min(1, Math.hypot(dx, dz));
        const hgt = Math.floor(SEA - 5 + n1(x / 14, z / 14) * 12 + n2(x / 5, z / 5) * 3 + (1 - edge * edge) * 6);
        hmap[z * SX + x] = hgt;
        for (let y = 0; y <= Math.min(hgt, SY - 1); y++) world[I(x, y, z)] = y < hgt - 3 ? 3 : y < hgt ? 2 : (hgt <= SEA + 1 ? 4 : 1);
        for (let y = hgt + 1; y <= SEA; y++) world[I(x, y, z)] = 10;
      }
      // trees
      for (let i = 0; i < 70; i++) {
        const x = 3 + Math.floor(r() * (SX - 6)), z = 3 + Math.floor(r() * (SZ - 6)), y = hmap[z * SX + x];
        if (world[I(x, y, z)] !== 1) continue;
        const th = 4 + Math.floor(r() * 2);
        for (let k = 1; k <= th; k++) world[I(x, y + k, z)] = 5;
        for (let ly = th - 1; ly <= th + 2; ly++) for (let lx = -2; lx <= 2; lx++) for (let lz = -2; lz <= 2; lz++) {
          if (Math.abs(lx) + Math.abs(lz) + Math.max(0, ly - th) * 1.5 > 3.2) continue;
          const X = x + lx, Y = y + ly, Z = z + lz;
          if (Y < SY && get(X, Y, Z) === 0) world[I(X, Y, Z)] = 6;
        }
      }
      // fluffy clouds you can stand on
      for (let i = 0; i < 9; i++) {
        const cx = Math.floor(r() * SX), cz = Math.floor(r() * SZ), cy = 30 + Math.floor(r() * 6), w = 3 + Math.floor(r() * 4);
        for (let x = -w; x <= w; x++) for (let z = -2; z <= 2; z++) for (let y = 0; y < 2; y++)
          if ((x / w) ** 2 + (z / 2.5) ** 2 + y * .4 < 1 && r() > .15) { const X = cx + x, Z = cz + z; if (X >= 0 && Z >= 0 && X < SX && Z < SZ) world[I(X, cy + y, Z)] = 9; }
      }
      // a sky-glass crystal on the highest hill
      let best = 0; for (let k = 0; k < hmap.length; k++) if (hmap[k] > hmap[best]) best = k;
      const bx = best % SX, bz = Math.floor(best / SX), by = hmap[best];
      for (let y = 1; y <= 6; y++) for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) if (Math.abs(x) + Math.abs(z) <= (y < 5 ? 2 : 0)) { const X = bx + x, Z = bz + z; if (by + y < SY) world[I(X, by + y, Z)] = y === 6 ? 11 : 8; }
      for (const [k, v] of Object.entries(save.edits)) world[+k] = v;
      return hmap;
    }
    let hmap = generate();
    const persist = () => { clearTimeout(persistT); persistT = 0; try { localStorage.setItem('sg.blocks', JSON.stringify(save)); } catch (e) { } };
    // building fast = many edits: write the (growing) world once per burst, not once per block
    let persistT = 0; const persistSoon = () => { if (!persistT) persistT = setTimeout(persist, 1500); };

    // ---- block textures: painted ONCE into a small atlas (16x16 texels per tile) instead of being
    // computed for every pixel of every frame. Tile = block type (column) x face kind & variant (row).
    // 4 variants per face kind give each block its own pixel noise, like the old per-block hash.
    const TILE = 16, VARS = 4, ACOLS = BLOCKS.length, AROWS = 3 * VARS;   // face kinds: 0 top, 1 side, 2 bottom
    function paintAtlas() {
      const W = ACOLS * TILE, H = AROWS * TILE, px = new Uint8Array(W * H * 4);
      const fract = v => v - Math.floor(v), step = (e, v) => (v < e ? 0 : 1);
      const smooth = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
      const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t), mul = (c, k) => c.map(v => v * k);
      for (let t = 1; t < ACOLS; t++) for (let kind = 0; kind < 3; kind++) for (let vr = 0; vr < VARS; vr++) {
        const noise = rng(t * 977 + kind * 131 + vr * 17 + 5), N = Array.from({ length: 64 }, noise);   // 8x8 noise cells
        const top = kind === 0, side = kind === 1;
        for (let j = 0; j < TILE; j++) for (let i = 0; i < TILE; i++) {
          const u = (i + .5) / TILE, v = (j + .5) / TILE, n = N[Math.floor(v * 8) * 8 + Math.floor(u * 8)];
          let c, a = 1;
          if (t === 1) c = (top || (side && v > .78)) ? mul([.36, .78, .27], .85 + n * .25) : mul([.55, .38, .24], .8 + n * .3);
          else if (t === 2) c = mul([.55, .38, .24], .8 + n * .3);
          else if (t === 3) c = mul([.58, .6, .64], .75 + n * .35);
          else if (t === 4) c = mul([.93, .86, .6], .9 + n * .15);
          else if (t === 5) c = top ? mix([.78, .6, .38], [.6, .44, .26], step(.5, fract(Math.hypot(u - .5, v - .5) * 6))) : mul([.45, .31, .18], .75 + .3 * step(.5, fract(u * 4 + n * .3)));
          else if (t === 6) c = mul([.27, .66, .3], .78 + n * .3);
          else if (t === 7) c = mul([.8, .62, .38], (.85 + n * .12) * (fract(v * 4) < .1 ? .7 : 1));
          else if (t === 8) { const edge = step(.88, Math.max(Math.abs(u - .5), Math.abs(v - .5)) * 2), shine = step(Math.abs(u - v + .15), .06);
            c = mix([.55, .85, 1], [1, 1, 1], Math.max(edge * .8, shine * .6)); a = .38 + edge * .5 + shine * .3; }
          else if (t === 9) c = mul([.97, .98, 1], .95 + n * .05);
          else if (t === 10) { c = mul([.2, .52, .95], .9 + n * .1); a = .62; }
          else if (t === 11) c = mul([1, .85, .35], .95 + n * .1);
          else if (t === 12) { const bx = u * 2 + step(.5, fract(v * 2)) * .5, by = v * 4; c = (fract(bx) < .08 || fract(by) < .12) ? [.86, .82, .76] : mul([.78, .33, .27], .85 + n * .2); }
          else if (t === 13) { c = mix([1, 1, 1], [.85, .6, 1], smooth(.05, .35, Math.hypot(u - .35, v - .35))); a = .55; }
          const o = (((kind * VARS + vr) * TILE + j) * W + t * TILE + i) * 4;
          px[o] = Math.min(255, c[0] * 255); px[o + 1] = Math.min(255, c[1] * 255); px[o + 2] = Math.min(255, c[2] * 255); px[o + 3] = Math.min(255, a * 255);
        }
      }
      const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      return tex;
    }
    const atlas = paintAtlas();

    // ---- shaders: one texture fetch per pixel; light and fog are worked out per vertex
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, `
      attribute vec3 p; attribute vec4 uvt; attribute float lt; uniform mat4 mvp; uniform vec3 eye;
      varying vec2 vuv, vtile; varying float vlit, vfog;
      void main() { vuv = uvt.xy; vtile = uvt.zw; vlit = lt * 1.2; vfog = clamp((distance(p, eye) - 22.0) / 30.0, 0.0, 1.0); gl_Position = mvp * vec4(p, 1.0); }`));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, `
      #ifdef GL_FRAGMENT_PRECISION_HIGH
      precision highp float;
      #else
      precision mediump float;
      #endif
      varying vec2 vuv, vtile; varying float vlit, vfog; uniform sampler2D atlas; uniform vec2 inv; uniform vec3 fogc;
      void main() {
        vec4 c = texture2D(atlas, (vtile + clamp(vuv, 0.01, 0.99)) * inv);
        gl_FragColor = vec4(mix(c.rgb * vlit, fogc, vfog), c.a);
      }`));
    gl.linkProgram(prog);
    const A = { p: gl.getAttribLocation(prog, 'p'), uvt: gl.getAttribLocation(prog, 'uvt'), lt: gl.getAttribLocation(prog, 'lt') };
    const U = n => gl.getUniformLocation(prog, n);
    const lineProg = gl.createProgram();
    gl.attachShader(lineProg, sh(gl.VERTEX_SHADER, 'attribute vec3 p; uniform mat4 mvp; void main() { gl_Position = mvp * vec4(p, 1.0); }'));
    gl.attachShader(lineProg, sh(gl.FRAGMENT_SHADER, 'precision mediump float; void main() { gl_FragColor = vec4(0.05, 0.1, 0.2, 1.0); }'));
    gl.linkProgram(lineProg);
    const lineBuf = gl.createBuffer();
    const skyProg = gl.createProgram();
    gl.attachShader(skyProg, sh(gl.VERTEX_SHADER, 'attribute vec2 q; varying float vy; void main() { vy = q.y; gl_Position = vec4(q, 0.999, 1.0); }'));
    gl.attachShader(skyProg, sh(gl.FRAGMENT_SHADER, `precision mediump float; varying float vy; uniform float pitch; uniform vec3 horizon, zenith;
      void main() { float e = pitch + vy * 0.62; gl_FragColor = vec4(mix(horizon, zenith, smoothstep(-0.05, 0.9, e)), 1.0); }`));
    gl.linkProgram(skyProg);
    const UL = { mvp: U('mvp'), eye: U('eye'), fogc: U('fogc'), atlas: U('atlas'), inv: U('inv'),
      sPitch: gl.getUniformLocation(skyProg, 'pitch'), sHor: gl.getUniformLocation(skyProg, 'horizon'), sZen: gl.getUniformLocation(skyProg, 'zenith'),
      sq: gl.getAttribLocation(skyProg, 'q'), lMvp: gl.getUniformLocation(lineProg, 'mvp'), lp: gl.getAttribLocation(lineProg, 'p') };
    const skyBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, skyBuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);

    // ---- meshing: one opaque + one see-through buffer per 16x16 chunk, hidden faces skipped
    const FACES = [ // normal, 4 corners, shade
      [[0, 1, 0], [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]], 1.0],
      [[0, -1, 0], [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], 0.5],
      [[1, 0, 0], [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]], 0.8],
      [[-1, 0, 0], [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]], 0.8],
      [[0, 0, 1], [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]], 0.65],
      [[0, 0, -1], [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]], 0.65],
    ];
    const UVS = [[0, 0], [0, 1], [1, 1], [1, 0]];
    const NCX = SX / CH, NCZ = SZ / CH;
    const occ = (x, y, z) => { if (x < 0 || z < 0 || x >= SX || z >= SZ || y < 0 || y >= SY) return 0; const b = world[I(x, y, z)]; return b && !BLOCKS[b][2] ? 1 : 0; };
    // Vertex: position (3 floats) + u, v, tile column, tile row (4 bytes) + light (1 byte, padded) = 20 bytes.
    // A face is 4 vertices shared through one index buffer (was 6 vertices of 32 bytes).
    const STRIDE = 20, QMAX = 16384;   // a draw call covers at most 16384 quads = 65536 vertices (16-bit indices)
    const quadIdx = new Uint16Array(QMAX * 6);
    for (let q = 0; q < QMAX; q++) quadIdx.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3], q * 6);
    const ibuf = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibuf); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, quadIdx, gl.STATIC_DRAW);
    const chunks = Array.from({ length: NCX * NCZ }, () => ({ o: gl.createBuffer(), on: 0, t: gl.createBuffer(), tn: 0, dirty: true, y0: 0, y1: SY }));
    // growable vertex store, reused by every rebuild (no garbage, no frame hitches)
    const mkStore = () => ({ buf: new ArrayBuffer(STRIDE * 4 * 4096), n: 0 });
    const stores = [mkStore(), mkStore()];
    function quadSlot(st) {
      if ((st.n + 1) * 4 * STRIDE > st.buf.byteLength) { const nb = new ArrayBuffer(st.buf.byteLength * 2); new Uint8Array(nb).set(new Uint8Array(st.buf)); st.buf = nb; }
      return st.n++ * 4 * STRIDE;
    }
    const aoTable = [0.55, 0.7, 0.85, 1];
    function buildChunk(ci) {
      const cx = (ci % NCX) * CH, cz = Math.floor(ci / NCX) * CH, op = stores[0], tr = stores[1];
      op.n = tr.n = 0; let y0 = SY, y1 = 0;
      for (let y = 0; y < SY; y++) for (let z = cz; z < cz + CH; z++) for (let x = cx; x < cx + CH; x++) {
        const b = world[I(x, y, z)]; if (!b) continue;
        const see = BLOCKS[b][2], st = see ? tr : op;
        for (let f = 0; f < 6; f++) {
          const [n, corners, shade] = FACES[f];
          const nb = get(x + n[0], y + n[1], z + n[2]);
          if (nb && (nb === b || !BLOCKS[nb][2])) continue;          // hidden behind a solid or same see-through block
          if (y < y0) y0 = y; if (y + 1 > y1) y1 = y + 1;
          const kind = f === 0 ? 0 : f === 1 ? 2 : 1;
          const row = kind * VARS + (((x * 73856093) ^ (y * 19349663) ^ (z * 83492791) ^ (f * 2654435)) >>> 0) % VARS;
          const ax = n[0] ? [1, 2] : n[1] ? [0, 2] : [0, 1];
          const off = quadSlot(st), F = new Float32Array(st.buf, off, 20), B = new Uint8Array(st.buf, off, 80);
          for (let k = 0; k < 4; k++) {
            const c = corners[k];
            let ao = 1;
            if (!see) {   // soft shadows in corners: the 3 blocks around each corner, just outside the face
              const L0 = x + n[0], L1 = y + n[1], L2 = z + n[2], d1 = [0, 0, 0], d2 = [0, 0, 0];
              d1[ax[0]] = c[ax[0]] ? 1 : -1; d2[ax[1]] = c[ax[1]] ? 1 : -1;
              const s1 = occ(L0 + d1[0], L1 + d1[1], L2 + d1[2]), s2 = occ(L0 + d2[0], L1 + d2[1], L2 + d2[2]);
              const cr = occ(L0 + d1[0] + d2[0], L1 + d1[1] + d2[1], L2 + d1[2] + d2[2]);
              ao = aoTable[s1 && s2 ? 0 : 3 - s1 - s2 - cr];
            }
            const o = k * 5;   // 5 floats (20 bytes) per vertex
            F[o] = x + c[0]; F[o + 1] = y + c[1] - (b === 10 && n[1] === 1 ? .12 : 0); F[o + 2] = z + c[2];
            const bo = k * STRIDE + 12;
            B[bo] = UVS[k][0]; B[bo + 1] = UVS[k][1]; B[bo + 2] = b; B[bo + 3] = row;
            B[bo + 4] = Math.round(Math.min(1, (b === 11 ? 1.15 : shade * ao) / 1.2) * 255);
          }
        }
      }
      const ch = chunks[ci];
      gl.bindBuffer(gl.ARRAY_BUFFER, ch.o); gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(op.buf, 0, op.n * 4 * STRIDE), gl.STATIC_DRAW); ch.on = op.n;
      gl.bindBuffer(gl.ARRAY_BUFFER, ch.t); gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(tr.buf, 0, tr.n * 4 * STRIDE), gl.STATIC_DRAW); ch.tn = tr.n;
      ch.y0 = y0; ch.y1 = Math.max(y0, y1); ch.dirty = false;
    }
    const markDirty = (x, z) => {
      for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const X = x + dx, Z = z + dz; if (X < 0 || Z < 0 || X >= SX || Z >= SZ) continue;
        chunks[Math.floor(Z / CH) * NCX + Math.floor(X / CH)].dirty = true;
      }
    };
    function setBlock(x, y, z, b) {
      if (x < 0 || z < 0 || x >= SX || z >= SZ || y < 0 || y >= SY) return;
      world[I(x, y, z)] = b; save.edits[I(x, y, z)] = b; markDirty(x, z); persistSoon(); wake();
    }

    // ---- player
    const P = { x: SX / 2 + .5, y: 0, z: SZ / 2 + .5, vx: 0, vy: 0, vz: 0, yaw: Math.PI * .75, pitch: -.15, ground: false, fly: false };
    const topY = (x, z) => { let y = SY - 1; while (y > 0 && !get(x, y, z)) y--; return y; };
    const spawnPlayer = () => {
      // spiral out from the middle until we find grass with open sky above
      for (let r = 0; r < SX / 2; r++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const x = SX / 2 + dx, z = SZ / 2 + dz, y = topY(x, z);
        let clear = get(x, y, z) === 1;
        for (let k = -2; k <= 2 && clear; k++) for (let j = -2; j <= 2 && clear; j++) { const b = get(x + k, topY(x + k, z + j), z + j); if (b === 5 || b === 6) clear = false; }
        if (clear) { P.x = x + .5; P.z = z + .5; P.y = y + 1.01; P.vy = 0; return; }
      }
      const y = topY(Math.floor(P.x), Math.floor(P.z)); P.y = y + 1.01; P.vy = 0;
    };
    if (save.player) Object.assign(P, save.player); else spawnPlayer();
    const solidAt = (x, y, z) => { const b = get(Math.floor(x), Math.floor(y), Math.floor(z)); return b && BLOCKS[b][3]; };
    const collides = (x, y, z) => { const r = .3; for (const dx of [-r, r]) for (const dz of [-r, r]) for (const dy of [0, .9, 1.75]) if (solidAt(x + dx, y + dy, z + dz)) return true; return false; };
    const inWater = () => get(Math.floor(P.x), Math.floor(P.y + .5), Math.floor(P.z)) === 10;

    // ---- input
    const input = { mx: 0, mz: 0, jump: false, down: false };
    let selected = 0;
    HOTBAR.forEach((b, i) => {
      const btn = document.createElement('button'); btn.className = 'cb-slot' + (i === 0 ? ' on' : ''); btn.title = BLOCKS[b][0];
      const c = BLOCKS[b][1]; btn.style.background = `linear-gradient(180deg, rgb(${c.map(v => Math.min(255, v * 290)).join(',')}), rgb(${c.map(v => v * 200).join(',')}))`;
      if (BLOCKS[b][2]) btn.style.opacity = .8;
      btn.onclick = () => { selected = i; bar.querySelectorAll('.cb-slot').forEach((s, k) => s.classList.toggle('on', k === i)); toastName(BLOCKS[b][0]); };
      bar.append(btn);
    });
    let nameTimer = 0;
    const toastName = n => { info.textContent = n; clearTimeout(nameTimer); nameTimer = setTimeout(() => (info.textContent = ''), 1200); };
    // left stick
    let stickId = null, sx0 = 0, sy0 = 0;
    stick.addEventListener('pointerdown', e => { stickId = e.pointerId; stick.setPointerCapture(e.pointerId); const r = stick.getBoundingClientRect(); sx0 = r.left + r.width / 2; sy0 = r.top + r.height / 2; moveStick(e); });
    const moveStick = e => {
      if (e.pointerId !== stickId) return;
      const r = stick.getBoundingClientRect(), max = r.width * .38;
      let dx = e.clientX - sx0, dy = e.clientY - sy0; const l = Math.hypot(dx, dy); if (l > max) { dx *= max / l; dy *= max / l; }
      knob.style.transform = `translate(${dx / r.width * 100}%, ${dy / r.height * 100}%)`;
      input.mx = dx / max; input.mz = dy / max;
    };
    stick.addEventListener('pointermove', moveStick);
    const endStick = e => { if (e.pointerId !== stickId) return; stickId = null; input.mx = input.mz = 0; knob.style.transform = ''; };
    stick.addEventListener('pointerup', endStick); stick.addEventListener('pointercancel', endStick);
    // look: drag anywhere on the 3D view
    const looks = new Map();
    cv.addEventListener('pointerdown', e => { cv.setPointerCapture(e.pointerId); looks.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0, button: e.button }); });
    cv.addEventListener('pointermove', e => {
      const l = looks.get(e.pointerId); if (!l) return;
      const k = 0.0055;   // radians per pixel of drag
      P.yaw -= (e.clientX - l.x) * k; P.pitch = Math.max(-1.55, Math.min(1.55, P.pitch - (e.clientY - l.y) * k));
      l.moved += Math.abs(e.clientX - l.x) + Math.abs(e.clientY - l.y); l.x = e.clientX; l.y = e.clientY;
    });
    cv.addEventListener('pointerup', e => {
      const l = looks.get(e.pointerId); looks.delete(e.pointerId);
      if (l && l.moved < 8 && performance.now() - l.t < 300 && e.pointerType === 'mouse') act(l.button === 2 ? 'place' : 'break');
    });
    cv.addEventListener('contextmenu', e => e.preventDefault());
    const btns = ui.querySelector('.cb-btns');
    btns.addEventListener('pointerdown', e => {
      const b = e.target.closest('button'); if (!b) return; e.preventDefault();
      const a = b.dataset.a;
      if (a === 'jump') input.jump = true; else if (a === 'down') input.down = true;
      else if (a === 'fly') { P.fly = !P.fly; P.vy = 0; b.classList.toggle('on', P.fly); toastName(P.fly ? 'Flying 🕊' : 'Walking'); }
      else act(a);
    });
    const btnUp = e => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.a === 'jump') input.jump = false; if (b.dataset.a === 'down') input.down = false; };
    btns.addEventListener('pointerup', btnUp); btns.addEventListener('pointercancel', btnUp); btns.addEventListener('pointerleave', () => { input.jump = input.down = false; });
    ui.querySelector('[data-a=new]').onclick = () => {
      save = { seed: Math.floor(Math.random() * 1e9), edits: {} }; hmap = generate(); chunks.forEach(c => (c.dirty = true));
      P.x = SX / 2 + .5; P.z = SZ / 2 + .5; spawnPlayer(); persist(); toastName('A brand new world ✨');
    };
    const keys = {};
    const kd = e => { if (!body.isConnected) return; keys[e.key.toLowerCase()] = true; if (e.key === ' ') { input.jump = true; e.preventDefault(); } if (/^[1-9]$/.test(e.key)) bar.children[+e.key - 1].click(); if (e.key === 'f') btns.querySelector('[data-a=fly]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); };
    const ku = e => { keys[e.key.toLowerCase()] = false; if (e.key === ' ') input.jump = false; };
    // focus lost while a key was held (no keyup will come): stop walking instead of walking forever
    const unstick = () => { for (const k in keys) keys[k] = false; input.jump = input.down = false; };
    addEventListener('keydown', kd); addEventListener('keyup', ku); addEventListener('blur', unstick);

    // ---- looking at blocks: step through the grid along the view ray (DDA)
    const look = () => [Math.cos(P.pitch) * -Math.sin(P.yaw), Math.sin(P.pitch), Math.cos(P.pitch) * -Math.cos(P.yaw)];
    function raycast() {
      const o = [P.x, P.y + 1.6, P.z], d = look();
      let p = o.map(Math.floor); const step = d.map(Math.sign), tD = d.map(v => Math.abs(1 / (v || 1e-9)));
      let tM = d.map((v, i) => v > 0 ? (p[i] + 1 - o[i]) * tD[i] : (o[i] - p[i]) * tD[i]);
      let prev = null;
      for (let i = 0; i < 40; i++) {
        const b = get(p[0], p[1], p[2]);
        if (b && b !== 10 && p[1] >= 0) return { hit: p, prev };
        prev = [...p];
        const k = tM[0] < tM[1] ? (tM[0] < tM[2] ? 0 : 2) : (tM[1] < tM[2] ? 1 : 2);
        if (tM[k] > 6) return null;
        p[k] += step[k]; tM[k] += tD[k];
      }
      return null;
    }
    function act(a) {
      const r = raycast(); if (!r) return;
      if (a === 'break') {
        const [x, y, z] = r.hit; if (y <= 0) return;
        const water = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]].some(([dx, dy, dz]) => get(x + dx, y + dy, z + dz) === 10);
        setBlock(x, y, z, water && y <= SEA ? 10 : 0); if (window.tone) tone('click');
      } else if (a === 'place' && r.prev) {
        const [x, y, z] = r.prev, b = HOTBAR[selected];
        // don't build inside yourself
        if (BLOCKS[b][3] && x === Math.floor(P.x) && z === Math.floor(P.z) && (y === Math.floor(P.y) || y === Math.floor(P.y + 1))) return;
        setBlock(x, y, z, b); if (window.tone) tone('pop');
      }
    }

    // ---- matrices
    const persp = (fov, asp, n, f) => { const t = 1 / Math.tan(fov / 2); return [t / asp, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, 2 * f * n / (n - f), 0]; };
    const mul = (a, b) => { const o = new Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; };
    const rx = a => [1, 0, 0, 0, 0, Math.cos(a), Math.sin(a), 0, 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 0, 1];
    const ry = a => [Math.cos(a), 0, -Math.sin(a), 0, 0, 1, 0, 0, Math.sin(a), 0, Math.cos(a), 0, 0, 0, 0, 1];
    const tr = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

    // ---- main loop
    // Power: the world is static, so a frame is only drawn when something visible changed (camera,
    // blocks, size). Standing still costs (almost) nothing; with no input at all the loop also slows
    // to 10 checks a second until a touch or key wakes it. Chunks outside the view are not drawn.
    let raf = 0, tmo = 0, last = 0, frames = 0, fpsT = 0, saveT = 0, idleSince = 0, lastKey = '', lastPlayer = '', closed = false;
    const mvpF = new Float32Array(16), lineF = new Float32Array(72), planes = Array.from({ length: 6 }, () => [0, 0, 0, 0]);
    const outline = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    function physics(dt) {
      let fx = input.mx, fz = input.mz;
      if (keys.w) fz -= 1; if (keys.s) fz += 1; if (keys.a) fx -= 1; if (keys.d) fx += 1;
      const l = Math.hypot(fx, fz); if (l > 1) { fx /= l; fz /= l; }
      const sp = P.fly ? 9 : inWater() ? 2.6 : 4.4, sy = Math.sin(P.yaw), cy = Math.cos(P.yaw);
      const wx = (fx * cy + fz * sy) * sp, wz = (-fx * sy + fz * cy) * sp;
      if (P.fly) P.vy = (input.jump ? 6 : 0) - (input.down ? 6 : 0);
      else if (inWater()) { P.vy = Math.max(-3, P.vy - 9 * dt); if (input.jump) P.vy = 3.2; }
      else { P.vy = Math.max(-30, P.vy - 26 * dt); if (input.jump && P.ground) { P.vy = 8.6; P.ground = false; } }
      const nx = P.x + wx * dt; if (!collides(nx, P.y, P.z)) P.x = nx;
      const nz = P.z + wz * dt; if (!collides(P.x, P.y, nz)) P.z = nz;
      const ny = P.y + P.vy * dt;
      if (!collides(P.x, ny, P.z)) { P.y = ny; P.ground = false; }
      else { if (P.vy < 0) { P.ground = true; P.y = Math.floor(P.y) + .001; } P.vy = 0; }
      if (P.y < -10) { spawnPlayer(); }
      P.x = Math.max(.4, Math.min(SX - .4, P.x)); P.z = Math.max(.4, Math.min(SZ - .4, P.z));
    }
    // view frustum planes from the (column-major) matrix; a chunk box fully outside one plane is skipped
    function setPlanes(m) {
      for (let i = 0; i < 6; i++) {
        const r = i >> 1, sg = i & 1 ? -1 : 1, pl = planes[i];
        for (let c = 0; c < 4; c++) pl[c] = m[c * 4 + 3] + sg * m[c * 4 + r];
      }
    }
    function visible(x0, y0, z0, x1, y1, z1) {
      for (const p of planes) if (p[0] * (p[0] > 0 ? x1 : x0) + p[1] * (p[1] > 0 ? y1 : y0) + p[2] * (p[2] > 0 ? z1 : z0) + p[3] < 0) return false;
      return true;
    }
    const covered = () => { const ph = document.getElementById('phone');
      return document.hidden || (ph && ph.classList.contains('locked')) || (typeof asleep !== 'undefined' && asleep) || !body.isConnected; };
    const busyInput = () => stickId !== null || looks.size > 0 || input.jump || input.down || keys.w || keys.a || keys.s || keys.d;
    function schedule(slow) {
      if (closed || raf || tmo) return;
      if (slow) tmo = setTimeout(() => { tmo = 0; raf = requestAnimationFrame(frame); }, 100);
      else raf = requestAnimationFrame(frame);
    }
    function wake() { if (tmo) { clearTimeout(tmo); tmo = 0; } schedule(false); }
    function frame(t) {
      raf = 0;
      if (covered()) { last = 0; lastKey = ''; return schedule(true); }      // behind the lock screen / asleep: just check back
      const dt = Math.min(.05, (t - (last || t)) / 1000); last = t;
      physics(dt);
      const k = (typeof ON_DEVICE !== 'undefined' && ON_DEVICE) ? .6 : .8; // render smaller and let the screen scale it up: much faster on the Pi
      const w = Math.max(1, Math.round(cssW * k)), hh = Math.max(1, Math.round(cssH * k));
      let changed = false;
      if (cv.width !== w || cv.height !== hh) { cv.width = w; cv.height = hh; changed = true; }
      let built = 0; for (let i = 0; i < chunks.length && built < 3; i++) if (chunks[i].dirty) { buildChunk(i); built++; }
      const underwater = get(Math.floor(P.x), Math.floor(P.y + 1.6), Math.floor(P.z)) === 10;
      const key = `${P.x.toFixed(3)},${P.y.toFixed(3)},${P.z.toFixed(3)},${P.yaw.toFixed(4)},${P.pitch.toFixed(4)}`;
      if (built || changed || key !== lastKey) { lastKey = key; draw(underwater, w, hh); frames++; idleSince = 0; }
      else if (!idleSince) idleSince = t;
      wrap.classList.toggle('under', underwater);
      if (t - fpsT > 1000) { if (frames) wrap.dataset.fps = frames; wrap.classList.toggle('idle', !frames); frames = 0; fpsT = t; }
      if (t - saveT > 5000) {
        saveT = t; const pl = { x: P.x, y: P.y, z: P.z, yaw: P.yaw, pitch: P.pitch, fly: P.fly }, js = JSON.stringify(pl);
        if (js !== lastPlayer) { lastPlayer = js; save.player = pl; persistSoon(); }
      }
      schedule(idleSince && t - idleSince > 600 && !busyInput());
    }
    function draw(underwater, w, hh) {
      const fogc = underwater ? [0.1, 0.3, 0.6] : [0.62, 0.84, 1.0];
      gl.viewport(0, 0, w, hh); gl.clear(gl.DEPTH_BUFFER_BIT);   // the sky quad below covers every pixel
      const eye = [P.x, P.y + 1.6, P.z];
      const mvp = mul(persp(1.25, w / hh, .08, 120), mul(rx(-P.pitch), mul(ry(-P.yaw), tr(-eye[0], -eye[1], -eye[2]))));
      mvpF.set(mvp); setPlanes(mvp);
      // sky
      gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.BLEND); gl.useProgram(skyProg);
      gl.uniform1f(UL.sPitch, P.pitch); gl.uniform3fv(UL.sHor, fogc); gl.uniform3fv(UL.sZen, underwater ? [0.03, 0.12, 0.3] : [0.16, 0.48, 0.92]);
      gl.disableVertexAttribArray(A.uvt); gl.disableVertexAttribArray(A.lt);
      gl.bindBuffer(gl.ARRAY_BUFFER, skyBuf); gl.enableVertexAttribArray(UL.sq); gl.vertexAttribPointer(UL.sq, 2, gl.FLOAT, false, 0, 0); gl.drawArrays(gl.TRIANGLES, 0, 6);
      // blocks
      gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); gl.frontFace(gl.CCW);
      gl.useProgram(prog);
      gl.uniformMatrix4fv(UL.mvp, false, mvpF); gl.uniform3fv(UL.eye, eye); gl.uniform3fv(UL.fogc, fogc);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, atlas); gl.uniform1i(UL.atlas, 0); gl.uniform2f(UL.inv, 1 / ACOLS, 1 / AROWS);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibuf);
      gl.enableVertexAttribArray(A.p); gl.enableVertexAttribArray(A.uvt); gl.enableVertexAttribArray(A.lt);
      const drawQuads = (buf, n) => {
        if (!n) return; gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        for (let q0 = 0; q0 < n; q0 += QMAX) {   // 16-bit indices: big buffers go in slices of 16384 quads
          const off = q0 * 4 * STRIDE;
          gl.vertexAttribPointer(A.p, 3, gl.FLOAT, false, STRIDE, off);
          gl.vertexAttribPointer(A.uvt, 4, gl.UNSIGNED_BYTE, false, STRIDE, off + 12);
          gl.vertexAttribPointer(A.lt, 1, gl.UNSIGNED_BYTE, true, STRIDE, off + 16);
          gl.drawElements(gl.TRIANGLES, Math.min(QMAX, n - q0) * 6, gl.UNSIGNED_SHORT, 0);
        }
      };
      const shown = chunks.map((c, i) => c.on + c.tn > 0 && visible((i % NCX) * CH, c.y0, Math.floor(i / NCX) * CH, (i % NCX) * CH + CH, c.y1, Math.floor(i / NCX) * CH + CH));
      chunks.forEach((c, i) => shown[i] && drawQuads(c.o, c.on));
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false); gl.disable(gl.CULL_FACE);
      chunks.forEach((c, i) => shown[i] && drawQuads(c.t, c.tn));
      gl.depthMask(true); gl.disable(gl.BLEND);
      // outline the block you're looking at
      const hit = raycast();
      if (hit) {
        const [x, y, z] = hit.hit, e = .003;
        const v = [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1], [0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]].map(c => c.map((k, i) => [x, y, z][i] + (k ? 1 + e : -e)));
        outline.forEach(([a1, b1], i) => { lineF.set(v[a1], i * 6); lineF.set(v[b1], i * 6 + 3); });
        gl.useProgram(lineProg); gl.uniformMatrix4fv(UL.lMvp, false, mvpF);
        gl.disableVertexAttribArray(A.uvt); gl.disableVertexAttribArray(A.lt);
        gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf); gl.bufferData(gl.ARRAY_BUFFER, lineF, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(UL.lp); gl.vertexAttribPointer(UL.lp, 3, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.LINES, 0, 24);
      }
    }
    // canvas size from a ResizeObserver: reading layout every frame can force a relayout
    let cssW = wrap.clientWidth || 600, cssH = wrap.clientHeight || 800;
    const ro = new ResizeObserver(() => { cssW = wrap.clientWidth || cssW; cssH = wrap.clientHeight || cssH; wake(); }); ro.observe(wrap);
    // any touch or key wakes a sleeping loop at once
    for (const ev of ['pointerdown', 'pointermove', 'wheel']) wrap.addEventListener(ev, wake, { passive: true });
    const kw = () => body.isConnected && wake(); addEventListener('keydown', kw);
    gl.clearColor(0.62, 0.84, 1.0, 1);
    schedule(false);
    toastName('Cloudblocks — build anything!');
    return () => {
      closed = true; cancelAnimationFrame(raf); clearTimeout(tmo); ro.disconnect();
      removeEventListener('keydown', kd); removeEventListener('keyup', ku); removeEventListener('keydown', kw); removeEventListener('blur', unstick);
      save.player = { x: P.x, y: P.y, z: P.z, yaw: P.yaw, pitch: P.pitch, fly: P.fly }; persist();
      const ext = gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext();
    };
  }
  GAMES.blocksReal = blocksReal;
})();
