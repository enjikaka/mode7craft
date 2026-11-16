// Mode7craft front-end: WebGPU renderer + input. Game logic lives in g.wasm.
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
  const ctx = cv.getContext('webgpu'), fmt = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device: dev, format: fmt, alphaMode: 'opaque' });
  const T = GPUTextureUsage;
  const vox = dev.createTexture({ size: [N, N, NZ], dimension: '3d', format: 'r8uint', usage: T.TEXTURE_BINDING | T.COPY_DST });
  const hm = dev.createTexture({ size: [N, N], format: 'r8uint', usage: T.TEXTURE_BINDING | T.COPY_DST });
  const upload = () => {
    dev.queue.writeTexture({ texture: vox }, new Uint8Array(mem(), X.world_ptr(), N * N * NZ), { bytesPerRow: N, rowsPerImage: N }, [N, N, NZ]);
    dev.queue.writeTexture({ texture: hm }, new Uint8Array(mem(), X.height_ptr(), N * N), { bytesPerRow: N }, [N, N]);
  };
  upload();
  const ub = dev.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
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

  // ---------- camera + input ----------
  // views cycle: chase -> first person -> top-down
  const VIEWS = [
    { name: 'chase', pitch: 0.62, tan: 0.27, dist: 30, fog: 1, lo: 0.3, hi: 1.45 },
    { name: 'first person', pitch: 0.08, tan: 0.62, dist: 0, fog: 1, lo: -1.45, hi: 1.45, fps: 1 },
    { name: 'top-down', pitch: 1.2, tan: 0.13, dist: 105, fog: 0, lo: 0.3, hi: 1.45 }];
  const qs = new URLSearchParams(location.search);
  let view = (+qs.get('v') || 0) % 3, yaw = Math.PI / 2 + (+qs.get('r') || 0), pitch = VIEWS[view].pitch, zoom = +qs.get('z') || 1, cz = 0, mode = 'kb', run = false;
  const keys = new Set();
  const HINTS = {
    kb: (f) => `WASD move \u00b7 click + mouse look \u00b7 ${f ? '' : 'Q/E turn \u00b7 wheel zoom \u00b7 '}space jump \u00b7 shift run \u00b7 V view`,
    pad: (f) => `L-stick move \u00b7 R-stick look \u00b7 A jump \u00b7 B run \u00b7 Y view${f ? '' : ' \u00b7 LT/RT zoom \u00b7 LB/RB turn'}`,
    touch: (f) => `left: move \u00b7 drag right: look${f ? '' : ' \u00b7 pinch: zoom'} \u00b7 VIEW: switch`,
  };
  const setHint = () => { hint.textContent = `[${VIEWS[view].name}] ` + HINTS[mode](VIEWS[view].fps); };
  const setMode = (m) => { if (m === mode) return; mode = m; setHint(); $('#t').style.display = m === 'touch' ? 'block' : 'none'; };
  setHint();
  const toggleView = () => { view = (view + 1) % 3; pitch = VIEWS[view].pitch; setHint(); };
  let jumpQ = false;
  addEventListener('keydown', (e) => { setMode('kb'); keys.add(e.code); if (e.code === 'KeyV' && !e.repeat) toggleView(); if (e.code === 'Space') { jumpQ = true; e.preventDefault(); } });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());
  const look = (dx, dy) => { yaw -= dx; pitch = Math.min(VIEWS[view].hi, Math.max(VIEWS[view].lo, pitch + dy)); };
  cv.addEventListener('mousedown', () => { setMode('kb'); if (document.pointerLockElement !== cv) cv.requestPointerLock?.(); });
  addEventListener('mousemove', (e) => { if (document.pointerLockElement === cv || e.buttons) look(e.movementX * 0.004, e.movementY * 0.003); });
  addEventListener('wheel', (e) => { zoom = Math.min(2.6, Math.max(0.45, zoom * Math.exp(e.deltaY * 0.001))); e.preventDefault(); }, { passive: false });
  // touch
  const stick = { id: null, ox: 0, oy: 0, x: 0, y: 0 }, looks = new Map(); let pinch = 0;
  const knob = $('#k'), base = $('#b');
  const tstart = (e) => {
    setMode('touch');
    for (const t of e.changedTouches) {
      if (t.target.dataset.btn) continue;
      if (t.clientX < innerWidth * 0.45 && stick.id === null) {
        Object.assign(stick, { id: t.identifier, ox: t.clientX, oy: t.clientY, x: 0, y: 0 });
        base.style.cssText = `display:block;left:${t.clientX}px;top:${t.clientY}px`; knob.style.transform = '';
      } else looks.set(t.identifier, { x: t.clientX, y: t.clientY });
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
        if (looks.size === 1) look((t.clientX - p.x) * 0.008, (t.clientY - p.y) * 0.006);
        p.x = t.clientX; p.y = t.clientY;
      }
    }
    if (looks.size === 2) {
      const [a, b] = [...looks.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch) zoom = Math.min(2.6, Math.max(0.45, zoom * pinch / d)); pinch = d;
    } else pinch = 0;
    e.preventDefault();
  };
  const tend = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === stick.id) { stick.id = null; stick.x = stick.y = 0; base.style.display = 'none'; }
      looks.delete(t.identifier);
    }
    pinch = 0;
  };
  cv.addEventListener('touchstart', tstart, { passive: false });
  addEventListener('touchmove', tmove, { passive: false });
  addEventListener('touchend', tend); addEventListener('touchcancel', tend);
  $('#j').addEventListener('touchstart', (e) => { jumpQ = true; e.preventDefault(); }, { passive: false });
  $('#v').addEventListener('touchstart', (e) => { toggleView(); e.preventDefault(); }, { passive: false });
  if (matchMedia('(pointer: coarse)').matches) setMode('touch');
  const prevBtn = [];
  const dz = (v) => (Math.abs(v) < 0.15 ? 0 : (v - Math.sign(v) * 0.15) / 0.85);

  // ---------- frame ----------
  const U = new Float32Array(32), st = new Float32Array(mem(), X.state_ptr(), 16);
  let last = performance.now(), acc = 0, frames = 0, slow = 0;
  // debug: ?p=x,y teleport, ?t=seconds time offset, ?pt=pitch
  if (qs.get('p')) { const [x, y] = qs.get('p').split(',').map(Number); const hm8 = new Uint8Array(mem(), X.height_ptr(), N * N); st[0] = x + 0.5; st[1] = y + 0.5; st[2] = hm8[y * N + x] + 2; }
  if (qs.get('pt')) pitch = +qs.get('pt');
  const t0 = +qs.get('t') || 0;
  cz = st[2];
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
      if (lx || ly || rx || ry || g.buttons.some((x) => x.pressed)) setMode('pad');
      mx += lx; my -= ly; look(rx * 2.6 * dt, ry * 1.6 * dt);
      if (b(0) && !prevBtn[0]) jump = true;
      if (b(3) && !prevBtn[3]) toggleView();
      if (b(4) && !prevBtn[4]) yaw += Math.PI / 4; if (b(5) && !prevBtn[5]) yaw -= Math.PI / 4;
      if (b(1) || b(10)) run = true;
      zoom = Math.min(2.6, Math.max(0.45, zoom * (1 + (v(6) - v(7)) * dt * 1.5)));
      for (let i = 0; i < 16; i++) prevBtn[i] = b(i);
      break;
    }
    mx += stick.x; my += stick.y;
    if (Math.hypot(stick.x, stick.y) > 0.95) run = true;
    X.step(dt, mx, my, yaw, (jump ? 1 : 0) | (run ? 2 : 0));
    const s = st.length ? st : new Float32Array(mem(), X.state_ptr(), 16);
    cz += (s[2] - cz) * Math.min(1, dt * 10);
    // camera orbiting the player (Mode 7 style)
    const V = VIEWS[view], dist = V.dist * zoom;
    const cp = Math.cos(pitch), sp = Math.sin(pitch), fx = Math.cos(yaw), fy = Math.sin(yaw);
    const F = [fx * cp, fy * cp, -sp], R = [fy, -fx, 0], Up = [R[1] * F[2] - R[2] * F[1], R[2] * F[0] - R[0] * F[2], R[0] * F[1] - R[1] * F[0]];
    // first person: camera at eye height (dist 0), avatar hidden
    const tx = s[0], ty = s[1], tz = cz + (V.fps ? 1.55 : 0.9);
    const tanV = V.tan * Math.max(1, (ih / iw) * (V.fps ? 0.6 : 0.8));
    const far = V.fps ? 64 : V.fog ? dist * 3.2 : dist * 6;
    U.set([iw, ih, now / 1000 + t0, tanV, tx - F[0] * dist, ty - F[1] * dist, tz - F[2] * dist, V.fog,
      ...F, far, ...R, iw / ih, ...Up, 0, s[0], s[1], s[2], 0, s[4], s[5], s[6], s[7], V.fps ? 1 : 0, 0, 0, 0]);
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
