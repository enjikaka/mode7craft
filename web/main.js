// Mode7craft front-end: WebGPU renderer + input. World + game logic live in g.wasm.
const $ = (s) => document.querySelector(s);
const cv = $('#c'), hint = $('#h');
const fail = (m) => { $('#e').textContent = m; $('#e').style.display = 'flex'; };
const wasmP = WebAssembly.instantiateStreaming(fetch('g.wasm'), { env: { msin: Math.sin, mcos: Math.cos, msqrt: Math.sqrt } });
(async () => {
  if (!navigator.gpu) return fail('WebGPU is not available in this browser. Try Chrome/Edge 113+, Safari 26+ (iOS 26), or enable WebGPU in your browser flags.');
  const ad = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!ad) return fail('WebGPU is supported but no GPU adapter was found.');
  const dev = await ad.requestDevice();
  dev.addEventListener('uncapturederror', (e) => console.error(e.error.message));
  dev.lost.then((i) => fail('GPU device lost: ' + i.message));
  const { instance } = await wasmP; const X = instance.exports;
  X.gen(1337);
  const mem = () => X.memory.buffer;
  const N = 128, NZ = 16;
  const qs = new URLSearchParams(location.search);
  // ---------- saved edits (localStorage diff: base36 index + block id) ----------
  const KEY = 'm7c-edits-1', edits = new Map();
  if (qs.has('reset')) localStorage.removeItem(KEY);
  for (const e of (localStorage.getItem(KEY) || '').split(',')) {
    if (!e) continue; const i = parseInt(e.slice(0, -1), 36), id = +e.slice(-1);
    edits.set(i, id); X.set_block(i % N, (i / N | 0) % N, i / (N * N) | 0, id);
  }
  let saveT = 0;
  const save = () => { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem(KEY, [...edits].map(([i, id]) => i.toString(36) + id).join(',')); } catch {} }, 400); };

  const ctx = cv.getContext('webgpu'), fmt = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device: dev, format: fmt, alphaMode: 'opaque' });
  const T = GPUTextureUsage;
  const vox = dev.createTexture({ size: [N, N, NZ], dimension: '3d', format: 'r8uint', usage: T.TEXTURE_BINDING | T.COPY_DST });
  const hm = dev.createTexture({ size: [N, N], format: 'r8uint', usage: T.TEXTURE_BINDING | T.COPY_DST });
  dev.queue.writeTexture({ texture: vox }, new Uint8Array(mem(), X.world_ptr(), N * N * NZ), { bytesPerRow: N, rowsPerImage: N }, [N, N, NZ]);
  dev.queue.writeTexture({ texture: hm }, new Uint8Array(mem(), X.height_ptr(), N * N), { bytesPerRow: N }, [N, N]);
  // partial upload: only the touched voxel + its heightmap texel
  const touch1 = (x, y, z, id) => {
    dev.queue.writeTexture({ texture: vox, origin: [x, y, z] }, new Uint8Array([id]), {}, [1, 1, 1]);
    dev.queue.writeTexture({ texture: hm, origin: [x, y] }, new Uint8Array(mem(), X.height_ptr() + y * N + x, 1), {}, [1, 1]);
    edits.set((z * N + y) * N + x, id); save();
  };
  const ub = dev.createBuffer({ size: 320, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const bb = dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const mk = (code, f) => { const m = dev.createShaderModule({ code }); m.getCompilationInfo?.().then((i) => i.messages.forEach((x) => console.warn(x.type, x.lineNum, x.message))); return dev.createRenderPipeline({ layout: 'auto', vertex: { module: m, entryPoint: 'vs' }, fragment: { module: m, entryPoint: 'fs', targets: [{ format: f }] } }); };
  const scene = mk(SCENE_WGSL, 'rgba8unorm'), blit = mk(BLIT_WGSL, fmt);
  let rt, sg, bg, W = 0, H = 0, px = 1, iw = 0, ih = 0, AREA = 115000, cross = 0;
  const resize = () => {
    const d = Math.min(devicePixelRatio || 1, 3);
    W = Math.max(1, Math.round(innerWidth * d)); H = Math.max(1, Math.round(innerHeight * d));
    cv.width = W; cv.height = H;
    px = Math.max(1, Math.round(Math.sqrt(W * H / AREA)));
    iw = Math.ceil(W / px); ih = Math.ceil(H / px);
    rt?.destroy();
    rt = dev.createTexture({ size: [iw, ih], format: 'rgba8unorm', usage: T.RENDER_ATTACHMENT | T.TEXTURE_BINDING });
    sg = dev.createBindGroup({ layout: scene.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ub } }, { binding: 1, resource: vox.createView() }, { binding: 2, resource: hm.createView() }] });
    bg = dev.createBindGroup({ layout: blit.getBindGroupLayout(0), entries: [{ binding: 0, resource: rt.createView() }, { binding: 1, resource: { buffer: bb } }] });
    dev.queue.writeBuffer(bb, 0, new Float32Array([px, cross, 0, 0]));
  };
  addEventListener('resize', resize); resize();

  // ---------- camera + views ----------
  // views cycle: chase -> first person -> top-down
  const VIEWS = [
    { name: 'chase', pitch: 0.62, tan: 0.27, dist: 30, fog: 1, lo: 0.3, hi: 1.45 },
    { name: 'first person', pitch: 0.08, tan: 0.62, dist: 0, fog: 1, lo: -1.45, hi: 1.45, fps: 1 },
    { name: 'top-down', pitch: 1.2, tan: 0.13, dist: 105, fog: 0, lo: 0.3, hi: 1.45 }];
  let view = (+qs.get('v') || 0) % 3, yaw = Math.PI / 2 + (+qs.get('r') || 0), pitch = VIEWS[view].pitch, zoom = +qs.get('z') || 1, cz = 0, mode = 'kb', run = false;
  const cam = { o: [0, 0, 0], F: [1, 0, 0], R: [0, 1, 0], Up: [0, 0, 1], tan: 0.3 };
  const keys = new Set();

  // ---------- hotbar + block editing ----------
  const BLOCKS = [[1, 'grass', '#6ab234'], [2, 'dirt', '#8a5a34'], [4, 'stone', '#959e9e'], [3, 'sand', '#d6c983'], [5, 'birch', '#ebe7dc'], [6, 'leaves', '#86b83a'], [7, 'planks', '#b8915a']];
  let slot = 0, placeMode = false;
  const hb = $('#hb');
  hb.innerHTML = BLOCKS.map(([, n, c], i) => `<i data-s="${i}" title="${n}" style="background:${c}">${i + 1}</i>`).join('');
  const setSlot = (i) => { slot = (i + BLOCKS.length) % BLOCKS.length; [...hb.children].forEach((e, j) => e.classList.toggle('on', j === slot)); };
  setSlot(0);
  hb.addEventListener('pointerdown', (e) => { const s = e.target.dataset.s; if (s != null) { setSlot(+s); e.preventDefault(); e.stopPropagation(); } });
  const REACH = 6, P = new Int32Array(mem(), X.pick_ptr(), 6), st = new Float32Array(mem(), X.state_ptr(), 16);
  const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
  // ray from the camera through a screen point (client px); null = crosshair/centre
  const screenRay = (cx, cy) => {
    const ax = iw / ih, ux = cx == null ? 0 : (cx / innerWidth) * 2 - 1, uy = cy == null ? 0 : (cy / innerHeight) * 2 - 1;
    const nx = ux * ax * cam.tan, ny = -uy * cam.tan;
    return norm([0, 1, 2].map((k) => cam.F[k] + cam.R[k] * nx + cam.Up[k] * ny));
  };
  // targeting: returns {b:[x,y,z], n:[nx,ny,nz]} within reach of the player, or null
  const target = (how, cx, cy) => {
    let o, d, md;
    if (how === 'front') { o = [st[0], st[1], st[2] + 1.4]; d = norm([st[4], st[5], -0.75]); md = 4.5; }
    else { o = cam.o; d = screenRay(cx, cy); md = VIEWS[view].fps ? REACH : 400; }
    if (!X.pick(o[0], o[1], o[2], d[0], d[1], d[2], md)) return null;
    const b = [P[0], P[1], P[2]], n = [P[3], P[4], P[5]];
    if (Math.hypot(b[0] + 0.5 - st[0], b[1] + 0.5 - st[1], b[2] + 0.5 - st[2] - 1.4) > REACH) return null;
    return { b, n };
  };
  // break particles (simulated here, drawn as tiny analytic cubes in the shader)
  const parts = []; let partId = 1;
  const act = (t, place) => {
    if (!t) return;
    const [x, y, z] = t.b;
    if (place) {
      const id = BLOCKS[slot][0], q = [x + t.n[0], y + t.n[1], z + t.n[2]];
      if (X.place_block(q[0], q[1], q[2], id)) touch1(q[0], q[1], q[2], id);
    } else {
      const old = X.break_block(x, y, z);
      if (!old) return;
      touch1(x, y, z, 0); partId = old; parts.length = 0;
      for (let i = 0; i < 8; i++) parts.push({ p: [x + 0.5, y + 0.5, z + 0.5], v: [(Math.random() - 0.5) * 5, (Math.random() - 0.5) * 5, Math.random() * 5 + 2], life: 0.55 + Math.random() * 0.25 });
    }
  };
  let aim = 'pointer', ptr = null, hl = null;

  // ---------- hints ----------
  const HINTS = {
    kb: (f) => f ? 'WASD move \u00b7 click: lock mouse \u00b7 LMB break \u00b7 RMB place \u00b7 1-7/wheel block \u00b7 space jump \u00b7 V view'
      : 'WASD move \u00b7 drag: look \u00b7 click break \u00b7 right-click place \u00b7 X/C break/place ahead \u00b7 1-7 block \u00b7 wheel zoom \u00b7 V view',
    pad: (f) => `L-stick move \u00b7 R-stick look \u00b7 RT break \u00b7 LT place \u00b7 D-pad \u2190\u2192 block${f ? '' : ' \u00b7 LB/RB zoom'} \u00b7 A jump \u00b7 Y view`,
    touch: (f) => f ? 'stick move \u00b7 drag look \u00b7 tap / \u25cf: ' + (placeMode ? 'place' : 'break') + ' \u00b7 hold: place \u00b7 VIEW' : 'stick move \u00b7 drag look \u00b7 tap block: ' + (placeMode ? 'place' : 'break') + ' \u00b7 hold: place \u00b7 pinch zoom',
  };
  const setHint = () => {
    hint.textContent = `[${VIEWS[view].name}] ` + HINTS[mode](VIEWS[view].fps);
    $('#a').style.display = VIEWS[view].fps ? 'flex' : 'none'; $('#m').textContent = placeMode ? 'PLACE' : 'BREAK';
  };
  const setMode = (m) => { if (m === mode) return; mode = m; setHint(); $('#t').style.display = m === 'touch' ? 'block' : 'none'; };
  setHint();
  const toggleView = () => {
    view = (view + 1) % 3; pitch = VIEWS[view].pitch; setHint();
    if (!VIEWS[view].fps && document.pointerLockElement) document.exitPointerLock();
  };

  // ---------- keyboard + mouse ----------
  let jumpQ = false;
  addEventListener('keydown', (e) => {
    setMode('kb'); keys.add(e.code);
    if (e.repeat) return;
    if (e.code === 'KeyV') toggleView();
    if (e.code === 'Space') { jumpQ = true; e.preventDefault(); }
    if (e.code >= 'Digit1' && e.code <= 'Digit7') setSlot(+e.code.slice(5) - 1);
    if (e.code === 'KeyX' || e.code === 'KeyC') act(VIEWS[view].fps ? target('center') : target('front'), e.code === 'KeyC');
  });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());
  const look = (dx, dy) => { yaw -= dx; pitch = Math.min(VIEWS[view].hi, Math.max(VIEWS[view].lo, pitch + dy)); };
  const locked = () => document.pointerLockElement === cv;
  let down = null;
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  cv.addEventListener('mousedown', (e) => {
    setMode('kb');
    if (VIEWS[view].fps) {
      if (!locked()) cv.requestPointerLock?.();
      else act(target('center'), e.button === 2);
    } else down = { x: e.clientX, y: e.clientY, b: e.button, drag: false };
  });
  addEventListener('mouseup', (e) => {
    if (down && !down.drag && !locked()) act(target('pointer', e.clientX, e.clientY), down.b === 2);
    down = null;
  });
  addEventListener('mousemove', (e) => {
    if (locked()) { look(e.movementX * 0.004, e.movementY * 0.003); aim = 'center'; return; }
    ptr = [e.clientX, e.clientY]; aim = 'pointer';
    if (down && (down.drag || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5)) { down.drag = true; look(e.movementX * 0.004, e.movementY * 0.003); }
  });
  addEventListener('wheel', (e) => {
    if (VIEWS[view].fps) setSlot(slot + Math.sign(e.deltaY));
    else zoom = Math.min(2.6, Math.max(0.45, zoom * Math.exp(e.deltaY * 0.001)));
    e.preventDefault();
  }, { passive: false });

  // ---------- touch ----------
  const stick = { id: null, ox: 0, oy: 0, x: 0, y: 0 }, looks = new Map(); let pinch = 0;
  const knob = $('#k'), base = $('#b');
  const tapAct = (x, y, place) => act(VIEWS[view].fps ? target('center') : target('pointer', x, y), place);
  const tstart = (e) => {
    setMode('touch');
    for (const t of e.changedTouches) {
      if (t.clientX < innerWidth * 0.45 && stick.id === null) {
        Object.assign(stick, { id: t.identifier, ox: t.clientX, oy: t.clientY, x: 0, y: 0 });
        base.style.cssText = `display:block;left:${t.clientX}px;top:${t.clientY}px`; knob.style.transform = '';
      } else {
        const L = { x: t.clientX, y: t.clientY, sx: t.clientX, sy: t.clientY, t: performance.now(), moved: false, done: false };
        // long-press = place
        L.timer = setTimeout(() => { if (!L.moved && looks.size === 1) { L.done = true; tapAct(L.sx, L.sy, true); } }, 450);
        looks.set(t.identifier, L);
      }
    }
    e.preventDefault();
  };
  const tmove = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === stick.id) {
        let dx = t.clientX - stick.ox, dy = t.clientY - stick.oy; const l = Math.hypot(dx, dy), R = 50;
        if (l > R) { dx *= R / l; dy *= R / l; }
        stick.x = dx / R; stick.y = -dy / R; knob.style.transform = `translate(${dx}px,${dy}px)`;
      } else if (looks.has(t.identifier)) {
        const p = looks.get(t.identifier);
        if (Math.hypot(t.clientX - p.sx, t.clientY - p.sy) > 10) p.moved = true;
        if (looks.size === 1 && p.moved) look((t.clientX - p.x) * 0.008, (t.clientY - p.y) * 0.006);
        p.x = t.clientX; p.y = t.clientY;
      }
    }
    if (looks.size === 2) {
      const [a, b] = [...looks.values()]; a.moved = b.moved = true; const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch && !VIEWS[view].fps) zoom = Math.min(2.6, Math.max(0.45, zoom * pinch / d)); pinch = d;
    } else pinch = 0;
    e.preventDefault();
  };
  const tend = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === stick.id) { stick.id = null; stick.x = stick.y = 0; base.style.display = 'none'; }
      const L = looks.get(t.identifier);
      if (L) { clearTimeout(L.timer); if (!L.moved && !L.done && performance.now() - L.t < 450) tapAct(L.sx, L.sy, placeMode); }
      looks.delete(t.identifier);
    }
    pinch = 0;
  };
  cv.addEventListener('touchstart', tstart, { passive: false });
  addEventListener('touchmove', tmove, { passive: false });
  addEventListener('touchend', tend); addEventListener('touchcancel', tend);
  const btn = (id, f) => $(id).addEventListener('touchstart', (e) => { f(); e.preventDefault(); e.stopPropagation(); }, { passive: false });
  btn('#j', () => (jumpQ = true)); btn('#v', toggleView);
  btn('#m', () => { placeMode = !placeMode; setHint(); });
  btn('#a', () => act(target('center'), placeMode));
  if (matchMedia('(pointer: coarse)').matches) setMode('touch');
  const prevBtn = []; let trig = [0, 0];
  const dz = (v) => (Math.abs(v) < 0.15 ? 0 : (v - Math.sign(v) * 0.15) / 0.85);

  // ---------- frame ----------
  const U = new Float32Array(80);
  let last = performance.now(), acc = 0, frames = 0, slow = 0;
  // debug: ?p=x,y teleport, ?t=seconds time offset, ?pt=pitch
  if (qs.get('p')) { const [x, y] = qs.get('p').split(',').map(Number); const hm8 = new Uint8Array(mem(), X.height_ptr(), N * N); st[0] = x + 0.5; st[1] = y + 0.5; st[2] = hm8[y * N + x] + 2; }
  if (qs.get('pt')) pitch = +qs.get('pt');
  const t0 = +qs.get('t') || 0;
  cz = st[2];
  window.m7 = { act, target, setSlot, X, edits, save, get view() { return view; } }; // handy for tests
  const frame = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    let mx = 0, my = 0, jump = jumpQ; jumpQ = false;
    run = keys.has('ShiftLeft') || keys.has('ShiftRight');
    mx += (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
    my += (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
    if (keys.has('KeyQ')) yaw += 2.2 * dt; if (keys.has('KeyE')) yaw -= 2.2 * dt;
    if (keys.has('KeyR')) look(0, -1.2 * dt); if (keys.has('KeyF')) look(0, 1.2 * dt);
    if (keys.has('Equal') || keys.has('NumpadAdd')) zoom = Math.max(0.45, zoom * (1 - dt)); if (keys.has('Minus') || keys.has('NumpadSubtract')) zoom = Math.min(2.6, zoom * (1 + dt));
    for (const g of navigator.getGamepads?.() || []) {
      if (!g || !g.connected) continue;
      const a = g.axes, b = (i) => g.buttons[i]?.pressed, v = (i) => g.buttons[i]?.value || 0;
      const lx = dz(a[0] || 0), ly = dz(a[1] || 0), rx = dz(a[2] || 0), ry = dz(a[3] || 0);
      if (lx || ly || rx || ry || g.buttons.some((x) => x.pressed)) { setMode('pad'); aim = VIEWS[view].fps ? 'center' : 'front'; }
      mx += lx; my -= ly; look(rx * 2.6 * dt, ry * 1.6 * dt);
      if (b(0) && !prevBtn[0]) jump = true;
      if (b(3) && !prevBtn[3]) toggleView();
      if (b(1) || b(10)) run = true;
      // LB/RB zoom, D-pad left/right hotbar, RT break / LT place (auto-repeat while held)
      zoom = Math.min(2.6, Math.max(0.45, zoom * (1 + ((b(4) ? 1 : 0) - (b(5) ? 1 : 0)) * dt * 1.5)));
      if (b(14) && !prevBtn[14]) setSlot(slot - 1); if (b(15) && !prevBtn[15]) setSlot(slot + 1);
      for (const [k, bi, pl] of [[0, 7, false], [1, 6, true]]) {
        if (v(bi) > 0.5) { if ((trig[k] -= dt) <= 0) { act(target(VIEWS[view].fps ? 'center' : 'front'), pl); trig[k] = 0.25; } } else trig[k] = 0;
      }
      for (let i = 0; i < 16; i++) prevBtn[i] = b(i);
      break;
    }
    mx += stick.x; my += stick.y;
    if (Math.hypot(stick.x, stick.y) > 0.95) run = true;
    if (mx || my) { if (mode === 'kb' && !ptr) aim = 'front'; }
    X.step(dt, mx, my, yaw, (jump ? 1 : 0) | (run ? 2 : 0));
    cz += (st[2] - cz) * Math.min(1, dt * 10);
    // camera orbiting the player (Mode 7 style); first person = eye height, dist 0
    const V = VIEWS[view], dist = V.dist * zoom;
    const cp = Math.cos(pitch), sp = Math.sin(pitch), fx = Math.cos(yaw), fy = Math.sin(yaw);
    const F = [fx * cp, fy * cp, -sp], R = [fy, -fx, 0], Up = [R[1] * F[2] - R[2] * F[1], R[2] * F[0] - R[0] * F[2], R[0] * F[1] - R[1] * F[0]];
    const tx = st[0], ty = st[1], tz = cz + (V.fps ? 1.55 : 0.9);
    const tanV = V.tan * Math.max(1, (ih / iw) * (V.fps ? 0.6 : 0.8));
    const far = V.fps ? 64 : V.fog ? dist * 3.2 : dist * 6;
    Object.assign(cam, { o: [tx - F[0] * dist, ty - F[1] * dist, tz - F[2] * dist], F, R, Up, tan: tanV });
    // highlight target: crosshair in FPS, pointer (mouse) or block in front (pad/keys/touch) elsewhere
    hl = V.fps ? target('center') : aim === 'pointer' && ptr && mode === 'kb' ? target('pointer', ptr[0], ptr[1]) : mode === 'touch' ? null : target('front');
    // particles
    for (const q of parts) { q.life -= dt; q.v[2] -= 18 * dt; for (let k = 0; k < 3; k++) q.p[k] += q.v[k] * dt; }
    while (parts.length && parts[parts.length - 1].life <= 0) parts.pop();
    U.fill(0);
    U.set([iw, ih, now / 1000 + t0, tanV, ...cam.o, V.fog, ...F, far, ...R, iw / ih, ...Up, 0, st[0], st[1], st[2], 0, st[4], st[5], st[6], st[7], V.fps ? 1 : 0, 0, 0, 0]);
    if (hl) U.set([...hl.b, 1], 32);
    if (parts.length) { U.set([partId, 1], 36); parts.forEach((q, i) => U.set([...q.p, q.life > 0 ? 0.07 + 0.08 * Math.min(1, q.life * 2) : 0], 40 + i * 4)); }
    if ((V.fps | 0) !== cross) { cross = V.fps | 0; dev.queue.writeBuffer(bb, 0, new Float32Array([px, cross, 0, 0])); }
    dev.queue.writeBuffer(ub, 0, U);
    const enc = dev.createCommandEncoder();
    let p = enc.beginRenderPass({ colorAttachments: [{ view: rt.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
    p.setPipeline(scene); p.setBindGroup(0, sg); p.draw(3); p.end();
    p = enc.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
    p.setPipeline(blit); p.setBindGroup(0, bg); p.draw(3); p.end();
    dev.queue.submit([enc.finish()]);
    // adaptive resolution: drop internal pixels if we can't hold ~45fps
    acc += dt; frames++;
    if (acc > 1) { if (acc / frames > 0.022 && AREA > 45000) { if (++slow >= 2) { AREA *= 0.75; resize(); slow = 0; } } else slow = 0; acc = 0; frames = 0; }
    requestAnimationFrame(frame);
  };
  $('#l').remove();
  requestAnimationFrame(frame);
})().catch((e) => fail('Failed to start: ' + e.message));
